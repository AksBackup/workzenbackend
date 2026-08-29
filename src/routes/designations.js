const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

router.get('/', asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        'SELECT id, name, default_salary FROM designations WHERE company_id = ? ORDER BY name ASC',
        [req.user.companyId]
    );
    return res.json(rows);
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { name, default_salary } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const [result] = await pool.query(
        'INSERT INTO designations (company_id, name, default_salary) VALUES (?, ?, ?)',
        [req.user.companyId, name, default_salary ?? null]
    );
    return res.status(201).json({ id: result.insertId, name, default_salary: default_salary ?? null });
}));

router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
    const fields = [];
    const values = [];
    if (req.body.name !== undefined) { fields.push('name = ?'); values.push(req.body.name); }
    if (req.body.default_salary !== undefined) { fields.push('default_salary = ?'); values.push(req.body.default_salary); }
    if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

    values.push(req.params.id, req.user.companyId);
    await pool.query(
        `UPDATE designations SET ${fields.join(', ')} WHERE id = ? AND company_id = ?`,
        values
    );
    return res.json({ message: 'Updated' });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM designations WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json({ message: 'Deleted' });
}));

module.exports = router;
