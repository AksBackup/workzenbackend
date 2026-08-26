const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');

const router = express.Router();
router.use(verifyFirebaseToken);

router.get('/', async (req, res) => {
    let sql = 'SELECT * FROM tasks WHERE company_id = ?';
    const params = [req.user.companyId];

    if (req.user.role === 'employee') {
        sql += ' AND employee_id = (SELECT id FROM employees WHERE firebase_uid = ? AND company_id = ?)';
        params.push(req.user.uid, req.user.companyId);
    }
    sql += ' ORDER BY due_date ASC';

    const [rows] = await pool.query(sql, params);
    return res.json(rows);
});

router.post('/', requireAdmin, async (req, res) => {
    const { employee_id, title, description, due_date } = req.body;
    if (!employee_id || !title) return res.status(400).json({ error: 'employee_id and title required' });

    const [adminRows] = await pool.query('SELECT id FROM admins WHERE firebase_uid = ?', [req.user.uid]);

    const [result] = await pool.query(
        `INSERT INTO tasks (company_id, employee_id, title, description, due_date, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [req.user.companyId, employee_id, title, description || null, due_date || null,
            adminRows[0] ? adminRows[0].id : null]
    );
    return res.status(201).json({ id: result.insertId });
});

router.put('/:id/status', async (req, res) => {
    const { status } = req.body;
    if (!['pending', 'in_progress', 'completed'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }
    await pool.query(
        'UPDATE tasks SET status = ? WHERE id = ? AND company_id = ?',
        [status, req.params.id, req.user.companyId]
    );
    return res.json({ message: 'Updated' });
});

module.exports = router;
