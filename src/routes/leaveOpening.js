const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');
const { parseBalances, resolveEmployees, runBulkBalance } = require('../utils/leaveBalanceBulk');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Leave Balance Entry (bulk Addition / Deletion, desktop screen).
 * Endpoints: GET /leave-balances/bulk/employees and POST /leave-balances/bulk.
 * Both write through the same leave_balances.allocated + leave_adjustments
 * storage as Earn Leave, so Apply Leave, payroll and reports all agree.
 * Rules and filter semantics: utils/leaveBalanceBulk.js.
 */
function sendBulkError(res, err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    throw err;
}

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
//
// Bug fix found while wiring up the Android app's "My Leave" screen:
// this had NO role==='employee' restriction at all - unlike every other
// self-service-capable route in this backend (attendance, leaves,
// mobile-punches, field-tracking), an employee-role caller could pass
// any employee_id (or omit it) and read every employee's leave
// balances company-wide. Restricted the same way those routes already
// are: an employee-role token always forces employee_id to their own,
// ignoring/overriding whatever was in the query string.
router.get('/', asyncHandler(async (req, res) => {
    const { year } = req.query;
    let { employee_id } = req.query;
    const params = [req.user.companyId];

    if (req.user.role === 'employee') {
        const [rows] = await pool.query(
            'SELECT id FROM employees WHERE firebase_uid = ? AND company_id = ?',
            [req.user.uid, req.user.companyId]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Employee record not found' });
        employee_id = rows[0].id;
    }

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
// Also accepts employee_ids=1,2,3 to clear several employees at once (checkbox selection on the
// Leave Opening Entry list).
router.delete('/', requireAdmin, asyncHandler(async (req, res) => {
    const { employee_id, employee_ids, year } = req.query;
    const ids = (employee_ids ? String(employee_ids).split(',') : (employee_id ? [employee_id] : []))
        .map(x => Number(x)).filter(x => Number.isInteger(x) && x > 0);
    if (!ids.length || !year) return res.status(400).json({ error: 'employee_id (or employee_ids) and year required' });

    const [empRows] = await pool.query(
        'SELECT id FROM employees WHERE id IN (?) AND company_id = ?',
        [ids, req.user.companyId]
    );
    if (empRows.length === 0) return res.status(404).json({ error: 'Employee not found' });

    // Only employees of THIS company are touched (leave_balances has no company_id of its own).
    const [result] = await pool.query('DELETE FROM leave_balances WHERE employee_id IN (?) AND year = ?', [empRows.map(r => r.id), year]);
    return res.json({ message: 'Cleared', employees: empRows.length, rows_deleted: result.affectedRows });
}));

// GET /leave-balances/bulk/employees?filter=<JSON>
// The employees a Leave Balance Entry filter matches (active employees of this
// company only). filter = { companyIds, branchIds, departmentIds, designationIds,
// employeeIds }: a key left out (or null / "all") means "All"; an array means
// "Few" (only those ids). Passing no filter returns every active employee.
router.get('/bulk/employees', requireAdmin, asyncHandler(async (req, res) => {
    let filter = {};
    if (req.query.filter) {
        try {
            filter = JSON.parse(String(req.query.filter));
        } catch (_) {
            return res.status(400).json({ error: 'filter must be valid JSON' });
        }
    }
    try {
        const rows = await resolveEmployees(pool, req.user.companyId, filter);
        return res.json(rows.map(r => ({
            id: r.id,
            emp_code: r.emp_code,
            name: r.name,
            branch_id: r.branch_id,
            department_id: r.department_id,
            designation_id: r.designation_id,
        })));
    } catch (err) {
        return sendBulkError(res, err);
    }
}));

// POST /leave-balances/bulk
// body: {
//   year: 2026,
//   mode: 'add' | 'delete',                      // Addition / Deletion
//   period?: 'monthly' (default) | 'yearly',     // Balance type: per-month quota or annual pool
//   balances: { "<leave_type_id>": days, ... },  // zero entries are ignored
//   filter: { companyIds?, branchIds?, departmentIds?, designationIds?, employeeIds? },
//   reason?: "text for the audit trail",
//   dry_run?: true                               // count only, write nothing
// }
// 'add' credits every matched employee (allocated += days, audit 'earn').
// 'delete' removes up to `days` from each (allocated = max(0, allocated - days),
// audit 'adjust' with the amount actually removed). One transaction for the lot.
// Returns { mode, year, dry_run, employees_matched, affected_employees,
//           affected_balances, total_days, by_leave_type[] }.
router.post('/bulk', requireAdmin, asyncHandler(async (req, res) => {
    const { year, mode, period, balances, filter, reason, dry_run } = req.body || {};
    try {
        const parsed = parseBalances(balances);
        const [adminRows] = await pool.query('SELECT id FROM admins WHERE firebase_uid = ?', [req.user.uid]);
        const result = await runBulkBalance(pool, {
            companyId: req.user.companyId,
            adminId: adminRows[0] ? adminRows[0].id : null,
            year,
            mode,
            period: period === undefined ? 'monthly' : period,
            balances: parsed,
            filter,
            reason,
            dryRun: dry_run === true,
        });
        return res.json(result);
    } catch (err) {
        return sendBulkError(res, err);
    }
}));

module.exports = router;
