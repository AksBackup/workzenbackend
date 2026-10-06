const {
    isAltSaturdayOff,
    effectiveOffDaysBitmask,
} = require('./attendanceRules');

/**
 * SHARED day classifier - used by reports.js (daily / weekly / monthly /
 * muster / yearly) AND payroll.js, so "present / half day / absent" can never
 * disagree between a report and the salary computed from it.
 * (Before this file existed classifyDay lived privately in reports.js and
 * payroll.js re-implemented a weaker copy that ignored per-shift policies,
 * holiday groups, weekly-off 2, prefix/suffix rules and multi-punch data.)
 */

/**
 * A check-out only counts if it is a REAL later punch. A device that records a
 * single scan can end up with check_out === check_in (or a few seconds later,
 * e.g. a double-tap). Treating that as "worked 0 hours" made present employees
 * show as ABSENT ("A") in the Daily report. Anything under 1 minute of span is
 * now treated as "no check-out yet" (a missed punch), exactly like a bare
 * check-in.
 */
function hasRealCheckout(attendance) {
    if (!attendance || !attendance.check_in || !attendance.check_out) return false;
    return (new Date(attendance.check_out) - new Date(attendance.check_in)) >= 60 * 1000;
}

/**
 * Classifies one employee-day. Returns one of:
 * 'holiday' | 'weekly_off' | 'leave' | 'present' | 'half_day' | 'absent'
 *
 * `rules` (optional) = the employee's shift's assigned Office Time Policy
 * thresholds { absentMinutes, halfDayMinutes, halfDayIfLateMinutes,
 * halfDayIfEarlyMinutes }. When a threshold is null/undefined we fall back to
 * the company-wide full_day_hours / half_day_min_hours from office_time_policy.
 * `lateMinutes` / `earlyMinutes` are the (post-grace) late-in / early-out
 * minutes for that day, used only for the "half day if late/early by X" rules.
 */
function classifyDay({
    dateStr, dayOfWeek, isHoliday, offDaysBitmask, altSaturdays,
    isWeeklyOff2 = () => false, isOnApprovedLeave, attendance,
    fullDayHours, halfDayMinHours,
    workMinutesOverride = undefined,
    rules = null, lateMinutes = 0, earlyMinutes = 0,
    thresholdScale = 1,
}) {
    // thresholdScale (<1): the person has a part-day leave (half / quarter / hours), so only the
    // remaining share of the day was expected - the duration thresholds shrink by that share.
    fullDayHours = fullDayHours * thresholdScale;
    halfDayMinHours = halfDayMinHours * thresholdScale;
    if (isHoliday(dateStr)) return 'holiday';
    if ((offDaysBitmask & (1 << dayOfWeek)) !== 0) return 'weekly_off';
    if (isAltSaturdayOff(dateStr, altSaturdays)) return 'weekly_off';
    if (isWeeklyOff2(dateStr)) return 'weekly_off';
    if (isOnApprovedLeave(dateStr)) return 'leave';
    if (!attendance || !attendance.check_in) return 'absent';

    // Bare check-in / single scan: present, no hours check (see hasRealCheckout).
    const realCheckout = workMinutesOverride != null ? true : hasRealCheckout(attendance);
    if (!realCheckout) return 'present';

    const minutes = workMinutesOverride != null
        ? workMinutesOverride
        : (new Date(attendance.check_out) - new Date(attendance.check_in)) / 60000;

    // Policy thresholds are "duration LESS THAN x minutes => ..." (policy screen wording).
    const absentBelow = rules && rules.absentMinutes != null ? Number(rules.absentMinutes) * thresholdScale : null;
    const halfBelow = rules && rules.halfDayMinutes != null ? Number(rules.halfDayMinutes) * thresholdScale : null;

    let status;
    if (absentBelow != null || halfBelow != null) {
        if (absentBelow != null && minutes < absentBelow) status = 'absent';
        else if (halfBelow != null && minutes < halfBelow) status = 'half_day';
        else status = 'present';
    } else {
        const hours = minutes / 60;
        status = hours >= fullDayHours ? 'present' : hours >= halfDayMinHours ? 'half_day' : 'absent';
    }

    if (status === 'present' && rules) {
        if (rules.halfDayIfLateMinutes != null && lateMinutes > Number(rules.halfDayIfLateMinutes)) status = 'half_day';
        else if (rules.halfDayIfEarlyMinutes != null && earlyMinutes > Number(rules.halfDayIfEarlyMinutes)) status = 'half_day';
    }
    return status;
}

/**
 * Resolves one employee's weekly-off inputs for classifyDay, preferring the
 * shift's assigned Office Time Policy over legacy shift columns / department /
 * company weekly-off config (unchanged behaviour, moved here from reports.js).
 */
function resolveEmployeeOffDays(empShiftId, empShift, employeeDepartment, weeklyOffIndex, shiftPolicyOffIndex) {
    if (empShiftId != null && shiftPolicyOffIndex.has(empShiftId)) {
        return {
            offDaysBitmask: shiftPolicyOffIndex.offDaysBitmaskFor(empShiftId),
            altSaturdays: null,
            isWeeklyOff2: (d) => shiftPolicyOffIndex.isWeeklyOff2Date(empShiftId, d),
        };
    }
    return {
        offDaysBitmask: effectiveOffDaysBitmask(empShift, employeeDepartment, weeklyOffIndex),
        altSaturdays: empShift ? empShift.alt_saturdays : null,
        isWeeklyOff2: () => false,
    };
}

/**
 * Post-grace late-in / early-out minutes for one day against a shift row.
 * Single source for Daily / Late-Early / Muster / Payroll so they agree.
 * `grace` = { lateGraceMinutes, earlyGraceMinutes } (policy grace if the shift
 * has an assigned policy, else the shift's own legacy columns).
 */
function computeLateEarly(dateStr, attendance, shift, grace) {
    let lateMinutes = 0, earlyMinutes = 0;
    if (!shift || !attendance || !attendance.check_in) return { lateMinutes, earlyMinutes };
    const g = grace || { lateGraceMinutes: shift.late_grace_minutes || 0, earlyGraceMinutes: shift.early_grace_minutes || 0 };
    const actualIn = new Date(attendance.check_in);
    const start = new Date(`${dateStr}T${shift.start_time}`);
    start.setMinutes(start.getMinutes() + (g.lateGraceMinutes || 0));
    if (actualIn > start) lateMinutes = Math.round((actualIn - start) / 60000);
    if (hasRealCheckout(attendance)) {
        const actualOut = new Date(attendance.check_out);
        const end = new Date(`${dateStr}T${shift.end_time}`);
        end.setMinutes(end.getMinutes() - (g.earlyGraceMinutes || 0));
        if (actualOut < end) earlyMinutes = Math.round((end - actualOut) / 60000);
    }
    return { lateMinutes, earlyMinutes };
}

module.exports = { classifyDay, resolveEmployeeOffDays, hasRealCheckout, computeLateEarly };
