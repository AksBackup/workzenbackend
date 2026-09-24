const pool = require('../db');

/**
 * Closes the gap PASS_NOTES.md flagged after migration_015 and
 * migration_016 landed: Holiday Groups and per-shift/per-department
 * weekly-off overrides were fully built at the config layer (Holiday
 * Groups screen, Branches screen, Shift rules, Weekly Off screen) but
 * nothing on the read side ever consulted them - every report and the
 * Attendance card just used one single company-wide holiday list and
 * one single company-wide weekly-off bitmask for every employee.
 *
 * This is the shared resolver both routes/reports.js and
 * routes/employees.js now call instead of each hand-rolling (or not
 * hand-rolling) this logic separately - see PASS_NOTES.md's earlier
 * note that reports.js/payroll.js already duplicate classifyDay-style
 * logic rather than share it; this at least stops that duplication
 * from growing for the newer per-employee rules.
 *
 * Everything here is loaded in a handful of batched queries up front
 * (one company-wide holiday list, one weekly_off_config list, one
 * employee->branch->group lookup) rather than a query per employee per
 * day, since a monthly/yearly report can be employees x 31 days of
 * classifyDay calls - an N+1 here would multiply straight into that.
 * The one exception is per-employee *shift* resolution
 * (resolveEffectiveShift in reports.js), which already does a query per
 * employee per day for the newer shift-aware reports (na-shift,
 * late-early, overtime, performance) - that established pattern is
 * left as-is here rather than introduced somewhere it wasn't already.
 */

/**
 * Returns { holidayDatesForGroup(groupId) }, a function you call per
 * employee (with that employee's resolved holiday_group_id, or null)
 * to get the Set<dateStr> of holidays that actually apply to them.
 *
 * holidays.holiday_group_id NULL = applies to every branch (see
 * migration_015's comment on the holidays table) - those dates are
 * always included regardless of the employee's own group. A
 * group-specific holiday is included only for employees whose branch
 * is assigned that same group.
 */
async function loadHolidayIndex(companyId, fromDateStr, toDateStr) {
    const [rows] = await pool.query(
        'SELECT date, holiday_group_id FROM holidays WHERE company_id = ? AND date BETWEEN ? AND ?',
        [companyId, fromDateStr, toDateStr]
    );
    const ungrouped = new Set();
    const byGroup = new Map(); // groupId -> Set<dateStr>
    for (const row of rows) {
        const dateStr = row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date);
        if (row.holiday_group_id == null) {
            ungrouped.add(dateStr);
        } else {
            if (!byGroup.has(row.holiday_group_id)) byGroup.set(row.holiday_group_id, new Set());
            byGroup.get(row.holiday_group_id).add(dateStr);
        }
    }
    return {
        isHoliday(dateStr, employeeGroupId) {
            if (ungrouped.has(dateStr)) return true;
            if (employeeGroupId == null) return false;
            const groupSet = byGroup.get(employeeGroupId);
            return groupSet ? groupSet.has(dateStr) : false;
        },
    };
}

/**
 * Returns Map<employeeId, holidayGroupId|null> for every employee in
 * one batched query (employees -> branches -> holiday_group_id), so
 * loadHolidayIndex's isHoliday() has what it needs per employee without
 * a per-employee query.
 */
async function loadEmployeeHolidayGroups(companyId) {
    const [rows] = await pool.query(
        `SELECT e.id AS employee_id, b.holiday_group_id
         FROM employees e
         LEFT JOIN branches b ON b.id = e.branch_id
         WHERE e.company_id = ?`,
        [companyId]
    );
    const map = new Map();
    for (const row of rows) map.set(row.employee_id, row.holiday_group_id ?? null);
    return map;
}

/**
 * Returns { companyDefault, forDepartment(deptName) } for weekly-off
 * bitmasks. weekly_off_config.department is the free-text department
 * name (matches employees.department, not department_id - see
 * schema.sql's own comment on that column), so this is keyed the same
 * way.
 */
