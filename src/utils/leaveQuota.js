const pool = require('../db');

/**
 * How many paid leave days has this employee used for THIS SPECIFIC
 * LEAVE TYPE in (year, month), and what's that type's quota for that
 * month.
 *
 * HISTORY (so a future pass doesn't re-litigate this): this used to be
 * a flat monthly reset reading only leave_types.monthly_quota, which
 * meant Leave Opening Entry and Earn/Adjust Leave (both writing to
 * leave_balances) had literally no effect on what an employee could
 * apply for or get paid - crediting +1 earned leave updated a ledger
 * nothing else read. A later pass rewired this into an ANNUAL bank
 * instead (leave_balances.allocated for the whole year, usage summed
 * across the whole year) to make Opening Entry/Earn-Adjust actually
 * matter. The person running this app then asked to go back to a
 * MONTHLY reset - this is that request, implemented properly rather
 * than just reverted, so Opening Entry/Earn-Adjust still actually do
 * something:
 *
 *   - quota = leave_balances.allocated for (employee, leave_type, year)
 *     IF a row exists - i.e. Opening Entry / Earn-Adjust Leave sets
 *     THIS EMPLOYEE's personal monthly quota for that leave type,
 *     overriding the type's company-wide default, for every month of
 *     that year (there's no month column on leave_balances - one
 *     number per employee/type/year is treated as "this many days a
 *     month, all year," matching how the person describes using
 *     Opening Entry: "adjusted from 2 to 6 per month").
 *   - OTHERWISE falls back to leave_types.monthly_quota, the plain
 *     company-wide default from Define Leave Types.
 *   - "used" is summed for JUST the one (year, month) being checked,
 *     not the whole year - a true reset each month.
 *
 * leave_types.yearly_quota is NOT read here - it's back to being a
 * separate, informational figure only (not part of this calculation),
 * matching the monthly-reset model this now implements.
 */
async function computeMonthlyPaidUsage(companyId, employeeId, leaveTypeId, year, month, opts = {}) {
    // opts.includePending: also count PENDING applications as "used" (reserve the balance).
    // Apply Leave uses this so two pending requests cannot both claim the same paid days.
    const statuses = opts.includePending ? ['approved', 'pending'] : ['approved'];
    const daysInMonth = new Date(year, month, 0).getDate();
    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

    const [balanceRows] = await pool.query(
        'SELECT allocated FROM leave_balances WHERE employee_id = ? AND leave_type_id = ? AND year = ?',
        [employeeId, leaveTypeId, year]
    );

    let quota;
    if (balanceRows.length > 0) {
        quota = Number(balanceRows[0].allocated) || 0;
    } else {
        const [typeRows] = await pool.query(
            'SELECT monthly_quota FROM leave_types WHERE id = ? AND company_id = ?',
            [leaveTypeId, companyId]
        );
        quota = typeRows.length > 0 ? parseFloat(typeRows[0].monthly_quota) || 0 : 0;
    }

    // Leave v2 (migration_043): paid usage is summed from the per-day rows, so a leave that
    // spans two months only uses each month's own quota. Applications created before the
    // migration have no day rows and are counted the old way (whole application, paid_days).
    let used = 0;
    let haveDayTable = true;
    try {
        const [dayRows] = await pool.query(
            `SELECT COALESCE(SUM(d.paid_fraction), 0) AS used
             FROM leave_application_days d JOIN leave_applications a ON a.id = d.application_id
             WHERE d.employee_id = ? AND d.leave_type_id = ? AND a.status IN (?) AND d.leave_date BETWEEN ? AND ?`,
            [employeeId, leaveTypeId, statuses, monthStart, monthEnd]
        );
        used += Number(dayRows[0].used) || 0;
    } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
        haveDayTable = false;
    }
    const [leaveRows] = await pool.query(
        `SELECT a.days_count, a.paid_days FROM leave_applications a
         WHERE a.employee_id = ? AND a.leave_type_id = ? AND a.status IN (?) AND a.from_date <= ? AND a.to_date >= ?
         ${haveDayTable ? 'AND NOT EXISTS (SELECT 1 FROM leave_application_days d WHERE d.application_id = a.id)' : ''}`,
        [employeeId, leaveTypeId, statuses, monthEnd, monthStart]
    );
    used += leaveRows.reduce((sum, r) => sum + (r.paid_days !== null ? Number(r.paid_days) : Number(r.days_count)), 0);

    return { quota, used: Math.round(used * 100) / 100 };
}

module.exports = { computeMonthlyPaidUsage };
