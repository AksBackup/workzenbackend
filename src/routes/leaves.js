const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');

const router = express.Router();
router.use(verifyFirebaseToken);

router.get('/', async (req, res) => {
    let sql = 'SELECT * FROM leave_applications WHERE company_id = ?';
    const params = [req.user.companyId];

    if (req.user.role === 'employee') {
        sql += ' AND employee_id = (SELECT id FROM employees WHERE firebase_uid = ? AND company_id = ?)';
        params.push(req.user.uid, req.user.companyId);
    }
    sql += ' ORDER BY applied_on DESC';

    const [rows] = await pool.query(sql, params);
    return res.json(rows);
});

router.post('/', async (req, res) => {
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

    const [result] = await pool.query(
        `INSERT INTO leave_applications (company_id, employee_id, leave_type_id, from_date, to_date, days_count, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [req.user.companyId, employeeId, leave_type_id, from_date, to_date, days_count, reason || null]
    );
    return res.status(201).json({ id: result.insertId });
});

router.post('/:id/approve', requireAdmin, async (req, res) => {
    const [adminRows] = await pool.query('SELECT id FROM admins WHERE firebase_uid = ?', [req.user.uid]);
    const adminId = adminRows[0] ? adminRows[0].id : null;

    await pool.query(
        `UPDATE leave_applications
         SET status = 'approved', approved_by = ?, approved_on = NOW()
         WHERE id = ? AND company_id = ?`,
        [adminId, req.params.id, req.user.companyId]
    );
    return res.json({ message: 'Approved' });
});

router.post('/:id/reject', requireAdmin, async (req, res) => {
    const [adminRows] = await pool.query('SELECT id FROM admins WHERE firebase_uid = ?', [req.user.uid]);
    const adminId = adminRows[0] ? adminRows[0].id : null;

    await pool.query(
        `UPDATE leave_applications
         SET status = 'rejected', approved_by = ?, approved_on = NOW()
         WHERE id = ? AND company_id = ?`,
        [adminId, req.params.id, req.user.companyId]
    );
    return res.json({ message: 'Rejected' });
});

module.exports = router;
