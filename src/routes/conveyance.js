const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Conveyance Approval (SCREENS.md 8.3) - same pending/approved/rejected
 * pattern as leave_applications (src/routes/leaves.js), copied
 * deliberately rather than inventing a new shape. There's no
 * employee-facing app yet (same standing limitation as leave
 * applications - see FROZEN_CONTRACT_V2.md), so claims are submitted by
 * the admin on an employee's behalf, same as leaves.js's admin path.
 */

router.get('/', requireAdmin, asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        `SELECT c.*, e.name AS employee_name, e.emp_code AS employee_code
         FROM conveyance_claims c
         JOIN employees e ON e.id = c.employee_id
         WHERE c.company_id = ?
         ORDER BY c.applied_on DESC`,
        [req.user.companyId]
    );
    return res.json(rows);
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { employee_id, date, amount, reason } = req.body;
    if (!employee_id || !date || amount === undefined) {
        return res.status(400).json({ error: 'employee_id, date, amount required' });
    }
    const [result] = await pool.query(
        `INSERT INTO conveyance_claims (company_id, employee_id, date, amount, reason)
         VALUES (?, ?, ?, ?, ?)`,
        [req.user.companyId, employee_id, date, amount, reason || null]
    );
    return res.status(201).json({ id: result.insertId });
}));

router.post('/:id/approve', requireAdmin, asyncHandler(async (req, res) => {
    const [adminRows] = await pool.query('SELECT id FROM admins WHERE firebase_uid = ?', [req.user.uid]);
    const adminId = adminRows[0] ? adminRows[0].id : null;
    await pool.query(
        `UPDATE conveyance_claims
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
        `UPDATE conveyance_claims
         SET status = 'rejected', approved_by = ?, approved_on = NOW()
         WHERE id = ? AND company_id = ?`,
        [adminId, req.params.id, req.user.companyId]
    );
    return res.json({ message: 'Rejected' });
}));

// Used by the Dashboard's pending-conveyance-count stat card (Agent C's
// own screen, see AGENT_C_PAYROLL_REPORTS_ADMIN.md's Dashboard row) -
// a plain count rather than making the dashboard fetch every claim.
router.get('/pending-count', requireAdmin, asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        "SELECT COUNT(*) AS cnt FROM conveyance_claims WHERE company_id = ? AND status = 'pending'",
        [req.user.companyId]
    );
    return res.json({ count: rows[0].cnt });
}));

module.exports = router;
