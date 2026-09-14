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
async function computeMonthlyPaidUsage(companyId, employeeId, leaveTypeId, year, month) {
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

    const [leaveRows] = await pool.query(
        `SELECT days_count, paid_days FROM leave_applications
         WHERE employee_id = ? AND leave_type_id = ? AND status = 'approved' AND from_date <= ? AND to_date >= ?`,
        [employeeId, leaveTypeId, monthEnd, monthStart]
    );
    const used = leaveRows.reduce((sum, r) => sum + (r.paid_days !== null ? Number(r.paid_days) : Number(r.days_count)), 0);

    return { quota, used };
}

module.exports = { computeMonthlyPaidUsage };
