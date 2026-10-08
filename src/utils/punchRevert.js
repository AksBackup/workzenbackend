/**
 * Undo the attendance effect of an APPROVED manual / mobile punch (used by Revert-to-pending and
 * by Delete on an approved punch).
 *
 * Since migration_045 every approval stores a snapshot of that day's attendance row as it was
 * before (attendance_snapshot). Revert/Delete restores exactly that row, then re-applies punches
 * approved after this one. Punches approved before the migration have no snapshot and fall back to
 * the older best-effort rule (delete the row if this kind of punch created it, else warn).
 * Auto-computed, still-pending overtime for that day is removed so it can be recomputed.
 *
 * @returns {Promise<{warning: string|null}>}
 */
const TABLES = { manual: 'manual_punches', mobile: 'mobile_punches' };

/** The day's attendance row exactly as it is now (times as plain strings - no timezone shifting). */
async function snapshotAttendance(conn, companyId, employeeId, date) {
    const [rows] = await conn.query(
        `SELECT DATE_FORMAT(check_in, '%Y-%m-%d %H:%i:%s') AS ci, DATE_FORMAT(check_out, '%Y-%m-%d %H:%i:%s') AS co, source, verify_mode
         FROM attendance WHERE company_id = ? AND employee_id = ? AND date = ? FOR UPDATE`,
        [companyId, employeeId, date]);
    if (!rows.length) return { existed: false };
    return { existed: true, check_in: rows[0].ci, check_out: rows[0].co, source: rows[0].source, verify_mode: rows[0].verify_mode };
}

/** Stores the snapshot on the punch. Silently skipped until migration_045 has been run. */
async function saveSnapshot(conn, kind, punchId, snapshot) {
    try {
        await conn.query(`UPDATE ${TABLES[kind]} SET attendance_snapshot = ? WHERE id = ?`, [JSON.stringify(snapshot), punchId]);
    } catch (err) {
        if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    }
}

async function reapplyPunches(conn, companyId, punch, list) {
    for (const o of list) {
        await conn.query(
            `INSERT INTO attendance (company_id, employee_id, date, check_in, check_out, source, verify_mode)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               check_in = COALESCE(VALUES(check_in), check_in),
               check_out = COALESCE(VALUES(check_out), check_out),
               verify_mode = VALUES(verify_mode)`,
            [companyId, punch.employee_id, punch.date, o.check_in, o.check_out, o.k, o.k]);
    }
}

async function undoApprovedPunch(conn, companyId, kind /* 'manual' | 'mobile' */, punch) {
    let warning = null;
    let snapshot = punch.attendance_snapshot;
    if (typeof snapshot === 'string') { try { snapshot = JSON.parse(snapshot); } catch (_) { snapshot = null; } }

    if (snapshot && typeof snapshot === 'object') {
        // Exact undo: put the day's attendance row back to what it was before THIS approval.
        if (snapshot.existed) {
            await conn.query(
                'UPDATE attendance SET check_in = ?, check_out = ?, source = ?, verify_mode = ? WHERE company_id = ? AND employee_id = ? AND date = ?',
                [snapshot.check_in || null, snapshot.check_out || null, snapshot.source, snapshot.verify_mode, companyId, punch.employee_id, punch.date]);
        } else {
            await conn.query('DELETE FROM attendance WHERE company_id = ? AND employee_id = ? AND date = ?', [companyId, punch.employee_id, punch.date]);
        }
        // Punches approved AFTER this one built on top of it - apply them again, in order.
        const later = [];
        for (const [table, k] of [['manual_punches', 'manual'], ['mobile_punches', 'mobile']]) {
            const [rows] = await conn.query(
                `SELECT id, check_in, check_out, approved_on FROM ${table}
                 WHERE company_id = ? AND employee_id = ? AND date = ? AND status = 'approved' AND id <> ? AND approved_on > ?
                 ORDER BY approved_on ASC, id ASC`,
                [companyId, punch.employee_id, punch.date, (k === kind ? punch.id : -1), punch.approved_on]);
            rows.forEach((r) => later.push({ ...r, k }));
        }
        later.sort((x, y) => new Date(x.approved_on) - new Date(y.approved_on));
        for (const o of later) {
            await conn.query(
                `INSERT INTO attendance (company_id, employee_id, date, check_in, check_out, source, verify_mode)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                   check_in = COALESCE(VALUES(check_in), check_in),
                   check_out = COALESCE(VALUES(check_out), check_out)`,
                [companyId, punch.employee_id, punch.date, o.check_in, o.check_out, o.k, o.k]);
        }
    } else {
        // Approved before migration_045 (no snapshot): best effort, as before.
        const [attRows] = await conn.query(
            'SELECT id, source FROM attendance WHERE company_id = ? AND employee_id = ? AND date = ? FOR UPDATE',
            [companyId, punch.employee_id, punch.date]);
        if (attRows.length && attRows[0].source === kind) {
            await conn.query('DELETE FROM attendance WHERE id = ?', [attRows[0].id]);
            const others = [];
            for (const [table, k] of [['manual_punches', 'manual'], ['mobile_punches', 'mobile']]) {
                const [rows] = await conn.query(
                    `SELECT id, check_in, check_out FROM ${table}
                     WHERE company_id = ? AND employee_id = ? AND date = ? AND status = 'approved' AND id <> ?`,
                    [companyId, punch.employee_id, punch.date, (k === kind ? punch.id : -1)]);
                rows.forEach((r) => others.push({ ...r, k }));
            }
            for (const o of others) {
                await conn.query(
                    `INSERT INTO attendance (company_id, employee_id, date, check_in, check_out, source, verify_mode)
                     VALUES (?, ?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE
                       check_in = COALESCE(VALUES(check_in), check_in),
                       check_out = COALESCE(VALUES(check_out), check_out)`,
                    [companyId, punch.employee_id, punch.date, o.check_in, o.check_out, o.k, o.k]);
            }
        } else if (attRows.length) {
            warning = 'This punch was approved before exact undo existed and the day has a device punch, so its attendance times were not changed.';
        }
    }
    try {
        await conn.query(
            "DELETE FROM overtime_records WHERE company_id = ? AND employee_id = ? AND date = ? AND status = 'pending' AND (source IS NULL OR source = 'auto')",
            [companyId, punch.employee_id, punch.date]);
    } catch (err) {
        if (err.code !== 'ER_BAD_FIELD_ERROR' && err.code !== 'ER_NO_SUCH_TABLE') throw err;
    }
    return { warning };
}

