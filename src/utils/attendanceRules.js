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

module.exports = {
    loadHolidayIndex,
    loadEmployeeHolidayGroups,
    loadWeeklyOffIndex,
    effectiveOffDaysBitmask,
};