async function loadWeeklyOffIndex(companyId) {
    const [rows] = await pool.query(
        'SELECT department, off_days_bitmask FROM weekly_off_config WHERE company_id = ?',
        [companyId]
    );
    let companyDefault = 1; // Sunday only, same fallback loadCompanyContext already used
    const byDepartment = new Map();
    for (const row of rows) {
        if (row.department == null) {
            companyDefault = row.off_days_bitmask;
        } else {
            byDepartment.set(row.department, row.off_days_bitmask);
        }
    }
    return {
        companyDefault,
        forDepartment(deptName) {
            if (!deptName) return null;
            return byDepartment.has(deptName) ? byDepartment.get(deptName) : null;
        },
    };
}

/**
 * migration_027: id -> {weekly_off_bitmask, alt_saturdays} for every
 * shift in the company, so callers with just an employee's shift_id
 * (not a full resolveEffectiveShift(...) row) can still get shift-wise
 * weekend-off resolution without an extra query per employee.
 */
async function loadShiftOffIndex(companyId) {
    const [rows] = await pool.query(
        'SELECT id, weekly_off_bitmask, alt_saturdays FROM shifts WHERE company_id = ?',
        [companyId]
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    return { byId };
}

/**
 * The actual fallback chain: a shift's own weekly_off_bitmask (if set)
 * wins outright (migration_015: NULL = inherit); otherwise a
 * department-specific weekly_off_config row; otherwise the company-wide
 * default. shift is whatever resolveEffectiveShift(...) returned (or
 * null if nothing resolved).
 */
function effectiveOffDaysBitmask(shift, employeeDepartment, weeklyOffIndex) {
    if (shift && shift.weekly_off_bitmask != null) return shift.weekly_off_bitmask;
    const deptBitmask = weeklyOffIndex.forDepartment(employeeDepartment);
    if (deptBitmask != null) return deptBitmask;
    return weeklyOffIndex.companyDefault;
}

/**
 * migration_027: is `dateStr` an alternate-Saturday-off per a shift's
 * `alt_saturdays` field (e.g. "1,3" = 1st and 3rd Saturday of the
 * month off). Only ever true for an actual Saturday - a non-Saturday
 * date always returns false regardless of what's configured. Shared
 * by reports.js (classifyDay) and employees.js's monthly-summary.
 */
function isAltSaturdayOff(dateStr, altSaturdays) {
    if (!altSaturdays) return false;
    const d = new Date(`${dateStr}T00:00:00`);
    if (d.getDay() !== 6) return false; // 6 = Saturday
    const ordinal = Math.ceil(d.getDate() / 7); // 1st/2nd/3rd/4th/5th Saturday of the month
    return altSaturdays
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n))
        .includes(ordinal);
}

module.exports = {
    loadHolidayIndex,
    loadEmployeeHolidayGroups,
    loadWeeklyOffIndex,
    loadShiftOffIndex,
    effectiveOffDaysBitmask,
    isAltSaturdayOff,
    // Task 3 (multi-punch engine) + Task 4 (Office Time Policy v2)
    // additions below. All new exports, nothing above this line
    // changed in signature or behavior - routes/employees.js (not
    // owned by this pass) imports loadWeeklyOffIndex/
    // effectiveOffDaysBitmask/isAltSaturdayOff and keeps working
    // exactly as before.
    derivePunchSpan,
    loadPunchEventsForDay,
    loadPunchEventsIndex,
    loadShiftPolicyIndex,
    loadShiftPolicyOffIndex,
    resolveShiftGrace,
    isNthWeekdayOfMonthOff,
};

/**
 * Task 3: derives {firstIn, lastOut, workMinutes} from one day's raw
 * punch_events rows (migration_033). Implements the client's exact
 * rule: full elapsed span (last punch-out minus first punch-in) by
 * default - every gap, including lunch/stepping-out, counts as office
 * time. When `deductBreaks` is true (the employee's shift's assigned
 * Office Time Policy has deduct_break_hours_from_work_duration ON),
 * every punch-out -> next punch-in gap is subtracted instead.
 */
