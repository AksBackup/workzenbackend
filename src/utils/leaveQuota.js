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
 * YEARLY POOL precedence: leave_yearly_pools (migration_051) > 0 overrides the monthly rule for that
 * employee/type/year; see the block inside computeMonthlyPaidUsage.
 *
 * leave_types.yearly_quota is NOT read here - it's back to being a
 * separate, informational figure only (not part of this calculation),
 * matching the monthly-reset model this now implements.
 */
function addDay(dateStr, n) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

async function computeMonthlyPaidUsage(companyId, employeeId, leaveTypeId, year, month, opts = {}) {
    // opts.includePending: also count PENDING applications as "used" (reserve the balance).
    // Apply Leave uses this so two pending requests cannot both claim the same paid days.
    const statuses = opts.includePending ? ['approved', 'pending'] : ['approved'];
    const daysInMonth = new Date(year, month, 0).getDate();
    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

    // Paid usage inside [from, to]. Leave v2 (migration_043): summed from the per-day rows, so a
    // leave spanning two months only uses each month's own quota. Applications created before the
    // migration have no day rows and are counted the old way (whole application, paid_days).
    let haveDayTable = true;
    const usedBetween = async (from, to) => {
        let sum = 0;
        if (haveDayTable) {
            try {
                const [dayRows] = await pool.query(
                    `SELECT COALESCE(SUM(d.paid_fraction), 0) AS used
                     FROM leave_application_days d JOIN leave_applications a ON a.id = d.application_id
                     WHERE d.employee_id = ? AND d.leave_type_id = ? AND a.status IN (?) AND d.leave_date BETWEEN ? AND ?`,
                    [employeeId, leaveTypeId, statuses, from, to]
                );
                sum += Number(dayRows[0].used) || 0;
            } catch (err) {
                if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
                haveDayTable = false;
            }
        }
        const [leaveRows] = await pool.query(
            `SELECT a.days_count, a.paid_days FROM leave_applications a
             WHERE a.employee_id = ? AND a.leave_type_id = ? AND a.status IN (?) AND a.from_date <= ? AND a.to_date >= ?
             ${haveDayTable ? 'AND NOT EXISTS (SELECT 1 FROM leave_application_days d WHERE d.application_id = a.id)' : ''}`,
            [employeeId, leaveTypeId, statuses, to, from]
        );
        return sum + leaveRows.reduce((t, r) => t + (r.paid_days !== null ? Number(r.paid_days) : Number(r.days_count)), 0);
    };

    // YEARLY POOL (migration_051, Leave Balance Entry "Yearly total"): if a pool > 0 exists it
    // governs this employee/type/year and the monthly quota below is ignored (no double count).
    // quota = pool minus paid days already used earlier in the year, so Apply Leave, Remaining,
    // the employee summary and planLeave all consume the pool in date order, then go unpaid.
    let pool_ = 0;
    try {
        const [poolRows] = await pool.query(
            'SELECT allocated FROM leave_yearly_pools WHERE employee_id = ? AND leave_type_id = ? AND year = ?',
            [employeeId, leaveTypeId, year]
        );
        pool_ = poolRows.length ? Number(poolRows[0].allocated) || 0 : 0;
    } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
    }
    if (pool_ > 0) {
        const before = month === 1 ? 0 : await usedBetween(`${year}-01-01`, addDay(monthStart, -1));
        const usedMonth = await usedBetween(monthStart, monthEnd);
        const poolCredits = await loadMonthCredits(employeeId, leaveTypeId, year);
        let creditSum = 0;
        for (const [m, amt] of poolCredits) if (m <= month) creditSum += amt;
        return {
            quota: Math.max(0, Math.round((pool_ + creditSum - before) * 100) / 100),
            used: Math.round(usedMonth * 100) / 100,
            yearly: true,
        };
    }

    const [balanceRows] = await pool.query(
        'SELECT allocated FROM leave_balances WHERE employee_id = ? AND leave_type_id = ? AND year = ?',
        [employeeId, leaveTypeId, year]
    );
    let carryForward = false;
    let baseQuota;
    const [typeRows] = await pool.query(
        'SELECT monthly_quota, carry_forward FROM leave_types WHERE id = ? AND company_id = ?',
        [leaveTypeId, companyId]
    );
    carryForward = typeRows.length > 0 && !!typeRows[0].carry_forward;
    if (balanceRows.length > 0) {
        baseQuota = Number(balanceRows[0].allocated) || 0;
    } else {
        baseQuota = typeRows.length > 0 ? parseFloat(typeRows[0].monthly_quota) || 0 : 0;
    }

    // Month-wise credit (Leave Opening Entry, month chosen): a one-time addition for THIS month only.
    const credits = await loadMonthCredits(employeeId, leaveTypeId, year);
    const credit = credits.get(month) || 0;

    // Carry forward (only when the leave type has it ticked): unused leave of earlier months rolls in.
    let carry = 0;
    if (carryForward) {
        let startMonth = 1;
        try {
            const [emp] = await pool.query('SELECT doj FROM employees WHERE id = ?', [employeeId]);
            const doj = emp.length && emp[0].doj ? new Date(emp[0].doj) : null;
            if (doj && !Number.isNaN(doj.getTime())) {
                if (doj.getUTCFullYear() > year) startMonth = 13; // joined later: nothing to carry
                else if (doj.getUTCFullYear() === year) startMonth = doj.getUTCMonth() + 1;
            }
        } catch (err) {
            if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
        }
        carry = await carryInto({ employeeId, year, month, baseQuota, credits, usedBetween, startMonth });
    }

    const used = await usedBetween(monthStart, monthEnd);
    const quota = Math.round((baseQuota + credit + carry) * 100) / 100;
    return { quota, used: Math.round(used * 100) / 100, credit, carry };
}

/** { month -> amount } of one-time month credits for (employee, type, year). Missing table = none. */
async function loadMonthCredits(employeeId, leaveTypeId, year) {
    const out = new Map();
    try {
        const [rows] = await pool.query(
            'SELECT month, amount FROM leave_month_credits WHERE employee_id = ? AND leave_type_id = ? AND year = ?',
            [employeeId, leaveTypeId, year]
        );
        for (const r of rows) out.set(Number(r.month), Number(r.amount) || 0);
    } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
    }
    return out;
}

function monthBounds(year, month) {
    const last = new Date(year, month, 0).getDate();
    const mm = String(month).padStart(2, '0');
    return [`${year}-${mm}-01`, `${year}-${mm}-${String(last).padStart(2, '0')}`];
}

/**
 * Unused paid leave carried into (year, month): walk the months of THIS year before it (starting at the
 * employee's joining month when they joined this year), each month's closing balance (quota + credit +
 * carry in - used, never below 0) becomes the next month's carry in. Carry stays inside the calendar year:
 * what is unused at the end of December lapses, so a new year starts from the plain quota.
 */
async function carryInto({ employeeId, year, month, baseQuota, credits, usedBetween, startMonth }) {
    let carry = 0;
    for (let m = Math.max(1, startMonth); m < month; m++) {
        const [from, to] = monthBounds(year, m);
        const used = await usedBetween(from, to);
        carry = Math.max(0, baseQuota + (credits.get(m) || 0) + carry - used);
    }
    return Math.round(carry * 100) / 100;
}

module.exports = { computeMonthlyPaidUsage, loadMonthCredits };
