const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');
const {
    loadHolidayIndex,
    loadEmployeeHolidayGroups,
    loadWeeklyOffIndex,
    loadShiftOffIndex,
    effectiveOffDaysBitmask,
    isAltSaturdayOff,
    loadPunchEventsIndex,
    loadShiftPolicyIndex,
    loadShiftPolicyOffIndex,
    classifyDay: classifyDayShared,
    pairPunchEvents,
    applyPrefixSuffixAbsent,
} = require('../utils/attendanceRules');

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
 * Shared computation behind GET / (all employees, admin) and GET /me
 * (the caller's own row, any employee). Pulled out so both routes stay
 * byte-for-byte identical in how a payslip is computed - the only
 * difference between them is which row(s) of `result` get returned.
 */
async function loadPayrollShiftContext(companyId, monthStart, monthEnd) {
    let shifts = [];
    try {
        [shifts] = await pool.query('SELECT * FROM shifts WHERE company_id = ?', [companyId]);
    } catch (_) {
        shifts = [];
    }
    const shiftById = new Map(shifts.map(s => [s.id, s]));
    const defaultShift = shifts.find(s => s.is_default) || shifts[0] || null;

    let assignments = [];
    try {
        [assignments] = await pool.query(
            `SELECT sa.employee_id, sa.shift_id, sa.effective_from, sa.effective_to
             FROM shift_assignments sa
             WHERE sa.company_id = ? AND sa.effective_from <= ?
               AND (sa.effective_to IS NULL OR sa.effective_to >= ?)`,
            [companyId, monthEnd, monthStart]
        );
    } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
    }
    const byEmployee = new Map();
    for (const row of assignments) {
        if (!byEmployee.has(row.employee_id)) byEmployee.set(row.employee_id, []);
        byEmployee.get(row.employee_id).push(row);
    }
    for (const list of byEmployee.values()) {
        list.sort((a, b) => String(b.effective_from).localeCompare(String(a.effective_from)));
    }

    return {
        resolve(employee, dateStr) {
            const assigned = (byEmployee.get(employee.id) || []).find(a =>
                String(a.effective_from) <= dateStr && (!a.effective_to || String(a.effective_to) >= dateStr));
            if (assigned && shiftById.has(assigned.shift_id)) return shiftById.get(assigned.shift_id);
            return shiftById.get(employee.shift_id) || defaultShift || null;
        },
    };
}

function minutesFromTime(value) {
    if (value == null) return null;
    const parts = String(value).split(':').map(Number);
    if (parts.length < 2 || parts.some(Number.isNaN)) return null;
    return parts[0] * 60 + parts[1] + (parts[2] || 0) / 60;
}

function dateTimeForShift(dateStr, timeValue) {
    if (timeValue == null) return null;
    const parsed = minutesFromTime(timeValue);
    if (parsed == null) return null;
    const d = new Date(`${dateStr}T00:00:00`);
    d.setMinutes(parsed);
    return d;
}

function lateEarlyMinutesForPunches(dateStr, shift, firstIn, lastOut, policy) {
    if (!shift) return { lateByMinutes: 0, earlyByMinutes: 0 };
    const lateGrace = policy ? Number(policy.grace_late_coming_minutes || 0) : Number(shift.late_grace_minutes || 0);
    const earlyGrace = policy ? Number(policy.grace_early_going_minutes || 0) : Number(shift.early_grace_minutes || 0);
    let lateByMinutes = 0;
    let earlyByMinutes = 0;
    if (firstIn) {
        const scheduledStart = dateTimeForShift(dateStr, shift.start_time);
        if (scheduledStart) {
            scheduledStart.setMinutes(scheduledStart.getMinutes() + lateGrace);
            const actual = new Date(firstIn);
            if (!Number.isNaN(actual.getTime()) && actual > scheduledStart) {
                lateByMinutes = Math.round((actual - scheduledStart) / 60000);
            }
        }
    }
    if (lastOut) {
        const scheduledEnd = dateTimeForShift(dateStr, shift.end_time);
        if (scheduledEnd) {
            scheduledEnd.setMinutes(scheduledEnd.getMinutes() - earlyGrace);
            const actual = new Date(lastOut);
            if (!Number.isNaN(actual.getTime()) && actual < scheduledEnd) {
                earlyByMinutes = Math.round((scheduledEnd - actual) / 60000);
            }
        }
    }
    return { lateByMinutes, earlyByMinutes };
}

