const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');
const {
    loadHolidayIndex,
    loadEmployeeHolidayGroups,
    loadWeeklyOffIndex,
    effectiveOffDaysBitmask,
} = require('../utils/attendanceRules');

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

    // offDaysBitmask used to be resolved once here, company-wide, and
    // reused for every employee - which meant department-specific
    // weekly_off_config rows and Holiday Groups were silently ignored
    // (every employee got the same single bitmask and the same
    // unfiltered holiday list, regardless of their own department or
    // branch). Both are now resolved per-employee - see
    // utils/attendanceRules.js - so this only still loads what's
    // genuinely company-wide: the hours policy.
    return { fullDayHours, halfDayMinHours };
}

/**
 * Classifies one employee-day. Returns one of:
 * 'holiday' | 'weekly_off' | 'leave' | 'present' | 'half_day' | 'absent'
 */
function classifyDay({ dateStr, dayOfWeek, isHoliday, offDaysBitmask, isOnApprovedLeave, attendance, fullDayHours, halfDayMinHours }) {
    if (isHoliday(dateStr)) return 'holiday';
    if ((offDaysBitmask & (1 << dayOfWeek)) !== 0) return 'weekly_off';
    if (isOnApprovedLeave(dateStr)) return 'leave';
    if (!attendance || !attendance.check_in) return 'absent';

    // No checkout recorded yet (missed punch, single-punch device policy,
    // or - for today - simply hasn't left yet) - GET
    // /employees/:id/monthly-summary counts this as 'present' on a bare
    // check-in with no hours check at all, so this needs to agree rather
    // than falling through to 'absent' for lack of a checkout to measure
    // hours against. That mismatch was exactly why an employee could show
    // present on the Attendance card and 0%/absent on the Monthly and
    // Performance reports for the same day.
    if (!attendance.check_out) return 'present';

    const hours = (new Date(attendance.check_out) - new Date(attendance.check_in)) / (1000 * 60 * 60);
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
    const { fullDayHours, halfDayMinHours } = await loadCompanyContext(companyId);

    const [employees] = await pool.query(
        "SELECT id, name, emp_code, department FROM employees WHERE company_id = ? AND status = 'active'",
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

    // Per-employee holiday-group + weekly-off resolution (see
    // utils/attendanceRules.js) instead of one shared company-wide
    // holiday list / bitmask for every employee.
    const holidayIndex = await loadHolidayIndex(companyId, date, date);
    const employeeGroups = await loadEmployeeHolidayGroups(companyId);
    const weeklyOffIndex = await loadWeeklyOffIndex(companyId);

    const dayOfWeek = new Date(`${date}T00:00:00`).getDay();

    const result = employees.map(emp => {
        const attendance = attendanceByEmp.get(emp.id);
        const employeeGroupId = employeeGroups.get(emp.id) ?? null;
        const offDaysBitmask = effectiveOffDaysBitmask(null, emp.department, weeklyOffIndex);
        const status = classifyDay({
            dateStr: date,
            dayOfWeek,
            isHoliday: (d) => holidayIndex.isHoliday(d, employeeGroupId),
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
    const { fullDayHours, halfDayMinHours } = context;
    const daysInMonth = new Date(year, month, 0).getDate();
    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

    const [employees] = await pool.query(
        "SELECT id, name, emp_code, department FROM employees WHERE company_id = ? AND status = 'active'",
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
    // Per-employee holiday-group + weekly-off resolution (see
    // utils/attendanceRules.js) - replaces the single company-wide
    // holiday Set + bitmask this used to compute once and apply to
    // every employee regardless of their branch/department.
    const holidayIndex = await loadHolidayIndex(companyId, monthStart, monthEnd);
    const employeeGroups = await loadEmployeeHolidayGroups(companyId);
    const weeklyOffIndex = await loadWeeklyOffIndex(companyId);

    return employees.map(emp => {
        let presentDays = 0, halfDays = 0, absentDays = 0, leaveDays = 0, workingDays = 0;

        const isOnApprovedLeave = (dateStr) => leaveRows.some(l => {
            if (l.employee_id !== emp.id) return false;
            const from = toDateStr(l.from_date);
            const to = toDateStr(l.to_date);
            return dateStr >= from && dateStr <= to;
        });
        const employeeGroupId = employeeGroups.get(emp.id) ?? null;
        const offDaysBitmask = effectiveOffDaysBitmask(null, emp.department, weeklyOffIndex);

        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const dayOfWeek = new Date(year, month - 1, day).getDay();
            const attendance = attendanceByEmpDate.get(`${emp.id}|${dateStr}`);
            const status = classifyDay({
                dateStr, dayOfWeek,
                isHoliday: (d) => holidayIndex.isHoliday(d, employeeGroupId),
                offDaysBitmask,
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

/**
 * GET /reports/weekly?date=YYYY-MM-DD (any date inside the target week)
 * Same shape as /reports/monthly's per-employee tally, just windowed to
 * one Sun-Sat week instead of a calendar month - reuses classifyDay
 * directly (not computeMonthlySummary, which is month-bounded) so the
 * week can cross a month boundary without special-casing that split.
 * Sun-Sat matches offDaysBitmask's own bit layout (bit 0 = Sunday),
 * not an arbitrary choice.
 */
router.get('/weekly', requireAdmin, asyncHandler(async (req, res) => {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date (YYYY-MM-DD, any day in the target week) query param required' });

    const companyId = req.user.companyId;
    const anchor = new Date(`${date}T00:00:00`);
    const weekStartDate = new Date(anchor);
    weekStartDate.setDate(anchor.getDate() - anchor.getDay()); // back up to Sunday
    const weekEndDate = new Date(weekStartDate);
    weekEndDate.setDate(weekStartDate.getDate() + 6);
    const weekStart = toDateStr(weekStartDate);
    const weekEnd = toDateStr(weekEndDate);

    const { fullDayHours, halfDayMinHours } = await loadCompanyContext(companyId);

    const [employees] = await pool.query(
        "SELECT id, name, emp_code, department FROM employees WHERE company_id = ? AND status = 'active'",
        [companyId]
    );
    const [attendanceRows] = await pool.query(
        'SELECT employee_id, date, check_in, check_out FROM attendance WHERE company_id = ? AND date BETWEEN ? AND ?',
        [companyId, weekStart, weekEnd]
    );
    const attendanceByEmpDate = new Map();
    for (const row of attendanceRows) {
        attendanceByEmpDate.set(`${row.employee_id}|${toDateStr(row.date)}`, row);
    }
    const [leaveRows] = await pool.query(
        `SELECT employee_id, from_date, to_date FROM leave_applications
         WHERE company_id = ? AND status = 'approved' AND from_date <= ? AND to_date >= ?`,
        [companyId, weekEnd, weekStart]
    );
    const holidayIndex = await loadHolidayIndex(companyId, weekStart, weekEnd);
    const employeeGroups = await loadEmployeeHolidayGroups(companyId);
    const weeklyOffIndex = await loadWeeklyOffIndex(companyId);

    const result = employees.map(emp => {
        let presentDays = 0, halfDays = 0, absentDays = 0, leaveDays = 0, workingDays = 0;
        const isOnApprovedLeave = (dateStr) => leaveRows.some(l => {
            if (l.employee_id !== emp.id) return false;
            return dateStr >= toDateStr(l.from_date) && dateStr <= toDateStr(l.to_date);
        });
        const employeeGroupId = employeeGroups.get(emp.id) ?? null;
        const offDaysBitmask = effectiveOffDaysBitmask(null, emp.department, weeklyOffIndex);

        const cursor = new Date(weekStartDate);
        for (let i = 0; i < 7; i++) {
            const dateStr = toDateStr(cursor);
            const dayOfWeek = cursor.getDay();
            const attendance = attendanceByEmpDate.get(`${emp.id}|${dateStr}`);
            const status = classifyDay({
                dateStr, dayOfWeek,
                isHoliday: (d) => holidayIndex.isHoliday(d, employeeGroupId),
                offDaysBitmask,
                isOnApprovedLeave, attendance, fullDayHours, halfDayMinHours,
            });
            if (status === 'present') { presentDays++; workingDays++; }
            else if (status === 'half_day') { halfDays++; workingDays++; }
            else if (status === 'absent') { absentDays++; workingDays++; }
            else if (status === 'leave') { leaveDays++; }
            cursor.setDate(cursor.getDate() + 1);
        }

        return {
            employee_id: emp.id, employee_name: emp.name, emp_code: emp.emp_code,
            week_start: weekStart, week_end: weekEnd,
            present_days: presentDays, half_days: halfDays, absent_days: absentDays,
            leave_days: leaveDays, working_days: workingDays,
        };
    });
    return res.json(result);
}));

/**
 * Resolves which shift applies to one employee on one date: the most
 * specific shift_assignments row covering that date (roster override),
 * falling back to the employee's plain employees.shift_id, falling
 * back to the company's default shift (shifts.is_default) if the
 * employee has no shift_id at all. Returns null only if the company
 * somehow has no shifts whatsoever (shouldn't happen - shifts.js lazily
 * seeds a default shift on first GET /shifts, but a company that has
 * never once opened that screen could still be shift-less here).
 */
async function resolveEffectiveShift(companyId, employeeId, dateStr) {
    const [assignmentRows] = await pool.query(
        `SELECT s.* FROM shift_assignments sa
         JOIN shifts s ON s.id = sa.shift_id
         WHERE sa.company_id = ? AND sa.employee_id = ?
           AND sa.effective_from <= ? AND (sa.effective_to IS NULL OR sa.effective_to >= ?)
         ORDER BY sa.effective_from DESC LIMIT 1`,
        [companyId, employeeId, dateStr, dateStr]
    );
    if (assignmentRows.length > 0) return assignmentRows[0];

    const [empShiftRows] = await pool.query(
        `SELECT s.* FROM employees e JOIN shifts s ON s.id = e.shift_id
         WHERE e.id = ? AND e.company_id = ?`,
        [employeeId, companyId]
    );
    if (empShiftRows.length > 0) return empShiftRows[0];

    const [defaultRows] = await pool.query(
        'SELECT * FROM shifts WHERE company_id = ? AND is_default = TRUE LIMIT 1',
        [companyId]
    );
    return defaultRows.length > 0 ? defaultRows[0] : null;
}

/**
 * GET /reports/na-shift?date=YYYY-MM-DD
 * "NA Shift Report" - active employees with NO resolvable shift at all
 * on the given date (no roster override, no employees.shift_id, and
 * the company itself has no default shift - see
 * resolveEffectiveShift's comment on when that last case can happen).
 * In practice this should almost always be an empty list once a
 * company has opened Shifts once (shifts.js auto-seeds a default), but
 * an empty list is the whole point of this report existing - "nothing
 * to flag" is a valid, useful answer, not a sign the query is broken.
 */
router.get('/na-shift', requireAdmin, asyncHandler(async (req, res) => {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date (YYYY-MM-DD) query param required' });

    const [employees] = await pool.query(
        "SELECT id, name, emp_code FROM employees WHERE company_id = ? AND status = 'active'",
        [req.user.companyId]
    );
    const naList = [];
    for (const emp of employees) {
        const shift = await resolveEffectiveShift(req.user.companyId, emp.id, date);
        if (!shift) naList.push({ employee_id: emp.id, employee_name: emp.name, emp_code: emp.emp_code, date });
    }
    return res.json(naList);
}));

/**
 * GET /reports/late-early?date=YYYY-MM-DD
 * "Daily: Late/Early Report" - a DEDICATED report, distinct from the
 * per-day 'isLate' flag already embedded in GET
 * /employees/:id/monthly-summary (which compares against the single
 * company-wide office_time_policy.check_in_window_end and has no
 * "early" concept at all). This report instead uses each employee's
 * OWN resolved shift (resolveEffectiveShift above) and that shift's
 * late_grace_minutes/early_grace_minutes (migration_015) - a shift
 * with 0/0 grace (the default for every shift created before this
 * migration) means "late" is anything after start_time exactly and
 * "early" is anything before end_time exactly, i.e. strict by default
 * until an admin configures real grace windows per shift.
 */
router.get('/late-early', requireAdmin, asyncHandler(async (req, res) => {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date (YYYY-MM-DD) query param required' });

    const [employees] = await pool.query(
        "SELECT id, name, emp_code FROM employees WHERE company_id = ? AND status = 'active'",
        [req.user.companyId]
    );
    const [attendanceRows] = await pool.query(
        'SELECT employee_id, check_in, check_out FROM attendance WHERE company_id = ? AND date = ?',
        [req.user.companyId, date]
    );
    const attendanceByEmp = new Map(attendanceRows.map(r => [r.employee_id, r]));

    const result = [];
    for (const emp of employees) {
        const attendance = attendanceByEmp.get(emp.id);
        if (!attendance) continue; // absent entirely - not this report's concern, /reports/daily covers absence
        const shift = await resolveEffectiveShift(req.user.companyId, emp.id, date);
        if (!shift) continue; // covered instead by /reports/na-shift

        let isLate = false, lateByMinutes = 0, isEarly = false, earlyByMinutes = 0;

        if (attendance.check_in) {
            const scheduledStart = new Date(`${date}T${shift.start_time}`);
            scheduledStart.setMinutes(scheduledStart.getMinutes() + shift.late_grace_minutes);
            const actualIn = new Date(attendance.check_in);
            if (actualIn > scheduledStart) {
                isLate = true;
                lateByMinutes = Math.round((actualIn - scheduledStart) / 60000);
            }
        }
        if (attendance.check_out) {
            const scheduledEnd = new Date(`${date}T${shift.end_time}`);
            scheduledEnd.setMinutes(scheduledEnd.getMinutes() - shift.early_grace_minutes);
            const actualOut = new Date(attendance.check_out);
            if (actualOut < scheduledEnd) {
                isEarly = true;
                earlyByMinutes = Math.round((scheduledEnd - actualOut) / 60000);
            }
        }

        if (isLate || isEarly) {
            result.push({
                employee_id: emp.id, employee_name: emp.name, emp_code: emp.emp_code, date,
                shift_name: shift.name, check_in: attendance.check_in, check_out: attendance.check_out,
                is_late: isLate, late_by_minutes: lateByMinutes,
                is_early: isEarly, early_by_minutes: earlyByMinutes,
            });
        }
    }
    return res.json(result);
}));

/**
 * GET /reports/overtime?from=&to=&status=
 * "Daily: Overtime Report" - overtime_records already exists and is
 * already populated (utils/overtime.js, now also gated by
 * shifts.ot_allowed per migration_015) - this is simply the missing
 * list/report view over that existing table, with a summary total so
 * the report doesn't require the client to sum rows itself.
 */
router.get('/overtime', requireAdmin, asyncHandler(async (req, res) => {
    const { from, to, status } = req.query;
    const params = [req.user.companyId];
    let sql = `SELECT o.*, e.name AS employee_name, e.emp_code AS employee_code
               FROM overtime_records o
               JOIN employees e ON e.id = o.employee_id
               WHERE o.company_id = ?`;
    if (from) { sql += ' AND o.date >= ?'; params.push(from); }
    if (to) { sql += ' AND o.date <= ?'; params.push(to); }
    if (status) { sql += ' AND o.status = ?'; params.push(status); }
    sql += ' ORDER BY o.date DESC, e.name ASC';

    const [rows] = await pool.query(sql, params);
    const totalHours = rows.reduce((sum, r) => sum + parseFloat(r.overtime_hours || 0), 0);
    const totalAmount = rows.reduce((sum, r) => sum + parseFloat(r.amount || 0), 0);
    return res.json({ records: rows, summary: { total_hours: Math.round(totalHours * 100) / 100, total_amount: Math.round(totalAmount * 100) / 100 } });
}));

/**
 * GET /reports/performance?year=&month=
 * "Daily: Performance Report" - the PDF lists this under "Daily" along
 * with Present/Absent/Late/etc, but a single day's worth of "late
 * count" or "attendance %" isn't a meaningful performance signal on
 * its own, so this is built as a month-level scorecard per employee
 * instead (attendance %, late count, early count, absent days, OT
 * hours) - the same monthly window every other non-daily report here
 * already uses. Composed from computeMonthlySummary (attendance/leave)
 * plus a per-day late/early scan (same grace-window logic as
 * /reports/late-early above) plus a sum over overtime_records, rather
 * than inventing a new scoring formula - each number here is exactly
 * what its own dedicated report already computes, just gathered into
 * one row per employee.
 */
router.get('/performance', requireAdmin, asyncHandler(async (req, res) => {
    const year = parseInt(req.query.year, 10);
    const month = parseInt(req.query.month, 10);
    if (!year || !month || month < 1 || month > 12) {
        return res.status(400).json({ error: 'year and month (1-12) query params required' });
    }
    const companyId = req.user.companyId;
    const context = await loadCompanyContext(companyId);
    const monthlySummary = await computeMonthlySummary(companyId, year, month, context);

    const daysInMonth = new Date(year, month, 0).getDate();
    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

    const [otRows] = await pool.query(
        'SELECT employee_id, SUM(overtime_hours) AS total_hours FROM overtime_records WHERE company_id = ? AND date BETWEEN ? AND ? GROUP BY employee_id',
        [companyId, monthStart, monthEnd]
    );
    const otByEmp = new Map(otRows.map(r => [r.employee_id, parseFloat(r.total_hours) || 0]));

    const lateEarlyCounts = new Map(); // employee_id -> { late, early }
    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        // Reuses the exact same per-day logic /reports/late-early runs
        // for a single date, just looped across the month here.
        const dayResp = await computeLateEarlyForDate(companyId, dateStr);
        for (const row of dayResp) {
            const counts = lateEarlyCounts.get(row.employee_id) || { late: 0, early: 0 };
            if (row.is_late) counts.late++;
            if (row.is_early) counts.early++;
            lateEarlyCounts.set(row.employee_id, counts);
        }
    }

    const result = monthlySummary.map(row => {
        const counts = lateEarlyCounts.get(row.employee_id) || { late: 0, early: 0 };
        const attendancePct = row.working_days > 0
            ? Math.round(((row.present_days + row.half_days * 0.5) / row.working_days) * 1000) / 10
            : null;
        return {
            employee_id: row.employee_id,
            employee_name: row.employee_name,
            emp_code: row.emp_code,
            attendance_percent: attendancePct,
            present_days: row.present_days,
            half_days: row.half_days,
            absent_days: row.absent_days,
            leave_days: row.leave_days,
            late_count: counts.late,
            early_count: counts.early,
            overtime_hours: Math.round((otByEmp.get(row.employee_id) || 0) * 100) / 100,
        };
    });
    return res.json(result);
}));

// Shared by both GET /late-early and GET /performance above, so the
// month-long scorecard's late/early counts use the literal same
// per-day rule as the dedicated daily report rather than a
// re-implementation that could quietly drift from it.
async function computeLateEarlyForDate(companyId, date) {
    const [employees] = await pool.query(
        "SELECT id FROM employees WHERE company_id = ? AND status = 'active'",
        [companyId]
    );
    const [attendanceRows] = await pool.query(
        'SELECT employee_id, check_in, check_out FROM attendance WHERE company_id = ? AND date = ?',
        [companyId, date]
    );
    const attendanceByEmp = new Map(attendanceRows.map(r => [r.employee_id, r]));

    const result = [];
    for (const emp of employees) {
        const attendance = attendanceByEmp.get(emp.id);
        if (!attendance) continue;
        const shift = await resolveEffectiveShift(companyId, emp.id, date);
        if (!shift) continue;

        let isLate = false, isEarly = false;
        if (attendance.check_in) {
            const scheduledStart = new Date(`${date}T${shift.start_time}`);
            scheduledStart.setMinutes(scheduledStart.getMinutes() + shift.late_grace_minutes);
            if (new Date(attendance.check_in) > scheduledStart) isLate = true;
        }
        if (attendance.check_out) {
            const scheduledEnd = new Date(`${date}T${shift.end_time}`);
            scheduledEnd.setMinutes(scheduledEnd.getMinutes() - shift.early_grace_minutes);
            if (new Date(attendance.check_out) < scheduledEnd) isEarly = true;
        }
        if (isLate || isEarly) result.push({ employee_id: emp.id, is_late: isLate, is_early: isEarly });
    }
    return result;
}

module.exports = router;
