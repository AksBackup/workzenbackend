const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

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
 * GET /leave-applications/remaining?employee_id=&leave_type_id=&year=
 *
 * Lightweight "how many paid leave days does this employee have left
 * this YEAR, for this specific leave type" lookup for the Apply Leave
 * screen's inline display - added alongside the paid/unpaid split
 * (migration_009) rather than folding into GET
 * /employees/:id/monthly-summary, so that endpoint's existing day-grid
 * logic (which counts *all* on-leave calendar days, paid or not, across
 * every leave type, and is already relied on elsewhere) doesn't need to
 * change.
 *
 * Was a monthly figure through migration_010; pass 3 rewired this to an
 * ANNUAL bank (see computeAnnualPaidUsage's doc comment below for the
 * full history/reasoning and the fallback priority across
 * leave_balances / leave_types.yearly_quota / monthly_quota). A `month`
 * query param is still silently accepted for old callers but no longer
 * has any effect - the fallback below only reads `year`.
 *
 * See computeAnnualPaidUsage() below - both this route and the POST /
 * split share the same counting logic.
 *
 * Registered before any '/:id' routes would matter, but there are none
 * here that collide with the literal path 'remaining'.
 */
router.get('/remaining', asyncHandler(async (req, res) => {
    const { employee_id, leave_type_id, year } = req.query;
    if (!employee_id || !leave_type_id || !year) {
        return res.status(400).json({ error: 'employee_id, leave_type_id, and year are required' });
    }

    const [empRows] = await pool.query(
        'SELECT id FROM employees WHERE id = ? AND company_id = ?',
        [employee_id, req.user.companyId]
    );
    if (empRows.length === 0) return res.status(404).json({ error: 'Employee not found' });

    // month is no longer used in the calculation (see
    // computeAnnualPaidUsage's header comment - quota/usage is now
    // tracked per YEAR, not per month) but stays an accepted, optional
    // query param so existing callers that still send it don't break.
    const { quota, used } = await computeAnnualPaidUsage(
        req.user.companyId, employee_id, leave_type_id, parseInt(year, 10)
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
    const { quota, used } = await computeAnnualPaidUsage(
        req.user.companyId, employeeId, leave_type_id, fromMonthDate.getFullYear()
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
 * How many paid leave days has this employee already used THIS SPECIFIC
 * LEAVE TYPE this YEAR, and what's that type's total available balance.
 *
 * BUG FIX (pass 2 - "leave bank" wiring): migration_010's model reset
 * leave_types.monthly_quota every month and never looked at
 * leave_balances at all - meanwhile Leave Opening Entry and Earn/Adjust
 * Leave (leaveOpening.js / leaveAdjustments.js) were writing to
 * leave_balances the entire time, so crediting an employee "+1 earned
 * leave" had literally zero effect on what they could actually apply
 * for or get paid. Two disconnected ledgers, only one of which was
 * ever read.
 *
 * ASSUMPTION MADE HERE (flag back if this isn't the model you want):
 * this now treats leave as an ANNUAL bank, not a monthly reset -
 * matching what Opening Entry ("set the year's balance") and
 * Earn/Adjust ("credit/debit that balance") actually imply:
 *   - quota = leave_balances.allocated for (employee, leave_type, year)
 *     if an opening entry / earn / adjust has ever been recorded for
 *     that employee+type+year
 *   - OTHERWISE, falls back to the old behavior scaled to a year
 *     (leave_types.monthly_quota x 12), so a leave type nobody has
 *     ever run Opening Entry for still works exactly as before instead
 *     of silently becoming a 0-day bank
 *   - "used" now sums paid_days across the WHOLE YEAR for this leave
 *     type (not just the one month) - a bank that isn't topped up
 *     monthly can't be checked against only one month of usage
 *
 * This is a real behavior change from the old flat monthly reset - if
 * you actually want each leave type to also refill every month
 * regardless of the annual bank, say so and this can be layered back
 * in (e.g. bank PLUS a monthly cap) rather than replacing it outright.
 *
 * FOLLOW-UP FIX (found while checking for other bugs, same pass):
 * `leave_types.yearly_quota` already existed in the schema before any
 * of this - routes/leaveTypes.js's own comment says it flat-out
 * "is kept alongside it for reference/carry-forward only" and nothing
 * ever read it. That's a THIRD disconnected leave number, sitting
 * right next to the two this function was written to reconcile. Since
 * it's clearly meant to represent an annual figure (the Leave Types
 * settings screen even has a "Yearly quota (optional)" field for it),
 * using it - when set - beats inferring an annual number by multiplying
 * monthly_quota by 12: an admin who explicitly typed "24 days/year"
 * obviously meant 24, not necessarily whatever monthly_quota x 12
 * happens to compute to. Fallback order is now: leave_balances.allocated
 * (an actual Opening Entry/Earn-Adjust has been recorded) > yearly_quota
 * (if the admin set one > 0) > monthly_quota x 12 (last resort, for a
 * leave type nobody's touched either newer field for yet).
 */
async function computeAnnualPaidUsage(companyId, employeeId, leaveTypeId, year) {
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;

    const [balanceRows] = await pool.query(
        'SELECT allocated FROM leave_balances WHERE employee_id = ? AND leave_type_id = ? AND year = ?',
        [employeeId, leaveTypeId, year]
    );

    let quota;
    if (balanceRows.length > 0) {
        quota = Number(balanceRows[0].allocated) || 0;
    } else {
        const [typeRows] = await pool.query(
            'SELECT yearly_quota, monthly_quota FROM leave_types WHERE id = ? AND company_id = ?',
            [leaveTypeId, companyId]
        );
        const yearlyQuota = typeRows.length > 0 ? parseFloat(typeRows[0].yearly_quota) || 0 : 0;
        const monthlyQuota = typeRows.length > 0 ? parseFloat(typeRows[0].monthly_quota) || 0 : 0;
        quota = yearlyQuota > 0 ? yearlyQuota : monthlyQuota * 12;
    }

    const [leaveRows] = await pool.query(
        `SELECT days_count, paid_days FROM leave_applications
         WHERE employee_id = ? AND leave_type_id = ? AND status = 'approved' AND from_date <= ? AND to_date >= ?`,
        [employeeId, leaveTypeId, yearEnd, yearStart]
    );
    const used = leaveRows.reduce((sum, r) => sum + (r.paid_days !== null ? Number(r.paid_days) : Number(r.days_count)), 0);

    return { quota, used };
}

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
