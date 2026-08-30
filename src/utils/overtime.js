const pool = require('../db');

/**
 * Auto-computes overtime for one employee/day whenever a check-out is
 * recorded, and upserts it into `overtime_records` as 'pending' - it
 * always needs admin approval (Employee Details > Attendance & Leave)
 * before it's confirmed, per the brief ("overtime will require admin
 * approvement for the confirmation").
 *
 * Deliberately does nothing if the company hasn't set
 * office_time_policy.overtime_rate_per_hour yet - a NULL rate means "not
 * configured", not "free overtime at ₹0/hour", so nothing is computed
 * (and nothing silently priced at zero) until an admin sets a rate in
 * Settings > Office Time.
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

    const [policyRows] = await pool.query(
        'SELECT check_out_time, overtime_rate_per_hour FROM office_time_policy WHERE company_id = ?',
        [companyId]
    );
    if (policyRows.length === 0 || policyRows[0].overtime_rate_per_hour === null) {
        return;
    }
    const { check_out_time, overtime_rate_per_hour } = policyRows[0];

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

    const rate = parseFloat(overtime_rate_per_hour);
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
           status = IF(status = 'approved', status, 'pending')`,
        [companyId, employeeId, dateStr, checkOutValue, overtimeHours.toFixed(2), rate.toFixed(2), amount.toFixed(2)]
    );
}

module.exports = { computeAndRecordOvertime };
