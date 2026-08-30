const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

const DEFAULTS = {
    check_in_time: '09:00:00',
    // migration_010: end of the on-time check-in grace window - a punch
    // any time between check_in_time and this is an on-time check-in;
    // after it, the punch still gets recorded (never dropped), just
    // flagged 'late' in GET /employees/:id/monthly-summary. Admin sets
    // this per company in Settings > Office Time.
    check_in_window_end: '09:45:00',
    check_out_time: '18:00:00',
    full_day_hours: 8.0,
    half_day_min_hours: 4.0,
    // overtime_rate_per_hour intentionally has no default - null means
    // "admin hasn't set a rate yet", which utils/overtime.js treats as
    // "don't auto-compute overtime" rather than pricing it at ₹0/hour.
    overtime_rate_per_hour: null,
    // DEPRECATED as of migration_010 - kept only so old rows/clients that
    // still send it don't break. The unified leave system now keeps each
    // leave type's own monthly quota on leave_types.monthly_quota (see
    // routes/leaveTypes.js / routes/leaves.js) instead of one flat
    // company-wide number here. Not read by anything new; not exposed in
    // the Office Time settings screen anymore.
    monthly_leave_quota: 5.0
};

router.get('/', asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        `SELECT check_in_time, check_in_window_end, check_out_time, full_day_hours, half_day_min_hours,
                overtime_rate_per_hour, monthly_leave_quota
         FROM office_time_policy WHERE company_id = ?`,
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
        check_in_window_end = DEFAULTS.check_in_window_end,
        check_out_time = DEFAULTS.check_out_time,
        full_day_hours = DEFAULTS.full_day_hours,
        half_day_min_hours = DEFAULTS.half_day_min_hours,
        overtime_rate_per_hour = null,
        // Accepted but no longer surfaced in the settings screen - see
        // DEPRECATED note above. Left writable (rather than removed) so
        // no existing caller breaks; if the request doesn't send it, the
        // COALESCE below leaves whatever was already stored untouched
        // instead of silently resetting it to the 5.0 default on save.
        monthly_leave_quota
    } = req.body;

    await pool.query(
        `INSERT INTO office_time_policy
           (company_id, check_in_time, check_in_window_end, check_out_time, full_day_hours, half_day_min_hours, overtime_rate_per_hour, monthly_leave_quota)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           check_in_time = VALUES(check_in_time),
           check_in_window_end = VALUES(check_in_window_end),
           check_out_time = VALUES(check_out_time),
           full_day_hours = VALUES(full_day_hours),
           half_day_min_hours = VALUES(half_day_min_hours),
           overtime_rate_per_hour = VALUES(overtime_rate_per_hour),
           monthly_leave_quota = COALESCE(?, monthly_leave_quota)`,
        [req.user.companyId, check_in_time, check_in_window_end, check_out_time, full_day_hours, half_day_min_hours,
            overtime_rate_per_hour, monthly_leave_quota ?? DEFAULTS.monthly_leave_quota, monthly_leave_quota ?? null]
    );
    return res.json({ message: 'Updated' });
}));

module.exports = router;
