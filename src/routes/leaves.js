const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');
const { computeMonthlyPaidUsage } = require('../utils/leaveQuota');
const { planLeave } = require('../utils/leaveDays');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * GET /leave-applications[?applied_on=YYYY-MM-DD][&status=pending|approved|rejected]
 * `applied_on` = the day the application was submitted (Approve Leave screen is day-by-day so it
 * never fills up). Rows now also carry the employee name/code and the leave type name + paid flag.
 */
router.get('/', asyncHandler(async (req, res) => {
    let sql = `SELECT a.*, lt.name AS leave_type_name, lt.is_paid AS leave_type_is_paid,
                      e.name AS employee_name, e.emp_code AS employee_code
               FROM leave_applications a
               LEFT JOIN leave_types lt ON lt.id = a.leave_type_id
               LEFT JOIN employees e ON e.id = a.employee_id
               WHERE a.company_id = ?`;
    const params = [req.user.companyId];

    if (req.user.role === 'employee') {
        sql += ' AND a.employee_id = (SELECT id FROM employees WHERE firebase_uid = ? AND company_id = ?)';
        params.push(req.user.uid, req.user.companyId);
    }
    if (req.query.applied_on) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.applied_on))) return res.status(400).json({ error: 'applied_on must be YYYY-MM-DD' });
        sql += ' AND DATE(a.applied_on) = ?';
        params.push(req.query.applied_on);
    }
    if (req.query.status) {
        if (!['pending', 'approved', 'rejected'].includes(String(req.query.status))) return res.status(400).json({ error: 'status must be pending, approved or rejected' });
        sql += ' AND a.status = ?';
        params.push(req.query.status);
    }
    sql += ' ORDER BY a.applied_on DESC, a.id DESC';

    const [rows] = await pool.query(sql, params);
    return res.json(rows);
}));

// Pending count across ALL dates (the Approve Leave screen shows it so nothing old is forgotten).
router.get('/pending-count', requireAdmin, asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        "SELECT COUNT(*) AS cnt FROM leave_applications WHERE company_id = ? AND status = 'pending'", [req.user.companyId]);
    return res.json({ count: rows[0].cnt });
}));

/**
 * GET /leave-applications/remaining?employee_id=&leave_type_id=&year=&month=
 * Paid leave days left this month for this leave type (pending requests reserve balance).
 * Unpaid leave types have no quota: leave_is_paid=false.
 */
router.get('/remaining', asyncHandler(async (req, res) => {
    const { employee_id, leave_type_id, year, month } = req.query;
    if (!employee_id || !leave_type_id || !year || !month) {
        return res.status(400).json({ error: 'employee_id, leave_type_id, year, and month are required' });
    }
    const [empRows] = await pool.query('SELECT id FROM employees WHERE id = ? AND company_id = ?', [employee_id, req.user.companyId]);
    if (empRows.length === 0) return res.status(404).json({ error: 'Employee not found' });

    const [typeRows] = await pool.query('SELECT is_paid FROM leave_types WHERE id = ? AND company_id = ?', [leave_type_id, req.user.companyId]);
    const isPaid = typeRows.length ? !!Number(typeRows[0].is_paid) : true;

    const { quota, used } = await computeMonthlyPaidUsage(
        req.user.companyId, employee_id, leave_type_id, parseInt(year, 10), parseInt(month, 10), { includePending: true });
    return res.json({
        leave_type_id: parseInt(leave_type_id, 10),
        leave_is_paid: isPaid,
        leave_quota: quota,
        leave_used: used,
        leave_remaining: Math.max(0, Math.round((quota - used) * 100) / 100),
    });
}));

/** Resolves who the leave is for + the leave type + builds the plan. Shared by preview and create. */
async function buildPlanFromRequest(req) {
    const b = req.body || {};
    if (!b.leave_type_id || !b.from_date) throw Object.assign(new Error('leave_type_id and from_date are required'), { status: 400 });

    let employeeId;
    if (req.user.role === 'employee') {
        const [rows] = await pool.query('SELECT id FROM employees WHERE firebase_uid = ? AND company_id = ?', [req.user.uid, req.user.companyId]);
        if (rows.length === 0) throw Object.assign(new Error('Employee record not found'), { status: 404 });
        employeeId = rows[0].id;
    } else {
        employeeId = b.employee_id;
        if (!employeeId) throw Object.assign(new Error('employee_id required for admin-submitted leave'), { status: 400 });
    }
    const [empRows] = await pool.query('SELECT id, shift_id, department FROM employees WHERE id = ? AND company_id = ?', [employeeId, req.user.companyId]);
    if (empRows.length === 0) throw Object.assign(new Error('Employee not found'), { status: 404 });
    const [typeRows] = await pool.query('SELECT * FROM leave_types WHERE id = ? AND company_id = ?', [b.leave_type_id, req.user.companyId]);
    if (typeRows.length === 0) throw Object.assign(new Error('Leave type not found'), { status: 404 });

    const plan = await planLeave({
        companyId: req.user.companyId, employee: empRows[0], leaveType: typeRows[0],
        durationType: b.duration_type || 'full', from: String(b.from_date).slice(0, 10), to: String(b.to_date || b.from_date).slice(0, 10),
        session: b.session, fromTime: b.from_time, toTime: b.to_time,
    });
    return { plan, employeeId, leaveType: typeRows[0] };
}

