const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

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
async function computeMonthlyPayroll(companyId, year, month) {
    const daysInMonth = new Date(year, month, 0).getDate();
    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

    // BUG FIX (pass 2 - "mid-month payroll" complaint): the day loop
    // below used to always run through daysInMonth regardless of
    // today's actual date. For the CURRENT, still-in-progress month,
    // every day after today has no attendance row yet (it hasn't
    // happened) and no leave application either, and fell straight
    // into the "no pay - no punch, no leave" branch - i.e. every
    // remaining day of the month was silently treated as an unpaid
    // ABSENCE. Checking payroll on, say, the 13th showed pay as if the
    // employee were going to be absent for the other 17-18 days, which
    // is exactly the "mid of the month" complaint. Now: for the
    // current month only, the loop stops at today (inclusive - today's
    // own attendance may already be in) and anything after that is
    // simply not evaluated at all (not paid, not deducted) - the
    // response reports how many days were actually counted so the UI
    // can show "earned so far" instead of implying a final total.
    const now = new Date();
    const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;
    const isFutureMonth = year > now.getFullYear() || (year === now.getFullYear() && month > now.getMonth() + 1);
    const daysToCount = isFutureMonth ? 0 : (isCurrentMonth ? now.getDate() : daysInMonth);

    // pf_percent/epf_percent/esi_percent/pf_limit/tds_amount/tds_percent/
    // statutory_override_active added by migration_035 - per-employee
    // overrides of the company-wide Statutory Settings, applied below in
    // computeStatutoryDeductions only when statutory_override_active is
    // true (see that function's header comment). Wrapped in a try/catch
    // with the same defensive fallback as the statutory_settings block
    // further down, since migration_035 may not have been run yet on an
    // older DB.
    let employees;
    try {
        [employees] = await pool.query(
            `SELECT e.id, e.name, e.emp_code, e.salary, d.default_salary,
                    e.pf_percent, e.epf_percent, e.esi_percent, e.pf_limit,
                    e.tds_amount, e.tds_percent, e.statutory_override_active
             FROM employees e
             LEFT JOIN designations d ON d.id = e.designation_id
             WHERE e.company_id = ? AND e.status = 'active'`,
            [companyId]
        );
    } catch (err) {
        if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
        // migration_035 not applied yet - fall back to the pre-migration
        // column set; every employee is simply treated as having no
        // statutory/OT override (same as statutory_override_active being
        // false for everyone).
        [employees] = await pool.query(
            `SELECT e.id, e.name, e.emp_code, e.salary, d.default_salary
             FROM employees e
             LEFT JOIN designations d ON d.id = e.designation_id
             WHERE e.company_id = ? AND e.status = 'active'`,
            [companyId]
        );
    }

    // Payment Setup integration fix: this used to only ever read
    // employees.salary/designations.default_salary, with no visibility
    // into whether an employee actually has Payment Setup heads
    // configured at all (routes/salaryStructures.js writes
    // addition_total - deduction_total into employees.salary on every
    // save, so the FLAT NUMBER was already correct - what was missing
    // is any way for this screen to show the breakdown behind that
    // number, or to tell "Payment Setup was used" apart from "nobody
    // ever touched Payment Setup, this is just the raw employees.salary
    // field"). Fetched once for the whole company, not per-employee.
    let salaryHeadTotals = [];
    try {
        [salaryHeadTotals] = await pool.query(
            `SELECT employee_id,
                    SUM(CASE WHEN head_type = 'addition' THEN amount ELSE 0 END) AS addition_total,
                    SUM(CASE WHEN head_type = 'deduction' THEN amount ELSE 0 END) AS deduction_total
             FROM salary_heads
             WHERE company_id = ?
             GROUP BY employee_id`,
            [companyId]
        );
    } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
        // migration_035 not applied yet - every employee behaves as
        // "no Payment Setup heads", same defensive fallback pattern
        // salaryStructures.js itself already uses.
    }
    const salaryHeadsByEmp = new Map(salaryHeadTotals.map(r => [r.employee_id, r]));

    const [policyRows] = await pool.query(
        'SELECT full_day_hours, half_day_min_hours FROM office_time_policy WHERE company_id = ?',
        [companyId]
    );
    const fullDayHours = policyRows.length ? Number(policyRows[0].full_day_hours) : 8.0;
    const halfDayMinHours = policyRows.length ? Number(policyRows[0].half_day_min_hours) : 4.0;

    const [attendanceRows] = await pool.query(
        `SELECT employee_id, date, check_in, check_out
         FROM attendance
         WHERE company_id = ? AND date BETWEEN ? AND ?`,
        [companyId, monthStart, monthEnd]
    );
    const attendanceByEmpDate = new Map();
    for (const row of attendanceRows) {
        const dateKey = row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date);
        attendanceByEmpDate.set(`${row.employee_id}|${dateKey}`, row);
    }

    // days_count/paid_days (migration_009, Part 4): paid_days is how
    // many of this application's days count as paid leave, decided once
    // at apply-time (see routes/leaves.js POST /) against that month's
    // quota - the remainder is unpaid, i.e. no pay for those days,
    // exactly like an unapproved absence. A NULL paid_days means this
    // row predates the split (created before migration_009) and is
    // treated as fully paid, matching the old behavior exactly.
    const [leaveRows] = await pool.query(
        `SELECT employee_id, from_date, to_date, days_count, paid_days
         FROM leave_applications
         WHERE company_id = ? AND status = 'approved'
           AND from_date <= ? AND to_date >= ?`,
        [companyId, monthEnd, monthStart]
    );

    const [holidayRows] = await pool.query(
        'SELECT date FROM holidays WHERE company_id = ? AND date BETWEEN ? AND ?',
        [companyId, monthStart, monthEnd]
    );
    const holidayDates = new Set(
        holidayRows.map(h => (h.date instanceof Date ? h.date.toISOString().slice(0, 10) : String(h.date)))
    );

    const [weeklyOffRows] = await pool.query(
        'SELECT off_days_bitmask FROM weekly_off_config WHERE company_id = ? AND department IS NULL LIMIT 1',
        [companyId]
    );
    const offDaysBitmask = weeklyOffRows.length ? weeklyOffRows[0].off_days_bitmask : 1; // default: Sunday only

    const [existingPayroll] = await pool.query(
        'SELECT employee_id, bonus, is_paid, paid_on FROM payroll_records WHERE company_id = ? AND year = ? AND month = ?',
        [companyId, year, month]
    );
    const payrollByEmp = new Map(existingPayroll.map(p => [p.employee_id, p]));

    // migration_028 - active loans per employee, for the projected
    // (not-yet-committed) monthly deduction shown here. 'salary_percent'
    // loans get auto-deducted for real when payroll is marked paid (see
    // POST /:employeeId/mark-paid below) - this function itself is
    // read-only (called from both GET / and GET /me) and must never
    // write a loan_payments row on its own, or simply viewing payroll
    // twice would double-charge the loan. 'installments' loans are
    // never auto-deducted - shown here purely so the list surfaces that
    // an employee still has one outstanding.
    let loanRows = [];
    try {
        [loanRows] = await pool.query(
            `SELECT l.id, l.employee_id, l.principal_amount, l.repayment_mode, l.salary_deduction_percent,
                    COALESCE((SELECT SUM(amount) FROM loan_payments WHERE loan_id = l.id), 0) AS paid_so_far
             FROM loans l
             WHERE l.company_id = ? AND l.status != 'closed'`,
            [companyId]
        );
    } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE' && err.code !== 'ER_BAD_FIELD_ERROR') throw err;
        // migration_028 not applied yet - proceed with no loan deductions,
        // same defensive fallback pattern as the statutory settings block
        // above.
    }
    const loansByEmp = new Map();
    for (const l of loanRows) {
        if (!loansByEmp.has(l.employee_id)) loansByEmp.set(l.employee_id, []);
        loansByEmp.get(l.employee_id).push(l);
    }

    // Overtime (migration_008) - only APPROVED records count toward pay;
    // pending ones are still awaiting admin sign-off and rejected ones
    // never did, so neither should show up in what someone is actually
    // paid.
    const [overtimeRows] = await pool.query(
        `SELECT employee_id, SUM(amount) AS overtime_pay, SUM(overtime_hours) AS overtime_hours
         FROM overtime_records
         WHERE company_id = ? AND status = 'approved' AND date BETWEEN ? AND ?
         GROUP BY employee_id`,
        [companyId, monthStart, monthEnd]
    );
    const overtimeByEmp = new Map(overtimeRows.map(r => [r.employee_id, r]));

    // PF/ESI/PT (migration_021 / routes/statutorySettings.js). Fetched
    // once here, not per-employee, then applied inside the map below by
    // computeStatutoryDeductions(). Defensive on purpose: if
    // migration_021 hasn't been run yet, this falls back to "nothing
    // enabled" rather than throwing and breaking payroll entirely for
    // every employee over a feature they may not even be using yet -
    // same reasoning as the email-settings hardening in pass 2.
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
        // migration_021 not applied yet - proceed with PF/ESI/PT all off.
    }

    const result = employees.map(emp => {
        const monthlySalary = Number(emp.salary ?? emp.default_salary ?? 0);
        const perDayRate = monthlySalary / daysInMonth;

        // Returns 'paid', 'unpaid', or null (not on leave that day). The
        // split's paid_days count from the front of the application (day
        // 0, 1, 2... from from_date) - matches how routes/leaves.js POST
        // / decided it: "first N days paid" where N is whatever quota
        // was left when the employee applied.
        const leavePayStatusFor = (dateStr) => {
            for (const l of leaveRows) {
                if (l.employee_id !== emp.id) continue;
                const from = l.from_date instanceof Date ? l.from_date.toISOString().slice(0, 10) : String(l.from_date);
                const to = l.to_date instanceof Date ? l.to_date.toISOString().slice(0, 10) : String(l.to_date);
                if (dateStr < from || dateStr > to) continue;

                const paidDays = l.paid_days !== null && l.paid_days !== undefined
                    ? Number(l.paid_days)
                    : Number(l.days_count); // pre-migration_009 row: fully paid, unchanged from old behavior
                const dayIndex = Math.round((new Date(dateStr) - new Date(from)) / (1000 * 60 * 60 * 24));
                return dayIndex < paidDays ? 'paid' : 'unpaid';
            }
            return null;
        };

        let basePay = 0;
        for (let day = 1; day <= daysToCount; day++) {
            const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const dayOfWeek = new Date(year, month - 1, day).getDay(); // 0=Sun..6=Sat, matches off_days_bitmask bit layout

            if (holidayDates.has(dateStr)) { basePay += perDayRate; continue; } // paid automatically
            if ((offDaysBitmask & (1 << dayOfWeek)) !== 0) { basePay += perDayRate; continue; } // weekly off, paid automatically

            const leaveStatus = leavePayStatusFor(dateStr);
            if (leaveStatus === 'paid') {
                basePay += perDayRate;
                continue;
            }
            if (leaveStatus === 'unpaid') {
                continue; // unpaid leave day - no pay, counted as absence
            }

            const attendance = attendanceByEmpDate.get(`${emp.id}|${dateStr}`);
            if (!attendance || !attendance.check_in) {
                continue; // no pay - no punch, no leave
            }

            let hours = 0;
            if (attendance.check_out) {
                hours = (new Date(attendance.check_out) - new Date(attendance.check_in)) / (1000 * 60 * 60);
            }

            if (hours >= fullDayHours) {
                basePay += perDayRate;
            } else if (hours >= halfDayMinHours) {
                basePay += perDayRate / 2;
            }
            // else: no pay for that day
        }

        const existing = payrollByEmp.get(emp.id);
        const bonus = existing ? Number(existing.bonus) : 0;
        const overtime = overtimeByEmp.get(emp.id);
        const overtimePay = overtime ? Math.round(Number(overtime.overtime_pay) * 100) / 100 : 0;
        const overtimeHours = overtime ? Number(overtime.overtime_hours) : 0;
        const roundedBasePay = Math.round(basePay * 100) / 100;
        const totalPay = Math.round((basePay + bonus + overtimePay) * 100) / 100;

        // Payment Setup breakdown for this employee (see the batched
        // query above) - hasSalaryStructure lets the UI say plainly
        // "this figure came from Payment Setup" vs "nobody has
        // configured Payment Setup for this employee yet, this is just
        // the flat Salary field" instead of presenting both the same
        // way and leaving the admin to guess which one they're looking
        // at.
        const headsSummary = salaryHeadsByEmp.get(emp.id);
        const hasSalaryStructure = !!headsSummary;

        // PF wages = the earned base pay for this period (already
        // prorated for absences/LOP above) - PF is a wage-linked
        // deduction, not charged on bonus/overtime. ESI and PT are
        // conventionally checked against gross pay instead (basic +
        // allowances + bonus + overtime), so they use totalPay.
        const employeeOverride = emp.statutory_override_active === undefined ? null : {
            active: !!emp.statutory_override_active,
            pfPercent: emp.pf_percent, epfPercent: emp.epf_percent, esiPercent: emp.esi_percent,
            pfLimit: emp.pf_limit, tdsAmount: emp.tds_amount, tdsPercent: emp.tds_percent,
        };
        const statutory = computeStatutoryDeductions(statutorySettings, ptSlabs, roundedBasePay, totalPay, employeeOverride);

        // Projected loan deduction (migration_028) - see the loanRows
        // comment above for why this is a preview only, not a write.
        let loanDeduction = 0;
        const empLoans = loansByEmp.get(emp.id) || [];
        const loanSummaries = empLoans.map(l => {
            const outstanding = Math.max(0, Number(l.principal_amount) - Number(l.paid_so_far));
            let projected = 0;
            if (l.repayment_mode === 'salary_percent' && l.salary_deduction_percent) {
                projected = Math.min(outstanding, round2(roundedBasePay * Number(l.salary_deduction_percent) / 100));
                loanDeduction += projected;
            }
            return {
                loan_id: l.id,
                repayment_mode: l.repayment_mode,
                outstanding_balance: round2(outstanding),
                projected_deduction_this_month: round2(projected),
            };
        });

        return {
            employee_id: emp.id,
            employee_name: emp.name,
            emp_code: emp.emp_code,
            base_pay: roundedBasePay,
            bonus,
            overtime_pay: overtimePay,
            overtime_hours: overtimeHours,
            total_pay: totalPay,
            pf_employee: statutory.pfEmployee,
            pf_employer: statutory.pfEmployer,
            esi_employee: statutory.esiEmployee,
            esi_employer: statutory.esiEmployer,
            pt_amount: statutory.ptAmount,
            // migration_035 - per-employee TDS, only nonzero when this
            // employee has an active statutory override with a TDS
            // amount/percent set (see computeStatutoryDeductions above).
            tds_amount: statutory.tdsAmount,
            loans: loanSummaries,
            loan_deduction: round2(loanDeduction),
            net_pay: Math.round((totalPay - statutory.pfEmployee - statutory.esiEmployee - statutory.ptAmount - statutory.tdsAmount - loanDeduction) * 100) / 100,
            has_salary_structure: hasSalaryStructure,
            addition_total: hasSalaryStructure ? round2(Number(headsSummary.addition_total)) : null,
            deduction_total: hasSalaryStructure ? round2(Number(headsSummary.deduction_total)) : null,
            is_paid: existing ? !!existing.is_paid : false,
            paid_on: existing ? existing.paid_on : null,
            // New (pass 2, see daysToCount comment above): lets the UI
            // show "earned through day X of Y" instead of a number that
            // silently looks final when the month isn't over yet.
            days_counted: daysToCount,
            days_in_month: daysInMonth,
            month_in_progress: isCurrentMonth,
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

    await pool.query(
        `INSERT INTO payroll_records (company_id, employee_id, year, month, bonus, total_pay)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE bonus = VALUES(bonus)`,
        [req.user.companyId, req.params.employeeId, year, month, bonus, bonus]
    );
    return res.json({ message: 'Bonus updated' });
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
