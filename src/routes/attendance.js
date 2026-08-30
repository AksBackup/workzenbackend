const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');
const { computeAndRecordOvertime } = require('../utils/overtime');

const router = express.Router();
router.use(verifyFirebaseToken);

// Admin: any employee in the company (optionally filtered). Employee: only self.
// Joins employees so callers (e.g. the app's Today/Yesterday/Calendar attendance
// view) get a display name directly instead of having to cross-reference a
// separate /employees call themselves.
router.get('/', asyncHandler(async (req, res) => {
    const { employee_id, month, year, date, device_id, verify_mode, search, limit } = req.query;
    const params = [req.user.companyId];
    let sql = `SELECT a.*, e.name AS employee_name, e.emp_code AS employee_code
               FROM attendance a
               JOIN employees e ON e.id = a.employee_id
               WHERE a.company_id = ?`;

    if (req.user.role === 'employee') {
        sql += ' AND a.employee_id = (SELECT id FROM employees WHERE firebase_uid = ? AND company_id = ?)';
        params.push(req.user.uid, req.user.companyId);
    } else if (employee_id) {
        sql += ' AND a.employee_id = ?';
        params.push(employee_id);
    }

    // Single-day filter (?date=YYYY-MM-DD) - takes precedence over month/year
    // since it's more specific. Used by the app's Today/Yesterday/Calendar tabs.
    if (date) {
        sql += ' AND a.date = ?';
        params.push(date);
    } else if (month && year) {
        sql += ' AND MONTH(a.date) = ? AND YEAR(a.date) = ?';
        params.push(month, year);
    }

    // Added for Real-Time Attendance Logs (4.1) / Real-time Event Monitor
    // (9.1) - both are just this same GET with a tighter filter set and,
    // for 9.1, a client-side poll loop rather than a push connection (per
    // AGENT_B_ATTENDANCE_LEAVE_OPS.md: "a live-feeling ticker is fine as a
    // polling list ... don't over-build this one").
    if (device_id) {
        sql += ' AND a.device_id = ?';
        params.push(device_id);
    }
    if (verify_mode) {
        sql += ' AND a.verify_mode = ?';
        params.push(verify_mode);
    }
    // Matches the mockup's "Search Employee / Emp ID" box on 4.1.
    if (search) {
        sql += ' AND (e.name LIKE ? OR e.emp_code LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
    }

    sql += ' ORDER BY a.date DESC, a.check_in DESC, e.name ASC';

    if (limit) {
        // Deliberately not parameterized as a placeholder (MySQL LIMIT
        // can't take a bound param via mysql2 the same way) - parsed to a
        // safe integer first so this can never become injectable.
        const safeLimit = Math.max(1, Math.min(500, parseInt(limit, 10) || 100));
        sql += ` LIMIT ${safeLimit}`;
    }

    const [rows] = await pool.query(sql, params);
    return res.json(rows);
}));

// Single punch write (e.g. an online-connected device posting directly)
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { employee_id, date, check_in, check_out, source, device_id, verify_mode } = req.body;
    if (!employee_id || !date) return res.status(400).json({ error: 'employee_id and date required' });

    await pool.query(
        `INSERT INTO attendance (company_id, employee_id, date, check_in, check_out, source, device_id, verify_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           check_in = COALESCE(VALUES(check_in), check_in),
           check_out = COALESCE(VALUES(check_out), check_out),
           verify_mode = COALESCE(VALUES(verify_mode), verify_mode)`,
        [req.user.companyId, employee_id, date, check_in || null, check_out || null, source || 'manual', device_id || null, verify_mode || 'unknown']
    );
    if (check_out) {
        // Best-effort - a failure here shouldn't fail the punch write
        // itself, which is the actual attendance record of record.
        await computeAndRecordOvertime(req.user.companyId, employee_id, date, check_out).catch(err =>
            console.error('Overtime computation failed:', err)
        );
    }
    return res.status(201).json({ message: 'Recorded' });
}));

// Only values the attendance.source ENUM in schema.sql actually accepts.
// Anything else (e.g. a stale local-queue row still holding the old,
// invalid 'biometric' default - see the Flutter app's
// AttendanceSyncService _createTableSql) gets coerced rather than sent
// straight into the INSERT, where MySQL would reject it outright.
const VALID_ATTENDANCE_SOURCES = new Set(['scanner', 'manual', 'mobile']);

// Only values the attendance.verify_mode ENUM accepts (schema.sql,
// migration_011). Same defense-in-depth reasoning as sources above -
// the Flutter client already sanitizes before sending, this is the
// second line of defense so a malformed/unexpected value from any
// future caller degrades to 'unknown' instead of failing the insert.
const VALID_VERIFY_MODES = new Set(['password', 'fingerprint', 'card', 'face', 'manual', 'unknown']);

/**
 * POST /attendance/sync
 * Batch endpoint for the Flutter app's local SQLite offline queue.
 * Idempotent against the (employee_id, date) unique constraint - safe
 * to retry/resend the same batch if a sync gets interrupted.
 *
 * Each record is written in its own transaction rather than one shared
 * transaction for the whole batch. This used to be a single transaction -
 * that meant one malformed/invalid row (e.g. an old queued row with a
 * `source` value MySQL's ENUM rejects) would roll back every OTHER
 * record in the same sync call too, silently blocking valid punches
 * indefinitely on every retry. Per-record isolation means one bad row
 * only fails itself; everything else still syncs, and the bad row(s)
 * are reported back so the caller/app can see exactly what failed.
 */
router.post('/sync', requireAdmin, asyncHandler(async (req, res) => {
    const { records } = req.body;
    if (!Array.isArray(records) || records.length === 0) {
        return res.status(400).json({ error: 'records array required' });
    }

    const succeeded = [];
    const failed = [];

    for (const r of records) {
        const source = VALID_ATTENDANCE_SOURCES.has(r.source) ? r.source : 'scanner';
        const verifyMode = VALID_VERIFY_MODES.has(r.verify_mode) ? r.verify_mode : 'unknown';
        try {
            await pool.query(
                `INSERT INTO attendance (company_id, employee_id, date, check_in, check_out, source, device_id, verify_mode, synced_from_local)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE)
                 ON DUPLICATE KEY UPDATE
                   check_in = COALESCE(VALUES(check_in), check_in),
                   check_out = COALESCE(VALUES(check_out), check_out),
                   verify_mode = COALESCE(VALUES(verify_mode), verify_mode)`,
                [req.user.companyId, r.employee_id, r.date, r.check_in || null, r.check_out || null,
                    source, r.device_id || null, verifyMode]
            );
            succeeded.push(r);
        } catch (err) {
            console.error('Sync failed for one record:', { employee_id: r.employee_id, date: r.date, error: err.message });
            failed.push({ employee_id: r.employee_id, date: r.date, error: err.message });
        }
    }

    // Overtime is best-effort and independent per row - a failure here
    // shouldn't affect the attendance rows that already committed above.
    for (const r of succeeded) {
        if (r.check_out) {
            await computeAndRecordOvertime(req.user.companyId, r.employee_id, r.date, r.check_out).catch(err =>
                console.error('Overtime computation failed:', err)
            );
        }
    }

    const status = failed.length === 0 ? 200 : (succeeded.length === 0 ? 500 : 207);
    return res.status(status).json({
        message: `Synced ${succeeded.length} of ${records.length} record(s)`,
        syncedCount: succeeded.length,
        failed,
    });
}));

module.exports = router;