function derivePunchSpan(events, deductBreaks) {
    if (!events || events.length === 0) return { firstIn: null, lastOut: null, workMinutes: null };
    const sorted = [...events].sort((a, b) => new Date(a.punch_time) - new Date(b.punch_time));
    const ins = sorted.filter((e) => e.punch_type === 'in');
    const outs = sorted.filter((e) => e.punch_type === 'out');
    if (ins.length === 0 || outs.length === 0) {
        // No complete in+out pair yet today (e.g. only a check-in so
        // far) - nothing to span, matches classifyDay's existing
        // "no checkout yet -> present, no hours check" behavior.
        return {
            firstIn: ins.length ? ins[0].punch_time : null,
            lastOut: outs.length ? outs[outs.length - 1].punch_time : null,
            workMinutes: null,
        };
    }

    const firstIn = ins[0].punch_time;
    const lastOut = outs[outs.length - 1].punch_time;
    let workMinutes = Math.round((new Date(lastOut) - new Date(firstIn)) / 60000);

    if (deductBreaks) {
        for (let i = 0; i < sorted.length - 1; i++) {
            const cur = sorted[i];
            const next = sorted[i + 1];
            if (cur.punch_type === 'out' && next.punch_type === 'in' && new Date(next.punch_time) < new Date(lastOut)) {
                const gapMinutes = Math.round((new Date(next.punch_time) - new Date(cur.punch_time)) / 60000);
                if (gapMinutes > 0) workMinutes -= gapMinutes;
            }
        }
        if (workMinutes < 0) workMinutes = 0;
    }

    return { firstIn, lastOut, workMinutes };
}

function toDateStrLocal(d) {
    if (d == null) return null;
    return d instanceof Date ? d.toISOString().slice(0, 10) : String(d);
}

/** Single employee-day lookup - used by anywhere not already looping a date range. */
async function loadPunchEventsForDay(companyId, employeeId, dateStr) {
    const [rows] = await pool.query(
        'SELECT punch_time, punch_type FROM punch_events WHERE company_id = ? AND employee_id = ? AND date = ? ORDER BY punch_time ASC',
        [companyId, employeeId, dateStr]
    );
    return rows;
}

/**
 * Batched version for report loops (monthly/weekly/daily reports
 * iterate many employee-days) - one query per (companyId, fromDate,
 * toDate) window instead of a query per employee-day, same batching
 * reasoning as loadHolidayIndex/loadWeeklyOffIndex above.
 */
async function loadPunchEventsIndex(companyId, fromDateStr, toDateStr) {
    const [rows] = await pool.query(
        'SELECT employee_id, date, punch_time, punch_type FROM punch_events WHERE company_id = ? AND date BETWEEN ? AND ? ORDER BY punch_time ASC',
        [companyId, fromDateStr, toDateStr]
    );
    const byKey = new Map();
    for (const r of rows) {
        const key = `${r.employee_id}|${toDateStrLocal(r.date)}`;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(r);
    }
    return {
        forEmployeeDate(employeeId, dateStr) {
            return byKey.get(`${employeeId}|${dateStr}`) || [];
        },
    };
}

/**
 * Task 4: company-wide, batched map of shift_id -> its assigned Office
 * Time Policy row's relevant fields (migration_034's
 * office_time_policy_shifts join). A shift with no assigned policy
 * simply won't appear in the map - callers fall back to the shift's
 * own legacy columns (still physically present - see migration_034's
 * header comment on why they weren't dropped) for those shifts.
 */
async function loadShiftPolicyIndex(companyId) {
    const [rows] = await pool.query(
        `SELECT ops.shift_id, p.weekly_off_1_day, p.weekly_off_2_day, p.weekly_off_2_occurrences,
                p.grace_late_coming_minutes, p.grace_early_going_minutes,
                p.deduct_break_hours_from_work_duration
         FROM office_time_policy_shifts ops
         JOIN office_time_policies p ON p.id = ops.policy_id
         WHERE ops.company_id = ?`,
        [companyId]
    );
    const byShiftId = new Map(rows.map((r) => [r.shift_id, r]));
    return {
        has(shiftId) {
            return byShiftId.has(shiftId);
        },
        deductBreaksFor(shiftId) {
            const r = byShiftId.get(shiftId);
            return !!(r && r.deduct_break_hours_from_work_duration);
        },
        graceFor(shiftId) {
            const r = byShiftId.get(shiftId);
            return {
                lateGraceMinutes: r ? r.grace_late_coming_minutes || 0 : 0,
                earlyGraceMinutes: r ? r.grace_early_going_minutes || 0 : 0,
            };
        },
    };
}