/**
 * Shared payroll calculation. Dynamic attendance values are derived from
 * the same holiday/weekly-off/shift-policy/punch-event sources used by the
 * reports. Employee `salary` remains the base-salary source and is NEVER
 * overwritten by Payment Setup.
 */
async function computeMonthlyPayroll(companyId, year, month) {
    const daysInMonth = new Date(year, month, 0).getDate();
    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

    const now = new Date();
    const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;
    const isFutureMonth = year > now.getFullYear() || (year === now.getFullYear() && month > now.getMonth() + 1);
    const daysToCount = isFutureMonth ? 0 : (isCurrentMonth ? now.getDate() : daysInMonth);

    let employees;
    try {
        [employees] = await pool.query(
            `SELECT e.id, e.name, e.emp_code, e.salary, e.department, e.shift_id, d.default_salary,
                    e.pf_percent, e.epf_percent, e.esi_percent, e.pf_limit,
                    e.ot_rate_type, e.ot_rate_value, e.tds_amount, e.tds_percent,
                    e.statutory_override_active
             FROM employees e
             LEFT JOIN designations d ON d.id = e.designation_id
             WHERE e.company_id = ? AND e.status = 'active'`,
            [companyId]
        );
    } catch (err) {
        if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
        [employees] = await pool.query(
            `SELECT e.id, e.name, e.emp_code, e.salary, e.department, e.shift_id, d.default_salary
             FROM employees e LEFT JOIN designations d ON d.id = e.designation_id
             WHERE e.company_id = ? AND e.status = 'active'`,
            [companyId]
        );
    }

    let salaryHeadRows = [];
    try {
        [salaryHeadRows] = await pool.query(
            `SELECT employee_id, head_type, head_name, amount
             FROM salary_heads WHERE company_id = ? ORDER BY sort_order ASC, id ASC`,
            [companyId]
        );
    } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
    }
    const headsByEmp = new Map();
    for (const h of salaryHeadRows) {
        if (!headsByEmp.has(h.employee_id)) headsByEmp.set(h.employee_id, { addition: [], deduction: [] });
        const bucket = h.head_type === 'deduction' ? 'deduction' : 'addition';
        headsByEmp.get(h.employee_id)[bucket].push({
            head_name: h.head_name,
            amount: round2(Number(h.amount) || 0),
        });
    }

    let basePolicyRows = [];
    [basePolicyRows] = await pool.query(
        'SELECT full_day_hours, half_day_min_hours, overtime_rate_per_hour FROM office_time_policy WHERE company_id = ?',
        [companyId]
    );
    const fullDayHours = basePolicyRows.length ? Number(basePolicyRows[0].full_day_hours) : 8.0;
    const halfDayMinHours = basePolicyRows.length ? Number(basePolicyRows[0].half_day_min_hours) : 4.0;
    const companyOtRate = basePolicyRows.length ? basePolicyRows[0].overtime_rate_per_hour : null;

    const [attendanceRows] = await pool.query(
        'SELECT employee_id, date, check_in, check_out FROM attendance WHERE company_id = ? AND date BETWEEN ? AND ?',
        [companyId, monthStart, monthEnd]
    );
    const attendanceByEmpDate = new Map();
    for (const row of attendanceRows) attendanceByEmpDate.set(`${row.employee_id}|${String(row.date).slice(0, 10)}`, row);

    const [leaveRows] = await pool.query(
        `SELECT employee_id, from_date, to_date, days_count, paid_days
         FROM leave_applications
         WHERE company_id = ? AND status = 'approved' AND from_date <= ? AND to_date >= ?`,
        [companyId, monthEnd, monthStart]
    );

    const holidayIndex = await loadHolidayIndex(companyId, monthStart, monthEnd);
    const employeeGroups = await loadEmployeeHolidayGroups(companyId);
    const weeklyOffIndex = await loadWeeklyOffIndex(companyId);
    let shiftOffIndex = { byId: new Map() };
    let shiftPolicyOffIndex = { has: () => false, offDaysBitmaskFor: () => 0, isWeeklyOff2Date: () => false };
    let shiftPolicyIndex = { has: () => false, policyFor: () => null, deductBreaksFor: () => false, graceFor: () => ({ lateGraceMinutes: 0, earlyGraceMinutes: 0 }) };
    try { shiftOffIndex = await loadShiftOffIndex(companyId); } catch (err) { if (err.code !== 'ER_BAD_FIELD_ERROR' && err.code !== 'ER_NO_SUCH_TABLE') throw err; }
    try { shiftPolicyOffIndex = await loadShiftPolicyOffIndex(companyId); } catch (err) { if (err.code !== 'ER_NO_SUCH_TABLE') throw err; }
    try { shiftPolicyIndex = await loadShiftPolicyIndex(companyId); } catch (err) { if (err.code !== 'ER_NO_SUCH_TABLE') throw err; }
    const punchEventsIndex = await loadPunchEventsIndex(companyId, monthStart, monthEnd);
    const shiftContext = await loadPayrollShiftContext(companyId, monthStart, monthEnd);

    let existingPayroll = [];
    [existingPayroll] = await pool.query(
        'SELECT employee_id, bonus, is_paid, paid_on FROM payroll_records WHERE company_id = ? AND year = ? AND month = ?',
        [companyId, year, month]
    );
    const payrollByEmp = new Map(existingPayroll.map(p => [p.employee_id, p]));

    let loanRows = [];
    try {
        [loanRows] = await pool.query(
            `SELECT l.id, l.employee_id, l.principal_amount, l.repayment_mode, l.salary_deduction_percent,
                    COALESCE((SELECT SUM(amount) FROM loan_payments WHERE loan_id = l.id), 0) AS paid_so_far
             FROM loans l WHERE l.company_id = ? AND l.status != 'closed'`,
            [companyId]
        );
    } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE' && err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    }
    const loansByEmp = new Map();
    for (const l of loanRows) {
        if (!loansByEmp.has(l.employee_id)) loansByEmp.set(l.employee_id, []);
        loansByEmp.get(l.employee_id).push(l);
    }

    let overtimeRows = [];
    try {
        [overtimeRows] = await pool.query(
            `SELECT employee_id, SUM(amount) AS overtime_pay, SUM(overtime_hours) AS overtime_hours
             FROM overtime_records WHERE company_id = ? AND status = 'approved' AND date BETWEEN ? AND ? GROUP BY employee_id`,
            [companyId, monthStart, monthEnd]
        );
    } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
    }
    const overtimeByEmp = new Map(overtimeRows.map(r => [r.employee_id, r]));

    let statutorySettings = { pf_enabled: false, esi_enabled: false, pt_enabled: false };
    let ptSlabs = [];
    try {
        const [settingsRows] = await pool.query('SELECT * FROM statutory_settings WHERE company_id = ?', [companyId]);
        if (settingsRows.length) statutorySettings = settingsRows[0];
        const [slabRows] = await pool.query(
            'SELECT min_wage, max_wage, pt_amount FROM pt_slabs WHERE company_id = ? ORDER BY min_wage ASC',
            [companyId]
        );
        ptSlabs = slabRows;
    } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
    }

    // Bonus Payroll is the source of truth for monthly bonus amounts.
    // payroll_records.bonus remains a backwards-compatible fallback for
    // installations where the bonus table has not been migrated yet.
    let bonusByEmp = new Map();
    try {
        const [bonusRows] = await pool.query(
            `SELECT employee_id, COALESCE(SUM(amount), 0) AS bonus
             FROM bonuses
             WHERE company_id = ? AND year = ? AND month = ?
             GROUP BY employee_id`,
            [companyId, year, month]
        );
        bonusByEmp = new Map(bonusRows.map(r => [Number(r.employee_id), Number(r.bonus || 0)]));
    } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
    }

    const result = employees.map(emp => {
        const baseSalary = round2(Number(emp.salary ?? emp.default_salary ?? 0));
        const perDayRate = baseSalary / daysInMonth;
        const empHeads = headsByEmp.get(emp.id) || { addition: [], deduction: [] };
        const additionTotal = round2(empHeads.addition.reduce((sum, h) => sum + h.amount, 0));
        const deductionTotal = round2(empHeads.deduction.reduce((sum, h) => sum + h.amount, 0));

        const leavePayFractionFor = (dateStr) => {
            for (const l of leaveRows) {
                if (l.employee_id !== emp.id) continue;
                const from = String(l.from_date).slice(0, 10);
                const to = String(l.to_date).slice(0, 10);
                if (dateStr < from || dateStr > to) continue;
                const paidDays = l.paid_days !== null && l.paid_days !== undefined
                    ? Number(l.paid_days) : Number(l.days_count || 0);
                const dayIndex = Math.round((new Date(`${dateStr}T00:00:00`) - new Date(`${from}T00:00:00`)) / 86400000);
                // Preserve fractional paid leave (for example 0.5 day) rather
                // than forcing every covered calendar date into paid/unpaid.
                return Math.max(0, Math.min(1, paidDays - dayIndex));
            }
            return null;
        };

        const dayResults = [];
        for (let day = 1; day <= daysToCount; day++) {
            const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const dayOfWeek = new Date(`${dateStr}T00:00:00`).getDay();
            const shift = shiftContext.resolve(emp, dateStr);
            const policy = shift ? shiftPolicyIndex.policyFor(shift.id) : null;
            const shiftId = shift ? shift.id : emp.shift_id;
            const empShift = shiftId != null ? (shiftOffIndex.byId.get(shiftId) || shift) : shift;

            let offDaysBitmask = weeklyOffIndex.companyDefault;
            let altSaturdays = empShift ? empShift.alt_saturdays : null;
            let isWeeklyOff2 = () => false;
            if (shiftId != null && shiftPolicyOffIndex.has(shiftId)) {
                offDaysBitmask = shiftPolicyOffIndex.offDaysBitmaskFor(shiftId);
                altSaturdays = null;
                isWeeklyOff2 = d => shiftPolicyOffIndex.isWeeklyOff2Date(shiftId, d);
            } else if (empShift && empShift.weekly_off_bitmask != null) {
                offDaysBitmask = empShift.weekly_off_bitmask;
            } else {
                const dept = weeklyOffIndex.forDepartment(emp.department);
                if (dept != null) offDaysBitmask = dept;
                else offDaysBitmask = effectiveOffDaysBitmask(empShift, emp.department, weeklyOffIndex);
            }

            const attendance = attendanceByEmpDate.get(`${emp.id}|${dateStr}`) || null;
            const dayEvents = punchEventsIndex.forEmployeeDate(emp.id, dateStr);
            const punchPair = pairPunchEvents(dayEvents, { considerOnlyFirstLastPunch: !!policy?.consider_only_first_last_punch });
            const firstIn = punchPair.firstIn || (attendance ? attendance.check_in : null);
            const lastOut = punchPair.lastOut || (attendance ? attendance.check_out : null);
            const punchHasCompletePair = punchPair.intervals.length > 0;
            const workMinutes = dayEvents.length > 0 && punchHasCompletePair
                ? punchPair.totalWorkMinutes
                : (attendance && attendance.check_in && attendance.check_out
                    ? Math.max(0, Math.round((new Date(attendance.check_out) - new Date(attendance.check_in)) / 60000))
                    : null);
            const leavePaidFraction = leavePayFractionFor(dateStr);
            const lateEarly = lateEarlyMinutesForPunches(dateStr, shift, firstIn, lastOut, policy);
            const status = classifyDayShared({
                dateStr, dayOfWeek,
                isHoliday: d => holidayIndex.isHoliday(d, employeeGroups.get(emp.id) ?? null),
                offDaysBitmask, altSaturdays, isWeeklyOff2,
                isOnApprovedLeave: d => leavePayFractionFor(d) !== null,
                attendance: attendance || (firstIn ? { check_in: firstIn, check_out: lastOut } : null),
                fullDayHours, halfDayMinHours,
                workMinutesOverride: workMinutes,
                policy,
                lateByMinutes: lateEarly.lateByMinutes,
                earlyByMinutes: lateEarly.earlyByMinutes,
            });
            dayResults.push({ date: dateStr, status, leavePaidFraction, workMinutes, lateByMinutes: lateEarly.lateByMinutes, earlyByMinutes: lateEarly.earlyByMinutes });
        }

        // Office Time Policy prefix/suffix rules are applied to the final
        // per-day statuses before converting them to paid-day units.
        if (dayResults.length && (dayResults.some(d => d.status === 'weekly_off' || d.status === 'holiday'))) {
            // Apply only when the resolved policy is consistent across the
            // period. For mixed-shift employees, day-level classification
            // remains authoritative and no cross-shift block conversion is
            // attempted.
            const policies = new Set();
            for (const d of dayResults) {
                const shift = shiftContext.resolve(emp, d.date);
                policies.add(shift ? shiftPolicyIndex.policyFor(shift.id) : null);
            }
            if (policies.size === 1) {
                const policy = policies.values().next().value;
                if (policy) applyPrefixSuffixAbsent(dayResults, {
                    prefix: !!policy.mark_absent_prefix_day,
                    suffix: !!policy.mark_absent_suffix_day,
                    both: !!policy.mark_absent_both_prefix_suffix_day,
                });
            }
        }

        let earnedUnits = 0;
        let presentUnits = 0;
        for (const d of dayResults) {
            if (d.status === 'holiday' || d.status === 'weekly_off') {
                earnedUnits += 1;
            } else if (d.leavePaidFraction != null) {
                earnedUnits += d.leavePaidFraction;
            } else if (d.status === 'present') {
                earnedUnits += 1;
                presentUnits += 1;
            } else if (d.status === 'half_day') {
                earnedUnits += 0.5;
                presentUnits += 0.5;
            }
        }

        const earnedHead = round2(perDayRate * earnedUnits);
        const existing = payrollByEmp.get(emp.id);
        const bonus = round2(
            bonusByEmp.has(emp.id)
                ? Number(bonusByEmp.get(emp.id) || 0)
                : (existing ? Number(existing.bonus || 0) : 0)
        );
        const overtime = overtimeByEmp.get(emp.id);
        const overtimePay = round2(overtime ? Number(overtime.overtime_pay || 0) : 0);
        const overtimeHours = overtime ? Number(overtime.overtime_hours || 0) : 0;
        const dynamicGross = round2(earnedHead + bonus + overtimePay);

        const employeeOverride = emp.statutory_override_active === undefined ? null : {
            active: !!emp.statutory_override_active,
            pfPercent: emp.pf_percent, epfPercent: emp.epf_percent, esiPercent: emp.esi_percent,
            pfLimit: emp.pf_limit, tdsAmount: emp.tds_amount, tdsPercent: emp.tds_percent,
        };
        const statutory = computeStatutoryDeductions(statutorySettings, ptSlabs, earnedHead, dynamicGross, employeeOverride);
        const fixedDeductionTotal = round2(statutory.pfEmployee + statutory.esiEmployee + statutory.ptAmount + statutory.tdsAmount);
        const total1 = round2(dynamicGross - fixedDeductionTotal);
        const total2 = round2(total1 + additionTotal);

        let loanDeduction = 0;
        const empLoans = loansByEmp.get(emp.id) || [];
        const loanSummaries = empLoans.map(l => {
            const outstanding = Math.max(0, Number(l.principal_amount) - Number(l.paid_so_far));
            let projected = 0;
            if (l.repayment_mode === 'salary_percent' && l.salary_deduction_percent) {
                projected = Math.min(outstanding, round2(Math.max(0, total2) * Number(l.salary_deduction_percent) / 100));
                loanDeduction += projected;
            }
            return {
                loan_id: l.id,
                repayment_mode: l.repayment_mode,
                outstanding_balance: round2(outstanding),
                projected_deduction_this_month: round2(projected),
            };
        });

        const grossTotal = round2(total2 - deductionTotal - loanDeduction);
        const effectiveOvertimeRate = emp.statutory_override_active && emp.ot_rate_type && emp.ot_rate_value != null
            ? { type: emp.ot_rate_type, value: Number(emp.ot_rate_value) }
            : { type: 'fixed', value: companyOtRate == null ? null : Number(companyOtRate) };

        return {
            employee_id: emp.id,
            employee_name: emp.name,
            emp_code: emp.emp_code,
            // Backward-compatible `base_pay` now means the earned base for
            // this month; `base_salary` is the fixed Employee Details salary.
            base_salary: baseSalary,
            base_pay: earnedHead,
            earned_head: earnedHead,
            bonus,
            overtime_pay: overtimePay,
            overtime_hours: overtimeHours,
            total_pay: dynamicGross,
            total_1: total1,
            addition_total: additionTotal,
            total_2: total2,
            deduction_total: deductionTotal,
            fixed_deduction_total: fixedDeductionTotal,
            gross_total: grossTotal,
            pf_employee: statutory.pfEmployee,
            pf_employer: statutory.pfEmployer,
            esi_employee: statutory.esiEmployee,
            esi_employer: statutory.esiEmployer,
            pt_amount: statutory.ptAmount,
            tds_amount: statutory.tdsAmount,
            loans: loanSummaries,
            loan_deduction: round2(loanDeduction),
            net_pay: grossTotal, // legacy consumer: final amount to be paid
            has_salary_structure: !!headsByEmp.has(emp.id),
            ot_rate_type: effectiveOvertimeRate.type,
            ot_rate_value: effectiveOvertimeRate.value,
            days_counted: daysToCount,
            days_in_month: daysInMonth,
            paid_day_units: presentUnits,
            month_in_progress: isCurrentMonth,
            is_paid: existing ? !!existing.is_paid : false,
            paid_on: existing ? existing.paid_on : null,
            salary_heads: empHeads,
        };
    });

    return result;
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
function computeStatutoryDeductions(settings, ptSlabs, basePayForPf, grossPay, employeeOverride) {
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
    if (settings.esi_enabled && grossPay <= Number(settings.esi_wage_ceiling)) {
        const esiEmployeeRate = override && override.esiPercent !== null && override.esiPercent !== undefined
            ? Number(override.esiPercent) : Number(settings.esi_employee_rate);
        esiEmployee = round2(grossPay * esiEmployeeRate / 100);
        esiEmployer = round2(grossPay * Number(settings.esi_employer_rate) / 100);
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
 * GET /payroll/me?year=&month= - the Android app's Salary Details
 * screen (see ANDROID_APP_SPEC.md). Deliberately no employee-facing
 * payroll endpoint existed before this - every other route in this
 * file is requireAdmin. Computes the exact same way as GET / (same
 * shared function above) and just returns the caller's own row, so a
 * payslip figure here can never drift from what the admin's Payroll
 * screen shows for the same employee/month.
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

    const result = await computeMonthlyPayroll(req.user.companyId, year, month);
    const own = result.find(r => r.employee_id === employeeId);
    if (!own) {
        // Genuinely no computable row for this employee this month -
        // e.g. they were marked inactive after the month in question
        // (computeMonthlyPayroll only includes status='active'
        // employees). Distinct from a 404 on the employee lookup above
        // (account exists, this specific month just has nothing).
        return res.json({
            employee_id: employeeId, base_pay: 0, bonus: 0, overtime_pay: 0,
            overtime_hours: 0, total_pay: 0, is_paid: false, paid_on: null,
        });
    }
    return res.json(own);
}));

