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
 * Shared computation behind GET / (all employees, admin) and GET /me
 * (the caller's own row, any employee). Pulled out so both routes stay
 * byte-for-byte identical in how a payslip is computed - the only
 * difference between them is which row(s) of `result` get returned.
 */
async function computeMonthlyPayroll(companyId, year, month) {
    const daysInMonth = new Date(year, month, 0).getDate();
    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

    const [employees] = await pool.query(
        `SELECT e.id, e.name, e.emp_code, e.salary, d.default_salary
         FROM employees e
         LEFT JOIN designations d ON d.id = e.designation_id
         WHERE e.company_id = ? AND e.status = 'active'`,
        [companyId]
    );

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
        for (let day = 1; day <= daysInMonth; day++) {
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

        return {
            employee_id: emp.id,
            employee_name: emp.name,
            emp_code: emp.emp_code,
            base_pay: Math.round(basePay * 100) / 100,
            bonus,
            overtime_pay: overtimePay,
            overtime_hours: overtimeHours,
            total_pay: Math.round((basePay + bonus + overtimePay) * 100) / 100,
            is_paid: existing ? !!existing.is_paid : false,
            paid_on: existing ? existing.paid_on : null
        };
    });

    return result;
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
    return res.json({ message: 'Paid status updated' });
}));

module.exports = router;