/** POST /leave-applications/preview - same body as create, writes nothing. Drives the Apply Leave dialog. */
router.post('/preview', asyncHandler(async (req, res) => {
    let built;
    try { built = await buildPlanFromRequest(req); }
    catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); throw err; }
    const { plan, leaveType } = built;
    return res.json({
        days_count: plan.daysCount, paid_days: plan.paidDays, unpaid_days: plan.unpaidDays,
        range_days: plan.rangeDays, excluded_days: plan.excluded.length,
        excluded_holidays: plan.excluded.filter(x => x.kind === 'holiday').length,
        excluded_weekly_offs: plan.excluded.filter(x => x.kind === 'weekly_off').length,
        counted_holidays: plan.days.filter(x => x.kind === 'holiday').length,
        counted_weekly_offs: plan.days.filter(x => x.kind === 'weekly_off').length,
        leave_is_paid: plan.isPaidType, leave_type_name: leaveType.name,
        hours: plan.hours, day_hours: plan.dayHours, duration_type: plan.durationType,
    });
}));

router.post('/', asyncHandler(async (req, res) => {
    let built;
    try { built = await buildPlanFromRequest(req); }
    catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); throw err; }
    const { plan, employeeId, leaveType } = built;
    const from = plan.days[0].date;
    const to = plan.days[plan.days.length - 1].date;
    // Keep the application's own range as typed (it may start/end on an excluded holiday).
    const reqFrom = String(req.body.from_date).slice(0, 10);
    const reqTo = String(req.body.to_date || req.body.from_date).slice(0, 10);

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [result] = await conn.query(
            `INSERT INTO leave_applications (company_id, employee_id, leave_type_id, from_date, to_date, days_count, paid_days, unpaid_days, reason,
                                             duration_type, session, from_time, to_time, leave_hours)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.user.companyId, employeeId, leaveType.id, reqFrom, reqTo, plan.daysCount, plan.paidDays, plan.unpaidDays,
                req.body.reason || null, plan.durationType, plan.session, plan.fromTime, plan.toTime, plan.hours]);
        for (const d of plan.days) {
            await conn.query(
                `INSERT INTO leave_application_days (company_id, application_id, employee_id, leave_type_id, leave_date, fraction, paid_fraction, kind)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [req.user.companyId, result.insertId, employeeId, leaveType.id, d.date, d.fraction, d.paidFraction, d.kind]);
        }
        await conn.commit();
        return res.status(201).json({
            id: result.insertId, days_count: plan.daysCount, paid_days: plan.paidDays, unpaid_days: plan.unpaidDays,
            excluded_days: plan.excluded.length, counted_from: from, counted_to: to,
        });
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}));

router.post('/:id/approve', requireAdmin, asyncHandler(async (req, res) => {
    const [adminRows] = await pool.query('SELECT id FROM admins WHERE firebase_uid = ?', [req.user.uid]);
    const adminId = adminRows[0] ? adminRows[0].id : null;
    await pool.query(
        `UPDATE leave_applications SET status = 'approved', approved_by = ?, approved_on = NOW() WHERE id = ? AND company_id = ?`,
        [adminId, req.params.id, req.user.companyId]);
    return res.json({ message: 'Approved' });
}));

router.post('/:id/reject', requireAdmin, asyncHandler(async (req, res) => {
    const [adminRows] = await pool.query('SELECT id FROM admins WHERE firebase_uid = ?', [req.user.uid]);
    const adminId = adminRows[0] ? adminRows[0].id : null;
    await pool.query(
        `UPDATE leave_applications SET status = 'rejected', approved_by = ?, approved_on = NOW() WHERE id = ? AND company_id = ?`,
        [adminId, req.params.id, req.user.companyId]);
    return res.json({ message: 'Rejected' });
}));

module.exports = router;
