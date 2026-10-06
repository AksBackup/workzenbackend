const pool = require('../db');
const {
    loadHolidayIndex, loadEmployeeHolidayGroups, loadWeeklyOffIndex, loadShiftOffIndex,
    loadShiftPolicyOffIndex, isAltSaturdayOff,
} = require('./attendanceRules');
const { resolveEmployeeOffDays } = require('./dayClassifier');
const { computeMonthlyPaidUsage } = require('./leaveQuota');
const { loadLeaveIndex, addDays } = require('./leaveIndex');

/**
 * Leave v2 planner: turns "employee X applies for leave type Y from A to B (full / half /
 * quarter / few hours)" into the list of DAYS that actually count as leave, and splits them
 * into paid / unpaid. ONE place used by both Apply Leave's live preview and the real insert,
 * so the preview can never disagree with what is stored.
 *
 * Rules (industry practice, all configurable per leave type in Settings > Define Leave):
 *  - Holidays and weekly offs inside the range are counted as leave only if the leave type says so:
 *      'no'      never counted (Mon-Fri leave over a long weekend = only the working days are leave)
 *      'between' counted only when BETWEEN two leave days (the "sandwich rule")
 *      'yes'     always counted
 *  - Unpaid leave type: every counted day is unpaid (loss of pay).
 *  - Paid leave type: days are paid until that MONTH's quota (Define Leave / Opening Entry) is used up
 *    (pending requests reserve balance), the rest is unpaid.
 *  - Half / quarter / few-hours leave must be on a single working day; hours are converted to a
 *    fraction of the company full-day hours (Office Time policy).
 */
const r2 = (n) => Math.round(n * 100) / 100;
const bad = (message) => Object.assign(new Error(message), { status: 400 });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function eachDate(from, to) {
    const out = [];
    for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
    return out;
}
function timeToMinutes(t) { const m = TIME_RE.exec(t); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }

async function dayKinds(companyId, employee, from, to) {
    const holidayIndex = await loadHolidayIndex(companyId, from, to);
    const groups = await loadEmployeeHolidayGroups(companyId);
    const weeklyOffIndex = await loadWeeklyOffIndex(companyId);
    const shiftOffIndex = await loadShiftOffIndex(companyId);
    const shiftPolicyOffIndex = await loadShiftPolicyOffIndex(companyId);
    const empShift = shiftOffIndex.byId.get(employee.shift_id) ?? null;
    const { offDaysBitmask, altSaturdays, isWeeklyOff2 } =
        resolveEmployeeOffDays(employee.shift_id, empShift, employee.department, weeklyOffIndex, shiftPolicyOffIndex);
    const groupId = groups.get(employee.id) ?? null;
    const kinds = new Map();
    for (const d of eachDate(from, to)) {
        const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
        if (holidayIndex.isHoliday(d, groupId)) kinds.set(d, 'holiday');
        else if ((offDaysBitmask & (1 << dow)) !== 0 || isAltSaturdayOff(d, altSaturdays) || isWeeklyOff2(d)) kinds.set(d, 'weekly_off');
        else kinds.set(d, 'working');
    }
    return kinds;
}

async function fullDayHours(companyId) {
    const [rows] = await pool.query('SELECT full_day_hours FROM office_time_policy WHERE company_id = ?', [companyId]);
    const h = rows.length ? Number(rows[0].full_day_hours) : 8;
    return h > 0 ? h : 8;
}

/**
 * input: { companyId, employee:{id,shift_id,department}, leaveType:{id,is_paid,count_holidays,count_weekly_offs},
 *          durationType, from, to, session, fromTime, toTime }
 * returns { days:[{date,fraction,paidFraction,kind}], excluded:[{date,kind}], daysCount, paidDays, unpaidDays,
 *           dayHours, hours, durationType, session, fromTime, toTime, rangeDays }
 */