/**
 * Registers POST /:id/revert (approved|rejected -> pending) and DELETE /:id on a punch router.
 */
function addRevertAndDelete(router, { pool, requireAdmin, asyncHandler, table, kind }) {
    router.post('/:id/revert', requireAdmin, asyncHandler(async (req, res) => {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const [rows] = await conn.query(`SELECT * FROM ${table} WHERE id = ? AND company_id = ? FOR UPDATE`, [req.params.id, req.user.companyId]);
            if (!rows.length) { await conn.rollback(); return res.status(404).json({ error: 'Punch not found' }); }
            const punch = rows[0];
            if (punch.status === 'pending') { await conn.rollback(); return res.status(409).json({ error: 'Already pending' }); }
            let warning = null;
            if (punch.status === 'approved') warning = (await undoApprovedPunch(conn, req.user.companyId, kind, punch)).warning;
            await conn.query(`UPDATE ${table} SET status = 'pending', approved_by = NULL, approved_on = NULL WHERE id = ? AND company_id = ?`, [req.params.id, req.user.companyId]);
            await conn.commit();
            await refreshPayrollSafe(req.user.companyId, punch.employee_id, punch.date);
            return res.json({ message: 'Reverted to pending', warning });
        } catch (err) {
            await conn.rollback();
            console.error('Punch revert failed:', err);
            return res.status(500).json({ error: 'Revert failed', detail: err.message });
        } finally { conn.release(); }
    }));

    router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const [rows] = await conn.query(`SELECT * FROM ${table} WHERE id = ? AND company_id = ? FOR UPDATE`, [req.params.id, req.user.companyId]);
            if (!rows.length) { await conn.rollback(); return res.status(404).json({ error: 'Punch not found' }); }
            const punch = rows[0];
            let warning = null;
            if (punch.status === 'approved') warning = (await undoApprovedPunch(conn, req.user.companyId, kind, punch)).warning;
            await conn.query(`DELETE FROM ${table} WHERE id = ? AND company_id = ?`, [req.params.id, req.user.companyId]);
            await conn.commit();
            await refreshPayrollSafe(req.user.companyId, punch.employee_id, punch.date);
            return res.json({ message: 'Deleted', warning });
        } catch (err) {
            await conn.rollback();
            console.error('Punch delete failed:', err);
            return res.status(500).json({ error: 'Delete failed', detail: err.message });
        } finally { conn.release(); }
    }));
}

/**
 * POST /:id/reject for a punch router. pending -> rejected, AND approved -> rejected directly:
 * the approval's effect on Attendance is undone (the day then follows the normal day rules - absent
 * unless leave / a holiday / week off / a device punch covers it) and a PAID payroll month is recomputed.
 */
function makeRejectHandler({ pool, table, kind, currentAdminId }) {
    return async (req, res) => {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const [rows] = await conn.query(`SELECT * FROM ${table} WHERE id = ? AND company_id = ? FOR UPDATE`, [req.params.id, req.user.companyId]);
            if (!rows.length) { await conn.rollback(); return res.status(404).json({ error: 'Punch not found' }); }
            const punch = rows[0];
            if (punch.status === 'rejected') { await conn.rollback(); return res.status(409).json({ error: 'Already rejected' }); }
            let warning = null;
            if (punch.status === 'approved') warning = (await undoApprovedPunch(conn, req.user.companyId, kind, punch)).warning;
            const adminId = await currentAdminId(req);
            await conn.query(`UPDATE ${table} SET status = 'rejected', approved_by = ?, approved_on = NOW() WHERE id = ? AND company_id = ?`, [adminId, req.params.id, req.user.companyId]);
            try {
                await conn.query(`UPDATE ${table} SET attendance_snapshot = NULL WHERE id = ?`, [req.params.id]);
            } catch (err) { if (err.code !== 'ER_BAD_FIELD_ERROR') throw err; }
            await conn.commit();
            const payroll = await refreshPayrollSafe(req.user.companyId, punch.employee_id, punch.date);
            return res.json({ message: 'Rejected', warning, payroll_updated: payroll });
        } catch (err) {
            await conn.rollback();
            console.error('Punch reject failed:', err);
            return res.status(500).json({ error: 'Reject failed', detail: err.message });
        } finally { conn.release(); }
    };
}

/** Recompute a PAID payroll month after attendance changed. Never fails the punch action itself. */
async function refreshPayrollSafe(companyId, employeeId, dateStr) {
    try {
        const { refreshPaidPayrollForDate } = require('../routes/payroll');
        const r = await refreshPaidPayrollForDate(companyId, employeeId, dateStr);
        return !!r.refreshed;
    } catch (err) {
        console.error('Paid payroll refresh failed:', err);
        return false;
    }
}

module.exports = { undoApprovedPunch, addRevertAndDelete, snapshotAttendance, saveSnapshot, makeRejectHandler, refreshPayrollSafe };
