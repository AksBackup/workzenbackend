const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Visitor Management (5.1) - explicitly a stub per FROZEN_CONTRACT_V2.md:
 * "no attendance/payroll linkage. Front-desk sign-in/out log." This is a
 * real, persisted CRUD (not fake local-only state) - "stub" here refers
 * to it not touching attendance/payroll, not to the data being fake.
 */

router.get('/', asyncHandler(async (req, res) => {
    const { date } = req.query;
    const params = [req.user.companyId];
    let sql = `SELECT v.*, e.name AS host_employee_name
               FROM visitors v
               LEFT JOIN employees e ON e.id = v.host_employee_id
               WHERE v.company_id = ?`;
    if (date) {
        sql += ' AND DATE(v.sign_in_at) = ?';
        params.push(date);
    }
    sql += ' ORDER BY v.sign_in_at DESC';

    const [rows] = await pool.query(sql, params);
    return res.json(rows);
}));

router.post('/', asyncHandler(async (req, res) => {
    const { name, phone, purpose, host_employee_id } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const [result] = await pool.query(
        `INSERT INTO visitors (company_id, name, phone, purpose, host_employee_id)
         VALUES (?, ?, ?, ?, ?)`,
        [req.user.companyId, name, phone || null, purpose || null, host_employee_id || null]
    );
    return res.status(201).json({ id: result.insertId });
}));

// POST /visitors/:id/sign-out - separate from the general update so the
// front desk has a single obvious action for "this visitor just left".
router.post('/:id/sign-out', asyncHandler(async (req, res) => {
    await pool.query(
        'UPDATE visitors SET sign_out_at = NOW() WHERE id = ? AND company_id = ? AND sign_out_at IS NULL',
        [req.params.id, req.user.companyId]
    );
    return res.json({ message: 'Signed out' });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM visitors WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json({ message: 'Deleted' });
}));

module.exports = router;
