const express = require('express');
const admin = require('firebase-admin');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const { generateTempPassword } = require('../utils/employeeCodes');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

// Admin: all employees in their company. Employee: only their own record.
router.get('/', asyncHandler(async (req, res) => {
    if (req.user.role === 'admin') {
        const [rows] = await pool.query('SELECT * FROM employees WHERE company_id = ?', [req.user.companyId]);
        return res.json(rows);
    }
    const [rows] = await pool.query(
        'SELECT * FROM employees WHERE company_id = ? AND firebase_uid = ?',
        [req.user.companyId, req.user.uid]
    );
    return res.json(rows);
}));

/**
 * POST /employees
 * Called after a successful biometric enrollment (or manual add).
 * Auto-generates emp_code + a temp password + a Firebase Auth account,
 * and returns the credentials for the admin to hand to the employee.
 */
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { name, designation, department, department_id, designation_id, shift_id, doj, dob, salary, biometric_template_id, photo_url, emp_code } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    // emp_code is normally auto-generated (see below) but can optionally be
    // supplied explicitly, e.g. to match an ID already printed on an
    // access card. Still digits-only either way - the device's User ID
    // field is a real integer, and CMD_USER_WRQ (used to push this ID +
    // name to the device from the app) requires a numeric uid too, so a
    // code like "ACME-0007" can't go into either.
    if (emp_code !== undefined && emp_code !== null && String(emp_code).trim() !== '') {
        if (!/^[0-9]+$/.test(String(emp_code).trim())) {
            return res.status(400).json({ error: 'emp_code must contain digits only (the device\'s User ID field is numeric)' });
        }
    }

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        let empCode;
        if (emp_code !== undefined && emp_code !== null && String(emp_code).trim() !== '') {
            empCode = String(emp_code).trim();
            const [dupRows] = await conn.query(
                'SELECT id FROM employees WHERE company_id = ? AND emp_code = ?',
                [req.user.companyId, empCode]
            );
            if (dupRows.length > 0) {
                await conn.rollback();
                return res.status(409).json({ error: `emp_code ${empCode} is already used by another employee` });
            }
        } else {
            // Plain sequential digits, unique per company - NOT slug-prefixed.
            // Uniqueness is still guaranteed per company via the employees
            // table's UNIQUE(company_id, emp_code) constraint.
            const [countRows] = await conn.query(
                'SELECT COUNT(*) AS cnt FROM employees WHERE company_id = ?',
                [req.user.companyId]
            );
            empCode = String(countRows[0].cnt + 1);
        }
        const tempPassword = generateTempPassword();
        // Synthetic login email - never shown to the employee (they only
        // ever see emp_code + tempPassword), so it doesn't need to be
        // pretty, just unique. Company ID keeps it unique across tenants
        // without needing a separate slug function.
        const syntheticEmail = `emp${empCode}@company${req.user.companyId}.local`;

        const firebaseUser = await admin.auth().createUser({
            email: syntheticEmail,
            password: tempPassword,
            displayName: name
        });
        await admin.auth().setCustomUserClaims(firebaseUser.uid, {
            company_id: req.user.companyId,
            role: 'employee'
        });

        const [result] = await conn.query(
            `INSERT INTO employees
             (company_id, emp_code, firebase_uid, name, designation, department, department_id, designation_id, shift_id, doj, dob, salary, photo_url, biometric_template_id, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
            [req.user.companyId, empCode, firebaseUser.uid, name, designation || null, department || null,
                department_id || null, designation_id || null, shift_id || null,
                doj || null, dob || null, salary || null, photo_url || null, biometric_template_id || null]
        );

        await conn.commit();
        return res.status(201).json({
            id: result.insertId,
            emp_code: empCode,
            login_email: syntheticEmail,
            temp_password: tempPassword
        });
    } catch (err) {
        await conn.rollback();
        console.error('Employee creation failed:', err);
        return res.status(500).json({ error: 'Failed to create employee', detail: err.message });
    } finally {
        conn.release();
    }
}));

/**
 * PUT /employees/:id
 * `emp_code` is now editable (it wasn't before - only auto-generated at
 * create time). Kept numeric-only here too, not just in the Flutter form,
 * since the device write (CMD_USER_WRQ) and the UNIQUE(company_id,
 * emp_code) constraint both require it - never trust client-side
 * validation alone for a rule the DB/device actually depend on.
 *
 * Device-push dirtiness: whenever `name` or `emp_code` changes, this
 * flips `device_push_status` back to 'pending' automatically. That's the
 * server-side half of "if new changes are made, the Push button must
 * re-enable" - the Flutter button reads this field rather than trying to
 * track dirtiness itself in local widget state (which would be lost the
 * moment the screen is left and re-entered).
 */
router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
    const fields = ['name', 'designation', 'department', 'department_id', 'designation_id', 'shift_id', 'doj', 'dob', 'salary', 'status', 'photo_url'];
    const updates = [];
    const values = [];
    fields.forEach(f => {
        if (req.body[f] !== undefined) {
            updates.push(`${f} = ?`);
            values.push(req.body[f]);
        }
    });

    let empCodeChanging = false;
    if (req.body.emp_code !== undefined) {
        const newCode = String(req.body.emp_code).trim();
        if (!/^[0-9]+$/.test(newCode)) {
            return res.status(400).json({ error: 'emp_code must contain digits only (the device\'s User ID field is numeric)' });
        }
        const [dupRows] = await pool.query(
            'SELECT id FROM employees WHERE company_id = ? AND emp_code = ? AND id != ?',
            [req.user.companyId, newCode, req.params.id]
        );
        if (dupRows.length > 0) {
            return res.status(409).json({ error: `emp_code ${newCode} is already used by another employee` });
        }
        updates.push('emp_code = ?');
        values.push(newCode);
        empCodeChanging = true;
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    // Any change to name or emp_code invalidates whatever's currently on
    // the device for this employee - force the push button to re-enable
    // rather than silently leaving the device out of date.
    if (req.body.name !== undefined || empCodeChanging) {
        updates.push('device_push_status = ?');
        values.push('pending');
    }

    values.push(req.params.id, req.user.companyId);
    await pool.query(
        `UPDATE employees SET ${updates.join(', ')} WHERE id = ? AND company_id = ?`,
        values
    );
    return res.json({ message: 'Updated' });
}));

/**
 * PATCH /employees/:id/device-push
 * Called by the Flutter app immediately after ZkWriteService.pushUser()
 * (and, when the emp_code changed, after the old device slot has been
 * cleaned up) succeeds. Records exactly what was written so the button
 * can be correctly disabled until the next real edit - this endpoint is
 * the only thing that ever sets device_push_status back to 'pushed'.
 */
router.patch('/:id/device-push', requireAdmin, asyncHandler(async (req, res) => {
    const { emp_code, name } = req.body;
    if (!emp_code || !name) {
        return res.status(400).json({ error: 'emp_code and name are required to record a push' });
    }
    const [result] = await pool.query(
        `UPDATE employees
         SET device_push_status = 'pushed', last_pushed_emp_code = ?, last_pushed_name = ?, last_pushed_at = NOW()
         WHERE id = ? AND company_id = ?`,
        [emp_code, name, req.params.id, req.user.companyId]
    );
    if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Employee not found' });
    }
    const [rows] = await pool.query('SELECT * FROM employees WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json(rows[0]);
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM employees WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json({ message: 'Deleted' });
}));

/**
 * GET /employees/:id/monthly-summary?year=YYYY&month=M
 *
 * Backs the new Employee Details "Attendance & Leave" table (a
 * non-push-to-device view - nothing here touches the biometric device).
 * Aggregates across attendance, holidays, approved leave_applications,
 * weekly_off_config, and overtime_records into one day-by-day grid plus
 * the month's headline numbers, so the Flutter side doesn't have to make
 * 5 separate calls and stitch them together itself.
 *
 * Per-day status precedence (a day can only be one thing): holiday >
 * approved leave > present (has a check-in) > weekly off > absent for
 * any day up to and including today; days after today are 'upcoming'
 * and excluded from every count below.
 */
router.get('/:id/monthly-summary', asyncHandler(async (req, res) => {
    const employeeId = req.params.id;
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const month = parseInt(req.query.month, 10) || (new Date().getMonth() + 1); // 1-12

    const [empRows] = await pool.query(
        'SELECT id, name, emp_code, dob FROM employees WHERE id = ? AND company_id = ?',
        [employeeId, req.user.companyId]
    );
    if (empRows.length === 0) return res.status(404).json({ error: 'Employee not found' });
    if (req.user.role === 'employee') {
        const [selfRows] = await pool.query(
            'SELECT id FROM employees WHERE firebase_uid = ? AND company_id = ?',
            [req.user.uid, req.user.companyId]
        );
        if (selfRows.length === 0 || String(selfRows[0].id) !== String(employeeId)) {
            return res.status(403).json({ error: 'Not authorized to view this employee' });
        }
    }
    const employee = empRows[0];

    const daysInMonth = new Date(year, month, 0).getDate();
    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

    const [attendanceRows] = await pool.query(
        'SELECT date, check_in, check_out, verify_mode FROM attendance WHERE employee_id = ? AND date BETWEEN ? AND ?',
        [employeeId, monthStart, monthEnd]
    );
    const [holidayRows] = await pool.query(
        'SELECT date, name FROM holidays WHERE company_id = ? AND date BETWEEN ? AND ?',
        [req.user.companyId, monthStart, monthEnd]
    );
    const [leaveRows] = await pool.query(
        `SELECT from_date, to_date FROM leave_applications
         WHERE employee_id = ? AND status = 'approved' AND from_date <= ? AND to_date >= ?`,
        [employeeId, monthEnd, monthStart]
    );
    const [weeklyOffRows] = await pool.query(
        'SELECT off_days_bitmask FROM weekly_off_config WHERE company_id = ? AND department IS NULL LIMIT 1',
        [req.user.companyId]
    );
    const offBitmask = weeklyOffRows.length > 0 ? weeklyOffRows[0].off_days_bitmask : 1; // default: Sunday off

    // migration_010: unified per-leave-type monthly quota, replacing the
    // old flat office_time_policy.monthly_leave_quota. Every leave type
    // the company has defined gets its own quota/used/remaining line
    // (see computeLeaveTypeBalances in routes/leaves.js for the same
    // per-type counting logic used at apply-time) - the flat
    // leave_quota/leave_used/leave_remaining fields below are kept as a
    // SUM across all types for any caller still expecting one number,
    // but the new leave_balances array is the source of truth going
    // forward.
    const [leaveTypeRows] = await pool.query(
        'SELECT id, name, monthly_quota FROM leave_types WHERE company_id = ? ORDER BY name ASC',
        [req.user.companyId]
    );
    const [usedByTypeRows] = await pool.query(
        `SELECT leave_type_id, SUM(COALESCE(paid_days, days_count)) AS used
         FROM leave_applications
         WHERE employee_id = ? AND status = 'approved' AND from_date <= ? AND to_date >= ?
         GROUP BY leave_type_id`,
        [employeeId, monthEnd, monthStart]
    );
    const usedByType = new Map(usedByTypeRows.map(r => [r.leave_type_id, parseFloat(r.used) || 0]));
    const leaveBalances = leaveTypeRows.map(lt => {
        const quota = parseFloat(lt.monthly_quota) || 0;
        const used = usedByType.get(lt.id) || 0;
        return {
            leave_type_id: lt.id,
            leave_type_name: lt.name,
            quota,
            used,
            remaining: Math.max(0, Math.round((quota - used) * 10) / 10),
        };
    });
    const leaveQuota = leaveBalances.reduce((acc, b) => acc + b.quota, 0);

    const [policyRows] = await pool.query(
        'SELECT check_in_window_end FROM office_time_policy WHERE company_id = ?',
        [req.user.companyId]
    );
    // Grace window for an on-time check-in (migration_010) - a check-in
    // after this is still recorded/counted as present, just flagged
    // 'late' below rather than silently unrecorded.
    const checkInWindowEnd = policyRows.length > 0 ? policyRows[0].check_in_window_end : '09:45:00';
    const [overtimeRows] = await pool.query(
        `SELECT id, date, checkout_time, overtime_hours, rate_per_hour, amount, status
         FROM overtime_records WHERE employee_id = ? AND date BETWEEN ? AND ? ORDER BY date ASC`,
        [employeeId, monthStart, monthEnd]
    );

    const attendanceByDate = new Map(attendanceRows.map(r => [toDateStr(r.date), r]));
    const holidayByDate = new Map(holidayRows.map(r => [toDateStr(r.date), r.name]));
    const today = toDateStr(new Date());

    const days = [];
    let presentDays = 0, absentDays = 0, leaveDays = 0, holidayDays = 0, weeklyOffDays = 0;

    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const dow = new Date(year, month - 1, d).getDay(); // 0=Sun..6=Sat
        const isWeeklyOff = ((offBitmask >> dow) & 1) === 1;
        const holidayName = holidayByDate.get(dateStr);
        const onLeave = leaveRows.some(l => toDateStr(l.from_date) <= dateStr && toDateStr(l.to_date) >= dateStr);
        const att = attendanceByDate.get(dateStr);
        const isFuture = dateStr > today;

        let status;
        let isLate = false;
        if (holidayName) {
            status = 'holiday';
            holidayDays++;
        } else if (onLeave) {
            status = 'leave';
            leaveDays++;
        } else if (att && att.check_in) {
            status = 'present';
            presentDays++;
            if (timeOfDayStr(att.check_in) > checkInWindowEnd) {
                isLate = true;
            }
        } else if (isWeeklyOff) {
            status = 'weekly_off';
            weeklyOffDays++;
        } else if (isFuture) {
            status = 'upcoming';
        } else {
            status = 'absent';
            absentDays++;
        }

        days.push({
            date: dateStr,
            status,
            check_in: att?.check_in || null,
            check_out: att?.check_out || null,
            verify_mode: att?.verify_mode || null,
            holiday_name: holidayName || null,
            // migration_010: true only when status === 'present' and the
            // check-in landed after check_in_window_end - never changes
            // whether the day counts as present/absent, just flags it.
            is_late: isLate,
        });
    }

    const workingDaysElapsed = presentDays + absentDays;
    const attendancePercentage = workingDaysElapsed > 0
        ? Math.round((presentDays / workingDaysElapsed) * 1000) / 10
        : 0;
    const leaveUsed = leaveBalances.reduce((acc, b) => acc + b.used, 0);
    const leaveRemaining = leaveBalances.reduce((acc, b) => acc + b.remaining, 0);

    const overtimePending = overtimeRows.filter(o => o.status === 'pending');
    const overtimeApproved = overtimeRows.filter(o => o.status === 'approved');
    const sum = (rows, field) => rows.reduce((acc, r) => acc + parseFloat(r[field] || 0), 0);

    return res.json({
        employee_id: employee.id,
        name: employee.name,
        emp_code: employee.emp_code,
        dob: employee.dob,
        year,
        month,
        attendance_percentage: attendancePercentage,
        present_days: presentDays,
        absent_days: absentDays,
        leave_days: leaveDays,
        holiday_days: holidayDays,
        weekly_off_days: weeklyOffDays,
        // DEPRECATED (migration_010): flat sum across leave_balances
        // below, kept only for any caller not yet updated to the
        // per-type breakdown. leave_used here is paid-days-used summed
        // across types (so it can legitimately be less than leave_days,
        // which counts ALL on-leave calendar days regardless of type or
        // paid/unpaid split).
        leave_quota: leaveQuota,
        leave_used: leaveUsed,
        leave_remaining: leaveRemaining,
        leave_balances: leaveBalances,
        overtime: {
            pending_hours: sum(overtimePending, 'overtime_hours'),
            pending_amount: sum(overtimePending, 'amount'),
            approved_hours: sum(overtimeApproved, 'overtime_hours'),
            approved_amount: sum(overtimeApproved, 'amount'),
            records: overtimeRows.map(o => ({ ...o, date: toDateStr(o.date) })),
        },
        days,
    });
}));

// mysql2 can return DATE columns as JS Date objects (driver-dependent on
// timezone config) or as plain 'YYYY-MM-DD' strings - normalizing here
// once means every comparison above can just do plain string equality
// instead of every call site guessing which shape it got.
function toDateStr(value) {
    if (value instanceof Date) {
        return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
    }
    return String(value).split('T')[0];
}

// attendance.check_in is a DATETIME (mysql2 hands it back as a JS Date),
// but office_time_policy.check_in_window_end is a TIME string
// ('HH:MM:SS') - this pulls just the time-of-day out of the Date so the
// two can be compared lexically (safe for zero-padded HH:MM:SS).
function timeOfDayStr(value) {
    if (value instanceof Date) {
        return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}:${String(value.getSeconds()).padStart(2, '0')}`;
    }
    // Already a string (e.g. 'YYYY-MM-DD HH:MM:SS' or 'HH:MM:SS') -
    // take whatever's after a space if present, else the whole thing.
    const str = String(value);
    return str.includes(' ') ? str.split(' ')[1] : str;
}

module.exports = router;
