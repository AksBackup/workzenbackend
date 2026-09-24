const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Salary Heads (migration_035) - REPLACES the old fixed Basic/HRA/
 * Conveyance/Special Allowance model (migration_029's
 * `salary_structures` table, see that table's now-stale comment) with a
 * free-form, PER-EMPLOYEE list of named "Addition Head" and "Deduction
 * Head" rows - the admin can type any head name they want (HRA, DA,
 * Bonus, Tea, Lunch...), and each employee's set of heads is entirely
 * independent of every other employee's.
 *
 * gross_salary = SUM(addition amounts) - SUM(deduction amounts), and
 * that figure is copied into employees.salary on every save - exactly
 * the same "this table is purely what feeds that field" relationship
 * migration_029 had. computeMonthlyPayroll (routes/payroll.js) keeps
 * reading employees.salary exactly as before and needed NO changes for
 * the monthly payroll run itself to keep working; it separately grew
 * its own employee-level statutory/OT override handling as part of the
 * same pass that added this file (see routes/payroll.js and
 * utils/overtime.js).
 */

// GET /salary-structures/:employeeId - this employee's addition/
// deduction heads, split into two arrays in whatever sort_order they
// were saved in, plus the gross_salary currently feeding payroll (kept
// in sync with employees.salary, not re-derived here, so this always
// matches what the last successful save actually wrote).
router.get('/:employeeId', requireAdmin, asyncHandler(async (req, res) => {
    const [empRows] = await pool.query(
        'SELECT id, salary FROM employees WHERE id = ? AND company_id = ?',
        [req.params.employeeId, req.user.companyId]
    );
    if (empRows.length === 0) return res.status(404).json({ error: 'Employee not found' });

    let heads = [];
    try {
        const [rows] = await pool.query(
            'SELECT id, head_type, head_name, amount, sort_order FROM salary_heads WHERE employee_id = ? AND company_id = ? ORDER BY head_type ASC, sort_order ASC, id ASC',
            [req.params.employeeId, req.user.companyId]
        );
        heads = rows;
    } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
        // migration_035 not applied yet - behave as if this employee
        // simply has no heads defined, same defensive fallback pattern
        // used elsewhere in this backend for not-yet-run migrations.
    }

    const addition = heads.filter(h => h.head_type === 'addition')
        .map(h => ({ id: h.id, head_name: h.head_name, amount: Number(h.amount), sort_order: h.sort_order }));
    const deduction = heads.filter(h => h.head_type === 'deduction')
        .map(h => ({ id: h.id, head_name: h.head_name, amount: Number(h.amount), sort_order: h.sort_order }));

    return res.json({
        addition,
        deduction,
        gross_salary: empRows[0].salary === null ? null : Number(empRows[0].salary),
    });
}));

// PUT /salary-structures/:employeeId
// body: { addition: [{head_name, amount}, ...], deduction: [{head_name, amount}, ...] }
// Full replace, same "evaluated as one complete set" reasoning as
// statutorySettings.js's PUT /pt-slabs - editing heads one at a time
// invites duplicate/renamed-but-orphaned rows for no benefit, since the
// whole point is the admin freely adding/renaming/removing named heads
// on this one screen.
router.put('/:employeeId', requireAdmin, asyncHandler(async (req, res) => {
    const { addition, deduction } = req.body;
    if (!Array.isArray(addition) || !Array.isArray(deduction)) {
        return res.status(400).json({ error: 'addition and deduction must both be arrays' });
    }

    const [empRows] = await pool.query('SELECT id FROM employees WHERE id = ? AND company_id = ?', [req.params.employeeId, req.user.companyId]);
    if (empRows.length === 0) return res.status(404).json({ error: 'Employee not found' });

    const cleanHeads = [];
    let additionTotal = 0;
    let deductionTotal = 0;
    for (const [type, list, addTo] of [['addition', addition, v => (additionTotal += v)], ['deduction', deduction, v => (deductionTotal += v)]]) {
        list.forEach((h, idx) => {
            const name = String(h?.head_name ?? '').trim();
            const amount = Number(h?.amount) || 0;
            if (!name) return; // silently skip blank rows (e.g. an empty "add new head" row not filled in)
            if (amount < 0) throw Object.assign(new Error(`${type} head "${name}" amount must not be negative`), { status: 400 });
            addTo(amount);
            cleanHeads.push({ type, name, amount, sortOrder: idx });
        });
    }

    const gross = additionTotal - deductionTotal;

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query('DELETE FROM salary_heads WHERE employee_id = ? AND company_id = ?', [req.params.employeeId, req.user.companyId]);
        for (const h of cleanHeads) {
            await conn.query(
                `INSERT INTO salary_heads (company_id, employee_id, head_type, head_name, amount, sort_order)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [req.user.companyId, req.params.employeeId, h.type, h.name, h.amount, h.sortOrder]
            );
        }
        // The one line that actually feeds payroll - same as
        // migration_029's version of this file did.
        await conn.query('UPDATE employees SET salary = ? WHERE id = ? AND company_id = ?', [gross, req.params.employeeId, req.user.companyId]);
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        if (err.status === 400) return res.status(400).json({ error: err.message });
        throw err;
    } finally {
        conn.release();
    }
    return res.json({ message: 'Salary heads saved', gross_salary: gross, addition_total: additionTotal, deduction_total: deductionTotal });
}));

module.exports = router;
