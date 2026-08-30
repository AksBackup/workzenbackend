const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

router.get('/', asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        'SELECT * FROM branches WHERE company_id = ? ORDER BY is_head_office DESC, name ASC',
        [req.user.companyId]
    );
    return res.json(rows);
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { name, address, phone, is_head_office } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const [result] = await pool.query(
        'INSERT INTO branches (company_id, name, address, phone, is_head_office) VALUES (?, ?, ?, ?, ?)',
        [req.user.companyId, name, address || null, phone || null, !!is_head_office]
    );
    return res.status(201).json({ id: result.insertId, name, address: address || null, phone: phone || null, is_head_office: !!is_head_office });
}));

router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
    const fields = ['name', 'address', 'phone', 'is_head_office'];
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
    await pool.query(
        `UPDATE branches SET ${updates.join(', ')} WHERE id = ? AND company_id = ?`,
        values
    );
    return res.json({ message: 'Updated' });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM branches WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json({ message: 'Deleted' });
}));

module.exports = router;
