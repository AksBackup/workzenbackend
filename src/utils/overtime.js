const pool = require('../db');

/**
 * Auto-computes overtime for one employee/day whenever a check-out is
 * recorded, and upserts it into `overtime_records` as 'pending' - it
 * always needs admin approval (Employee Details > Attendance & Leave)
 * before it's confirmed, per the brief ("overtime will require admin
 * approvement for the confirmation").
 *
 * Rate resolution (migration_035 added the per-employee override):
 *   1. If this employee has an active statutory/OT override
 *      (employees.statutory_override_active) with an ot_rate_type set,
 *      use THAT rate instead of the company-wide one:
 *        - 'fixed'      -> ot_rate_value, a flat rupees-per-OT-hour figure.
 *        - 'percentage' -> ot_rate_value% of this employee's derived
 *          per-hour salary rate, i.e. employees.salary / (full_day_hours
 *          * days in dateStr's month) - full_day_hours comes from
 *          office_time_policy, the same figure payroll.js's
 *          computeMonthlyPayroll uses to decide full/half day pay.
 *   2. Otherwise, fall back to the original company-wide behaviour:
 *      office_time_policy.overtime_rate_per_hour. A NULL rate there
 *      still means "not configured", not "free overtime at ₹0/hour" -
 *      nothing is computed until either an admin sets a company rate or
 *      this employee has their own override.
 *
 * Called from:
 *   - attendance.js  POST /attendance        (single punch write)
 *   - attendance.js  POST /attendance/sync   (offline queue batch)
 *   - manualPunch.js POST /:id/approve       (approved manual punch)
 * All three already upsert into `attendance` with the same
 * (employee_id, date) unique key `overtime_records` also uses, so this
 * is called right after that upsert succeeds, using whatever the
 * resulting check_out value is (COALESCEd, so this always reflects the
 * real stored value even for check-in-only writes that don't touch
 * check_out at all).
 */
async function computeAndRecordOvertime(companyId, employeeId, dateStr, checkOutValue) {
    if (!checkOutValue) return;

    // migration_015: per-shift OT eligibility gate. An employee with no
    // shift assigned (shift_id NULL) keeps today's original behaviour
    // (OT computed for everyone) - the join below only excludes someone
    // when their *specific* assigned shift has ot_allowed = FALSE.
    const [shiftRows] = await pool.query(
        `SELECT s.ot_allowed FROM employees e
         JOIN shifts s ON s.id = e.shift_id
         WHERE e.id = ? AND e.company_id = ?`,
        [employeeId, companyId]
    );
    if (shiftRows.length > 0 && !shiftRows[0].ot_allowed) {
        // This employee's shift explicitly disallows OT - clear any
        // stale pending record for consistency (e.g. their shift was
        // just changed to an OT-disallowed one) and stop.
        await pool.query(
            "DELETE FROM overtime_records WHERE employee_id = ? AND date = ? AND status = 'pending'",
            [employeeId, dateStr]
        );
        return;
    }

    const [policyRows] = await pool.query(
        'SELECT check_out_time, overtime_rate_per_hour, full_day_hours FROM office_time_policy WHERE company_id = ?',
        [companyId]
    );
    if (policyRows.length === 0) return;
    const { check_out_time, overtime_rate_per_hour, full_day_hours } = policyRows[0];

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
        if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
        // migration_035 not applied yet - proceed with no OT override.
    }

    let rate;
    if (employeeOverride) {
        if (employeeOverride.ot_rate_type === 'fixed') {
            rate = parseFloat(employeeOverride.ot_rate_value) || 0;
        } else {
            // 'percentage' - of this employee's derived per-hour salary
            // rate. Falls back to a rate of 0 (not an error) if salary or
            // full_day_hours isn't set - an OT % of an undefined base pay
            // isn't computable, and silently skipping is safer than
            // guessing.
            const daysInMonth = new Date(
                Number(dateStr.slice(0, 4)), Number(dateStr.slice(5, 7)), 0
            ).getDate();
            const fullDayHours = Number(full_day_hours) || 8.0;
            const monthlySalary = Number(employeeOverride.salary) || 0;
            const hourlyRate = monthlySalary > 0 ? monthlySalary / (fullDayHours * daysInMonth) : 0;
            rate = round2(hourlyRate * (parseFloat(employeeOverride.ot_rate_value) || 0) / 100);
        }
    } else if (overtime_rate_per_hour !== null) {
        rate = parseFloat(overtime_rate_per_hour);
    } else {
        // No employee override and no company-wide rate configured -
        // same "not configured" no-op as before this migration.
        return;
    }

    const checkOut = new Date(checkOutValue);
    if (Number.isNaN(checkOut.getTime())) return;

    const [h, m, s] = String(check_out_time).split(':').map(Number);
    const scheduled = new Date(checkOut);
    scheduled.setHours(h || 0, m || 0, s || 0, 0);

    const diffMs = checkOut.getTime() - scheduled.getTime();
    const overtimeHours = diffMs > 0 ? diffMs / (1000 * 60 * 60) : 0;

    if (overtimeHours <= 0) {
        // Not staying late (or checked out earlier than before, e.g. a
        // corrected punch) - remove any stale PENDING record for this
        // day rather than leaving a now-wrong approval request sitting
        // around. An already-approved record is left alone; unwinding a
        // real approval isn't this function's call to make.
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
           -- Recalculating shouldn't silently undo a real approval - only
           -- downgrade back to 'pending' if it wasn't already approved.
           -- This also happens to protect migration_017's manual entries
           -- (always inserted 'approved') from being knocked back to
           -- 'pending' if a real late check-out also lands on the same
           -- day - hours/amount still get refreshed to match the actual
           -- punch, but the approval and 'manual' source (untouched
           -- above) survive.
           status = IF(status = 'approved', status, 'pending')`,
        [companyId, employeeId, dateStr, checkOutValue, overtimeHours.toFixed(2), rate.toFixed(2), amount.toFixed(2)]
    );
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

module.exports = { computeAndRecordOvertime };
