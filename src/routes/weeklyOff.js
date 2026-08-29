const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

router.get('/', asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        'SELECT id, department, off_days_bitmask, alternate_saturdays FROM weekly_off_config WHERE company_id = ?',
        [req.user.companyId]
    );
    return res.json(rows);
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { department, off_days_bitmask, alternate_saturdays } = req.body;
    if (off_days_bitmask === undefined || off_days_bitmask === null) {
        return res.status(400).json({ error: 'off_days_bitmask required' });
    }

    const [result] = await pool.query(
        'INSERT INTO weekly_off_config (company_id, department, off_days_bitmask, alternate_saturdays) VALUES (?, ?, ?, ?)',
        [req.user.companyId, department || null, off_days_bitmask, alternate_saturdays || null]
    );
    return res.status(201).json({ id: result.insertId });
}));

module.exports = router;