/**
 * Task 4 weekly-off half of loadShiftPolicyIndex, kept as its own
 * function (rather than folded into loadShiftPolicyIndex) since
 * reports.js's three off-days call sites (daily/monthly/weekly) don't
 * all need the grace/deduct-breaks fields, only the weekly-off ones.
 */
async function loadShiftPolicyOffIndex(companyId) {
    const [rows] = await pool.query(
        `SELECT ops.shift_id, p.weekly_off_1_day, p.weekly_off_2_day, p.weekly_off_2_occurrences
         FROM office_time_policy_shifts ops
         JOIN office_time_policies p ON p.id = ops.policy_id
         WHERE ops.company_id = ?`,
        [companyId]
    );
    const byShiftId = new Map(rows.map((r) => [r.shift_id, r]));
    return {
        has(shiftId) {
            return byShiftId.has(shiftId);
        },
        offDaysBitmaskFor(shiftId) {
            const r = byShiftId.get(shiftId);
            if (!r) return 0;
            let mask = 0;
            if (r.weekly_off_1_day != null) mask |= (1 << r.weekly_off_1_day);
            // Only folded into the plain weekly bitmask when there's no
            // ordinal-occurrence restriction - an occurrence-restricted
            // Weekly Off 2 is checked per-date via isWeeklyOff2Date
            // instead (a day-of-week bit alone can't express "only the
            // 1st and 3rd occurrence").
            if (r.weekly_off_2_day != null && !r.weekly_off_2_occurrences) mask |= (1 << r.weekly_off_2_day);
            return mask;
        },
        isWeeklyOff2Date(shiftId, dateStr) {
            const r = byShiftId.get(shiftId);
            if (!r || !r.weekly_off_2_occurrences) return false;
            return isNthWeekdayOfMonthOff(dateStr, r.weekly_off_2_day, r.weekly_off_2_occurrences);
        },
    };
}

/**
 * Single-shift, per-call grace lookup - matches resolveEffectiveShift's
 * (routes/reports.js) own per-call style for the late-early/performance
 * reports, which already loop employee-by-employee rather than
 * batching. Falls back to the shift row's own now-legacy
 * late_grace_minutes/early_grace_minutes when no policy is assigned to
 * it yet, so an unassigned shift doesn't silently lose its grace
 * configuration the moment migration_034 runs.
 */
async function resolveShiftGrace(companyId, shift) {
    if (!shift) return { lateGraceMinutes: 0, earlyGraceMinutes: 0 };
    const [rows] = await pool.query(
        `SELECT p.grace_late_coming_minutes, p.grace_early_going_minutes
         FROM office_time_policy_shifts ops
         JOIN office_time_policies p ON p.id = ops.policy_id
         WHERE ops.shift_id = ? AND ops.company_id = ? LIMIT 1`,
        [shift.id, companyId]
    );
    if (rows.length > 0) {
        return {
            lateGraceMinutes: rows[0].grace_late_coming_minutes || 0,
            earlyGraceMinutes: rows[0].grace_early_going_minutes || 0,
        };
    }
    return { lateGraceMinutes: shift.late_grace_minutes || 0, earlyGraceMinutes: shift.early_grace_minutes || 0 };
}

/**
 * Generalized version of isAltSaturdayOff (kept alongside it unchanged,
 * for routes/employees.js - see the module.exports comment above) -
 * same ordinal-occurrence rule, any weekday instead of hardcoded
 * Saturday, for Office Time Policy's Weekly Off 2 field (a day picker
 * plus occurrence checkboxes 1-5, not fixed to Saturday like the old
 * shift-level alt_saturdays field was).
 */
function isNthWeekdayOfMonthOff(dateStr, weekday, occurrences) {
    if (weekday == null || !occurrences) return false;
    const d = new Date(`${dateStr}T00:00:00`);
    if (d.getDay() !== weekday) return false;
    const ordinal = Math.ceil(d.getDate() / 7);
    return occurrences
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n))
        .includes(ordinal);
}
