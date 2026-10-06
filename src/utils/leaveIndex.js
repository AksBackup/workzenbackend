const pool = require('../db');

/**
 * Read-side view of leave for payroll + every attendance report, so they can never disagree.
 *
 * Source of truth = leave_application_days (one row per COUNTED leave day, written when the
 * application is created - see utils/leaveDays.js). Applications created before migration_043
 * have no day rows; they are expanded here on the fly with the OLD rule (calendar range,
 * first `paid_days` days paid) so history keeps working untouched.
 *
 * Returned helpers (all keyed by employee id + 'YYYY-MM-DD'):
 *   get(emp, date)            -> null | { fraction, paidFraction, kind }   (merged if several applications)
 *   isFullLeave(emp, date)    -> a whole-day leave (fraction ~ 1)
 *   partialFraction(emp, date)-> 0.25 / 0.5 / ... when only part of the day is leave, else 0
 */
function dateKey(d) {
    if (d == null) return null;
    return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}
function addDays(dateStr, n) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}
function r2(n) { return Math.round(n * 100) / 100; }

async function loadLeaveIndex(companyId, fromStr, toStr, opts = {}) {
    const statuses = opts.statuses || ['approved'];
    const empFilter = opts.employeeId ? ' AND employee_id = ?' : '';
    const entries = new Map(); // `${emp}|${date}` -> [{fraction, paidFraction, kind}]
    const push = (emp, date, e) => {
        const k = `${emp}|${date}`;
        if (!entries.has(k)) entries.set(k, []);
        entries.get(k).push(e);
    };

    let haveDayTable = true;
    try {
        const params = [companyId, fromStr, toStr, statuses];
        if (opts.employeeId) params.push(opts.employeeId);
        const [rows] = await pool.query(
            `SELECT d.employee_id, d.leave_date, d.fraction, d.paid_fraction, d.kind
             FROM leave_application_days d JOIN leave_applications a ON a.id = d.application_id
             WHERE d.company_id = ? AND d.leave_date BETWEEN ? AND ? AND a.status IN (?)${empFilter.replace('employee_id', 'd.employee_id')}`,
            params);
        for (const r of rows) {
            push(r.employee_id, dateKey(r.leave_date), {
                fraction: Number(r.fraction), paidFraction: Number(r.paid_fraction), kind: r.kind || 'working',
            });
        }
    } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
        haveDayTable = false;
    }

    // Legacy applications (no day rows): old calendar-range rule.
    const legacyParams = [companyId, statuses, toStr, fromStr];
    if (opts.employeeId) legacyParams.push(opts.employeeId);
    const legacySql = `SELECT a.employee_id, a.from_date, a.to_date, a.days_count, a.paid_days FROM leave_applications a
        WHERE a.company_id = ? AND a.status IN (?) AND a.from_date <= ? AND a.to_date >= ?
        ${haveDayTable ? 'AND NOT EXISTS (SELECT 1 FROM leave_application_days d WHERE d.application_id = a.id)' : ''}
        ${opts.employeeId ? 'AND a.employee_id = ?' : ''}`;
    const [legacy] = await pool.query(legacySql, legacyParams);
    for (const l of legacy) {
        const from = dateKey(l.from_date), to = dateKey(l.to_date);
        const daysCount = Number(l.days_count);
        const paidDays = l.paid_days !== null && l.paid_days !== undefined ? Number(l.paid_days) : daysCount;
        if (from === to && daysCount > 0 && daysCount < 1) {
            // old "0.5 days" application on one date = a partial day
            push(l.employee_id, from, { fraction: daysCount, paidFraction: Math.min(daysCount, paidDays), kind: 'working' });
            continue;
        }
        for (let d = from, idx = 0; d <= to; d = addDays(d, 1), idx++) {
            if (d < fromStr || d > toStr) continue;
            push(l.employee_id, d, { fraction: 1, paidFraction: r2(Math.max(0, Math.min(1, paidDays - idx))), kind: 'working' });
        }
    }

    const merged = new Map();
    const get = (emp, date) => {
        const k = `${emp}|${date}`;
        if (merged.has(k)) return merged.get(k);
        const list = entries.get(k);
        let out = null;
        if (list && list.length) {
            const fraction = Math.min(1, r2(list.reduce((a, e) => a + e.fraction, 0)));
            const paidFraction = Math.min(fraction, r2(list.reduce((a, e) => a + e.paidFraction, 0)));
            const kindEntry = list.find(e => e.kind !== 'working') || list[0];
            out = { fraction, paidFraction, kind: kindEntry.kind };
        }
        merged.set(k, out);
        return out;
    };
    return {
        get,
        isFullLeave: (emp, date) => { const e = get(emp, date); return !!e && e.fraction >= 0.999; },
        partialFraction: (emp, date) => { const e = get(emp, date); return e && e.fraction < 0.999 ? e.fraction : 0; },
    };
}

module.exports = { loadLeaveIndex, dateKey, addDays };
