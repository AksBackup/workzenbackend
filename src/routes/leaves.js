const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');
const { computeMonthlyPaidUsage } = require('../utils/leaveQuota');

const router = express.Router();
router.use(verifyFirebaseToken);

router.get('/', asyncHandler(async (req, res) => {
    let sql = 'SELECT * FROM leave_applications WHERE company_id = ?';
    const params = [req.user.companyId];

    if (req.user.role === 'employee') {
        sql += ' AND employee_id = (SELECT id FROM employees WHERE firebase_uid = ? AND company_id = ?)';
        params.push(req.user.uid, req.user.companyId);
    }
    sql += ' ORDER BY applied_on DESC';

    const [rows] = await pool.query(sql, params);
    return res.json(rows);
}));

/**
 * GET /leave-applications/remaining?employee_id=&leave_type_id=&year=&month=
 *
 * Lightweight "how many paid leave days does this employee have left
 * this month, for this specific leave type" lookup for the Apply Leave
 * screen's inline display - added alongside the paid/unpaid split
 * (migration_009) rather than folding into GET
 * /employees/:id/monthly-summary, so that endpoint's existing day-grid
 * logic (which counts *all* on-leave calendar days, paid or not, across
 * every leave type, and is already relied on elsewhere) doesn't need to
 * change.
 *
 * Monthly reset, by request - see leaveQuota.js's computeMonthlyPaidUsage
 * doc comment for the full history (this went monthly -> annual bank ->
 * back to monthly, each time for a real reason - that comment is the
 * one to read before changing this again).
 *
 * See computeMonthlyPaidUsage() - both this route and the POST / split
 * share the same counting logic.
 *
 * Registered before any '/:id' routes would matter, but there are none
 * here that collide with the literal path 'remaining'.
 */
router.get('/remaining', asyncHandler(async (req, res) => {
    const { employee_id, leave_type_id, year, month } = req.query;
    if (!employee_id || !leave_type_id || !year || !month) {
        return res.status(400).json({ error: 'employee_id, leave_type_id, year, and month are required' });
    }

    const [empRows] = await pool.query(
        'SELECT id FROM employees WHERE id = ? AND company_id = ?',
        [employee_id, req.user.companyId]
    );
    if (empRows.length === 0) return res.status(404).json({ error: 'Employee not found' });

    const { quota, used } = await computeMonthlyPaidUsage(
        req.user.companyId, employee_id, leave_type_id, parseInt(year, 10), parseInt(month, 10)
    );
    return res.json({
        leave_type_id: parseInt(leave_type_id, 10),
        leave_quota: quota,
        leave_used: used,
        leave_remaining: Math.max(0, Math.round((quota - used) * 10) / 10),
    });
}));

router.post('/', asyncHandler(async (req, res) => {
    const { leave_type_id, from_date, to_date, days_count, reason } = req.body;
    if (!leave_type_id || !from_date || !to_date || !days_count) {
        return res.status(400).json({ error: 'Missing required fields' });
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
        if (!employeeId) return res.status(400).json({ error: 'employee_id required for admin-submitted leave' });
    }

    // Paid/unpaid split (migration_009, Part 4 brief; migration_010
    // makes the quota per-leave-type instead of one flat company-wide
    // number): decided once, now, against the quota month of from_date -
    // not re-derived later, and against THIS application's own leave
    // type only - "3 days/month Casual Leave, already used 2, applies
    // for 3 more Casual Leave" -> first 1 paid (remaining Casual quota),
    // other 2 unpaid (counted as absence in payroll, see
    // routes/payroll.js). A Sick Leave application that same month is
    // checked against Sick Leave's own quota/usage, entirely separately
    // - leave types don't share or borrow from each other's quota.
    // Cross-month applications are evaluated against from_date's month
    // only - a known simplification, flag back if a leave spanning a
    // month boundary needs finer handling.
    const fromMonthDate = new Date(from_date);
    const { quota, used } = await computeMonthlyPaidUsage(
        req.user.companyId, employeeId, leave_type_id, fromMonthDate.getFullYear(), fromMonthDate.getMonth() + 1
    );
    const remainingQuota = Math.max(0, quota - used);
    const paidDays = Math.min(Number(days_count), remainingQuota);
    const unpaidDays = Math.round((Number(days_count) - paidDays) * 10) / 10;

    const [result] = await pool.query(
        `INSERT INTO leave_applications (company_id, employee_id, leave_type_id, from_date, to_date, days_count, paid_days, unpaid_days, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.user.companyId, employeeId, leave_type_id, from_date, to_date, days_count, paidDays, unpaidDays, reason || null]
    );
    return res.status(201).json({ id: result.insertId, paid_days: paidDays, unpaid_days: unpaidDays });
}));

/**
 * computeMonthlyPaidUsage moved to ../utils/leaveQuota.js (imported
 * above) - GET /:id/monthly-summary in routes/employees.js shares the
 * exact same function instead of running its own, disagreeing
 * calculation. See that file for the full history/reasoning.
 */

router.post('/:id/approve', requireAdmin, asyncHandler(async (req, res) => {
    const [adminRows] = await pool.query('SELECT id FROM admins WHERE firebase_uid = ?', [req.user.uid]);
    const adminId = adminRows[0] ? adminRows[0].id : null;

    await pool.query(
        `UPDATE leave_applications
         SET status = 'approved', approved_by = ?, approved_on = NOW()
         WHERE id = ? AND company_id = ?`,
        [adminId, req.params.id, req.user.companyId]
    );
    return res.json({ message: 'Approved' });
}));

router.post('/:id/reject', requireAdmin, asyncHandler(async (req, res) => {
    const [adminRows] = await pool.query('SELECT id FROM admins WHERE firebase_uid = ?', [req.user.uid]);
    const adminId = adminRows[0] ? adminRows[0].id : null;

    await pool.query(
        `UPDATE leave_applications
         SET status = 'rejected', approved_by = ?, approved_on = NOW()
         WHERE id = ? AND company_id = ?`,
        [adminId, req.params.id, req.user.companyId]
    );
    return res.json({ message: 'Rejected' });
}));

module.exports = router;
