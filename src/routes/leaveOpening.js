const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Leave Opening Entry (4.2, SCREENS.md). `leave_balances` has existed in
 * schema.sql since Phase 1 but nothing populated or read it - flagged as
 * a known gap in CONTEXT.md ("leave_balances table exists in the schema
 * but nothing populates or reads it yet"). This route is exactly that:
 * set `allocated` per employee per leave type per year, and list what's
 * already set. No migration needed for this table itself - only
 * leaveTypes.js (a genuinely missing dependency) needed one.
 */

// GET /leave-balances?year=2026[&employee_id=5]
// Joined with employees + leave_types so the client gets display names
// directly, same pattern /attendance already established.
router.get('/', asyncHandler(async (req, res) => {
    const { year, employee_id } = req.query;
    const params = [req.user.companyId];
    let sql = `SELECT lb.*, e.name AS employee_name, e.emp_code AS employee_code,
                      e.department AS department_name, e.designation AS designation_name,
                      lt.name AS leave_type_name
               FROM leave_balances lb
               JOIN employees e ON e.id = lb.employee_id
               JOIN leave_types lt ON lt.id = lb.leave_type_id
               WHERE e.company_id = ?`;

    if (year) {
        sql += ' AND lb.year = ?';
        params.push(year);
    }
    if (employee_id) {
        sql += ' AND lb.employee_id = ?';
        params.push(employee_id);
    }
    sql += ' ORDER BY e.name ASC, lt.name ASC';

    const [rows] = await pool.query(sql, params);
    return res.json(rows);
}));

// POST /leave-balances - upsert allocated for (employee_id, leave_type_id, year).
// Mirrors the `ON DUPLICATE KEY UPDATE` pattern attendance.js already
// uses against the table's own unique key (uq_emp_type_year).
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { employee_id, leave_type_id, year, allocated } = req.body;
    if (!employee_id || !leave_type_id || !year || allocated === undefined) {
        return res.status(400).json({ error: 'employee_id, leave_type_id, year, allocated required' });
    }

    // Tenant-isolation check: confirm the employee actually belongs to
    // this company before writing a balance against it (leave_balances
    // itself has no company_id column - it's scoped transitively through
    // employee_id - so this is the only place that isolation is enforced
    // for a write).
    const [empRows] = await pool.query(
        'SELECT id FROM employees WHERE id = ? AND company_id = ?',
        [employee_id, req.user.companyId]
    );
    if (empRows.length === 0) return res.status(404).json({ error: 'Employee not found' });

    await pool.query(
        `INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE allocated = VALUES(allocated)`,
        [employee_id, leave_type_id, year, allocated]
    );
    return res.status(201).json({ message: 'Saved' });
}));

// DELETE /leave-balances?employee_id=&year= - "Clear All Leave Balance"
// from the mockup: wipes every leave-type balance for one employee/year
// in one call rather than requiring N individual deletes client-side.
router.delete('/', requireAdmin, asyncHandler(async (req, res) => {
    const { employee_id, year } = req.query;
    if (!employee_id || !year) return res.status(400).json({ error: 'employee_id and year required' });

    const [empRows] = await pool.query(
        'SELECT id FROM employees WHERE id = ? AND company_id = ?',
        [employee_id, req.user.companyId]
    );
    if (empRows.length === 0) return res.status(404).json({ error: 'Employee not found' });

    await pool.query('DELETE FROM leave_balances WHERE employee_id = ? AND year = ?', [employee_id, year]);
    return res.json({ message: 'Cleared' });
}));

module.exports = router;
