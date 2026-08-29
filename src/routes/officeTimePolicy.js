const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

const DEFAULTS = {
    check_in_time: '09:00:00',
    check_out_time: '18:00:00',
    full_day_hours: 8.0,
    half_day_min_hours: 4.0
};

router.get('/', asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        'SELECT check_in_time, check_out_time, full_day_hours, half_day_min_hours FROM office_time_policy WHERE company_id = ?',
        [req.user.companyId]
    );
    if (rows.length === 0) {
        // No row yet for this company - return sensible defaults rather
        // than 404, since "not configured yet" is a normal, expected state
        // for a fresh company, not an error.
        return res.json(DEFAULTS);
    }
    return res.json(rows[0]);
}));

router.put('/', requireAdmin, asyncHandler(async (req, res) => {
    const {
        check_in_time = DEFAULTS.check_in_time,
        check_out_time = DEFAULTS.check_out_time,
        full_day_hours = DEFAULTS.full_day_hours,
        half_day_min_hours = DEFAULTS.half_day_min_hours
    } = req.body;

    await pool.query(
        `INSERT INTO office_time_policy (company_id, check_in_time, check_out_time, full_day_hours, half_day_min_hours)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           check_in_time = VALUES(check_in_time),
           check_out_time = VALUES(check_out_time),
           full_day_hours = VALUES(full_day_hours),
           half_day_min_hours = VALUES(half_day_min_hours)`,
        [req.user.companyId, check_in_time, check_out_time, full_day_hours, half_day_min_hours]
    );
    return res.json({ message: 'Updated' });
}));

module.exports = router;
