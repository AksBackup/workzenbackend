const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Ad-hoc Payments (migration_029). One-off payments outside the normal
 * monthly payroll run - per the client's request to keep this
 * alongside (not instead of) the salary-structure-driven monthly
 * payroll in payroll.js. Deliberately NOT summed into
 * computeMonthlyPayroll's total_pay - these are a separate ledger so
 * the monthly payroll number stays a pure function of attendance +
 * structure + OT + loans, auditable on its own.
 */

router.get('/', requireAdmin, asyncHandler(async (req, res) => {
    const { employee_id } = req.query;
    const params = [req.user.companyId];
    let sql = `SELECT p.*, e.name AS employee_name, e.emp_code AS employee_code
               FROM ad_hoc_payments p
               JOIN employees e ON e.id = p.employee_id
               WHERE p.company_id = ?`;
    if (employee_id) {
        sql += ' AND p.employee_id = ?';
        params.push(employee_id);
    }
    sql += ' ORDER BY p.payment_date DESC, p.id DESC';
    const [rows] = await pool.query(sql, params);
    return res.json(rows);
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { employee_id, amount, payment_date, reason } = req.body;
    if (!employee_id || !(amount > 0) || !payment_date || !reason || !reason.trim()) {
        return res.status(400).json({ error: 'employee_id, amount (> 0), payment_date, and reason are all required' });
    }
    const [empRows] = await pool.query('SELECT id FROM employees WHERE id = ? AND company_id = ?', [employee_id, req.user.companyId]);
    if (empRows.length === 0) return res.status(404).json({ error: 'Employee not found' });

    const [adminRows] = await pool.query('SELECT id FROM admins WHERE firebase_uid = ?', [req.user.uid]);
    const adminId = adminRows[0] ? adminRows[0].id : null;

    const [result] = await pool.query(
        `INSERT INTO ad_hoc_payments (company_id, employee_id, amount, payment_date, reason, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [req.user.companyId, employee_id, amount, payment_date, reason.trim(), adminId]
    );
    return res.status(201).json({ id: result.insertId });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM ad_hoc_payments WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json({ message: 'Deleted' });
}));

module.exports = router;
