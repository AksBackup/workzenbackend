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
    // Task 3 (multi-punch engine) + Task 4 (Office Time Policy v2).
    derivePunchSpan,
    loadPunchEventsForDay,
    loadPunchEventsIndex,
    loadShiftPolicyIndex,
    applyPrefixSuffixAbsent,
    loadShiftPolicyOffIndex,
    resolveShiftGrace,
} = require('../utils/attendanceRules');
const { classifyDay, resolveEmployeeOffDays, hasRealCheckout, computeLateEarly } = require('../utils/dayClassifier');

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

    // migration_037: card_no (employees) and attendance_remarks feed the
    // CardNo / Remark columns of daily_report.jpeg. Branch name comes
    // from the existing branches table (migration_016).
    const [employees] = await pool.query(
        `SELECT e.id, e.name, e.emp_code, e.department, e.shift_id, e.designation, e.card_no, b.name AS branch_name
         FROM employees e LEFT JOIN branches b ON b.id = e.branch_id
         WHERE e.company_id = ? AND e.status = 'active'`,
        [companyId]
    );
    let remarkRows = [];
    try {
        [remarkRows] = await pool.query(
            'SELECT employee_id, remark FROM attendance_remarks WHERE company_id = ? AND date = ?',
            [companyId, date]
        );
    } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
    }
    const remarkByEmp = new Map(remarkRows.map(r => [r.employee_id, r.remark]));
    const overtimeIndex = await loadOvertimeIndex(companyId, date, date);
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
    // migration_027 - resolves shift-wise weekend off (weekly_off_bitmask
    // AND alt_saturdays) via each employee's shift_id, instead of the
    // bug this replaces where shift was always passed as null here,
    // silently skipping shift-level weekly-off even though the
    // fallback chain (effectiveOffDaysBitmask) already supported it.
    const shiftOffIndex = await loadShiftOffIndex(companyId);
    // migration_034 - policy-assigned weekly-off, preferred over the
    // legacy shift columns above when a shift has a policy assigned -
    // see resolveEmployeeOffDays.
    const shiftPolicyOffIndex = await loadShiftPolicyOffIndex(companyId);
    // migration_034 - policy-assigned grace minutes, preferred over
    // shifts.late_grace_minutes/early_grace_minutes below.
    const shiftPolicyIndex = await loadShiftPolicyIndex(companyId);
    // migration_033 - this day's raw punch events, batched company-wide,
    // for the multi-punch work_minutes/gap-deduction calculation below.
    const punchEventsIndex = await loadPunchEventsIndex(companyId, date, date);
    // Full shift details (name/times/grace) for the new Designation /
    // Shift / Shift Time / Late Hrs / Early Hrs columns, matching the
    // reference layout (daily_report.jpeg) the client provided -
    // reusing the same late/early math as GET /reports/late-early
    // below rather than duplicating a different formula. InTemp/OutTemp
    // from that same reference image are NOT included - this system has
    // no thermal-sensor integration on any supported device, so those
    // columns would only ever show blanks; flagging rather than faking.
    const [shiftDetailRows] = await pool.query(
        'SELECT id, name, start_time, end_time, late_grace_minutes, early_grace_minutes FROM shifts WHERE company_id = ?',
        [companyId]
    );
    const shiftDetails = new Map(shiftDetailRows.map(s => [s.id, s]));

    const dayOfWeek = new Date(`${date}T00:00:00`).getDay();

    const result = employees.map(emp => {
        const attendance = attendanceByEmp.get(emp.id);
        const employeeGroupId = employeeGroups.get(emp.id) ?? null;
        const empShift = shiftOffIndex.byId.get(emp.shift_id) ?? null;
        const { offDaysBitmask, altSaturdays, isWeeklyOff2 } =
            resolveEmployeeOffDays(emp.shift_id, empShift, emp.department, weeklyOffIndex, shiftPolicyOffIndex);

        // Task 3: derive this day's punch span/work-minutes from raw
        // punch_events when any exist (going-forward-only per
        // migration_033) - "Deduct Break Hours From Work Duration"
        // applied per the employee's shift's assigned policy, default
        // OFF (full elapsed span) when no policy is assigned.
        const dayEvents = punchEventsIndex.forEmployeeDate(emp.id, date);
        const deductBreaks = emp.shift_id != null ? shiftPolicyIndex.deductBreaksFor(emp.shift_id) : false;
        const punchSpan = dayEvents.length > 0 ? derivePunchSpan(dayEvents, deductBreaks) : null;

        const le = computeLateEarly(date, attendance, shiftDetails.get(emp.shift_id) ?? null, (emp.shift_id != null && shiftPolicyIndex.has(emp.shift_id) ? shiftPolicyIndex.graceFor(emp.shift_id) : null));
        const status = classifyDay({
            dateStr: date,
            dayOfWeek,
            rules: shiftPolicyIndex.rulesFor(emp.shift_id), lateMinutes: le.lateMinutes, earlyMinutes: le.earlyMinutes,
            isHoliday: (d) => holidayIndex.isHoliday(d, employeeGroupId),
            offDaysBitmask,
            altSaturdays,
            isWeeklyOff2,
            isOnApprovedLeave: () => onLeaveEmpIds.has(emp.id),
            attendance,
            fullDayHours,
            halfDayMinHours,
            workMinutesOverride: punchSpan ? punchSpan.workMinutes ?? undefined : undefined,
        });

        const shiftDetail = shiftDetails.get(emp.shift_id) ?? null;
        let lateByMinutes = 0, earlyByMinutes = 0, workMinutes = null;
        if (shiftDetail && attendance && attendance.check_in) {
            const grace = emp.shift_id != null && shiftPolicyIndex.has(emp.shift_id)
                ? shiftPolicyIndex.graceFor(emp.shift_id)
                : { lateGraceMinutes: shiftDetail.late_grace_minutes || 0, earlyGraceMinutes: shiftDetail.early_grace_minutes || 0 };
            const actualIn = new Date(attendance.check_in);
            const scheduledStart = new Date(`${date}T${shiftDetail.start_time}`);
            scheduledStart.setMinutes(scheduledStart.getMinutes() + grace.lateGraceMinutes);
            if (actualIn > scheduledStart) lateByMinutes = Math.round((actualIn - scheduledStart) / 60000);
            if (hasRealCheckout(attendance)) {
                const actualOut = new Date(attendance.check_out);
                const scheduledEnd = new Date(`${date}T${shiftDetail.end_time}`);
                scheduledEnd.setMinutes(scheduledEnd.getMinutes() - grace.earlyGraceMinutes);
                if (actualOut < scheduledEnd) earlyByMinutes = Math.round((scheduledEnd - actualOut) / 60000);
                // Task 3: prefer the punch_events-derived figure (which
                // respects the deduct-breaks policy) over the plain
                // check_out-minus-check_in span used before this pass.
                workMinutes = punchSpan && punchSpan.workMinutes != null
                    ? punchSpan.workMinutes
                    : Math.round((actualOut - actualIn) / 60000);
            }
        }

        return {
            employee_id: emp.id,
            employee_name: emp.name,
            emp_code: emp.emp_code,
            designation: emp.designation,
            shift_name: shiftDetail ? shiftDetail.name : null,
            shift_start: shiftDetail ? shiftDetail.start_time : null,
            shift_end: shiftDetail ? shiftDetail.end_time : null,
            date,
            check_in: attendance ? attendance.check_in : null,
            check_out: attendance ? attendance.check_out : null,
            late_by_minutes: lateByMinutes,
            early_by_minutes: earlyByMinutes,
            work_minutes: workMinutes,
            status,
            card_no: emp.card_no || null,
            department: emp.department || null,
            branch_name: emp.branch_name || null,
            overtime_minutes: overtimeIndex.minutesFor(emp.id, date),
            remark: remarkByEmp.get(emp.id) || null,
            // Present in daily_report.jpeg but there is no thermal
            // sensor data anywhere in this system - always null, the
            // screen renders them as blank columns to match the layout.
            in_temp: null,
            out_temp: null,
        };
    });
    return res.json(result);
}));

