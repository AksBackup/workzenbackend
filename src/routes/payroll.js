const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');
const {
    loadHolidayIndex, loadEmployeeHolidayGroups, loadWeeklyOffIndex, loadShiftOffIndex,
    loadPunchEventsIndex, loadShiftPolicyIndex, loadShiftPolicyOffIndex,
    derivePunchSpan, applyPrefixSuffixAbsent,
} = require('../utils/attendanceRules');
const { resolvePaymentWindow } = require('../utils/paymentWindow');
const { classifyDay, resolveEmployeeOffDays, computeLateEarly } = require('../utils/dayClassifier');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Payroll calculation rule (see FROZEN_CONTRACT.md - this is the
 * documented MVP rule, not independently confirmed with the client,
 * flag back if it needs to change):
 *
 * Per employee per day in the target month:
 *   - Holiday or weekly-off day -> excluded entirely, paid automatically
 *   - Day falls inside an APPROVED leave application -> full day pay for
 *     that day's *paid* portion, no pay for its *unpaid* portion
 *     (migration_009 paid/unpaid split, Part 4 - see leavePayStatusFor()
 *     below and routes/leaves.js POST / for how the split is decided)
 *   - Otherwise, check attendance for that day:
 *       hours >= full_day_hours          -> full day pay
 *       hours >= half_day_min_hours
 *         and < full_day_hours           -> half day pay
 *       hours < half_day_min_hours,
 *         or no punch at all             -> no pay
 *   - hours = (check_out - check_in) in hours; missing check_out = 0 hours
 *
 * per-day rate = employee.salary (or designation default_salary if
 * employee.salary is null) / (calendar days in that month)
 * total_pay = SUM(per-day amounts across the month) + bonus + approved overtime pay
 *
 * Overtime (migration_008): SUM(overtime_records.amount) for that
 * employee/month, APPROVED records only - pending/rejected overtime
 * never affects pay. See utils/overtime.js for how those records get
 * created in the first place.
 */

/**
 * Shared 2-decimal rounding - used across computeMonthlyPayroll and
 * computeStatutoryDeductions so both round money the same way.
 */
function round2(n) {
    return Math.round(n * 100) / 100;
}

/**
 * Shared computation behind GET / (all employees, admin), GET /me and
 * GET /:employeeId/breakdown. ONE engine, one set of rules.
 *
 * ---- PAYROLL v3 (replaces the old flat-salary computation) ----------------
 * Every figure below is what the Payroll screens, the Payment Setup "Fixed
 * Heads" preview and the pay dialog show. Order of calculation:
 *
 *  1. BASE SALARY      employees.salary (Employee Details) - read-only here.
 *                      Falls back to the designation's default_salary.
 *  2. EARNED           base / days_in_month x payable day-units, where each day
 *                      is classified by the SAME shared classifier the
 *                      attendance reports use (utils/dayClassifier.js):
 *                        present 1 | half_day 0.5 | absent 0
 *                        paid holiday 1 | weekly off 1 (0 if prefix/suffix rule
 *                        turns it absent) | approved paid leave 1 | unpaid leave 0
 *                      Per-shift Office Time Policy (duration thresholds, half
 *                      day if late/early by X, grace, weekly-off 1/2, holiday
 *                      groups, break deduction) is honoured; company-wide
 *                      full/half-day hours are only the fallback.
 *                      Days before the employee's joining date are not counted.
 *  3. OVERTIME         APPROVED overtime_records only (rate = employee override
 *                      fixed / % else company rate, see utils/overtime.js).
 *                      Pending OT hours are reported but NOT paid.
 *  4. BONUS            SUM of Bonus Payroll line items for the month (falls
 *                      back to the legacy single payroll_records.bonus only
 *                      when there are no line items).
 *  5. STATUTORY        PF / ESI / PT / TDS - employee override when its
 *                      "Active" switch is on, otherwise master Statutory
 *                      Settings. Wage bases (industry norm): PF on earned
 *                      basic wage only; ESI on earned + addition heads (no
 *                      OT / bonus); PT & TDS on total gross earnings.
 *  TOTAL 1 = earned + overtime + bonus - statutory
 *  6. ADDITION HEADS   Payment Setup addition heads (flat monthly amounts).
 *  TOTAL 2 = total 1 + addition heads
 *  7. DEDUCTION HEADS  Payment Setup deduction heads + auto loan deduction.
 *  GROSS TOTAL = total 2 - deduction heads - loan deduction   <- amount to pay
 *
 * Once a month is PAID the figures are frozen (payroll_records.paid_snapshot),
 * so later attendance/setup edits can never silently change what was paid.
 *
 * Backward compatible fields kept for the other screens / Android app:
 *   base_pay = earned, total_pay = earned + overtime + bonus,
 *   net_pay  = gross_total.
 */
