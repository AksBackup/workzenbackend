const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Earn/Adjust Leave (PDF gap, CONTEXT.md section 8 item 3,
 * migration_014_leave_adjustments.sql). See that migration's header
 * comment for the full architectural note - short version: this writes
 * a delta (not an absolute value, unlike POST /leave-balances) into the
 * SAME `leave_balances.allocated` column Leave Opening Entry uses,
 * plus a permanent audit row in `leave_adjustments` recording who
 * changed it, by how much, and why. Does not touch the live
 * per-month-quota calculation in routes/leaves.js /
 * routes/employees.js - see the migration for why that's deliberate,
 * not an oversight.
 */

async function _currentAdminId(req) {
    const [rows] = await pool.query('SELECT id FROM admins WHERE firebase_uid = ?', [req.user.uid]);
    return rows[0] ? rows[0].id : null;
}

// GET /leave-adjustments?employee_id=&year=&leave_type_id=
// History/audit view - every earn/adjust entry ever applied, newest
// first. Joined with employees + leave_types for display names, same
// pattern GET /leave-balances already established.
router.get('/', asyncHandler(async (req, res) => {
    const { employee_id, year, leave_type_id } = req.query;
    const params = [req.user.companyId];
    let sql = `SELECT la.*, e.name AS employee_name, e.emp_code AS employee_code, lt.name AS leave_type_name
               FROM leave_adjustments la
               JOIN employees e ON e.id = la.employee_id
               JOIN leave_types lt ON lt.id = la.leave_type_id
               WHERE la.company_id = ?`;

    if (employee_id) {
        sql += ' AND la.employee_id = ?';
        params.push(employee_id);
    }
    if (year) {
        sql += ' AND la.year = ?';
        params.push(year);
    }
    if (leave_type_id) {
        sql += ' AND la.leave_type_id = ?';
        params.push(leave_type_id);
    }
    sql += ' ORDER BY la.created_at DESC';

    const [rows] = await pool.query(sql, params);
    return res.json(rows);
}));

// POST /leave-adjustments - apply a credit or debit.
// body: { employee_id, leave_type_id, year, type: 'earn'|'adjust', amount, reason }
// 'earn' must be a positive amount (a credit) - 'adjust' can go either
// way, since it's meant for corrections. Both require a reason: unlike
// Opening Entry's blind overwrite, the whole point of this endpoint is
// that every change here is explained.
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { employee_id, leave_type_id, year, type, amount, reason } = req.body;
    if (!employee_id || !leave_type_id || !year || !type || amount === undefined || !reason) {
        return res.status(400).json({ error: 'employee_id, leave_type_id, year, type, amount, and reason are all required' });
    }
    if (!['earn', 'adjust'].includes(type)) {
        return res.status(400).json({ error: "type must be 'earn' or 'adjust'" });
    }
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount === 0) {
        return res.status(400).json({ error: 'amount must be a non-zero number' });
    }
    if (type === 'earn' && numericAmount <= 0) {
        return res.status(400).json({ error: "'earn' amount must be positive - use type 'adjust' for a deduction/correction" });
    }

    // Tenant-isolation check, same as leaveOpening.js's POST -
    // leave_balances/leave_adjustments have no way to reject a
    // cross-company employee_id at the DB level.
    const [empRows] = await pool.query(
        'SELECT id FROM employees WHERE id = ? AND company_id = ?',
        [employee_id, req.user.companyId]
    );
    if (empRows.length === 0) return res.status(404).json({ error: 'Employee not found' });

    const [typeRows] = await pool.query(
        'SELECT id FROM leave_types WHERE id = ? AND company_id = ?',
        [leave_type_id, req.user.companyId]
    );
    if (typeRows.length === 0) return res.status(404).json({ error: 'Leave type not found' });

    const adminId = await _currentAdminId(req);
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const [result] = await conn.query(
            `INSERT INTO leave_adjustments (company_id, employee_id, leave_type_id, year, type, amount, reason, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.user.companyId, employee_id, leave_type_id, year, type, numericAmount, reason, adminId]
        );

        // Delta upsert against leave_balances' existing uq_emp_type_year
        // key - see migration_014's header comment for why
        // VALUES(allocated) is being reused as "the amount being
        // applied" here, not "the absolute value being set" the way
        // leaveOpening.js's own POST /leave-balances uses it.
        await conn.query(
            `INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE allocated = allocated + VALUES(allocated)`,
            [employee_id, leave_type_id, year, numericAmount]
        );

        await conn.commit();
        return res.status(201).json({ id: result.insertId, applied: numericAmount });
    } catch (err) {
        await conn.rollback();
        console.error('Leave adjustment failed:', err);
        return res.status(500).json({ error: 'Adjustment failed', detail: err.message });
    } finally {
        conn.release();
    }
}));

// DELETE /leave-adjustments/:id - void a mistaken entry. Unlike a
// typical delete, this also reverses the entry's effect on
// leave_balances.allocated (subtracts back the same amount that was
// added), so a voided earn/adjust doesn't leave a permanent balance
// discrepancy behind. The row itself is removed rather than
// soft-deleted/flagged - matches this repo's existing delete
// conventions elsewhere (leaveTypes.js, leaveOpening.js's own DELETE) -
// but note that this does mean the audit trail loses the entry once
// voided, not just its effect. Worth revisiting if a permanent
// "voided but still visible" trail turns out to matter more than
// matching the existing hard-delete convention.
router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const [rows] = await conn.query(
            'SELECT * FROM leave_adjustments WHERE id = ? AND company_id = ? FOR UPDATE',
            [req.params.id, req.user.companyId]
        );
        if (rows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ error: 'Leave adjustment not found' });
        }
        const adj = rows[0];

        await conn.query(
            'UPDATE leave_balances SET allocated = allocated - ? WHERE employee_id = ? AND leave_type_id = ? AND year = ?',
            [adj.amount, adj.employee_id, adj.leave_type_id, adj.year]
        );
        await conn.query('DELETE FROM leave_adjustments WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);

        await conn.commit();
        return res.json({ message: 'Voided' });
    } catch (err) {
        await conn.rollback();
        console.error('Leave adjustment void failed:', err);
        return res.status(500).json({ error: 'Void failed', detail: err.message });
    } finally {
        conn.release();
    }
}));

module.exports = router;