/**
 * PUT /reports/daily-remark - the Remark column of the Daily Report.
 * body: { employee_id, date, remark }. Empty remark clears it. Kept in
 * its own table (attendance_remarks) rather than a column on
 * attendance so remarking an ABSENT employee doesn't create an
 * attendance row that other logic could misread as a punch.
 */
router.put('/daily-remark', requireAdmin, asyncHandler(async (req, res) => {
    const { employee_id, date, remark } = req.body;
    if (!employee_id || !date) return res.status(400).json({ error: 'employee_id and date are required' });
    const text = (remark || '').trim().slice(0, 255);
    const [emp] = await pool.query('SELECT id FROM employees WHERE id = ? AND company_id = ?', [employee_id, req.user.companyId]);
    if (emp.length === 0) return res.status(404).json({ error: 'Employee not found' });
    if (text === '') {
        await pool.query('DELETE FROM attendance_remarks WHERE company_id = ? AND employee_id = ? AND date = ?', [req.user.companyId, employee_id, date]);
    } else {
        await pool.query(
            `INSERT INTO attendance_remarks (company_id, employee_id, date, remark) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE remark = VALUES(remark)`,
            [req.user.companyId, employee_id, date, text]
        );
    }
    return res.json({ message: 'Saved' });
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
        "SELECT id, name, emp_code, department, shift_id FROM employees WHERE company_id = ? AND status = 'active'",
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
    // migration_027 - see the /daily handler's comment above for why
    // this replaces passing shift=null here.
    const shiftOffIndex = await loadShiftOffIndex(companyId);
    // migration_034 - policy-assigned weekly-off, preferred per shift
    // when assigned (see resolveEmployeeOffDays).
    const shiftPolicyOffIndex = await loadShiftPolicyOffIndex(companyId);
    // migration_033/034 - this month's raw punch events plus each
    // shift's deduct-break-hours policy flag, for the same
    // punch_events-derived work-minutes classifyDay now accepts - see
    // the /daily handler's comment above.
    const punchEventsIndex = await loadPunchEventsIndex(companyId, monthStart, monthEnd);
    const shiftPolicyIndex = await loadShiftPolicyIndex(companyId);
    const [shiftRowsAll] = await pool.query('SELECT id, name, start_time, end_time, late_grace_minutes, early_grace_minutes FROM shifts WHERE company_id = ?', [companyId]);
    const shiftsById = new Map(shiftRowsAll.map(x => [x.id, x]));

    return employees.map(emp => {
        let presentDays = 0, halfDays = 0, absentDays = 0, leaveDays = 0, workingDays = 0;

        const isOnApprovedLeave = (dateStr) => leaveRows.some(l => {
            if (l.employee_id !== emp.id) return false;
            const from = toDateStr(l.from_date);
            const to = toDateStr(l.to_date);
            return dateStr >= from && dateStr <= to;
        });
        const employeeGroupId = employeeGroups.get(emp.id) ?? null;
        const empShift = shiftOffIndex.byId.get(emp.shift_id) ?? null;
        const { offDaysBitmask, altSaturdays, isWeeklyOff2 } =
            resolveEmployeeOffDays(emp.shift_id, empShift, emp.department, weeklyOffIndex, shiftPolicyOffIndex);
        const deductBreaks = emp.shift_id != null ? shiftPolicyIndex.deductBreaksFor(emp.shift_id) : false;

        const dayList = [];
        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const dayOfWeek = new Date(year, month - 1, day).getDay();
            const attendance = attendanceByEmpDate.get(`${emp.id}|${dateStr}`);
            const dayEvents = punchEventsIndex.forEmployeeDate(emp.id, dateStr);
            const punchSpan = dayEvents.length > 0 ? derivePunchSpan(dayEvents, deductBreaks) : null;
            const le = computeLateEarly(dateStr, attendance, shiftsById.get(emp.shift_id) ?? null, (emp.shift_id != null && shiftPolicyIndex.has(emp.shift_id) ? shiftPolicyIndex.graceFor(emp.shift_id) : null));
            const status = classifyDay({
                dateStr, dayOfWeek,
                rules: shiftPolicyIndex.rulesFor(emp.shift_id), lateMinutes: le.lateMinutes, earlyMinutes: le.earlyMinutes,
                isHoliday: (d) => holidayIndex.isHoliday(d, employeeGroupId),
                offDaysBitmask,
                altSaturdays,
                isWeeklyOff2,
                isOnApprovedLeave, attendance, fullDayHours, halfDayMinHours,
                workMinutesOverride: punchSpan ? punchSpan.workMinutes ?? undefined : undefined,
            });
            dayList.push({ status });
        }
        // Office Time Policy prefix/suffix-day rules (weekly-off/holiday -> absent).
        applyPrefixSuffixAbsent(dayList, emp.shift_id != null ? shiftPolicyIndex.prefixSuffixFor(emp.shift_id) : null);
        for (const { status } of dayList) {
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
        "SELECT id, name, emp_code, department, shift_id FROM employees WHERE company_id = ? AND status = 'active'",
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
    const shiftOffIndex = await loadShiftOffIndex(companyId);
    const shiftPolicyOffIndex = await loadShiftPolicyOffIndex(companyId);
    const punchEventsIndex = await loadPunchEventsIndex(companyId, weekStart, weekEnd);
    const shiftPolicyIndex = await loadShiftPolicyIndex(companyId);
    const [shiftRowsAll] = await pool.query('SELECT id, name, start_time, end_time, late_grace_minutes, early_grace_minutes FROM shifts WHERE company_id = ?', [companyId]);
    const shiftsById = new Map(shiftRowsAll.map(x => [x.id, x]));

    const result = employees.map(emp => {
        let presentDays = 0, halfDays = 0, absentDays = 0, leaveDays = 0, workingDays = 0;
        const isOnApprovedLeave = (dateStr) => leaveRows.some(l => {
            if (l.employee_id !== emp.id) return false;
            return dateStr >= toDateStr(l.from_date) && dateStr <= toDateStr(l.to_date);
        });
        const employeeGroupId = employeeGroups.get(emp.id) ?? null;
        const empShift = shiftOffIndex.byId.get(emp.shift_id) ?? null;
        const { offDaysBitmask, altSaturdays, isWeeklyOff2 } =
            resolveEmployeeOffDays(emp.shift_id, empShift, emp.department, weeklyOffIndex, shiftPolicyOffIndex);
        const deductBreaks = emp.shift_id != null ? shiftPolicyIndex.deductBreaksFor(emp.shift_id) : false;

        const weekDays = [];
        let weekWorkMinutes = 0, weekLateDays = 0, weekEarlyDays = 0;
        const cursor = new Date(weekStartDate);
        for (let i = 0; i < 7; i++) {
            const dateStr = toDateStr(cursor);
            const dayOfWeek = cursor.getDay();
            const attendance = attendanceByEmpDate.get(`${emp.id}|${dateStr}`);
            const dayEvents = punchEventsIndex.forEmployeeDate(emp.id, dateStr);
            const punchSpan = dayEvents.length > 0 ? derivePunchSpan(dayEvents, deductBreaks) : null;
            const le = computeLateEarly(dateStr, attendance, shiftsById.get(emp.shift_id) ?? null, (emp.shift_id != null && shiftPolicyIndex.has(emp.shift_id) ? shiftPolicyIndex.graceFor(emp.shift_id) : null));
            const status = classifyDay({
                dateStr, dayOfWeek,
                rules: shiftPolicyIndex.rulesFor(emp.shift_id), lateMinutes: le.lateMinutes, earlyMinutes: le.earlyMinutes,
                isHoliday: (d) => holidayIndex.isHoliday(d, employeeGroupId),
                offDaysBitmask,
                altSaturdays,
                isWeeklyOff2,
                isOnApprovedLeave, attendance, fullDayHours, halfDayMinHours,
                workMinutesOverride: punchSpan ? punchSpan.workMinutes ?? undefined : undefined,
            });
            if (status === 'present') { presentDays++; workingDays++; }
            else if (status === 'half_day') { halfDays++; workingDays++; }
            else if (status === 'absent') { absentDays++; workingDays++; }
            else if (status === 'leave') { leaveDays++; }
            // Per-day detail so the Weekly report can actually show data
            // (previously only 5 counters came back).
            const realOut = hasRealCheckout(attendance);
            const dayWork = punchSpan && punchSpan.workMinutes != null
                ? punchSpan.workMinutes
                : (realOut ? Math.round((new Date(attendance.check_out) - new Date(attendance.check_in)) / 60000) : null);
            if (dayWork) weekWorkMinutes += dayWork;
            if (le.lateMinutes > 0) weekLateDays++;
            if (le.earlyMinutes > 0) weekEarlyDays++;
            weekDays.push({
                date: dateStr, weekday: dayOfWeek, status,
                check_in: attendance ? attendance.check_in : null,
                check_out: realOut ? attendance.check_out : null,
                work_minutes: dayWork, late_by_minutes: le.lateMinutes, early_by_minutes: le.earlyMinutes,
            });
            cursor.setDate(cursor.getDate() + 1);
        }

        return {
            employee_id: emp.id, employee_name: emp.name, emp_code: emp.emp_code,
            week_start: weekStart, week_end: weekEnd,
            present_days: presentDays, half_days: halfDays, absent_days: absentDays,
            leave_days: leaveDays, working_days: workingDays,
            total_work_minutes: weekWorkMinutes, late_days: weekLateDays, early_days: weekEarlyDays,
            days: weekDays,
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
        // migration_034 - prefer the shift's assigned Office Time
        // Policy's grace minutes over the shift row's own legacy
        // columns (see resolveShiftGrace's comment).
        const grace = await resolveShiftGrace(req.user.companyId, shift);

        let isLate = false, lateByMinutes = 0, isEarly = false, earlyByMinutes = 0;

        if (attendance.check_in) {
            const scheduledStart = new Date(`${date}T${shift.start_time}`);
            scheduledStart.setMinutes(scheduledStart.getMinutes() + grace.lateGraceMinutes);
            const actualIn = new Date(attendance.check_in);
            if (actualIn > scheduledStart) {
                isLate = true;
                lateByMinutes = Math.round((actualIn - scheduledStart) / 60000);
            }
        }
        // Early punch-OUT: only meaningful with a REAL check-out (a later
        // punch than the check-in). A single scan stored as check_out ===
        // check_in used to be reported as "left 9 hours early".
        if (hasRealCheckout(attendance)) {
            const scheduledEnd = new Date(`${date}T${shift.end_time}`);
            scheduledEnd.setMinutes(scheduledEnd.getMinutes() - grace.earlyGraceMinutes);
            const actualOut = new Date(attendance.check_out);
            if (actualOut < scheduledEnd) {
                isEarly = true;
                earlyByMinutes = Math.round((scheduledEnd - actualOut) / 60000);
            }
        }

        // Changed per the client's direction: this used to only include
        // employees who were actually late and/or left early. Now every
        // punched-in employee appears, with a `status` field, so the
        // report answers "who was on time AND who wasn't" in one place
        // rather than needing the absence of a row to mean "on time" -
        // status is still skipped entirely for anyone absent (see the
        // `continue` above - you can't be "late" on a day you never
        // punched in at all, that's /reports/daily's concern) or with no
        // resolvable shift (/reports/na-shift's concern).
        const status = isLate && isEarly ? 'late_and_early' : isLate ? 'late' : isEarly ? 'early' : 'on_time';
        result.push({
            employee_id: emp.id, employee_name: emp.name, emp_code: emp.emp_code, date,
            shift_name: shift.name, shift_start: shift.start_time, shift_end: shift.end_time,
            check_in: attendance.check_in, check_out: hasRealCheckout(attendance) ? attendance.check_out : null,
            missed_punch_out: !!attendance.check_in && !hasRealCheckout(attendance),
            is_late: isLate, late_by_minutes: lateByMinutes,
            is_early: isEarly, early_by_minutes: earlyByMinutes,
            status,
        });
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
        const grace = await resolveShiftGrace(companyId, shift);

        let isLate = false, isEarly = false;
        if (attendance.check_in) {
            const scheduledStart = new Date(`${date}T${shift.start_time}`);
            scheduledStart.setMinutes(scheduledStart.getMinutes() + grace.lateGraceMinutes);
            if (new Date(attendance.check_in) > scheduledStart) isLate = true;
        }
        if (hasRealCheckout(attendance)) {
            const scheduledEnd = new Date(`${date}T${shift.end_time}`);
            scheduledEnd.setMinutes(scheduledEnd.getMinutes() - grace.earlyGraceMinutes);
            if (new Date(attendance.check_out) < scheduledEnd) isEarly = true;
        }
        if (isLate || isEarly) result.push({ employee_id: emp.id, is_late: isLate, is_early: isEarly });
    }
    return result;
}

/**
 * Monthly Muster / Attendance Register (client-supplied reference
 * images: na_shift_report.jpeg and Performance_Monthly_Report.jpeg).
 *
 * IMPORTANT NAMING NOTE: despite the client's reference filenames,
 * this is NOT the same report as GET /na-shift above (that one lists
 * employees with no resolvable shift at all - a config-warning list)
 * and it is NOT the same as GET /performance above (a monthly
 * scorecard: attendance %, late count, OT hours - one row per
 * employee, no day-by-day grid). Both reference images are actually
 * ONE report type - a day-by-day attendance calendar for a month -
 * just single-employee (na_shift_report.jpeg, with a rich per-employee
 * summary line) vs. multi-employee (Performance_Monthly_Report.jpeg,
 * stacked per-employee blocks, no summary line). Rather than repurpose
 * either existing, differently-behaved endpoint under a confusing
 * name, this is a new, third report type - GET /monthly-muster
 * (single employee, WITH the summary) and GET /monthly-muster-all
 * (every active employee, WITHOUT it, matching each reference image's
 * own layout).
 *
 * Reuses every existing per-day classification/holiday/weekly-off/
 * shift-policy/punch-events utility computeMonthlySummary and GET
 * /daily above already use - this is genuinely the same per-day
 * computation, just collecting the full row (not just a tally) for
 * every day, plus batch-resolving each day's effective shift (shift
 * roster override -> employee's own shift -> company default) without
 * a query per employee per day the way resolveEffectiveShift above
 * does for a single date - that pattern doesn't scale to 30 days x
 * every employee in one report.
 */
async function loadShiftAssignmentIndex(companyId, monthStart, monthEnd) {
    const [rows] = await pool.query(
        `SELECT sa.employee_id, sa.effective_from, sa.effective_to, s.id AS shift_id, s.name, s.start_time, s.end_time,
                s.late_grace_minutes, s.early_grace_minutes
         FROM shift_assignments sa
         JOIN shifts s ON s.id = sa.shift_id
         WHERE sa.company_id = ? AND sa.effective_from <= ? AND (sa.effective_to IS NULL OR sa.effective_to >= ?)`,
        [companyId, monthEnd, monthStart]
    );
    const byEmployee = new Map();
    for (const r of rows) {
        if (!byEmployee.has(r.employee_id)) byEmployee.set(r.employee_id, []);
        byEmployee.get(r.employee_id).push(r);
    }
    return {
        // Same fallback chain as resolveEffectiveShift above, just
        // resolved in-memory against pre-loaded rows instead of a
        // query per (employee, date) pair.
        resolve(employeeId, dateStr, employeeOwnShift, defaultShift) {
            const assignments = byEmployee.get(employeeId);
            if (assignments) {
                const applicable = assignments
                    .filter(a => a.effective_from <= dateStr && (!a.effective_to || a.effective_to >= dateStr))
                    .sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1));
                if (applicable.length > 0) return applicable[0];
            }
            return employeeOwnShift || defaultShift || null;
        },
    };
}

async function loadOvertimeIndex(companyId, monthStart, monthEnd) {
    let rows = [];
    try {
        [rows] = await pool.query(
            `SELECT employee_id, date, overtime_hours FROM overtime_records
             WHERE company_id = ? AND date BETWEEN ? AND ? AND status = 'approved'`,
            [companyId, monthStart, monthEnd]
        );
    } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
    }
    const byKey = new Map(rows.map(r => [`${r.employee_id}|${toDateStr(r.date)}`, Number(r.overtime_hours) || 0]));
    return { minutesFor: (employeeId, dateStr) => Math.round((byKey.get(`${employeeId}|${dateStr}`) || 0) * 60) };
}

const SHIFT_CODE_FALLBACK = 'GEN'; // used only when a resolved shift has no name at all - shouldn't normally happen

// Generalized from a month-only computation (still used that way by
// /monthly-muster(-all)) to an arbitrary inclusive date range, so
// /weekly-muster below can reuse every bit of this rather than a
// duplicate week-only copy. `monthStart`/`monthEnd` names kept as-is
// internally (despite now being a possibly-week-long range) to keep
// this diff small - they're just "range start"/"range end" now.
async function computeMuster(companyId, monthStart, monthEnd, context, { employeeId } = {}) {
    const { fullDayHours, halfDayMinHours } = context;
    // Build the list of date strings in [monthStart, monthEnd] by
    // stepping a Date object, rather than assuming a calendar month -
    // this is what makes an arbitrary week (or any other range) work
    // the same way a full month already did.
    const dateStrsInRange = [];
    {
        const cursor = new Date(`${monthStart}T00:00:00`);
        const end = new Date(`${monthEnd}T00:00:00`);
        while (cursor <= end) {
            dateStrsInRange.push(toDateStr(cursor));
            cursor.setDate(cursor.getDate() + 1);
        }
    }
    const daysInMonth = dateStrsInRange.length;

    const empParams = [companyId];
    let empFilterSql = '';
    if (employeeId) {
        empFilterSql = ' AND id = ?';
        empParams.push(employeeId);
    }
    const [employees] = await pool.query(
        `SELECT id, name, emp_code, department, shift_id FROM employees WHERE company_id = ? AND status = 'active'${empFilterSql}`,
        empParams
    );
    if (employees.length === 0) return [];

    const [attendanceRows] = await pool.query(
        'SELECT employee_id, date, check_in, check_out FROM attendance WHERE company_id = ? AND date BETWEEN ? AND ?',
        [companyId, monthStart, monthEnd]
    );
    const attendanceByEmpDate = new Map(attendanceRows.map(r => [`${r.employee_id}|${toDateStr(r.date)}`, r]));

    const [leaveRows] = await pool.query(
        `SELECT employee_id, from_date, to_date FROM leave_applications
         WHERE company_id = ? AND status = 'approved' AND from_date <= ? AND to_date >= ?`,
        [companyId, monthEnd, monthStart]
    );

    const holidayIndex = await loadHolidayIndex(companyId, monthStart, monthEnd);
    const employeeGroups = await loadEmployeeHolidayGroups(companyId);
    const weeklyOffIndex = await loadWeeklyOffIndex(companyId);
    const shiftOffIndex = await loadShiftOffIndex(companyId);
    const shiftPolicyOffIndex = await loadShiftPolicyOffIndex(companyId);
    const shiftPolicyIndex = await loadShiftPolicyIndex(companyId);
    const punchEventsIndex = await loadPunchEventsIndex(companyId, monthStart, monthEnd);
    const shiftAssignmentIndex = await loadShiftAssignmentIndex(companyId, monthStart, monthEnd);
    const overtimeIndex = await loadOvertimeIndex(companyId, monthStart, monthEnd);

    const [shiftDetailRows] = await pool.query(
        'SELECT id, name, start_time, end_time, late_grace_minutes, early_grace_minutes FROM shifts WHERE company_id = ?',
        [companyId]
    );
    const shiftDetails = new Map(shiftDetailRows.map(s => [s.id, s]));
    const [defaultShiftRows] = await pool.query(
        'SELECT id, name, start_time, end_time, late_grace_minutes, early_grace_minutes FROM shifts WHERE company_id = ? AND is_default = TRUE LIMIT 1',
        [companyId]
    );
    const defaultShift = defaultShiftRows[0] || null;

    return employees.map(emp => {
        const isOnApprovedLeave = (dateStr) => leaveRows.some(l => {
            if (l.employee_id !== emp.id) return false;
            const from = toDateStr(l.from_date);
            const to = toDateStr(l.to_date);
            return dateStr >= from && dateStr <= to;
        });
        const employeeGroupId = employeeGroups.get(emp.id) ?? null;
        const empShift = shiftOffIndex.byId.get(emp.shift_id) ?? null;
        const { offDaysBitmask, altSaturdays, isWeeklyOff2 } =
            resolveEmployeeOffDays(emp.shift_id, empShift, emp.department, weeklyOffIndex, shiftPolicyOffIndex);
        const deductBreaks = emp.shift_id != null ? shiftPolicyIndex.deductBreaksFor(emp.shift_id) : false;
        const employeeOwnShiftDetail = shiftDetails.get(emp.shift_id) ?? null;

        const days = [];
        let totalWorkMinutes = 0, totalOvertimeMinutes = 0;
        let presentDays = 0, absentDays = 0, weeklyOffDays = 0, holidayDays = 0, leaveDays = 0;
        let lateByMinutesTotal = 0, lateByDays = 0, earlyByMinutesTotal = 0, earlyByDays = 0;
        const shiftCounts = {};

        for (let dayIndex = 0; dayIndex < dateStrsInRange.length; dayIndex++) {
            const dateStr = dateStrsInRange[dayIndex];
            const day = Number(dateStr.slice(-2)); // calendar day-of-month, still shown in the grid header even for a week-only range
            const dayOfWeek = new Date(`${dateStr}T00:00:00`).getDay();
            const attendance = attendanceByEmpDate.get(`${emp.id}|${dateStr}`) || null;
            const dayEvents = punchEventsIndex.forEmployeeDate(emp.id, dateStr);
            const punchSpan = dayEvents.length > 0 ? derivePunchSpan(dayEvents, deductBreaks) : null;

            const resolvedShift = shiftAssignmentIndex.resolve(emp.id, dateStr, employeeOwnShiftDetail, defaultShift);
            const le = computeLateEarly(dateStr, attendance, resolvedShift, (emp.shift_id != null && shiftPolicyIndex.has(emp.shift_id) ? shiftPolicyIndex.graceFor(emp.shift_id) : null));
            const status = classifyDay({
                dateStr, dayOfWeek,
                rules: shiftPolicyIndex.rulesFor(emp.shift_id), lateMinutes: le.lateMinutes, earlyMinutes: le.earlyMinutes,
                isHoliday: (d) => holidayIndex.isHoliday(d, employeeGroupId),
                offDaysBitmask, altSaturdays, isWeeklyOff2,
                isOnApprovedLeave, attendance, fullDayHours, halfDayMinHours,
                workMinutesOverride: punchSpan ? punchSpan.workMinutes ?? undefined : undefined,
            });

            let lateByMinutes = 0, earlyByMinutes = 0, workMinutes = null;
            if (resolvedShift && attendance && attendance.check_in) {
                const grace = emp.shift_id != null && shiftPolicyIndex.has(emp.shift_id)
                    ? shiftPolicyIndex.graceFor(emp.shift_id)
                    : { lateGraceMinutes: resolvedShift.late_grace_minutes || 0, earlyGraceMinutes: resolvedShift.early_grace_minutes || 0 };
                const actualIn = new Date(attendance.check_in);
                const scheduledStart = new Date(`${dateStr}T${resolvedShift.start_time}`);
                scheduledStart.setMinutes(scheduledStart.getMinutes() + grace.lateGraceMinutes);
                if (actualIn > scheduledStart) lateByMinutes = Math.round((actualIn - scheduledStart) / 60000);
                if (hasRealCheckout(attendance)) {
                    const actualOut = new Date(attendance.check_out);
                    const scheduledEnd = new Date(`${dateStr}T${resolvedShift.end_time}`);
                    scheduledEnd.setMinutes(scheduledEnd.getMinutes() - grace.earlyGraceMinutes);
                    if (actualOut < scheduledEnd) earlyByMinutes = Math.round((scheduledEnd - actualOut) / 60000);
                    workMinutes = punchSpan && punchSpan.workMinutes != null
                        ? punchSpan.workMinutes
                        : Math.round((actualOut - actualIn) / 60000);
                }
            }
            const overtimeMinutes = overtimeIndex.minutesFor(emp.id, dateStr);

            if (status === 'present' || status === 'half_day') presentDays += status === 'half_day' ? 0.5 : 1;
            else if (status === 'absent') absentDays++;
            else if (status === 'weekly_off') weeklyOffDays++;
            else if (status === 'holiday') holidayDays++;
            else if (status === 'leave') leaveDays++;

            if (workMinutes) totalWorkMinutes += workMinutes;
            totalOvertimeMinutes += overtimeMinutes;
            if (lateByMinutes > 0) { lateByMinutesTotal += lateByMinutes; lateByDays++; }
            if (earlyByMinutes > 0) { earlyByMinutesTotal += earlyByMinutes; earlyByDays++; }

            const shiftCode = resolvedShift ? resolvedShift.name : SHIFT_CODE_FALLBACK;
            shiftCounts[shiftCode] = (shiftCounts[shiftCode] || 0) + 1;

            days.push({
                day,
                date: dateStr,
                status,
                check_in: attendance ? attendance.check_in : null,
                check_out: attendance ? attendance.check_out : null,
                work_minutes: workMinutes,
                late_by_minutes: lateByMinutes,
                early_by_minutes: earlyByMinutes,
                overtime_minutes: overtimeMinutes,
                shift_code: shiftCode,
            });
        }

        const workingDaysWithPay = presentDays; // present + half-days already weighted above
        return {
            employee_id: emp.id,
            employee_name: emp.name,
            emp_code: emp.emp_code,
            days,
            summary: {
                total_work_minutes: totalWorkMinutes,
                total_overtime_minutes: totalOvertimeMinutes,
                present_days: presentDays,
                absent_days: absentDays,
                weekly_off_days: weeklyOffDays,
                holiday_days: holidayDays,
                leave_days: leaveDays,
                late_by_minutes_total: lateByMinutesTotal,
                late_by_days: lateByDays,
                early_by_minutes_total: earlyByMinutesTotal,
                early_by_days: earlyByDays,
                average_working_minutes: workingDaysWithPay > 0 ? Math.round(totalWorkMinutes / workingDaysWithPay) : 0,
                shift_counts: shiftCounts,
                total_shift_count: daysInMonth,
            },
        };
    });
}

/**
 * GET /reports/monthly-muster?employee_id=&year=&month=
 * Single-employee day-by-day attendance calendar with the full summary
 * block - matches na_shift_report.jpeg.
 */
router.get('/monthly-muster', requireAdmin, asyncHandler(async (req, res) => {
    const employeeId = parseInt(req.query.employee_id, 10);
    const year = parseInt(req.query.year, 10);
    const month = parseInt(req.query.month, 10);
    if (!employeeId || !year || !month || month < 1 || month > 12) {
        return res.status(400).json({ error: 'employee_id, year, and month (1-12) query params required' });
    }
    const daysInMonth = new Date(year, month, 0).getDate();
    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
    const context = await loadCompanyContext(req.user.companyId);
    const result = await computeMuster(req.user.companyId, monthStart, monthEnd, context, { employeeId });
    if (result.length === 0) return res.status(404).json({ error: 'Employee not found or not active' });
    return res.json(result[0]);
}));

/**
 * GET /reports/monthly-muster-all?year=&month=
 * Every active employee's day-by-day calendar, WITHOUT the summary
 * block (each entry is just { employee_id, employee_name, emp_code,
 * days }) - matches Performance_Monthly_Report.jpeg's simpler stacked
 * layout. Same underlying computation as /monthly-muster; the summary
 * is dropped here rather than computed and discarded on the client, to
 * keep the payload proportionate to "every employee, every day of the
 * month" already being a fair amount of data.
 */
router.get('/monthly-muster-all', requireAdmin, asyncHandler(async (req, res) => {
    const year = parseInt(req.query.year, 10);
    const month = parseInt(req.query.month, 10);
    if (!year || !month || month < 1 || month > 12) {
        return res.status(400).json({ error: 'year and month (1-12) query params required' });
    }
    const daysInMonth = new Date(year, month, 0).getDate();
    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
    const context = await loadCompanyContext(req.user.companyId);
    const result = await computeMuster(req.user.companyId, monthStart, monthEnd, context);
    return res.json(result.map(r => ({
        employee_id: r.employee_id,
        employee_name: r.employee_name,
        emp_code: r.emp_code,
        days: r.days,
    })));
}));

/**
 * GET /reports/weekly-muster?date=
 * Same day-by-day grid as /monthly-muster-all, windowed to one Sun-Sat
 * week instead of a calendar month - the "Muster Grid" tab on Weekly
 * Report. Same Sun-Sat boundary rule GET /weekly above already uses,
 * kept identical so both tabs of Weekly Report agree on which 7 days
 * are "this week". No summary block, same reasoning as
 * /monthly-muster-all (this is the "all employees" shape; a rich
 * per-employee summary for a single week wasn't asked for - shout if
 * you want a single-employee weekly equivalent of /monthly-muster too).
 */
router.get('/weekly-muster', requireAdmin, asyncHandler(async (req, res) => {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date (YYYY-MM-DD, any day in the target week) query param required' });

    const anchor = new Date(`${date}T00:00:00`);
    const weekStartDate = new Date(anchor);
    weekStartDate.setDate(anchor.getDate() - anchor.getDay());
    const weekEndDate = new Date(weekStartDate);
    weekEndDate.setDate(weekStartDate.getDate() + 6);
    const weekStart = toDateStr(weekStartDate);
    const weekEnd = toDateStr(weekEndDate);

    const context = await loadCompanyContext(req.user.companyId);
    const result = await computeMuster(req.user.companyId, weekStart, weekEnd, context);
    return res.json(result.map(r => ({
        employee_id: r.employee_id,
        employee_name: r.employee_name,
        emp_code: r.emp_code,
        days: r.days,
    })));
}));


/**
 * GET /reports/all-in-out?from=YYYY-MM-DD&to=YYYY-MM-DD[&employee_id=]
 * "All In/Out" report - EVERY punch of every employee per day (not just the
 * first-in/last-out pair stored in `attendance`).
 *
 * Rules (per the client's brief):
 *  - Punches are taken from raw_punches (every device scan, de-duplicated by
 *    device+user+time) merged with punch_events (manual / mobile / synced).
 *  - Only punches inside the employee's shift window are counted:
 *      window start = shift start - early-coming allowance (2h default)
 *      window end   = shift end                                (OT not allowed)
 *                   = shift end + max OT (policy max_ot_minutes, else 12h) (OT allowed)
 *    Punches outside the window are still returned (outside_window=true) so the
 *    admin can see them, but are NOT counted in total work time.
 *  - Counted punches alternate IN, OUT, IN, OUT ... (1st punch = in, 2nd = out,
 *    3rd = in ...). Each IN->OUT duration is summed = total work time of the day.
 *    An odd trailing punch is an IN with no OUT (missing_out=true, adds 0).
 *  - Two scans within 1 minute of each other are treated as a double-tap and the
 *    later one is ignored.
 */
router.get('/all-in-out', requireAdmin, asyncHandler(async (req, res) => {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to (YYYY-MM-DD) query params required' });
    const companyId = req.user.companyId;
    const empFilter = req.query.employee_id ? parseInt(req.query.employee_id, 10) : null;

    const [employees] = await pool.query(
        `SELECT id, name, emp_code, shift_id FROM employees WHERE company_id = ? AND status = 'active'${empFilter ? ' AND id = ?' : ''}`,
        empFilter ? [companyId, empFilter] : [companyId]
    );
    const empById = new Map(employees.map(e => [e.id, e]));

    const [shiftRows] = await pool.query('SELECT id, name, start_time, end_time, ot_allowed, is_default FROM shifts WHERE company_id = ?', [companyId]);
    const shiftsById = new Map(shiftRows.map(x => [x.id, x]));
    const defaultShift = shiftRows.find(x => x.is_default) || null;
    let maxOtByShift = new Map();
    try {
        const [pr] = await pool.query(
            `SELECT ops.shift_id, p.max_ot_minutes FROM office_time_policy_shifts ops
             JOIN office_time_policies p ON p.id = ops.policy_id WHERE ops.company_id = ?`, [companyId]);
        maxOtByShift = new Map(pr.map(r => [r.shift_id, r.max_ot_minutes]));
    } catch (err) { if (err.code !== 'ER_NO_SUCH_TABLE') throw err; }

    const fmt = (d) => (d instanceof Date ? d.toISOString().slice(0, 19).replace('T', ' ') : String(d).slice(0, 19).replace('T', ' '));
    const punchesByKey = new Map(); // `${empId}|${date}` -> Map<time, source>
    const add = (empId, timeStr, source) => {
        if (!empById.has(empId)) return;
        const key = `${empId}|${timeStr.slice(0, 10)}`;
        if (!punchesByKey.has(key)) punchesByKey.set(key, new Map());
        if (!punchesByKey.get(key).has(timeStr)) punchesByKey.get(key).set(timeStr, source);
    };
    const [raw] = await pool.query(
        `SELECT employee_id, punch_time FROM raw_punches
         WHERE company_id = ? AND employee_id IS NOT NULL AND punch_time >= ? AND punch_time < DATE_ADD(?, INTERVAL 1 DAY)`,
        [companyId, from, to]
    );
    raw.forEach(r => add(r.employee_id, fmt(r.punch_time), 'device'));
    try {
        const [ev] = await pool.query(
            'SELECT employee_id, punch_time FROM punch_events WHERE company_id = ? AND date BETWEEN ? AND ?',
            [companyId, from, to]
        );
        ev.forEach(r => add(r.employee_id, fmt(r.punch_time), 'app'));
    } catch (err) { if (err.code !== 'ER_NO_SUCH_TABLE') throw err; }
    // Fall back to attendance first/last for days that have no raw/event rows at all
    // (legacy rows from before punch_events existed).
    const [att] = await pool.query(
        'SELECT employee_id, date, check_in, check_out FROM attendance WHERE company_id = ? AND date BETWEEN ? AND ?',
        [companyId, from, to]
    );
    for (const a of att) {
        const key = `${a.employee_id}|${toDateStr(a.date)}`;
        if (punchesByKey.has(key)) continue;
        if (a.check_in) add(a.employee_id, fmt(a.check_in), 'attendance');
        if (a.check_out && hasRealCheckout(a)) add(a.employee_id, fmt(a.check_out), 'attendance');
    }

    const rows = [];
    for (const [key, timeMap] of punchesByKey) {
        const [empIdStr, date] = key.split('|');
        const emp = empById.get(Number(empIdStr));
        const shift = (emp.shift_id != null ? shiftsById.get(emp.shift_id) : null) || defaultShift;

        let winStart = null, winEnd = null;
        if (shift && shift.start_time && shift.end_time) {
            winStart = new Date(`${date}T${shift.start_time}`); winStart.setHours(winStart.getHours() - 2);
            winEnd = new Date(`${date}T${shift.end_time}`);
            if (winEnd <= new Date(`${date}T${shift.start_time}`)) winEnd.setDate(winEnd.getDate() + 1); // overnight shift
            if (shift.ot_allowed) {
                const maxOt = maxOtByShift.get(shift.id);
                winEnd.setMinutes(winEnd.getMinutes() + (maxOt != null && Number(maxOt) > 0 ? Number(maxOt) : 12 * 60));
            }
        }

        const times = [...timeMap.keys()].sort();
        const punches = [];
        let lastCounted = null;
        for (const t of times) {
            const dt = new Date(t.replace(' ', 'T'));
            const inWindow = !winStart || (dt >= winStart && dt <= winEnd);
            if (inWindow && lastCounted && (dt - lastCounted) < 60 * 1000) continue; // double-tap
            punches.push({ time: t, inWindow });
            if (inWindow) lastCounted = dt;
        }
        const counted = punches.filter(p => p.inWindow);
        counted.forEach((p, i) => { p.type = i % 2 === 0 ? 'in' : 'out'; });
        punches.filter(p => !p.inWindow).forEach(p => { p.type = 'ignored'; });

        const pairs = [];
        let totalMinutes = 0;
        for (let i = 0; i + 1 < counted.length; i += 2) {
            const mins = Math.round((new Date(counted[i + 1].time.replace(' ', 'T')) - new Date(counted[i].time.replace(' ', 'T'))) / 60000);
            pairs.push({ in: counted[i].time, out: counted[i + 1].time, minutes: mins });
            totalMinutes += mins;
        }
        rows.push({
            employee_id: emp.id, employee_name: emp.name, emp_code: emp.emp_code, date,
            shift_name: shift ? shift.name : null, shift_start: shift ? shift.start_time : null, shift_end: shift ? shift.end_time : null,
            ot_allowed: shift ? !!shift.ot_allowed : null,
            punches, pairs,
            punch_count: counted.length,
            outside_window_count: punches.length - counted.length,
            missing_out: counted.length % 2 === 1,
            total_work_minutes: totalMinutes,
        });
    }
    rows.sort((a, b) => (a.date === b.date ? a.employee_name.localeCompare(b.employee_name) : (a.date < b.date ? 1 : -1)));
    return res.json(rows);
}));

module.exports = router;
