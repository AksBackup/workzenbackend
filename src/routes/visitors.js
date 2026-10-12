const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Current time as a wall-clock 'YYYY-MM-DD HH:mm:ss' string in the company's local
 * zone (PAYROLL_UTC_OFFSET_MIN, default 330 = IST), the same convention as device
 * punches (see index.js). Stamping in SQL with NOW() / CURRENT_TIMESTAMP uses the DB
 * server's own clock instead (often UTC), which is why these times could be hours off.
 */
function wallClockNow() {
    const offset = Number(process.env.PAYROLL_UTC_OFFSET_MIN ?? 330);
    return new Date(Date.now() + offset * 60000).toISOString().slice(0, 19).replace('T', ' ');
}

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
        `INSERT INTO visitors (company_id, name, phone, purpose, host_employee_id, sign_in_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [req.user.companyId, name, phone || null, purpose || null, host_employee_id || null, wallClockNow()]
    );
    return res.status(201).json({ id: result.insertId });
}));

// POST /visitors/:id/sign-out - separate from the general update so the
// front desk has a single obvious action for "this visitor just left".
router.post('/:id/sign-out', asyncHandler(async (req, res) => {
    await pool.query(
        'UPDATE visitors SET sign_out_at = ? WHERE id = ? AND company_id = ? AND sign_out_at IS NULL',
        [wallClockNow(), req.params.id, req.user.companyId]
    );
    return res.json({ message: 'Signed out' });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM visitors WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json({ message: 'Deleted' });
}));

module.exports = router;
