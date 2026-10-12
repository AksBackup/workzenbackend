const pool = require('../db');

/**
 * migration_051 - "no shift" employees.
 *
 * An employee with work_mode 'office_policy' and an office_time_policy_id has
 * no shift. Every shift-keyed lookup (policy rules, grace, weekly off,
 * deduct-breaks, prefix/suffix, punch window, OT end time) then runs off a key
 * instead of a shift id: basisKeyFor(emp) returns the shift_id for shift
 * employees (unchanged) or 'p:<policyId>' for no-shift employees.
 * utils/attendanceRules.js indexes every policy under that 'p:' key too, and
 * loadOfficePolicyShifts builds a "virtual shift" for the policy so the day
 * classifier, punch pairing and late/early code get a shift-shaped object with
 * the policy's in/out times.
 */

function isOfficePolicyEmployee(emp) {
    return !!emp && emp.work_mode === 'office_policy' && emp.office_time_policy_id != null;
}

function basisKeyFor(emp) {
    if (!emp) return null;
    return isOfficePolicyEmployee(emp) ? `p:${emp.office_time_policy_id}` : (emp.shift_id ?? null);
}

/**
 * Builds the shift-shaped object for one Office Time Policy. Times fall back to
 * the company Office Time check-in / check-out when the policy leaves them blank.
 * ot_allowed is on: a no-shift employee's OT is measured from the policy end time.
 */
function virtualShiftFromPolicy(policy, companyTimes) {
    return {
        id: `p:${policy.id}`,
        name: policy.policy_name || 'Office policy',
        start_time: policy.check_in_time || companyTimes.check_in_time,
        end_time: policy.check_out_time || companyTimes.check_out_time,
        ot_allowed: 1,
        single_punch_policy: 'none',
        is_half_day_shift: 0,
        weekly_off_bitmask: null,
        alt_saturdays: null,
        late_grace_minutes: 0,
        early_grace_minutes: 0,
        is_default: 0,
        office_policy: true,
    };
}

/**
 * { forPolicyId(id) -> virtual shift | null }, built once per request/report.
 * Works before migration_051 is applied: the policy in/out columns are then
 * missing, the query falls back to no policies, and nobody is a no-shift employee.
 */
async function loadOfficePolicyShifts(companyId) {
    let companyTimes = { check_in_time: '09:00:00', check_out_time: '18:00:00' };
    const [companyRows] = await pool.query(
        'SELECT check_in_time, check_out_time FROM office_time_policy WHERE company_id = ?', [companyId]);
    if (companyRows.length) {
        companyTimes = {
            check_in_time: companyRows[0].check_in_time || companyTimes.check_in_time,
            check_out_time: companyRows[0].check_out_time || companyTimes.check_out_time,
        };
    }
    let policies = [];
    try {
        [policies] = await pool.query(
            'SELECT id, policy_name, check_in_time, check_out_time FROM office_time_policies WHERE company_id = ?', [companyId]);
    } catch (err) {
        if (err.code !== 'ER_BAD_FIELD_ERROR' && err.code !== 'ER_NO_SUCH_TABLE') throw err; // migration_051 not run yet
    }
    const byId = new Map(policies.map((p) => [Number(p.id), virtualShiftFromPolicy(p, companyTimes)]));
    return {
        all() { return [...byId.values()]; },
        forPolicyId(policyId) {
            return byId.get(Number(policyId)) || null;
        },
    };
}

/**
 * Single-employee version for routes that look one employee up at a time
 * (utils/overtime.js). Returns the virtual shift for a no-shift employee, or null.
 */
async function officePolicyShiftFor(companyId, employeeId) {
    let rows = [];
    try {
        [rows] = await pool.query(
            'SELECT work_mode, office_time_policy_id FROM employees WHERE id = ? AND company_id = ?', [employeeId, companyId]);
    } catch (err) {
        if (err.code !== 'ER_BAD_FIELD_ERROR') throw err; // migration_051 not run yet
        return null;
    }
    if (!rows.length || !isOfficePolicyEmployee(rows[0])) return null;
    const index = await loadOfficePolicyShifts(companyId);
    return index.forPolicyId(rows[0].office_time_policy_id);
}

/**
 * Adds every policy's virtual shift to a Map keyed by shift id, under its 'p:<id>' key, so
 * reports that do shiftDetails.get(basisKeyFor(emp)) find the policy window for no-shift employees.
 */
async function addPolicyShiftsToMap(companyId, map) {
    const index = await loadOfficePolicyShifts(companyId);
    for (const v of index.all()) map.set(v.id, v);
    return map;
}

module.exports = {
    addPolicyShiftsToMap,
    isOfficePolicyEmployee,
    basisKeyFor,
    loadOfficePolicyShifts,
    officePolicyShiftFor,
    virtualShiftFromPolicy,
};
