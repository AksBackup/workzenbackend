const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Raw Punches (CONTEXT.md: Device management #3 "Download Logs From
 * Device/USB", Attendance #4 "Show Device Raw Punch", Report "All Raw
 * Punch Report" - migration_015). See that migration's table comment
 * for what "raw" means here vs. the processed `attendance` table.
 *
 * Flow: the Flutter desktop app calls the local zk_bridge's new
 * GET /device/logs (DeviceOperations.PullAttendanceLogs) to pull
 * whatever's in a device's own log buffer, then POSTs the result here
 * via POST /raw-punches/bulk to persist it server-side. This route
 * never talks to zk_bridge itself - zk_bridge only listens on
 * 127.0.0.1, reachable from the same desktop machine, not from this
 * cloud backend.
 */

// verifyMode display mapping - SDK returns a bare integer code (see
// DeviceOperations.PullAttendanceLogs's comment); this is the
// commonly-documented ZK code table, not independently verified
// against this project's specific device firmware.
const VERIFY_MODE_LABELS = {
    0: 'password', 1: 'fingerprint', 2: 'card', 15: 'face',
};
const IN_OUT_MODE_LABELS = {
    0: 'in', 1: 'out', 2: 'break_out', 3: 'break_in', 4: 'ot_in', 5: 'ot_out',
};

// POST /raw-punches/bulk
// body: { device_id, logs: [{ enrollNumber, verifyMode, inOutMode, timestamp }, ...] }
// (the exact shape GET /device/logs on zk_bridge returns, passed straight
// through by the Flutter app).
router.post('/bulk', requireAdmin, asyncHandler(async (req, res) => {
    const { device_id, logs } = req.body;
    if (!device_id || !Array.isArray(logs)) {
        return res.status(400).json({ error: 'device_id and a logs array are required' });
    }

    const [deviceRows] = await pool.query(
        'SELECT id FROM devices WHERE id = ? AND company_id = ?',
        [device_id, req.user.companyId]
    );
    if (deviceRows.length === 0) return res.status(404).json({ error: 'Device not found' });

    // Match each raw device_user_id against employees.emp_code (the
    // same numeric id the device stores, per employees.js's own
    // "the device's User ID field is a real integer" comment) so the
    // report can show a name, not just a bare device id.
    const [empRows] = await pool.query(
        'SELECT id, emp_code FROM employees WHERE company_id = ?',
        [req.user.companyId]
    );
    const empByCode = new Map(empRows.map(e => [String(e.emp_code), e.id]));

    let inserted = 0;
    let skippedDuplicates = 0;
    for (const log of logs) {
        if (!log || !log.enrollNumber || !log.timestamp) continue;

        // App-layer dedup, per migration_015's comment on why this
        // isn't a DB unique key: re-pulling the same not-yet-cleared
        // device buffer twice should not double-insert the same
        // second's record.
        const [existing] = await pool.query(
            'SELECT id FROM raw_punches WHERE device_id = ? AND device_user_id = ? AND punch_time = ?',
            [device_id, log.enrollNumber, log.timestamp]
        );
        if (existing.length > 0) {
            skippedDuplicates++;
            continue;
        }

        await pool.query(
            `INSERT INTO raw_punches (company_id, device_id, device_user_id, employee_id, punch_time, verify_mode, in_out_mode)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                req.user.companyId, device_id, log.enrollNumber,
                empByCode.get(String(log.enrollNumber)) || null,
                log.timestamp, log.verifyMode ?? null, log.inOutMode ?? null,
            ]
        );
        inserted++;
    }

    return res.status(201).json({ inserted, skippedDuplicates, total: logs.length });
}));

// GET /raw-punches?device_id=&employee_id=&from=&to=
// Powers both "Show Device Raw Punch" (a live browsable list) and
// the "All Raw Punch Report" (same data, just filtered to a date
// range and typically exported) - one endpoint, both use cases.
router.get('/', asyncHandler(async (req, res) => {
    const { device_id, employee_id, from, to } = req.query;
    const params = [req.user.companyId];
    // devices' name column is called device_name, not name - this was
    // selecting a column that doesn't exist (d.name), which threw a SQL
    // error and surfaced to the Flutter screen as a bare "HTTP 500:
    // Internal server error".
    // day_first / day_last: the employee's earliest / latest punch of that day within this result
    // set. They let the screen show a usable In/Out even when the device sends no usable in/out
    // flag (many F22 units send nothing or 255): same rule the attendance table itself uses -
    // first punch of the day = in, last = out. Needs MySQL 8 window functions; falls back
    // automatically (without the two columns) on a server that doesn't have them.
    const build = (withWindow) => {
        const p = [req.user.companyId];
        let q = `SELECT rp.*, e.name AS employee_name, e.emp_code AS employee_code, d.device_name AS device_name${withWindow
            ? `,
                      MIN(rp.punch_time) OVER (PARTITION BY rp.device_user_id, DATE(rp.punch_time)) AS day_first,
                      MAX(rp.punch_time) OVER (PARTITION BY rp.device_user_id, DATE(rp.punch_time)) AS day_last`
            : ''}
               FROM raw_punches rp
               LEFT JOIN employees e ON e.id = rp.employee_id
               LEFT JOIN devices d ON d.id = rp.device_id
               WHERE rp.company_id = ?`;
        if (device_id) { q += ' AND rp.device_id = ?'; p.push(device_id); }
        if (employee_id) { q += ' AND rp.employee_id = ?'; p.push(employee_id); }
        if (from) { q += ' AND rp.punch_time >= ?'; p.push(from); }
        if (to) { q += ' AND rp.punch_time <= ?'; p.push(to); }
        q += ' ORDER BY rp.punch_time DESC LIMIT 5000'; // hard cap - this is a raw log, not a paginated table yet
        return [q, p];
    };

    let rows;
    try {
        const [q, p] = build(true);
        [rows] = await pool.query(q, p);
    } catch (err) {
        if (err && (err.code === 'ER_PARSE_ERROR' || err.errno === 1064)) {
            const [q, p] = build(false);
            [rows] = await pool.query(q, p);
        } else {
            throw err;
        }
    }

    const ms = (v) => (v == null ? NaN : (v instanceof Date ? v.getTime() : new Date(v).getTime()));
    const withLabels = rows.map((r) => {
        const { day_first, day_last, ...rest } = r;
        const cur = ms(r.punch_time);
        let derived = null;
        if (cur === ms(day_first)) derived = 'in';
        else if (cur === ms(day_last)) derived = 'out';
        return {
            ...rest,
            // An unmapped code is shown as "code N" (not just "unknown") so what the device really
            // sends is visible; null/255/unmapped in/out -> null label (the screen then uses
            // in_out_derived instead of a useless "unknown").
            verify_mode_label: VERIFY_MODE_LABELS[r.verify_mode] ?? (r.verify_mode == null ? 'unknown' : `code ${r.verify_mode}`),
            in_out_mode_label: IN_OUT_MODE_LABELS[r.in_out_mode] ?? null,
            in_out_derived: derived,
        };
    });
    return res.json(withLabels);
}));

module.exports = router;
