const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

// IMPORTANT: this table's shape (id, company_id, name, start_time,
// end_time) is committed and relied on by Agent B's Shift Change /
// Generate Shift / Shift Roaster screens. Do not rename columns here
// without checking with that pass first.

router.get('/', asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        'SELECT * FROM shifts WHERE company_id = ? ORDER BY start_time ASC',
        [req.user.companyId]
    );
    return res.json(rows);
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { name, start_time, end_time } = req.body;
    if (!name || !start_time || !end_time) {
        return res.status(400).json({ error: 'name, start_time and end_time are required' });
    }

    const [result] = await pool.query(
        'INSERT INTO shifts (company_id, name, start_time, end_time) VALUES (?, ?, ?, ?)',
        [req.user.companyId, name, start_time, end_time]
    );
    return res.status(201).json({ id: result.insertId, name, start_time, end_time });
}));

router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
    const fields = ['name', 'start_time', 'end_time'];
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
        `UPDATE shifts SET ${updates.join(', ')} WHERE id = ? AND company_id = ?`,
        values
    );
    return res.json({ message: 'Updated' });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM shifts WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json({ message: 'Deleted' });
}));

module.exports = router;
