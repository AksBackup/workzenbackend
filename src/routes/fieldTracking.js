const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

// BUG FIX: MySQL's DATETIME literal syntax is 'YYYY-MM-DD HH:MM:SS' - it
// does not accept the 'T' separator or trailing 'Z' that JS's
// Date#toISOString() (and every phone's location API) produces, e.g.
// '2026-09-14T06:53:29Z'. mysql2 only reformats this automatically when
// given an actual JS Date object; a raw string like the phone sends is
// passed straight through to the SQL statement and MySQL rejects it with
// ER_TRUNCATED_WRONG_VALUE (1292). Converting to a Date first and then to
// MySQL's expected string ourselves - always in UTC, regardless of this
// server's local timezone - keeps the stored instant identical to what
// the phone recorded (recorded_at is TIMESTAMP/DATETIME with no timezone
// info of its own, so it needs to unambiguously mean UTC).
function toMysqlDatetimeUtc(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Track Field Employee (CONTEXT.md, Attendance #9, migration_015).
 * Deliberately separate from geofencing/mobile-punches: this is a
 * continuous trail of periodic background-location pings logged while
 * a field employee is on duty (per the research this pass's build note
 * cites - "background location only between clock-in and clock-out"),
 * not a single validation event at punch time.
 */

// POST /field-tracking/pings - the phone posts here periodically
// (e.g. every few minutes) while a field employee is clocked in.
// Always self-submitted, same reasoning as mobilePunch.js's POST -
// employee_id is derived from the caller's own Firebase identity for
// an 'employee' role, never trusted from the body.
router.post('/pings', asyncHandler(async (req, res) => {
    const { latitude, longitude, accuracy_meters, recorded_at } = req.body;
    if (latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: 'latitude and longitude are required' });
    }

    let employeeId;
    if (req.user.role === 'employee') {
        const [rows] = await pool.query(
            'SELECT id FROM employees WHERE firebase_uid = ? AND company_id = ?',
            [req.user.uid, req.user.companyId]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Employee record not found' });
        employeeId = rows[0].id;
    } else {
        employeeId = req.body.employee_id;
        if (!employeeId) return res.status(400).json({ error: 'employee_id required' });
    }

    const recordedAt = toMysqlDatetimeUtc(recorded_at || new Date());
    if (recordedAt === null) {
        return res.status(400).json({ error: 'recorded_at must be a valid date/time' });
    }

    await pool.query(
        `INSERT INTO field_location_pings (company_id, employee_id, latitude, longitude, accuracy_meters, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [req.user.companyId, employeeId, latitude, longitude, accuracy_meters ?? null, recordedAt]
    );
    return res.status(201).json({ message: 'Recorded' });
}));

// GET /field-tracking/trail?employee_id=&date=YYYY-MM-DD
// Admin-only - the "trail" view: every ping for one employee on one
// day, oldest first, so it can be drawn as a route on a map. Employee
// role can view their own trail too (same self-access shape as
// GET /mobile-punches), though the primary use case is an admin
// checking on a field team.
router.get('/trail', asyncHandler(async (req, res) => {
    const { employee_id, date } = req.query;
    if (!date) return res.status(400).json({ error: 'date required' });

    let targetEmployeeId = employee_id;
    if (req.user.role === 'employee') {
        const [rows] = await pool.query(
            'SELECT id FROM employees WHERE firebase_uid = ? AND company_id = ?',
            [req.user.uid, req.user.companyId]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Employee record not found' });
        targetEmployeeId = rows[0].id;
    } else if (!targetEmployeeId) {
        return res.status(400).json({ error: 'employee_id required' });
    }

    const [rows] = await pool.query(
        `SELECT id, latitude, longitude, accuracy_meters, recorded_at
         FROM field_location_pings
         WHERE company_id = ? AND employee_id = ? AND DATE(recorded_at) = ?
         ORDER BY recorded_at ASC`,
        [req.user.companyId, targetEmployeeId, date]
    );
    return res.json(rows);
}));

// GET /field-tracking/latest - one row per employee, their single most
// recent ping today - powers a "where is everyone right now" admin
// dashboard view without pulling every employee's full trail.
router.get('/latest', requireAdmin, asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        `SELECT p.employee_id, e.name AS employee_name, e.emp_code AS employee_code,
                p.latitude, p.longitude, p.accuracy_meters, p.recorded_at
         FROM field_location_pings p
         JOIN employees e ON e.id = p.employee_id
         JOIN (
             SELECT employee_id, MAX(recorded_at) AS latest_time
             FROM field_location_pings
             WHERE company_id = ? AND DATE(recorded_at) = CURDATE()
             GROUP BY employee_id
         ) latest ON latest.employee_id = p.employee_id AND latest.latest_time = p.recorded_at
         WHERE p.company_id = ?
         ORDER BY e.name ASC`,
        [req.user.companyId, req.user.companyId]
    );
    return res.json(rows);
}));

module.exports = router;
