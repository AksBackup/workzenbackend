const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

router.get('/', asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        'SELECT id, name FROM departments WHERE company_id = ? ORDER BY name ASC',
        [req.user.companyId]
    );
    return res.json(rows);
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const [result] = await pool.query(
        'INSERT INTO departments (company_id, name) VALUES (?, ?)',
        [req.user.companyId, name]
    );
    return res.status(201).json({ id: result.insertId, name });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM departments WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json({ message: 'Deleted' });
}));

module.exports = router;