async function planLeave(input) {
    const { companyId, employee, leaveType } = input;
    const durationType = input.durationType || 'full';
    if (!['full', 'half', 'quarter', 'hours'].includes(durationType)) throw bad('Unknown leave duration type.');
    const from = input.from;
    const to = input.to || input.from;
    if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) throw bad('Dates must be in YYYY-MM-DD format.');
    if (to < from) throw bad('The end date cannot be before the start date.');
    if (eachDate(from, to).length > 366) throw bad('A leave cannot be longer than one year.');

    const kinds = await dayKinds(companyId, employee, from, to);
    const dayHours = await fullDayHours(companyId);
    let days = [];
    let excluded = [];
    let session = null, fromTime = null, toTime = null, hours = null;

    if (durationType === 'full') {
        const dates = eachDate(from, to);
        const modeH = leaveType.count_holidays || 'no';
        const modeW = leaveType.count_weekly_offs || 'no';
        const workIdx = dates.map((d, i) => (kinds.get(d) === 'working' ? i : -1)).filter(i => i >= 0);
        const firstW = workIdx.length ? workIdx[0] : -1;
        const lastW = workIdx.length ? workIdx[workIdx.length - 1] : -1;
        dates.forEach((d, i) => {
            const kind = kinds.get(d);
            let counted;
            if (kind === 'working') counted = true;
            else {
                const mode = kind === 'holiday' ? modeH : modeW;
                counted = mode === 'yes' || (mode === 'between' && firstW >= 0 && i > firstW && i < lastW);
            }
            if (counted) days.push({ date: d, fraction: 1, kind });
            else excluded.push({ date: d, kind });
        });
        if (days.length === 0) throw bad('All the selected days are holidays or weekly offs, so there is no leave to apply for.');
    } else {
        if (from !== to) throw bad('Half day, quarter day and hours leave must be for a single date.');
        const kind = kinds.get(from);
        if (kind !== 'working') throw bad(`${from} is a ${kind === 'holiday' ? 'holiday' : 'weekly off'} - choose a working day.`);
        let fraction;
        if (durationType === 'half') {
            session = input.session === 'second' ? 'second' : 'first';
            fraction = 0.5;
        } else if (durationType === 'quarter') {
            fraction = 0.25;
        } else {
            fromTime = input.fromTime; toTime = input.toTime;
            const a = timeToMinutes(fromTime || ''), b = timeToMinutes(toTime || '');
            if (a == null || b == null) throw bad('Enter the from and to time as HH:MM (24-hour).');
            if (b <= a) throw bad('The "to" time must be after the "from" time.');
            hours = r2((b - a) / 60);
            if (hours >= dayHours) throw bad(`${hours} hours is a full day (${dayHours} h) - choose Full day instead.`);
            fraction = r2(hours / dayHours);
            if (fraction <= 0) throw bad('Leave must be longer than a few minutes.');
        }
        days.push({ date: from, fraction, kind });
    }

    // paid / unpaid split
    const isPaidType = leaveType.is_paid === undefined ? true : !!Number(leaveType.is_paid);
    const budgets = new Map(); // 'YYYY-MM' -> paid days still available that month
    for (const d of days) {
        let paid = 0;
        if (isPaidType) {
            const ym = d.date.slice(0, 7);
            if (!budgets.has(ym)) {
                const { quota, used } = await computeMonthlyPaidUsage(
                    companyId, employee.id, leaveType.id, Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), { includePending: true });
                budgets.set(ym, Math.max(0, quota - used));
            }
            const avail = budgets.get(ym);
            paid = Math.min(d.fraction, avail);
            budgets.set(ym, r2(avail - paid));
        }
        d.paidFraction = r2(paid);
    }

    // refuse overlapping leave (pending or approved) that would exceed one full day
    const idx = await loadLeaveIndex(companyId, from, to, { statuses: ['approved', 'pending'], employeeId: employee.id });
    for (const d of days) {
        const existing = idx.get(employee.id, d.date);
        if (existing && existing.fraction + d.fraction > 1.0001) {
            throw bad(`This employee already has leave applied for ${d.date}.`);
        }
    }

    const daysCount = r2(days.reduce((a, d) => a + d.fraction, 0));
    const paidDays = r2(days.reduce((a, d) => a + d.paidFraction, 0));
    return {
        days, excluded, daysCount, paidDays, unpaidDays: r2(daysCount - paidDays),
        dayHours, hours, durationType, session, fromTime, toTime,
        rangeDays: eachDate(from, to).length, isPaidType,
    };
}

module.exports = { planLeave };