async function computeMonthlyPayroll(companyId, year, month, opts = {}) {
    const daysInMonth = new Date(year, month, 0).getDate();
    const mm = String(month).padStart(2, '0');
    const monthStart = `${year}-${mm}-01`;
    const monthEnd = `${year}-${mm}-${String(daysInMonth).padStart(2, '0')}`;

    // Current month: only count through today (see pass-2 note in git history:
    // future days must not be treated as absences).
    const now = new Date();
    const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;
    const isFutureMonth = year > now.getFullYear() || (year === now.getFullYear() && month > now.getMonth() + 1);
    const daysToCount = isFutureMonth ? 0 : (isCurrentMonth ? now.getDate() : daysInMonth);

    const empFilterSql = opts.employeeId ? ' AND e.id = ?' : '';
    const empParams = opts.employeeId ? [companyId, opts.employeeId] : [companyId];
    let employees;
    try {
        [employees] = await pool.query(
            `SELECT e.id, e.name, e.emp_code, e.salary, e.doj, e.department, e.shift_id, d.default_salary,
                    e.pf_percent, e.epf_percent, e.esi_percent, e.pf_limit,
                    e.tds_amount, e.tds_percent, e.statutory_override_active
             FROM employees e LEFT JOIN designations d ON d.id = e.designation_id
             WHERE e.company_id = ? AND e.status = 'active'${empFilterSql}`, empParams);
    } catch (err) {
        if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
        [employees] = await pool.query(
            `SELECT e.id, e.name, e.emp_code, e.salary, e.doj, e.department, e.shift_id, d.default_salary
             FROM employees e LEFT JOIN designations d ON d.id = e.designation_id
             WHERE e.company_id = ? AND e.status = 'active'${empFilterSql}`, empParams);
    }

    // ---- Payment Setup heads (names + amounts, not just totals) ----
    let headRows = [];
    try {
        [headRows] = await pool.query(
            'SELECT employee_id, head_type, head_name, amount FROM salary_heads WHERE company_id = ? ORDER BY sort_order ASC, id ASC',
            [companyId]);
    } catch (err) { if (err.code !== 'ER_NO_SUCH_TABLE') throw err; }
    const headsByEmp = new Map();
    for (const h of headRows) {
        if (!headsByEmp.has(h.employee_id)) headsByEmp.set(h.employee_id, { addition: [], deduction: [] });
        headsByEmp.get(h.employee_id)[h.head_type === 'addition' ? 'addition' : 'deduction']
            .push({ name: h.head_name, amount: round2(Number(h.amount)) });
    }

    const [policyRows] = await pool.query(
        'SELECT full_day_hours, half_day_min_hours FROM office_time_policy WHERE company_id = ?', [companyId]);
    const fullDayHours = policyRows.length ? Number(policyRows[0].full_day_hours) : 8.0;
    const halfDayMinHours = policyRows.length ? Number(policyRows[0].half_day_min_hours) : 4.0;

    const [attendanceRows] = await pool.query(
        'SELECT employee_id, date, check_in, check_out FROM attendance WHERE company_id = ? AND date BETWEEN ? AND ?',
        [companyId, monthStart, monthEnd]);
    const attendanceByEmpDate = new Map();
    for (const row of attendanceRows) attendanceByEmpDate.set(`${row.employee_id}|${dateKey(row.date)}`, row);

    const [leaveRows] = await pool.query(
        `SELECT employee_id, from_date, to_date, days_count, paid_days FROM leave_applications
         WHERE company_id = ? AND status = 'approved' AND from_date <= ? AND to_date >= ?`,
        [companyId, monthEnd, monthStart]);

    // Shared attendance context (same loaders the reports use).
    const holidayIndex = await loadHolidayIndex(companyId, monthStart, monthEnd);
    const employeeGroups = await loadEmployeeHolidayGroups(companyId);
    const weeklyOffIndex = await loadWeeklyOffIndex(companyId);
    const shiftOffIndex = await loadShiftOffIndex(companyId);
    const shiftPolicyOffIndex = await loadShiftPolicyOffIndex(companyId);
    const shiftPolicyIndex = await loadShiftPolicyIndex(companyId);
    const punchEventsIndex = await loadPunchEventsIndex(companyId, monthStart, monthEnd);
    const [shiftRowsAll] = await pool.query(
        'SELECT id, name, start_time, end_time, late_grace_minutes, early_grace_minutes, is_default FROM shifts WHERE company_id = ?', [companyId]);
    const shiftsById = new Map(shiftRowsAll.map(x => [x.id, x]));
    const defaultShift = shiftRowsAll.find(x => x.is_default) || null;

    // ---- existing payroll rows (paid flag, frozen snapshot, legacy bonus) ----
    let existingPayroll;
    try {
        [existingPayroll] = await pool.query(
            'SELECT employee_id, bonus, is_paid, paid_on, paid_snapshot FROM payroll_records WHERE company_id = ? AND year = ? AND month = ?',
            [companyId, year, month]);
    } catch (err) {
        if (err.code !== 'ER_BAD_FIELD_ERROR') throw err; // migration_041 not applied yet - no snapshots
        [existingPayroll] = await pool.query(
            'SELECT employee_id, bonus, is_paid, paid_on FROM payroll_records WHERE company_id = ? AND year = ? AND month = ?',
            [companyId, year, month]);
    }
    const payrollByEmp = new Map(existingPayroll.map(p => [p.employee_id, p]));

    // ---- bonus line items (Bonus Payroll screen = source of truth) ----
    let bonusRows = [];
    try {
        [bonusRows] = await pool.query(
            'SELECT employee_id, amount, reason FROM bonuses WHERE company_id = ? AND year = ? AND month = ? ORDER BY id ASC',
            [companyId, year, month]);
    } catch (err) { if (err.code !== 'ER_NO_SUCH_TABLE') throw err; }
    const bonusByEmp = new Map();
    for (const b of bonusRows) {
        if (!bonusByEmp.has(b.employee_id)) bonusByEmp.set(b.employee_id, []);
        bonusByEmp.get(b.employee_id).push({ name: b.reason || 'Bonus', amount: round2(Number(b.amount)) });
    }

    // ---- loans (preview only; written on Pay) ----
    let loanRows = [];
    try {
        [loanRows] = await pool.query(
            `SELECT l.id, l.employee_id, l.principal_amount, l.repayment_mode, l.salary_deduction_percent,
                    COALESCE((SELECT SUM(amount) FROM loan_payments WHERE loan_id = l.id), 0) AS paid_so_far
             FROM loans l WHERE l.company_id = ? AND l.status != 'closed'`, [companyId]);
    } catch (err) { if (err.code !== 'ER_NO_SUCH_TABLE' && err.code !== 'ER_BAD_FIELD_ERROR') throw err; }
    const loansByEmp = new Map();
    for (const l of loanRows) {
        if (!loansByEmp.has(l.employee_id)) loansByEmp.set(l.employee_id, []);
        loansByEmp.get(l.employee_id).push(l);
    }

    // ---- overtime: approved is paid, pending is shown only ----
    const [overtimeRows] = await pool.query(
        `SELECT employee_id,
                SUM(CASE WHEN status = 'approved' THEN amount ELSE 0 END) AS approved_pay,
                SUM(CASE WHEN status = 'approved' THEN overtime_hours ELSE 0 END) AS approved_hours,
                SUM(CASE WHEN status = 'pending' THEN overtime_hours ELSE 0 END) AS pending_hours,
                SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END) AS pending_pay
         FROM overtime_records WHERE company_id = ? AND date BETWEEN ? AND ? GROUP BY employee_id`,
        [companyId, monthStart, monthEnd]);
    const overtimeByEmp = new Map(overtimeRows.map(r => [r.employee_id, r]));

    // ---- master statutory settings ----
    let statutorySettings = { pf_enabled: false, esi_enabled: false, pt_enabled: false };
    let ptSlabs = [];
    try {
        const [settingsRows] = await pool.query('SELECT * FROM statutory_settings WHERE company_id = ?', [companyId]);
        if (settingsRows.length) statutorySettings = settingsRows[0];
        const [slabRows] = await pool.query(
            'SELECT min_wage, max_wage, pt_amount FROM pt_slabs WHERE company_id = ? ORDER BY min_wage ASC', [companyId]);
        ptSlabs = slabRows;
    } catch (err) { if (err.code !== 'ER_NO_SUCH_TABLE') throw err; }

    const result = employees.map(emp => {
        const existing = payrollByEmp.get(emp.id);

        // Frozen (already paid) -> return the snapshot exactly as paid.
        if (existing && existing.is_paid && existing.paid_snapshot) {
            try {
                const snap = typeof existing.paid_snapshot === 'string' ? JSON.parse(existing.paid_snapshot) : existing.paid_snapshot;
                return { ...snap, is_paid: true, paid_on: existing.paid_on, frozen: true };
            } catch (e) { /* corrupt snapshot - fall through and recompute */ }
        }

        const baseSalary = Number(emp.salary ?? emp.default_salary ?? 0);
        const perDayRate = baseSalary / daysInMonth;
        const empShift = shiftOffIndex.byId.get(emp.shift_id) ?? null;
        const employeeGroupId = employeeGroups.get(emp.id) ?? null;
        const { offDaysBitmask, altSaturdays, isWeeklyOff2 } =
            resolveEmployeeOffDays(emp.shift_id, empShift, emp.department, weeklyOffIndex, shiftPolicyOffIndex);
        const deductBreaks = emp.shift_id != null ? shiftPolicyIndex.deductBreaksFor(emp.shift_id) : false;
        const shiftForDay = (emp.shift_id != null ? shiftsById.get(emp.shift_id) : null) || defaultShift;
        const grace = emp.shift_id != null && shiftPolicyIndex.has(emp.shift_id) ? shiftPolicyIndex.graceFor(emp.shift_id) : null;
        const rules = shiftPolicyIndex.rulesFor(emp.shift_id);
        const dojStr = emp.doj ? dateKey(emp.doj) : null;

        // Which approved leave (if any) covers `dateStr`, and is that day paid or unpaid?
        const leaveFor = (dateStr) => {
            for (const l of leaveRows) {
                if (l.employee_id !== emp.id) continue;
                const from = dateKey(l.from_date), to = dateKey(l.to_date);
                if (dateStr < from || dateStr > to) continue;
                const paidDays = l.paid_days !== null && l.paid_days !== undefined ? Number(l.paid_days) : Number(l.days_count);
                const dayIndex = Math.round((new Date(`${dateStr}T00:00:00`) - new Date(`${from}T00:00:00`)) / 86400000);
                return dayIndex < paidDays ? 'paid' : 'unpaid';
            }
            return null;
        };

        // 1) classify every counted day with the shared classifier
        const dayList = [];
        for (let day = 1; day <= daysToCount; day++) {
            const dateStr = `${year}-${mm}-${String(day).padStart(2, '0')}`;
            if (dojStr && dateStr < dojStr) { dayList.push({ status: 'not_joined', dateStr }); continue; }
            const dayOfWeek = new Date(year, month - 1, day).getDay();
            const attendance = attendanceByEmpDate.get(`${emp.id}|${dateStr}`);
            const dayEvents = punchEventsIndex.forEmployeeDate(emp.id, dateStr);
            const punchSpan = dayEvents.length > 0 ? derivePunchSpan(dayEvents, deductBreaks) : null;
            const le = computeLateEarly(dateStr, attendance, shiftForDay, grace);
            const status = classifyDay({
                dateStr, dayOfWeek,
                isHoliday: (d) => holidayIndex.isHoliday(d, employeeGroupId),
                offDaysBitmask, altSaturdays, isWeeklyOff2,
                isOnApprovedLeave: (d) => leaveFor(d) !== null,
                attendance, fullDayHours, halfDayMinHours,
                workMinutesOverride: punchSpan ? punchSpan.workMinutes ?? undefined : undefined,
                rules, lateMinutes: le.lateMinutes, earlyMinutes: le.earlyMinutes,
            });
            dayList.push({ status, dateStr, lateHalf: status === 'half_day' && le.lateMinutes > 0 });
        }
        // 2) Office-policy prefix/suffix rule (weekly off / holiday next to an absence becomes absent)
        applyPrefixSuffixAbsent(
            dayList.filter(d => d.status !== 'not_joined'),
            emp.shift_id != null ? shiftPolicyIndex.prefixSuffixFor(emp.shift_id) : null);

        // 3) day-units -> earned
        const counts = { present: 0, half_day: 0, absent: 0, paid_leave: 0, unpaid_leave: 0, holiday: 0, weekly_off: 0 };
        let payableUnits = 0;
        for (const d of dayList) {
            switch (d.status) {
                case 'present': counts.present++; payableUnits += 1; break;
                case 'half_day': counts.half_day++; payableUnits += 0.5; break;
                case 'holiday': counts.holiday++; payableUnits += 1; break;
                case 'weekly_off': counts.weekly_off++; payableUnits += 1; break;
                case 'leave':
                    if (leaveFor(d.dateStr) === 'paid') { counts.paid_leave++; payableUnits += 1; }
                    else { counts.unpaid_leave++; }
                    break;
                case 'absent': counts.absent++; break;
                default: break; // not_joined
            }
        }
        const earned = round2(perDayRate * payableUnits);

        // 4) overtime / bonus
        const ot = overtimeByEmp.get(emp.id);
        const overtimePay = ot ? round2(Number(ot.approved_pay) || 0) : 0;
        const overtimeHours = ot ? round2(Number(ot.approved_hours) || 0) : 0;
        const overtimePendingHours = ot ? round2(Number(ot.pending_hours) || 0) : 0;
        const bonusItems = bonusByEmp.get(emp.id) || [];
        const bonus = bonusItems.length
            ? round2(bonusItems.reduce((a, b) => a + b.amount, 0))
            : (existing ? round2(Number(existing.bonus) || 0) : 0);
        if (!bonusItems.length && bonus > 0) bonusItems.push({ name: 'Bonus', amount: bonus });

        // 5) statutory (PF on earned wage; ESI/PT on gross earnings)
        const totalPay = round2(earned + overtimePay + bonus);
        const employeeOverride = emp.statutory_override_active === undefined ? null : {
            active: !!emp.statutory_override_active,
            pfPercent: emp.pf_percent, epfPercent: emp.epf_percent, esiPercent: emp.esi_percent,
            pfLimit: emp.pf_limit, tdsAmount: emp.tds_amount, tdsPercent: emp.tds_percent,
        };
        // Industry-norm wage bases (India):
        //   PF  - on the earned BASIC wage only (capped at the PF ceiling if enabled); never on OT / bonus.
        //   ESI - on earned wage + fixed allowances (addition heads); OT and bonus are excluded by law.
        //   PT / TDS - on total gross earnings (earned + OT + bonus + allowances).
        const heads0 = headsByEmp.get(emp.id) || { addition: [], deduction: [] };
        const additionForWages = round2(heads0.addition.reduce((a, h) => a + h.amount, 0));
        const esiWage = round2(earned + additionForWages);
        const grossEarnings = round2(totalPay + additionForWages);
        const statutory = computeStatutoryDeductions(statutorySettings, ptSlabs, earned, esiWage, grossEarnings, employeeOverride);
        const statutoryTotal = round2(statutory.pfEmployee + statutory.esiEmployee + statutory.ptAmount + statutory.tdsAmount);
        const total1 = round2(totalPay - statutoryTotal);

        // 6) addition heads -> total 2
        const heads = headsByEmp.get(emp.id) || { addition: [], deduction: [] };
        const additionTotal = round2(heads.addition.reduce((a, h) => a + h.amount, 0));
        const total2 = round2(total1 + additionTotal);

        // 7) deduction heads + loan -> gross total
        const deductionTotal = round2(heads.deduction.reduce((a, h) => a + h.amount, 0));
        let loanDeduction = 0;
        const loanSummaries = (loansByEmp.get(emp.id) || []).map(l => {
            const outstanding = Math.max(0, Number(l.principal_amount) - Number(l.paid_so_far));
            let projected = 0;
            if (l.repayment_mode === 'salary_percent' && l.salary_deduction_percent) {
                projected = Math.min(outstanding, round2(earned * Number(l.salary_deduction_percent) / 100));
                loanDeduction += projected;
            }
            return { loan_id: l.id, repayment_mode: l.repayment_mode, outstanding_balance: round2(outstanding), projected_deduction_this_month: round2(projected) };
        });
        loanDeduction = round2(loanDeduction);
        const grossTotal = round2(total2 - deductionTotal - loanDeduction);

        return {
            employee_id: emp.id, employee_name: emp.name, emp_code: emp.emp_code,
            year, month,
            // --- fixed heads ---
            base_salary: round2(baseSalary),
            earned_amount: earned,
            day_counts: counts, payable_day_units: payableUnits,
            overtime_pay: overtimePay, overtime_hours: overtimeHours, overtime_pending_hours: overtimePendingHours,
            bonus, bonus_items: bonusItems,
            pf_employee: statutory.pfEmployee, pf_employer: statutory.pfEmployer,
            esi_employee: statutory.esiEmployee, esi_employer: statutory.esiEmployer,
            pt_amount: statutory.ptAmount, tds_amount: statutory.tdsAmount,
            statutory_total: statutoryTotal,
            total_1: total1,
            addition_heads: heads.addition, addition_total: additionTotal,
            total_2: total2,
            deduction_heads: heads.deduction, deduction_total: deductionTotal,
            loans: loanSummaries, loan_deduction: loanDeduction,
            gross_total: grossTotal,
            // --- legacy fields (other screens + Android app) ---
            base_pay: earned, total_pay: totalPay, net_pay: grossTotal,
            has_salary_structure: heads.addition.length + heads.deduction.length > 0,
            is_paid: existing ? !!existing.is_paid : false,
            paid_on: existing ? existing.paid_on : null,
            days_counted: daysToCount, days_in_month: daysInMonth, month_in_progress: isCurrentMonth,
            frozen: false,
        };
    });
    // Payment window (Settings > Payment Day Setup) - same for every employee of the month.
    const paymentWindow = await resolvePaymentWindow(companyId, year, month);
    return result.map(r => ({ ...r, payment_window: paymentWindow }));
}

