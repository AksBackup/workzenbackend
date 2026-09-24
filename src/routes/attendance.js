const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');
const { computeAndRecordOvertime } = require('../utils/overtime');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Task 3 (multi-punch engine, migration_033): records each
 * check_in/check_out this call carries as its own row in punch_events,
 * then recomputes attendance.check_in/check_out for that employee/day
 * from EVERY punch_event on record for that day (not just this call's
 * values) - earliest 'in' as check_in, latest 'out' as check_out. This
 * replaces the old COALESCE-only upsert, which overwrote check_in on a
 * second punch-in of the same day instead of preserving the first one
 * - see migration_033's header comment for the full reasoning.
 *
 * attendance.check_in/check_out remain a single pair per day, so every
 * EXISTING reader of them (payroll.js, most of reports.js, the Flutter
 * app) keeps working unchanged and automatically gets the correct
 * full-span hours - it's exactly first-in/last-out now, not "whatever
 * the last call happened to send". The "Deduct Break Hours From Work
 * Duration" exception (Office Time Policy, migration_034) needs the
 * raw gaps between punches, which only routes/reports.js's GET /daily
 * and classifyDay (both updated this pass) actually read from
 * punch_events directly - every OTHER existing reader of
 * check_in/check_out still gets the full-span number, not the
 * gap-deducted one, until it's updated to do the same lookup. Flagging
 * this plainly rather than silently patching every consumer (some of
 * which - payroll.js - are explicitly out of this pass's owned files).
 *
 * Not wrapped in an explicit transaction (matches this file's existing
 * style - neither POST / nor POST /sync used one before this pass
 * either), so a genuinely simultaneous double-punch for the same
 * employee/day is a known, pre-existing class of race this pass
 * doesn't newly introduce or newly fix - flagged rather than silently
 * assumed safe.
 */
async function recordPunchEventsAndDeriveAttendance({
    companyId, employeeId, date, checkIn, checkOut, source, deviceId, verifyMode, syncedFromLocal,
}) {
    if (checkIn) {
        await pool.query(
            `INSERT INTO punch_events (company_id, employee_id, date, punch_time, punch_type, source, device_id, verify_mode)
             VALUES (?, ?, ?, ?, 'in', ?, ?, ?)`,
            [companyId, employeeId, date, checkIn, source || 'scanner', deviceId || null, verifyMode || 'unknown']
        );
    }
    if (checkOut) {
        await pool.query(
            `INSERT INTO punch_events (company_id, employee_id, date, punch_time, punch_type, source, device_id, verify_mode)
             VALUES (?, ?, ?, ?, 'out', ?, ?, ?)`,
            [companyId, employeeId, date, checkOut, source || 'scanner', deviceId || null, verifyMode || 'unknown']
        );
    }
    if (!checkIn && !checkOut) return;

    const [events] = await pool.query(
        'SELECT punch_time, punch_type FROM punch_events WHERE company_id = ? AND employee_id = ? AND date = ? ORDER BY punch_time ASC',
        [companyId, employeeId, date]
    );
    const ins = events.filter((e) => e.punch_type === 'in');
    const outs = events.filter((e) => e.punch_type === 'out');
    const derivedCheckIn = ins.length ? ins[0].punch_time : null;
    const derivedCheckOut = outs.length ? outs[outs.length - 1].punch_time : null;

    await pool.query(
        `INSERT INTO attendance (company_id, employee_id, date, check_in, check_out, source, device_id, verify_mode, synced_from_local)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           check_in = VALUES(check_in),
           check_out = VALUES(check_out),
           verify_mode = COALESCE(VALUES(verify_mode), verify_mode)`,
        [companyId, employeeId, date, derivedCheckIn, derivedCheckOut, source || 'manual', deviceId || null, verifyMode || 'unknown', !!syncedFromLocal]
    );
}

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

    await recordPunchEventsAndDeriveAttendance({
        companyId: req.user.companyId, employeeId: employee_id, date,
        checkIn: check_in || null, checkOut: check_out || null,
        source: source || 'manual', deviceId: device_id || null, verifyMode: verify_mode || 'unknown',
    });
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
// 'mobile' added by migration_013_mobile_punches.sql, mirroring how
// 'manual' got added here when manual_punches' approve route started
// writing verify_mode='manual'.
const VALID_VERIFY_MODES = new Set(['password', 'fingerprint', 'card', 'face', 'manual', 'mobile', 'unknown']);

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
            await recordPunchEventsAndDeriveAttendance({
                companyId: req.user.companyId, employeeId: r.employee_id, date: r.date,
                checkIn: r.check_in || null, checkOut: r.check_out || null,
                source, deviceId: r.device_id || null, verifyMode, syncedFromLocal: true,
            });
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
