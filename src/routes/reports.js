const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Reports (SCREENS.md section 7) - all read-only, all built against
 * attendance/leave_applications/holidays/weekly_off_config/employees,
 * which already exist and are already being written to.
 *
 * Daily/Monthly/Yearly all classify each employee-day using the SAME
 * rule payroll.js already documents and uses for pay calculation
 * (holiday/weekly-off -> excluded from the "present/absent" question
 * entirely; approved leave -> 'leave'; else attendance hours vs.
 * full_day_hours/half_day_min_hours -> present/half_day/absent). This
 * mirrors payroll.js's per-day logic rather than sharing code with it
 * (payroll.js is owned by the shared Payroll route, not duplicated here
 * to avoid a cross-file edit) - flagged in PASS_NOTES.md as duplicated
 * methodology, not shared code, so if the MVP payroll rule ever changes
 * this file needs the same change made twice.
 *
 * "Old Version Monthly" (SCREENS.md 7, no separate spec found - see
 * PASS_NOTES.md) reuses GET /reports/monthly's exact response as-is; the
 * "old version" is purely a denser Flutter-side table layout
 * (old_monthly_report_screen.dart), not a different backend shape.
 */

function toDateStr(d) {
    if (d == null) return null;
    return d instanceof Date ? d.toISOString().slice(0, 10) : String(d);
}

async function loadCompanyContext(companyId) {
    const [policyRows] = await pool.query(
        'SELECT full_day_hours, half_day_min_hours FROM office_time_policy WHERE company_id = ?',
        [companyId]
    );
    const fullDayHours = policyRows.length ? Number(policyRows[0].full_day_hours) : 8.0;
    const halfDayMinHours = policyRows.length ? Number(policyRows[0].half_day_min_hours) : 4.0;

    const [weeklyOffRows] = await pool.query(
        'SELECT off_days_bitmask FROM weekly_off_config WHERE company_id = ? AND department IS NULL LIMIT 1',
        [companyId]
    );
    const offDaysBitmask = weeklyOffRows.length ? weeklyOffRows[0].off_days_bitmask : 1; // default: Sunday only

    return { fullDayHours, halfDayMinHours, offDaysBitmask };
}

/**
 * Classifies one employee-day. Returns one of:
 * 'holiday' | 'weekly_off' | 'leave' | 'present' | 'half_day' | 'absent'
 */
function classifyDay({ dateStr, dayOfWeek, holidayDates, offDaysBitmask, isOnApprovedLeave, attendance, fullDayHours, halfDayMinHours }) {
    if (holidayDates.has(dateStr)) return 'holiday';
    if ((offDaysBitmask & (1 << dayOfWeek)) !== 0) return 'weekly_off';
    if (isOnApprovedLeave(dateStr)) return 'leave';
    if (!attendance || !attendance.check_in) return 'absent';

    let hours = 0;
    if (attendance.check_out) {
        hours = (new Date(attendance.check_out) - new Date(attendance.check_in)) / (1000 * 60 * 60);
    }
    if (hours >= fullDayHours) return 'present';
    if (hours >= halfDayMinHours) return 'half_day';
    return 'absent';
}

/**
 * GET /reports/daily?date=YYYY-MM-DD
 * Every active employee for one day, with a derived status - unlike
 * plain GET /attendance (which only returns rows that exist in the
 * attendance table), this includes employees with no punch at all so
 * absentees actually show up.
 */
router.get('/daily', requireAdmin, asyncHandler(async (req, res) => {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date (YYYY-MM-DD) query param required' });

    const companyId = req.user.companyId;
    const { fullDayHours, halfDayMinHours, offDaysBitmask } = await loadCompanyContext(companyId);

    const [employees] = await pool.query(
        "SELECT id, name, emp_code FROM employees WHERE company_id = ? AND status = 'active'",
        [companyId]
    );
    const [attendanceRows] = await pool.query(
        'SELECT employee_id, check_in, check_out FROM attendance WHERE company_id = ? AND date = ?',
        [companyId, date]
    );
    const attendanceByEmp = new Map(attendanceRows.map(r => [r.employee_id, r]));

    const [leaveRows] = await pool.query(
        `SELECT employee_id FROM leave_applications
         WHERE company_id = ? AND status = 'approved' AND from_date <= ? AND to_date >= ?`,
        [companyId, date, date]
    );
    const onLeaveEmpIds = new Set(leaveRows.map(r => r.employee_id));

    const [holidayRows] = await pool.query('SELECT date FROM holidays WHERE company_id = ? AND date = ?', [companyId, date]);
    const holidayDates = new Set(holidayRows.map(h => toDateStr(h.date)));

    const dayOfWeek = new Date(`${date}T00:00:00`).getDay();

    const result = employees.map(emp => {
        const attendance = attendanceByEmp.get(emp.id);
        const status = classifyDay({
            dateStr: date,
            dayOfWeek,
            holidayDates,
            offDaysBitmask,
            isOnApprovedLeave: () => onLeaveEmpIds.has(emp.id),
            attendance,
            fullDayHours,
            halfDayMinHours,
        });
        return {
            employee_id: emp.id,
            employee_name: emp.name,
            emp_code: emp.emp_code,
            date,
            check_in: attendance ? attendance.check_in : null,
            check_out: attendance ? attendance.check_out : null,
            status,
        };
    });
    return res.json(result);
}));

/**
 * GET /reports/missed-punch?date=YYYY-MM-DD
 * Employees with a check_in but no check_out (or vice versa) that day -
 * straightforward query against the attendance table, joined for names
 * the same way attendance.js already does.
 */
