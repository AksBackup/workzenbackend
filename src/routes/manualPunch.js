const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');
const { computeAndRecordOvertime } = require('../utils/overtime');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Manual Punch (4.8) / Bulk Manual Punch (4.9) / Approval Manual Punch
 * (4.10). All three write to the same `manual_punches` queue table;
 * 4.10 is what promotes a row into the real `attendance` table.
 *
 * work_code_id: per AGENT_B_ATTENDANCE_LEAVE_OPS.md, 4.8/4.9 "depend on
 * Agent A's work_codes" - that table wasn't available in this session,
 * so work_code_id is accepted and stored (nullable, no FK - see
 * migration_004's comments) but never validated against a real
 * work_codes table here. Once Agent A's table lands, add an existence
 * check before insert, same as the shift_id note in shiftAssignments.js.
 */

async function _currentAdminId(req) {
    const [rows] = await pool.query('SELECT id FROM admins WHERE firebase_uid = ?', [req.user.uid]);
    return rows[0] ? rows[0].id : null;
}

// GET /manual-punches?status=pending
router.get('/', asyncHandler(async (req, res) => {
    const { status, employee_id } = req.query;
    const params = [req.user.companyId];
    let sql = `SELECT mp.*, e.name AS employee_name, e.emp_code AS employee_code
               FROM manual_punches mp
               JOIN employees e ON e.id = mp.employee_id
               WHERE mp.company_id = ?`;

    if (status) {
        sql += ' AND mp.status = ?';
        params.push(status);
    }
    if (employee_id) {
        sql += ' AND mp.employee_id = ?';
        params.push(employee_id);
    }
    sql += ' ORDER BY mp.date DESC, mp.created_at DESC';

    const [rows] = await pool.query(sql, params);
    return res.json(rows);
}));

// POST /manual-punches - single employee, single day (4.8).
// body: { employee_id, date, check_in?, check_out?, work_code_id?, remark? }
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { employee_id, date, check_in, check_out, work_code_id, remark } = req.body;
    if (!employee_id || !date) return res.status(400).json({ error: 'employee_id and date required' });

    const adminId = await _currentAdminId(req);
    const [result] = await pool.query(
        `INSERT INTO manual_punches (company_id, employee_id, date, check_in, check_out, work_code_id, remark, marked_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.user.companyId, employee_id, date, check_in || null, check_out || null, work_code_id || null, remark || null, adminId]
    );
    return res.status(201).json({ id: result.insertId });
}));

// POST /manual-punches/bulk - multiple employees, same date/time/remark
// (4.9 - "select all in department" is a client-side employee_ids
// selection built off the department filter, this endpoint doesn't care
// how the list was chosen).
// body: { employee_ids: [1,2,3], date, check_in?, check_out?, work_code_id?, remark? }
router.post('/bulk', requireAdmin, asyncHandler(async (req, res) => {
    const { employee_ids, date, check_in, check_out, work_code_id, remark } = req.body;
    if (!Array.isArray(employee_ids) || employee_ids.length === 0 || !date) {
        return res.status(400).json({ error: 'employee_ids array and date required' });
    }

    const adminId = await _currentAdminId(req);
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const insertedIds = [];
        for (const employeeId of employee_ids) {
            const [result] = await conn.query(
                `INSERT INTO manual_punches (company_id, employee_id, date, check_in, check_out, work_code_id, remark, marked_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [req.user.companyId, employeeId, date, check_in || null, check_out || null, work_code_id || null, remark || null, adminId]
            );
            insertedIds.push(result.insertId);
        }
        await conn.commit();
        return res.status(201).json({ message: `Created ${insertedIds.length} manual punch entries`, ids: insertedIds });
    } catch (err) {
        await conn.rollback();
        console.error('Bulk manual punch failed:', err);
        return res.status(500).json({ error: 'Bulk insert failed', detail: err.message });
    } finally {
        conn.release();
    }
}));

/**
 * POST /manual-punches/:id/approve (4.10)
 *
 * This is the one place in this agent's scope with real cross-table
 * logic - an approved manual punch is supposed to show up everywhere
 * real attendance does (Attendance Process, Reports, Payroll), not live
 * in this queue table forever. Writes into `attendance` using the exact
 * same `(employee_id, date)` upsert pattern `POST /attendance/sync`
 * already uses (src/routes/attendance.js), with source='manual' so it's
 * distinguishable from a scanner punch downstream. check_in/check_out
 * are COALESCEd against existing values so approving a check-out-only
 * manual punch (e.g. someone forgot to punch out) doesn't null out an
 * already-recorded check-in for that day, and vice versa.
 */
router.post('/:id/approve', requireAdmin, asyncHandler(async (req, res) => {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const [rows] = await conn.query(
            'SELECT * FROM manual_punches WHERE id = ? AND company_id = ? FOR UPDATE',
            [req.params.id, req.user.companyId]
        );
        if (rows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ error: 'Manual punch not found' });
        }
        const punch = rows[0];
        if (punch.status !== 'pending') {
            await conn.rollback();
            return res.status(409).json({ error: `Already ${punch.status}` });
        }

        // The real write: same upsert shape as attendance.js's /sync route.
        // verify_mode='manual' (migration_011) - an admin typed this in,
        // there's no device verification step, so it should read as
        // "Manual" in the UI rather than falling back to the column's
        // 'unknown' default, which used to look identical to a device
        // punch whose verify method we simply failed to capture.
        await conn.query(
            `INSERT INTO attendance (company_id, employee_id, date, check_in, check_out, source, verify_mode)
             VALUES (?, ?, ?, ?, ?, 'manual', 'manual')
             ON DUPLICATE KEY UPDATE
               check_in = COALESCE(VALUES(check_in), check_in),
               check_out = COALESCE(VALUES(check_out), check_out),
               verify_mode = 'manual'`,
            [req.user.companyId, punch.employee_id, punch.date, punch.check_in, punch.check_out]
        );

        const adminId = await _currentAdminId(req);
        await conn.query(
            `UPDATE manual_punches SET status = 'approved', approved_by = ?, approved_on = NOW()
             WHERE id = ? AND company_id = ?`,
            [adminId, req.params.id, req.user.companyId]
        );

        await conn.commit();
        if (punch.check_out) {
            await computeAndRecordOvertime(req.user.companyId, punch.employee_id, punch.date, punch.check_out).catch(err =>
                console.error('Overtime computation failed:', err)
            );
        }
        return res.json({ message: 'Approved and written to attendance' });
    } catch (err) {
        await conn.rollback();
        console.error('Manual punch approval failed:', err);
        return res.status(500).json({ error: 'Approval failed', detail: err.message });
    } finally {
        conn.release();
    }
}));

router.post('/:id/reject', requireAdmin, asyncHandler(async (req, res) => {
    const adminId = await _currentAdminId(req);
    await pool.query(
        `UPDATE manual_punches SET status = 'rejected', approved_by = ?, approved_on = NOW()
         WHERE id = ? AND company_id = ? AND status = 'pending'`,
        [adminId, req.params.id, req.user.companyId]
    );
    return res.json({ message: 'Rejected' });
}));

module.exports = router;
