const pool = require('../db');
const { pairPunchEvents } = require('./attendanceRules');

/**
 * Auto-computes overtime for one employee/day whenever a checkout is
 * recorded. The function name and callers remain unchanged.
 *
 * Source-of-truth order for worked time:
 *   1. Raw punch_events, paired IN -> OUT -> IN -> OUT and summed.
 *   2. Legacy attendance/check-out policy fallback when raw punches are
 *      unavailable (keeps older records working).
 *
 * OT minutes are based on worked minutes beyond the employee's effective
 * shift duration. Employee OT fixed/percentage configuration is honored
 * when its override is active; otherwise the existing company policy rate
 * is used.
 */
async function computeAndRecordOvertime(companyId, employeeId, dateStr, checkOutValue) {
    if (!checkOutValue) return;

<<<<<<< HEAD
    let employee;
    try {
        const [rows] = await pool.query(
            `SELECT e.id, e.salary, e.shift_id, e.ot_rate_type, e.ot_rate_value, e.statutory_override_active
             FROM employees e WHERE e.id = ? AND e.company_id = ? LIMIT 1`,
            [employeeId, companyId]
        );
        employee = rows[0] || null;
    } catch (err) {
        if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
        const [rows] = await pool.query(
            `SELECT e.id, e.salary, e.shift_id FROM employees e WHERE e.id = ? AND e.company_id = ? LIMIT 1`,
            [employeeId, companyId]
        );
        employee = rows[0] || null;
    }
    if (!employee) return;

    const [shiftAssignmentRows] = await pool.query(
        `SELECT s.* FROM shift_assignments sa
         JOIN shifts s ON s.id = sa.shift_id
         WHERE sa.company_id = ? AND sa.employee_id = ?
           AND sa.effective_from <= ? AND (sa.effective_to IS NULL OR sa.effective_to >= ?)
         ORDER BY sa.effective_from DESC LIMIT 1`,
        [companyId, employeeId, dateStr, dateStr]
    ).catch(err => {
        if (err.code === 'ER_NO_SUCH_TABLE') return [[]];
        throw err;
    });
    let shift = shiftAssignmentRows[0] || null;
    if (!shift && employee.shift_id != null) {
        const [rows] = await pool.query('SELECT * FROM shifts WHERE id = ? AND company_id = ? LIMIT 1', [employee.shift_id, companyId]);
        shift = rows[0] || null;
    }
    if (!shift) {
        const [rows] = await pool.query('SELECT * FROM shifts WHERE company_id = ? AND is_default = TRUE LIMIT 1', [companyId]);
        shift = rows[0] || null;
    }

    if (shift && shift.ot_allowed === false || shift && Number(shift.ot_allowed) === 0) {
=======
    // migration_015: per-shift OT eligibility gate. An employee with no
    // shift assigned (shift_id NULL) keeps today's original behaviour
    // (OT computed for everyone) - the join below only excludes someone
    // when their *specific* assigned shift has ot_allowed = FALSE.
    const [shiftRows] = await pool.query(
        `SELECT s.ot_allowed, s.end_time FROM employees e
         JOIN shifts s ON s.id = e.shift_id
         WHERE e.id = ? AND e.company_id = ?`,
        [employeeId, companyId]
    );
    if (shiftRows.length > 0 && !shiftRows[0].ot_allowed) {
        // This employee's shift explicitly disallows OT - clear any
        // stale pending record for consistency (e.g. their shift was
        // just changed to an OT-disallowed one) and stop.
>>>>>>> b066605 (payroll v2)
        await pool.query(
            "DELETE FROM overtime_records WHERE employee_id = ? AND date = ? AND status = 'pending'",
            [employeeId, dateStr]
        );
        return;
    }

    const [policyRows] = await pool.query(
        'SELECT check_out_time, overtime_rate_per_hour, full_day_hours, max_ot_minutes FROM office_time_policy WHERE company_id = ?',
        [companyId]
<<<<<<< HEAD
    ).catch(async err => {
=======
    );
    if (policyRows.length === 0) return;
    const { check_out_time: companyCheckOutTime, overtime_rate_per_hour, full_day_hours } = policyRows[0];
    // Payroll v3: overtime starts after the EMPLOYEE'S SHIFT end time (the shift the
    // attendance/late-early reports use). The company-wide office_time_policy
    // check_out_time is only the fallback for employees with no shift - previously it
    // was used for everyone, so a night/early shift got OT (or none) against the wrong
    // clock time.
    const check_out_time = shiftRows.length > 0 && shiftRows[0].end_time ? shiftRows[0].end_time : companyCheckOutTime;

    // migration_035 - this employee's own OT rate override, if any.
    // Defensive on the column set (ER_BAD_FIELD_ERROR) the same way the
    // rest of this backend handles migrations that may not have been
    // applied yet to an older DB.
    let employeeOverride = null;
    try {
        const [empRows] = await pool.query(
            'SELECT salary, ot_rate_type, ot_rate_value, statutory_override_active FROM employees WHERE id = ? AND company_id = ?',
            [employeeId, companyId]
        );
        if (empRows.length > 0 && empRows[0].statutory_override_active && empRows[0].ot_rate_type) {
            employeeOverride = empRows[0];
        }
    } catch (err) {
>>>>>>> b066605 (payroll v2)
        if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
        return pool.query(
            'SELECT check_out_time, overtime_rate_per_hour, full_day_hours FROM office_time_policy WHERE company_id = ?',
            [companyId]
        );
    });
    if (policyRows.length === 0) return;
    const { check_out_time, overtime_rate_per_hour, full_day_hours, max_ot_minutes: officePolicyMaxOtMinutes } = policyRows[0];

    let override = null;
    if (employee.statutory_override_active && employee.ot_rate_type && employee.ot_rate_value != null) {
        override = employee;
    }

    let rate;
    if (override) {
        if (override.ot_rate_type === 'fixed') {
            rate = Number(override.ot_rate_value) || 0;
        } else {
            const daysInMonth = new Date(Number(dateStr.slice(0, 4)), Number(dateStr.slice(5, 7)), 0).getDate();
            const fullDay = Number(full_day_hours) || 8;
            const monthlySalary = Number(override.salary) || 0;
            const hourlyRate = monthlySalary > 0 ? monthlySalary / (fullDay * daysInMonth) : 0;
            rate = hourlyRate * (Number(override.ot_rate_value) || 0) / 100;
        }
    } else if (overtime_rate_per_hour !== null) {
        rate = Number(overtime_rate_per_hour) || 0;
    } else {
        return;
    }

    const [eventRows] = await pool.query(
        `SELECT punch_time, punch_type FROM punch_events
         WHERE company_id = ? AND employee_id = ? AND DATE(punch_time) = ?
         ORDER BY punch_time ASC`,
        [companyId, employeeId, dateStr]
    ).catch(err => {
        if (err.code === 'ER_NO_SUCH_TABLE') return [[]];
        throw err;
    });

    let overtimeHours = 0;
    const pair = pairPunchEvents(eventRows);
    if (pair.intervals.length > 0 && shift && shift.start_time != null && shift.end_time != null) {
        const [sh, sm] = String(shift.start_time).split(':').map(Number);
        const [eh, em] = String(shift.end_time).split(':').map(Number);
        const start = new Date(`${dateStr}T00:00:00`);
        start.setHours(sh || 0, sm || 0, 0, 0);
        const end = new Date(`${dateStr}T00:00:00`);
        end.setHours(eh || 0, em || 0, 0, 0);
        if (end <= start) end.setDate(end.getDate() + 1);
        const scheduledMinutes = Math.max(0, Math.round((end - start) / 60000));
        const maxOtMinutes = Number.isFinite(Number(officePolicyMaxOtMinutes))
            ? Number(officePolicyMaxOtMinutes)
            : (Number.isFinite(Number(shift.max_ot_minutes)) ? Number(shift.max_ot_minutes) : null);
        const rawOtMinutes = Math.max(0, pair.totalWorkMinutes - scheduledMinutes);
        const otMinutes = maxOtMinutes != null && maxOtMinutes > 0 ? Math.min(rawOtMinutes, maxOtMinutes) : rawOtMinutes;
        overtimeHours = otMinutes / 60;
    } else {
        // Legacy fallback for old attendance rows that have no raw punch events.
        const checkOut = new Date(checkOutValue);
        if (Number.isNaN(checkOut.getTime()) || check_out_time == null) return;
        const parts = String(check_out_time).split(':').map(Number);
        const scheduled = new Date(checkOut);
        scheduled.setHours(parts[0] || 0, parts[1] || 0, parts[2] || 0, 0);
        overtimeHours = Math.max(0, (checkOut.getTime() - scheduled.getTime()) / 3600000);
    }

    if (overtimeHours <= 0 || rate <= 0) {
        await pool.query(
            "DELETE FROM overtime_records WHERE employee_id = ? AND date = ? AND status = 'pending'",
            [employeeId, dateStr]
        );
        return;
    }

    const amount = overtimeHours * rate;
    await pool.query(
        `INSERT INTO overtime_records (company_id, employee_id, date, checkout_time, overtime_hours, rate_per_hour, amount, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
         ON DUPLICATE KEY UPDATE
           checkout_time = VALUES(checkout_time),
           overtime_hours = VALUES(overtime_hours),
           rate_per_hour = VALUES(rate_per_hour),
           amount = VALUES(amount),
           status = IF(status = 'approved', status, 'pending')`,
        [companyId, employeeId, dateStr, checkOutValue, overtimeHours.toFixed(2), rate.toFixed(2), amount.toFixed(2)]
    );
}

module.exports = { computeAndRecordOvertime };
