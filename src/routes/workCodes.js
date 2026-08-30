const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

router.get('/', asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        'SELECT * FROM work_codes WHERE company_id = ? ORDER BY code ASC',
        [req.user.companyId]
    );
    return res.json(rows);
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { code, label, color } = req.body;
    if (!code || !label) return res.status(400).json({ error: 'code and label are required' });

    const [dupRows] = await pool.query(
        'SELECT id FROM work_codes WHERE company_id = ? AND code = ?',
        [req.user.companyId, code]
    );
    if (dupRows.length > 0) {
        return res.status(409).json({ error: `Work code "${code}" already exists` });
    }

    const [result] = await pool.query(
        'INSERT INTO work_codes (company_id, code, label, color) VALUES (?, ?, ?, ?)',
        [req.user.companyId, code, label, color || '#63D7F1']
    );
    return res.status(201).json({ id: result.insertId, code, label, color: color || '#63D7F1' });
}));

router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
    const fields = ['code', 'label', 'color'];
    const updates = [];
    const values = [];
    fields.forEach(f => {
        if (req.body[f] !== undefined) {
            updates.push(`${f} = ?`);
            values.push(req.body[f]);
        }
    });
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    if (req.body.code !== undefined) {
        const [dupRows] = await pool.query(
            'SELECT id FROM work_codes WHERE company_id = ? AND code = ? AND id != ?',
            [req.user.companyId, req.body.code, req.params.id]
        );
        if (dupRows.length > 0) {
            return res.status(409).json({ error: `Work code "${req.body.code}" already exists` });
        }
    }

    values.push(req.params.id, req.user.companyId);
    await pool.query(
        `UPDATE work_codes SET ${updates.join(', ')} WHERE id = ? AND company_id = ?`,
        values
    );
    return res.json({ message: 'Updated' });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM work_codes WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json({ message: 'Deleted' });
}));

module.exports = router;
