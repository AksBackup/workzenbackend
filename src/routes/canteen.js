const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Canteen Management (5.2) - same "stub" treatment as visitors.js: real
 * persisted CRUD, just no attendance/payroll linkage.
 */

router.get('/', asyncHandler(async (req, res) => {
    const { date } = req.query;
    const params = [req.user.companyId];
    let sql = `SELECT c.*, e.name AS employee_name, e.emp_code AS employee_code
               FROM canteen_usage c
               JOIN employees e ON e.id = c.employee_id
               WHERE c.company_id = ?`;
    if (date) {
        sql += ' AND c.date = ?';
        params.push(date);
    }
    sql += ' ORDER BY c.punch_time DESC';

    const [rows] = await pool.query(sql, params);
    return res.json(rows);
}));

router.post('/', asyncHandler(async (req, res) => {
    const { employee_id, date, meal_type, subsidy, amount } = req.body;
    if (!employee_id || !date) return res.status(400).json({ error: 'employee_id and date required' });

    const [empRows] = await pool.query(
        'SELECT id FROM employees WHERE id = ? AND company_id = ?',
        [employee_id, req.user.companyId]
    );
    if (empRows.length === 0) return res.status(404).json({ error: 'Employee not found' });

    const [result] = await pool.query(
        `INSERT INTO canteen_usage (company_id, employee_id, date, meal_type, subsidy, amount)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [req.user.companyId, employee_id, date, meal_type || 'lunch', subsidy || null, amount || null]
    );
    return res.status(201).json({ id: result.insertId });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM canteen_usage WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json({ message: 'Deleted' });
}));

module.exports = router;
