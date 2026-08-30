const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Overtime (migration_008). Rows are written automatically by
 * utils/overtime.js whenever a check-out is recorded past the scheduled
 * check-out time and an admin has set a per-hour rate - never created
 * directly through this route. This route is purely the approval queue:
 * list + approve/reject, same pending/approved/rejected pattern as
 * leave_applications and conveyance_claims.
 */

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
