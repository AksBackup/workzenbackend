const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Loan / Advance (SCREENS.md 8.1). Standalone CRUD only - NOT wired into
 * payroll.js's total_pay calculation. See PASS_NOTES.md: subtracting an
 * active loan's monthly_deduction from an employee's total pay touches
 * payroll.js, which is shared/crosscutting, and is flagged as a gap
 * rather than guessed at here.
 */

router.get('/', requireAdmin, asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        `SELECT l.*, e.name AS employee_name, e.emp_code AS employee_code
         FROM loans l
         JOIN employees e ON e.id = l.employee_id
         WHERE l.company_id = ?
         ORDER BY l.created_at DESC`,
        [req.user.companyId]
    );
    return res.json(rows);
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { employee_id, principal_amount, monthly_deduction, start_month, start_year } = req.body;
    if (!employee_id || !principal_amount || !monthly_deduction || !start_month || !start_year) {
        return res.status(400).json({ error: 'employee_id, principal_amount, monthly_deduction, start_month, start_year required' });
    }
    const [result] = await pool.query(
        `INSERT INTO loans (company_id, employee_id, principal_amount, monthly_deduction, start_month, start_year)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [req.user.companyId, employee_id, principal_amount, monthly_deduction, start_month, start_year]
    );
    return res.status(201).json({ id: result.insertId });
}));

router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
    const fields = ['principal_amount', 'monthly_deduction', 'start_month', 'start_year', 'status'];
    const updates = [];
    const values = [];
    fields.forEach(f => {
        if (req.body[f] !== undefined) {
            updates.push(`${f} = ?`);
            values.push(req.body[f]);
        }
    });
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    values.push(req.params.id, req.user.companyId);
    await pool.query(`UPDATE loans SET ${updates.join(', ')} WHERE id = ? AND company_id = ?`, values);
    return res.json({ message: 'Updated' });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM loans WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json({ message: 'Deleted' });
}));

module.exports = router;