function dateKey(d) {
    if (d == null) return null;
    return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

/**
 * PF/ESI/PT for one employee's pay run. Pure function of already-
 * computed numbers (no DB access) so it's trivially testable and can't
 * accidentally issue a query per employee. See migration_021's header
 * comment for what each setting means; employer-side figures
 * (pf_employer/esi_employer) are informational company-cost numbers
 * only - they're never subtracted from what the employee is paid.
 *
 * `employeeOverride` (migration_035, optional/nullable): per-employee
 * PF%/EPF%/ESI%/PF wage ceiling that override the company-wide
 * settings above for this one employee, PLUS a TDS deduction
 * (flat amount + percent of gross) that has no company-wide equivalent
 * at all. Only applied when employeeOverride.active is true - an
 * override value that was typed in but the "Active" checkbox left
 * unticked has no effect, so filling in the fields doesn't
 * accidentally start changing someone's pay. PF/ESI/PT *eligibility*
 * (settings.pf_enabled/esi_enabled/pt_enabled) always stays
 * company-wide - an override changes the rate/ceiling used, it can't
 * turn on a scheme the company has switched off entirely.
 */
function computeStatutoryDeductions(settings, ptSlabs, basePayForPf, esiWage, grossPay, employeeOverride) {
    const override = employeeOverride && employeeOverride.active ? employeeOverride : null;

    let pfEmployee = 0, pfEmployer = 0;
    if (settings.pf_enabled) {
        const pfEmployeeRate = override && override.pfPercent !== null && override.pfPercent !== undefined
            ? Number(override.pfPercent) : Number(settings.pf_employee_rate);
        const pfEmployerRate = override && override.epfPercent !== null && override.epfPercent !== undefined
            ? Number(override.epfPercent) : Number(settings.pf_employer_rate);
        const pfCeiling = override && override.pfLimit !== null && override.pfLimit !== undefined
            ? Number(override.pfLimit) : Number(settings.pf_wage_ceiling);
        let pfWage = basePayForPf;
        if (settings.pf_apply_ceiling) pfWage = Math.min(pfWage, pfCeiling);
        pfEmployee = round2(pfWage * pfEmployeeRate / 100);
        pfEmployer = round2(pfWage * pfEmployerRate / 100);
    }

    let esiEmployee = 0, esiEmployer = 0;
    // ESI is all-or-nothing on eligibility, not prorated at the
    // ceiling like PF: an employee over the wage ceiling simply isn't
    // covered by ESI that month at all. (The wage ceiling itself has no
    // per-employee override - only the employee-side rate does.)
    if (settings.esi_enabled && esiWage <= Number(settings.esi_wage_ceiling)) {
        const esiEmployeeRate = override && override.esiPercent !== null && override.esiPercent !== undefined
            ? Number(override.esiPercent) : Number(settings.esi_employee_rate);
        esiEmployee = round2(esiWage * esiEmployeeRate / 100);
        esiEmployer = round2(esiWage * Number(settings.esi_employer_rate) / 100);
    }

    let ptAmount = 0;
    if (settings.pt_enabled) {
        const slab = ptSlabs.find(s => {
            const min = Number(s.min_wage);
            const max = s.max_wage === null ? null : Number(s.max_wage);
            return grossPay >= min && (max === null || grossPay <= max);
        });
        if (slab) ptAmount = round2(Number(slab.pt_amount));
    }

    // TDS (migration_035) - purely per-employee, no company-wide
    // setting to fall back to, so it's simply 0 when there's no active
    // override. Flat amount and percent-of-gross are additive (an
    // employee can have either, both, or neither).
    let tdsAmount = 0;
    if (override) {
        const flat = override.tdsAmount !== null && override.tdsAmount !== undefined ? Number(override.tdsAmount) : 0;
        const pct = override.tdsPercent !== null && override.tdsPercent !== undefined ? Number(override.tdsPercent) : 0;
        tdsAmount = round2(flat + (grossPay * pct / 100));
    }

    return { pfEmployee, pfEmployer, esiEmployee, esiEmployer, ptAmount, tdsAmount };
}

router.get('/', requireAdmin, asyncHandler(async (req, res) => {
    const year = parseInt(req.query.year, 10);
    const month = parseInt(req.query.month, 10); // 1-12
    if (!year || !month || month < 1 || month > 12) {
        return res.status(400).json({ error: 'year and month (1-12) query params required' });
    }
    const result = await computeMonthlyPayroll(req.user.companyId, year, month);
    return res.json(result);
}));

/**
 * GET /payroll/:employeeId/breakdown?year=&month= - the full report for ONE
 * employee (fixed heads, Total 1, addition heads, Total 2, deduction heads,
 * gross total). Backs the Payment Setup "Fixed Heads" section and the pay
 * dialog on the Monthly Pay Process screen. Must be declared BEFORE the
 * '/:employeeId/...' POST routes only for readability - different verb.
 */
router.get('/:employeeId/breakdown', requireAdmin, asyncHandler(async (req, res) => {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const month = parseInt(req.query.month, 10) || (new Date().getMonth() + 1);
    if (month < 1 || month > 12) return res.status(400).json({ error: 'month must be 1-12' });
    const rows = await computeMonthlyPayroll(req.user.companyId, year, month, { employeeId: Number(req.params.employeeId) });
    if (rows.length === 0) return res.status(404).json({ error: 'Employee not found or not active' });
    return res.json(rows[0]);
}));

/**
 * GET /payroll/me?year=&month= - the Android app's Salary Details screen.
 * Same engine as GET / so a payslip figure can never drift from the admin view.
 */
router.get('/me', asyncHandler(async (req, res) => {
    const year = parseInt(req.query.year, 10);
    const month = parseInt(req.query.month, 10);
    if (!year || !month || month < 1 || month > 12) {
        return res.status(400).json({ error: 'year and month (1-12) query params required' });
    }
    const [empRows] = await pool.query(
        'SELECT id FROM employees WHERE firebase_uid = ? AND company_id = ?',
        [req.user.uid, req.user.companyId]
    );
    if (empRows.length === 0) return res.status(404).json({ error: 'Employee record not found' });
    const employeeId = empRows[0].id;

    const rows = await computeMonthlyPayroll(req.user.companyId, year, month, { employeeId });
    const own = rows[0];
    if (!own) {
        return res.json({
            employee_id: employeeId, base_pay: 0, bonus: 0, overtime_pay: 0,
            overtime_hours: 0, total_pay: 0, gross_total: 0, net_pay: 0, is_paid: false, paid_on: null,
        });
    }
    return res.json(own);
}));

/**
 * POST /payroll/:employeeId/bonus - LEGACY single-value bonus. Bonus Payroll
 * (routes/bonuses.js) is now the source of truth; the engine ignores this
 * single value whenever the month has bonus line items, so writing here in
 * that case would silently do nothing - refuse instead of pretending.
 */
router.post('/:employeeId/bonus', requireAdmin, asyncHandler(async (req, res) => {
    const { year, month, bonus } = req.body;
    if (!year || !month || bonus === undefined) {
        return res.status(400).json({ error: 'year, month, and bonus are required' });
    }
    try {
        const [lines] = await pool.query(
            'SELECT 1 FROM bonuses WHERE company_id = ? AND employee_id = ? AND year = ? AND month = ? LIMIT 1',
            [req.user.companyId, req.params.employeeId, year, month]);
        if (lines.length > 0) {
            return res.status(409).json({ error: 'This employee already has Bonus Payroll entries for this month - edit them in Bonus Payroll instead.' });
        }
    } catch (err) { if (err.code !== 'ER_NO_SUCH_TABLE') throw err; }

    await pool.query(
        `INSERT INTO payroll_records (company_id, employee_id, year, month, bonus, total_pay)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE bonus = VALUES(bonus)`,
        [req.user.companyId, req.params.employeeId, year, month, bonus, bonus]
    );
    return res.json({ message: 'Bonus updated' });
}));

/** Writes the auto salary-percent loan deductions for a payroll that was just paid (idempotent). */
async function commitLoanDeductions(companyId, own, year, month) {
    if (!own || !own.loans || !own.loans.length) return;
    try {
        for (const loan of own.loans) {
            if (loan.repayment_mode !== 'salary_percent' || loan.projected_deduction_this_month <= 0) continue;
            await pool.query(
                `INSERT IGNORE INTO loan_payments
                    (company_id, loan_id, amount, payment_date, source, payroll_year, payroll_month, note)
                 VALUES (?, ?, ?, CURDATE(), 'payroll_auto', ?, ?, ?)`,
                [companyId, loan.loan_id, loan.projected_deduction_this_month, year, month,
                    `Auto salary deduction - ${year}-${String(month).padStart(2, '0')}`]
            );
            const remaining = loan.outstanding_balance - loan.projected_deduction_this_month;
            if (remaining <= 0.01) {
                await pool.query("UPDATE loans SET status = 'closed' WHERE id = ? AND company_id = ?", [loan.loan_id, companyId]);
            }
        }
    } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE' && err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    }
}

/**
 * POST /payroll/:employeeId/pay  body: { year, month }
 * The "Pay" button of the Monthly Pay Process. Computes the payslip ONE last
 * time, FREEZES it (paid_snapshot = exactly what the dialog showed), marks the
 * month paid and commits any auto loan deduction - all in one call, so the
 * paid/pending toggle flips automatically when the payment completes.
 * The admin-password prompt is enforced by the Flutter client (Firebase
 * re-authentication) before this is called.
 */
router.post('/:employeeId/pay', requireAdmin, asyncHandler(async (req, res) => {
    const year = parseInt(req.body.year, 10);
    const month = parseInt(req.body.month, 10);
    if (!year || !month || month < 1 || month > 12) return res.status(400).json({ error: 'year and month (1-12) are required' });
    const employeeId = Number(req.params.employeeId);

    const rows = await computeMonthlyPayroll(req.user.companyId, year, month, { employeeId });
    const own = rows[0];
    if (!own) return res.status(404).json({ error: 'Employee not found or not active' });
    if (own.is_paid) return res.status(409).json({ error: 'This month is already marked as paid.' });
    if (!own.payment_window.open) return res.status(403).json({ error: own.payment_window.reason || 'Payment window is closed.', payment_window: own.payment_window });

    const snapshot = JSON.stringify({ ...own, is_paid: true, paid_on: null, frozen: true });
    try {
        await pool.query(
            `INSERT INTO payroll_records (company_id, employee_id, year, month, is_paid, paid_on, paid_amount, paid_snapshot, paid_by)
             VALUES (?, ?, ?, ?, TRUE, NOW(), ?, ?, ?)
             ON DUPLICATE KEY UPDATE is_paid = TRUE, paid_on = NOW(), paid_amount = VALUES(paid_amount),
                                     paid_snapshot = VALUES(paid_snapshot), paid_by = VALUES(paid_by)`,
            [req.user.companyId, employeeId, year, month, own.gross_total, snapshot, req.user.email || null]
        );
    } catch (err) {
        if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
        // migration_041 not applied: still mark paid (no freeze) so payments are never blocked.
        await pool.query(
            `INSERT INTO payroll_records (company_id, employee_id, year, month, is_paid, paid_on)
             VALUES (?, ?, ?, ?, TRUE, NOW())
             ON DUPLICATE KEY UPDATE is_paid = TRUE, paid_on = NOW()`,
            [req.user.companyId, employeeId, year, month]
        );
    }
    await commitLoanDeductions(req.user.companyId, own, year, month);
    return res.json({ message: 'Payment recorded', gross_total: own.gross_total });
}));

/**
 * POST /payroll/:employeeId/mark-paid  body: { year, month, is_paid }
 * Kept for the old toggle + un-marking. is_paid=true delegates to the same
 * freeze-and-commit logic as /pay; is_paid=false reverts to Pending and
 * discards the frozen snapshot (un-marking does not reverse loan deductions).
 */
router.post('/:employeeId/mark-paid', requireAdmin, asyncHandler(async (req, res) => {
    const { year, month, is_paid } = req.body;
    if (!year || !month || is_paid === undefined) {
        return res.status(400).json({ error: 'year, month, and is_paid are required' });
    }
    if (!is_paid) {
        try {
            await pool.query(
                `UPDATE payroll_records SET is_paid = FALSE, paid_on = NULL, paid_amount = NULL, paid_snapshot = NULL, paid_by = NULL
                 WHERE company_id = ? AND employee_id = ? AND year = ? AND month = ?`,
                [req.user.companyId, req.params.employeeId, year, month]);
        } catch (err) {
            if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
            await pool.query(
                'UPDATE payroll_records SET is_paid = FALSE, paid_on = NULL WHERE company_id = ? AND employee_id = ? AND year = ? AND month = ?',
                [req.user.companyId, req.params.employeeId, year, month]);
        }
        return res.json({ message: 'Paid status updated' });
    }
    req.body = { year, month };
    // Re-enter the /pay handler logic directly.
    const rows = await computeMonthlyPayroll(req.user.companyId, Number(year), Number(month), { employeeId: Number(req.params.employeeId) });
    const own = rows[0];
    if (!own) return res.status(404).json({ error: 'Employee not found or not active' });
    if (!own.is_paid) {
        if (!own.payment_window.open) return res.status(403).json({ error: own.payment_window.reason || 'Payment window is closed.', payment_window: own.payment_window });
        const snapshot = JSON.stringify({ ...own, is_paid: true, paid_on: null, frozen: true });
        try {
            await pool.query(
                `INSERT INTO payroll_records (company_id, employee_id, year, month, is_paid, paid_on, paid_amount, paid_snapshot, paid_by)
                 VALUES (?, ?, ?, ?, TRUE, NOW(), ?, ?, ?)
                 ON DUPLICATE KEY UPDATE is_paid = TRUE, paid_on = NOW(), paid_amount = VALUES(paid_amount),
                                         paid_snapshot = VALUES(paid_snapshot), paid_by = VALUES(paid_by)`,
                [req.user.companyId, req.params.employeeId, year, month, own.gross_total, snapshot, req.user.email || null]);
        } catch (err) {
            if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
            await pool.query(
                `INSERT INTO payroll_records (company_id, employee_id, year, month, is_paid, paid_on) VALUES (?, ?, ?, ?, TRUE, NOW())
                 ON DUPLICATE KEY UPDATE is_paid = TRUE, paid_on = NOW()`,
                [req.user.companyId, req.params.employeeId, year, month]);
        }
        await commitLoanDeductions(req.user.companyId, own, Number(year), Number(month));
    }
    return res.json({ message: 'Paid status updated' });
}));

module.exports = router;
module.exports.computeMonthlyPayroll = computeMonthlyPayroll;
