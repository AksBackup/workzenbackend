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

// ---------------------------------------------------------------------
// Task 4: multi-policy, shift-assignable Office Time Policy (migration_034).
// Everything below is NEW and ADDITIVE - the singleton GET '/' / PUT '/'
// routes above are completely untouched (see migration_034's header
// comment on why a separate `office_time_policies` table exists instead
// of extending the singleton `office_time_policy` one). The new Flutter
// office_time_screen.dart talks to these routes; the old GET/PUT above
// are left in place for whatever else may still call them.
// ---------------------------------------------------------------------

const POLICY_FIELDS = [
    'policy_name', 'short_name', 'grace_late_coming_minutes', 'grace_early_going_minutes',
    'weekly_off_1_day', 'weekly_off_2_day', 'weekly_off_2_occurrences',
    'absent_if_duration_less_than_minutes', 'half_day_if_duration_less_than_minutes',
    'mark_late_absent_enabled', 'mark_late_absent_status', 'mark_late_absent_after_minutes',
    'consider_only_first_last_punch', 'deduct_break_hours_from_work_duration',
    'ot_deduction_from_holiday_minutes', 'ot_deduction_from_weekly_off_minutes',
    'miss_punch_handling', 'auto_approve_gps_punch',
    'partial_day_half_day_if_duration_less_than_minutes', 'partial_day_absent_if_duration_less_than_minutes',
    'ot_formula', 'max_ot_minutes',
    'half_day_if_late_by_enabled', 'half_day_if_late_by_minutes',
    'half_day_if_early_going_by_enabled', 'half_day_if_early_going_by_minutes',
    'consider_early_coming_punch', 'consider_late_going_punch',
    'mark_absent_prefix_day', 'mark_absent_suffix_day', 'mark_absent_both_prefix_suffix_day',
    'punch_required_mode', 'present_weekly_off_count', 'check_duplicate_minute',
];

/** Pulls only the known policy fields out of req.body, in a stable order matching POLICY_FIELDS. */
function pickPolicyFields(body) {
    return POLICY_FIELDS.map((f) => (body[f] === undefined ? null : body[f]));
}

// GET /office-time-policy/policies - list every named policy for this
// company, each with the shift_ids currently assigned to it.
router.get('/policies', asyncHandler(async (req, res) => {
    const [policies] = await pool.query(
        `SELECT * FROM office_time_policies WHERE company_id = ? ORDER BY policy_name ASC`,
        [req.user.companyId]
    );
    const [assignments] = await pool.query(
        `SELECT policy_id, shift_id FROM office_time_policy_shifts WHERE company_id = ?`,
        [req.user.companyId]
    );
    const shiftsByPolicy = new Map();
    for (const a of assignments) {
        if (!shiftsByPolicy.has(a.policy_id)) shiftsByPolicy.set(a.policy_id, []);
        shiftsByPolicy.get(a.policy_id).push(a.shift_id);
    }
    return res.json(policies.map((p) => ({ ...p, shift_ids: shiftsByPolicy.get(p.id) || [] })));
}));

// POST /office-time-policy/policies - create a new named policy.
router.post('/policies', requireAdmin, asyncHandler(async (req, res) => {
    const { policy_name } = req.body;
    if (!policy_name || !policy_name.trim()) return res.status(400).json({ error: 'policy_name is required' });

    const [result] = await pool.query(
        `INSERT INTO office_time_policies (company_id, ${POLICY_FIELDS.join(', ')})
         VALUES (?, ${POLICY_FIELDS.map(() => '?').join(', ')})`,
        [req.user.companyId, ...pickPolicyFields(req.body)]
    );
    return res.status(201).json({ id: result.insertId, message: 'Policy created' });
}));

// PUT /office-time-policy/policies/:id - update an existing policy's fields.
router.put('/policies/:id', requireAdmin, asyncHandler(async (req, res) => {
    const { policy_name } = req.body;
    if (!policy_name || !policy_name.trim()) return res.status(400).json({ error: 'policy_name is required' });

    const [result] = await pool.query(
        `UPDATE office_time_policies SET ${POLICY_FIELDS.map((f) => `${f} = ?`).join(', ')}
         WHERE id = ? AND company_id = ?`,
        [...pickPolicyFields(req.body), req.params.id, req.user.companyId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Policy not found' });
    return res.json({ message: 'Policy updated' });
}));

// DELETE /office-time-policy/policies/:id
router.delete('/policies/:id', requireAdmin, asyncHandler(async (req, res) => {
    // office_time_policy_shifts rows for this policy cascade-delete
    // (ON DELETE CASCADE, migration_034) - any shift that was assigned
    // to this policy simply goes back to having no policy assigned,
    // same as a shift that was never assigned one (falls back to its
    // own legacy weekly-off/grace columns - see
    // utils/attendanceRules.js's resolveEmployeeOffDays/resolveShiftGrace).
    const [result] = await pool.query(
        `DELETE FROM office_time_policies WHERE id = ? AND company_id = ?`,
        [req.params.id, req.user.companyId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Policy not found' });
    return res.json({ message: 'Policy deleted' });
}));

// PUT /office-time-policy/policies/:id/assign-shifts
// body: { shift_ids: number[] }
// Replaces this policy's ENTIRE assigned-shift set with the given list
// (multi-select dropdown on the policy screen sends the full selection
// each time, not a delta). Since a shift can only ever belong to one
// policy (uq_office_time_policy_shifts_shift), any of the given
// shift_ids that were previously assigned to a DIFFERENT policy are
// silently moved over - that's the intended "reassign" behavior, not
// an error, since the UI lets an admin pick any shift regardless of
// its current policy.
router.put('/policies/:id/assign-shifts', requireAdmin, asyncHandler(async (req, res) => {
    const { shift_ids } = req.body;
    if (!Array.isArray(shift_ids)) return res.status(400).json({ error: 'shift_ids must be an array' });

    const [policyRows] = await pool.query(
        `SELECT id FROM office_time_policies WHERE id = ? AND company_id = ?`,
        [req.params.id, req.user.companyId]
    );
    if (policyRows.length === 0) return res.status(404).json({ error: 'Policy not found' });

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        // Clear this policy's current assignments...
        await conn.query(`DELETE FROM office_time_policy_shifts WHERE policy_id = ? AND company_id = ?`, [req.params.id, req.user.companyId]);
        // ...and clear the incoming shift_ids from whichever OTHER
        // policy currently holds them, so uq_office_time_policy_shifts_shift
        // never conflicts on insert below.
        if (shift_ids.length > 0) {
            await conn.query(
                `DELETE FROM office_time_policy_shifts WHERE company_id = ? AND shift_id IN (${shift_ids.map(() => '?').join(', ')})`,
                [req.user.companyId, ...shift_ids]
            );
            for (const shiftId of shift_ids) {
                await conn.query(
                    `INSERT INTO office_time_policy_shifts (company_id, policy_id, shift_id) VALUES (?, ?, ?)`,
                    [req.user.companyId, req.params.id, shiftId]
                );
            }
        }
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
    return res.json({ message: 'Shift assignment updated' });
}));

module.exports = router;
