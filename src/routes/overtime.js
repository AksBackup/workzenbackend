const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Overtime (migration_008, extended by migration_017). Two ways a row
 * gets here:
 *   - AUTO: written by utils/overtime.js whenever a check-out is
 *     recorded past the scheduled check-out time and an admin has set a
 *     per-hour rate. Reactive only - it can't pre-authorize a day that
 *     hasn't happened yet. Starts 'pending', needs the approve/reject
 *     below.
 *   - MANUAL (new): POST / below. For "mark this employee as on
 *     overtime today" ahead of time, or to log OT that didn't involve a
 *     late check-out at all (e.g. called in on an off-day). Starts
 *     'approved' immediately, since an admin creating it has already
 *     made the call - there's no separate reactive computation here to
 *     double-check.
 * Both land in the same table/list/report so Overtime Report and
 * Payroll's OT sum don't need to know which path a row came from.
 */

// POST /overtime - manual creation (admin only). See migration_017's
// header comment for why these skip the pending queue.
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { employee_id, date, overtime_hours, rate_per_hour, note } = req.body;
    if (!employee_id || !date || !overtime_hours) {
        return res.status(400).json({ error: 'employee_id, date, and overtime_hours are required' });
    }
    const hours = parseFloat(overtime_hours);
    if (!(hours > 0)) {
        return res.status(400).json({ error: 'overtime_hours must be greater than 0' });
    }
    if (!note || !note.trim()) {
        return res.status(400).json({ error: 'note is required - explain why this OT is being marked manually' });
    }

    const [empRows] = await pool.query(
        'SELECT id FROM employees WHERE id = ? AND company_id = ?',
        [employee_id, req.user.companyId]
    );
    if (empRows.length === 0) {
        return res.status(404).json({ error: 'Employee not found' });
    }

    // Falls back to the company's configured rate when the admin
    // doesn't override it for this entry - same rate the auto path
    // uses, just resolved here instead of assumed by the client.
    let rate = rate_per_hour !== undefined && rate_per_hour !== null && rate_per_hour !== ''
        ? parseFloat(rate_per_hour)
        : null;
    if (rate === null) {
        const [policyRows] = await pool.query(
            'SELECT overtime_rate_per_hour FROM office_time_policy WHERE company_id = ?',
            [req.user.companyId]
        );
        rate = policyRows[0] ? parseFloat(policyRows[0].overtime_rate_per_hour) : NaN;
    }
    if (Number.isNaN(rate)) {
        return res.status(400).json({
            error: 'No overtime rate available - set one in Settings > Office Time, or pass rate_per_hour with this request',
        });
    }
    const amount = hours * rate;

    const [adminRows] = await pool.query('SELECT id FROM admins WHERE firebase_uid = ?', [req.user.uid]);
    const adminId = adminRows[0] ? adminRows[0].id : null;

    // Same (employee_id, date) unique key the auto path relies on - a
    // manual entry for a day that already has an auto-computed one
    // (e.g. they also happened to check out late) replaces it rather
    // than creating a conflicting second row for the same day.
    await pool.query(
        `INSERT INTO overtime_records
           (company_id, employee_id, date, overtime_hours, rate_per_hour, amount, status, source, note, approved_by, approved_on)
         VALUES (?, ?, ?, ?, ?, ?, 'approved', 'manual', ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           overtime_hours = VALUES(overtime_hours),
           rate_per_hour = VALUES(rate_per_hour),
           amount = VALUES(amount),
           status = 'approved',
           source = 'manual',
           note = VALUES(note),
           approved_by = VALUES(approved_by),
           approved_on = NOW()`,
        [req.user.companyId, employee_id, date, hours.toFixed(2), rate.toFixed(2), amount.toFixed(2), note.trim(), adminId]
    );
    return res.status(201).json({ message: 'Overtime marked and approved' });
}));

// GET /overtime?employee_id=&year=&month=&status=
// Admin: any employee, optionally filtered. Employee: only their own.
router.get('/', asyncHandler(async (req, res) => {
    const { employee_id, year, month, status } = req.query;
    const params = [req.user.companyId];
    let sql = `SELECT o.*, e.name AS employee_name, e.emp_code AS employee_code
               FROM overtime_records o
               JOIN employees e ON e.id = o.employee_id
               WHERE o.company_id = ?`;

    if (req.user.role === 'employee') {
        sql += ' AND o.employee_id = (SELECT id FROM employees WHERE firebase_uid = ? AND company_id = ?)';
        params.push(req.user.uid, req.user.companyId);
    } else if (employee_id) {
        sql += ' AND o.employee_id = ?';
        params.push(employee_id);
    }
    if (year && month) {
        sql += ' AND YEAR(o.date) = ? AND MONTH(o.date) = ?';
        params.push(year, month);
    }
    if (status) {
        sql += ' AND o.status = ?';
        params.push(status);
    }
    sql += ' ORDER BY o.date DESC';

    const [rows] = await pool.query(sql, params);
    return res.json(rows);
}));

router.post('/:id/approve', requireAdmin, asyncHandler(async (req, res) => {
    const [adminRows] = await pool.query('SELECT id FROM admins WHERE firebase_uid = ?', [req.user.uid]);
    const adminId = adminRows[0] ? adminRows[0].id : null;
    const [result] = await pool.query(
        `UPDATE overtime_records
         SET status = 'approved', approved_by = ?, approved_on = NOW()
         WHERE id = ? AND company_id = ? AND status = 'pending'`,
        [adminId, req.params.id, req.user.companyId]
    );
    if (result.affectedRows === 0) {
        return res.status(409).json({ error: 'Not found, or not pending' });
    }
    return res.json({ message: 'Approved' });
}));

router.post('/:id/reject', requireAdmin, asyncHandler(async (req, res) => {
    const [adminRows] = await pool.query('SELECT id FROM admins WHERE firebase_uid = ?', [req.user.uid]);
    const adminId = adminRows[0] ? adminRows[0].id : null;
    const [result] = await pool.query(
        `UPDATE overtime_records
         SET status = 'rejected', approved_by = ?, approved_on = NOW()
         WHERE id = ? AND company_id = ? AND status = 'pending'`,
        [adminId, req.params.id, req.user.companyId]
    );
    if (result.affectedRows === 0) {
        return res.status(409).json({ error: 'Not found, or not pending' });
    }
    return res.json({ message: 'Rejected' });
}));

module.exports = router;