router.get('/missed-punch', requireAdmin, asyncHandler(async (req, res) => {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date (YYYY-MM-DD) query param required' });

    const [rows] = await pool.query(
        `SELECT a.*, e.name AS employee_name, e.emp_code AS employee_code
         FROM attendance a
         JOIN employees e ON e.id = a.employee_id
         WHERE a.company_id = ? AND a.date = ?
           AND (a.check_in IS NULL OR a.check_out IS NULL)
         ORDER BY e.name ASC`,
        [req.user.companyId, date]
    );
    return res.json(rows);
}));

/**
 * Shared per-employee-per-month tally used by both /reports/monthly and
 * /reports/yearly (one month at a time for yearly, called 12 times).
 */
async function computeMonthlySummary(companyId, year, month, context) {
    const { fullDayHours, halfDayMinHours, offDaysBitmask } = context;
    const daysInMonth = new Date(year, month, 0).getDate();
    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

    const [employees] = await pool.query(
        "SELECT id, name, emp_code FROM employees WHERE company_id = ? AND status = 'active'",
        [companyId]
    );
    const [attendanceRows] = await pool.query(
        'SELECT employee_id, date, check_in, check_out FROM attendance WHERE company_id = ? AND date BETWEEN ? AND ?',
        [companyId, monthStart, monthEnd]
    );
    const attendanceByEmpDate = new Map();
    for (const row of attendanceRows) {
        attendanceByEmpDate.set(`${row.employee_id}|${toDateStr(row.date)}`, row);
    }
    const [leaveRows] = await pool.query(
        `SELECT employee_id, from_date, to_date FROM leave_applications
         WHERE company_id = ? AND status = 'approved' AND from_date <= ? AND to_date >= ?`,
        [companyId, monthEnd, monthStart]
    );
    const [holidayRows] = await pool.query(
        'SELECT date FROM holidays WHERE company_id = ? AND date BETWEEN ? AND ?',
        [companyId, monthStart, monthEnd]
    );
    const holidayDates = new Set(holidayRows.map(h => toDateStr(h.date)));

    return employees.map(emp => {
        let presentDays = 0, halfDays = 0, absentDays = 0, leaveDays = 0, workingDays = 0;

        const isOnApprovedLeave = (dateStr) => leaveRows.some(l => {
            if (l.employee_id !== emp.id) return false;
            const from = toDateStr(l.from_date);
            const to = toDateStr(l.to_date);
            return dateStr >= from && dateStr <= to;
        });

        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const dayOfWeek = new Date(year, month - 1, day).getDay();
            const attendance = attendanceByEmpDate.get(`${emp.id}|${dateStr}`);
            const status = classifyDay({
                dateStr, dayOfWeek, holidayDates, offDaysBitmask,
                isOnApprovedLeave, attendance, fullDayHours, halfDayMinHours,
            });
            if (status === 'present') { presentDays++; workingDays++; }
            else if (status === 'half_day') { halfDays++; workingDays++; }
            else if (status === 'absent') { absentDays++; workingDays++; }
            else if (status === 'leave') { leaveDays++; }
            // holiday / weekly_off: excluded from workingDays denominator entirely
        }

        return {
            employee_id: emp.id,
            employee_name: emp.name,
            emp_code: emp.emp_code,
            present_days: presentDays,
            half_days: halfDays,
            absent_days: absentDays,
            leave_days: leaveDays,
            working_days: workingDays,
        };
    });
}

/**
 * GET /reports/monthly?year=&month=
 * Also backs "Old Version Monthly" client-side - see file header note.
 */
router.get('/monthly', requireAdmin, asyncHandler(async (req, res) => {
    const year = parseInt(req.query.year, 10);
    const month = parseInt(req.query.month, 10);
    if (!year || !month || month < 1 || month > 12) {
        return res.status(400).json({ error: 'year and month (1-12) query params required' });
    }
    const context = await loadCompanyContext(req.user.companyId);
    const result = await computeMonthlySummary(req.user.companyId, year, month, context);
    return res.json(result);
}));

/**
 * GET /reports/yearly?year=
 * Per employee, present-day count for each of the 12 months plus a
 * yearly total - runs computeMonthlySummary 12 times (once per month),
 * which is the straightforward-but-not-fast approach; fine for a report
 * screen an admin opens occasionally, not something called in a loop.
 */
router.get('/yearly', requireAdmin, asyncHandler(async (req, res) => {
    const year = parseInt(req.query.year, 10);
    if (!year) return res.status(400).json({ error: 'year query param required' });

    const context = await loadCompanyContext(req.user.companyId);
    const byEmployee = new Map(); // employee_id -> { employee_name, emp_code, monthly: [12] }

    for (let month = 1; month <= 12; month++) {
        const monthly = await computeMonthlySummary(req.user.companyId, year, month, context);
        for (const row of monthly) {
            if (!byEmployee.has(row.employee_id)) {
                byEmployee.set(row.employee_id, {
                    employee_id: row.employee_id,
                    employee_name: row.employee_name,
                    emp_code: row.emp_code,
                    monthly_present_days: new Array(12).fill(0),
                });
            }
            byEmployee.get(row.employee_id).monthly_present_days[month - 1] = row.present_days + (row.half_days * 0.5);
        }
    }

    const result = Array.from(byEmployee.values()).map(r => ({
        ...r,
        total_present_days: r.monthly_present_days.reduce((a, b) => a + b, 0),
    }));
    return res.json(result);
}));

module.exports = router;