router.post('/:employeeId/bonus', requireAdmin, asyncHandler(async (req, res) => {
    const { year, month, bonus } = req.body;
    if (!year || !month || bonus === undefined) {
        return res.status(400).json({ error: 'year, month, and bonus are required' });
    }

    const companyId = req.user.companyId;
    const employeeId = Number(req.params.employeeId);
    const amount = Number(bonus);
    if (!Number.isFinite(amount) || amount < 0) {
        return res.status(400).json({ error: 'bonus must be a non-negative number' });
    }

    // Keep the existing endpoint/feature, but store the monthly inline payroll
    // adjustment in the same `bonuses` source used by Bonus Payroll. This
    // prevents the two screens from silently overwriting each other.
    const adjustmentReason = '[SYSTEM:PayrollScreenBonusAdjustment]';
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        try {
            const [existing] = await conn.query(
                `SELECT id FROM bonuses
                 WHERE company_id = ? AND employee_id = ? AND year = ? AND month = ? AND reason = ?
                 ORDER BY id DESC LIMIT 1`,
                [companyId, employeeId, year, month, adjustmentReason]
            );
            if (existing.length) {
                await conn.query('UPDATE bonuses SET amount = ? WHERE id = ?', [amount, existing[0].id]);
            } else {
                await conn.query(
                    `INSERT INTO bonuses (company_id, employee_id, year, month, amount, reason)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [companyId, employeeId, year, month, amount, adjustmentReason]
                );
            }

            const [totals] = await conn.query(
                `SELECT COALESCE(SUM(amount), 0) AS bonus
                 FROM bonuses WHERE company_id = ? AND employee_id = ? AND year = ? AND month = ?`,
                [companyId, employeeId, year, month]
            );
            const totalBonus = Number(totals[0]?.bonus || 0);
            await conn.query(
                `INSERT INTO payroll_records (company_id, employee_id, year, month, bonus, total_pay)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE bonus = VALUES(bonus)`,
                [companyId, employeeId, year, month, totalBonus, totalBonus]
            );
            await conn.commit();
            return res.json({ message: 'Bonus updated', bonus: totalBonus });
        } catch (err) {
            if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
            await conn.rollback();
            // Backward-compatible fallback for databases that predate Bonus Payroll.
            await pool.query(
                `INSERT INTO payroll_records (company_id, employee_id, year, month, bonus, total_pay)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE bonus = VALUES(bonus)`,
                [companyId, employeeId, year, month, amount, amount]
            );
            return res.json({ message: 'Bonus updated', bonus: amount });
        }
    } catch (err) {
        try { await conn.rollback(); } catch (_) {}
        throw err;
    } finally {
        conn.release();
    }
}));

router.post('/:employeeId/mark-paid', requireAdmin, asyncHandler(async (req, res) => {
    const { year, month, is_paid } = req.body;
    if (!year || !month || is_paid === undefined) {
        return res.status(400).json({ error: 'year, month, and is_paid are required' });
    }

    await pool.query(
        `INSERT INTO payroll_records (company_id, employee_id, year, month, is_paid, paid_on)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE is_paid = VALUES(is_paid), paid_on = VALUES(paid_on)`,
        [req.user.companyId, req.params.employeeId, year, month, is_paid, is_paid ? new Date() : null]
    );

    // migration_028 - this is the one place a 'salary_percent' loan's
    // monthly deduction actually gets written, not computeMonthlyPayroll
    // (which only ever previews it - see that function's loanRows
    // comment). Only fires when marking AS paid, not on un-marking -
    // un-marking doesn't reverse a deduction that already happened.
    // uq_loan_payroll_auto (loan_id, payroll_year, payroll_month,
    // source) is what makes this safe to call more than once for the
    // same employee/month (mark-paid -> un-mark -> mark-paid again).
    if (is_paid) {
        try {
            const [empRows] = await pool.query(
                'SELECT id FROM employees WHERE id = ? AND company_id = ?',
                [req.params.employeeId, req.user.companyId]
            );
            if (empRows.length) {
                const payrollRows = await computeMonthlyPayroll(req.user.companyId, year, month);
                const own = payrollRows.find(r => r.employee_id === Number(req.params.employeeId));
                if (own && own.loans && own.loans.length) {
                    for (const loan of own.loans) {
                        if (loan.repayment_mode !== 'salary_percent' || loan.projected_deduction_this_month <= 0) continue;
                        await pool.query(
                            `INSERT IGNORE INTO loan_payments
                                (company_id, loan_id, amount, payment_date, source, payroll_year, payroll_month, note)
                             VALUES (?, ?, ?, CURDATE(), 'payroll_auto', ?, ?, ?)`,
                            [req.user.companyId, loan.loan_id, loan.projected_deduction_this_month, year, month,
                                `Auto salary deduction - ${year}-${String(month).padStart(2, '0')}`]
                        );
                        // Auto-close the loan once it's fully repaid.
                        const remaining = loan.outstanding_balance - loan.projected_deduction_this_month;
                        if (remaining <= 0.01) {
                            await pool.query(
                                "UPDATE loans SET status = 'closed' WHERE id = ? AND company_id = ?",
                                [loan.loan_id, req.user.companyId]
                            );
                        }
                    }
                }
            }
        } catch (err) {
            // Best-effort - the payroll_records row above is already
            // committed, and this is a loans table dependency
            // (migration_028) that may not exist yet on an older DB.
            if (err.code !== 'ER_NO_SUCH_TABLE' && err.code !== 'ER_BAD_FIELD_ERROR') throw err;
        }
    }

    return res.json({ message: 'Paid status updated' });
}));

module.exports = router;
module.exports.computeMonthlyPayroll = computeMonthlyPayroll;
