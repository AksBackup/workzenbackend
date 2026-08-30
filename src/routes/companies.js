const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

// `companies` table already existed (name, address, phone, email) - one
// row per company (3.1 Company Details is just an edit form over it, no
// new table). Scoped by req.user.companyId same as every other route,
// even though there's only ever one row a given token could reach.

router.get('/', asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        'SELECT id, name, address, phone, email, status FROM companies WHERE id = ?',
        [req.user.companyId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Company not found' });
    return res.json(rows[0]);
}));

router.put('/', requireAdmin, asyncHandler(async (req, res) => {
    const fields = ['name', 'address', 'phone', 'email'];
    const updates = [];
    const values = [];
    fields.forEach(f => {
        if (req.body[f] !== undefined) {
            updates.push(`${f} = ?`);
            values.push(req.body[f]);
        }
    });
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    values.push(req.user.companyId);
    await pool.query(`UPDATE companies SET ${updates.join(', ')} WHERE id = ?`, values);
    return res.json({ message: 'Updated' });
}));

module.exports = router;
