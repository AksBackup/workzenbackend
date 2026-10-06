const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Backs Shift Change (4.5), Generate Shift (4.6), and Shift Roaster
 * (4.7) - all three are really the same underlying table
 * (`shift_assignments`) viewed/written differently:
 *   - Shift Roaster: GET, a read-only calendar-style listing.
 *   - Generate Shift / Shift Change: POST, create or overwrite an
 *     employee's shift for a date range.
 *
 * IMPORTANT - shifts table assumption: `shift_id` here is expected to
 * reference Agent A's `shifts` table (id, name, start_time, end_time,
 * at minimum). That table's actual shape was not available in this
 * session (AGENT_A_MASTERS_DEVICES.md was not provided - only
 * FROZEN_CONTRACT_V2.md and this agent's own brief were). This route
 * does NOT validate shift_id against a `shifts` table at all (no JOIN,
 * no existence check) - it just stores whatever numeric id is posted.
 * Once Agent A's `shifts` table is confirmed and its migration has run,
 * this route should gain:
 *   1. A JOIN to `shifts` in the GET below (so responses include a
 *      shift name, not just shift_id).
 *   2. An existence check in POST /shift-assignments before insert.
 * Flagged explicitly in PASS_NOTES.md for the merge agent.
 */

// GET /shift-assignments?employee_id=&from=&to=
// Powers Shift Roaster (4.7). Joined with employees only (not shifts,
// per the note above) so the client at least gets a name/emp_code.
router.get('/', asyncHandler(async (req, res) => {
    const { employee_id, from, to } = req.query;
    const params = [req.user.companyId];
    let sql = `SELECT sa.*, e.name AS employee_name, e.emp_code AS employee_code
               FROM shift_assignments sa
               JOIN employees e ON e.id = sa.employee_id
               WHERE sa.company_id = ?`;

    if (employee_id) {
        sql += ' AND sa.employee_id = ?';
        params.push(employee_id);
    }
    // Overlap check: an assignment is "in range" if its own [from, to)
    // window overlaps the requested window at all (effective_to may be
    // NULL, meaning "still active").
    if (from) {
        sql += ' AND (sa.effective_to IS NULL OR sa.effective_to >= ?)';
        params.push(from);
    }
    if (to) {
        sql += ' AND sa.effective_from <= ?';
        params.push(to);
    }
    sql += ' ORDER BY sa.effective_from DESC, sa.id DESC, e.name ASC';

    const [rows] = await pool.query(sql, params);
    return res.json(rows);
}));

// POST /shift-assignments - single employee, used by both Shift Change
// (4.5) and, called in a loop client-side, Generate Shift (4.6)'s
// bulk/date-range case. body: { employee_id, shift_id, effective_from,
// effective_to? }
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { employee_id, shift_id, effective_from, effective_to } = req.body;
    if (!employee_id || !shift_id || !effective_from) {
        return res.status(400).json({ error: 'employee_id, shift_id, effective_from required' });
    }

    const [empRows] = await pool.query(
        'SELECT id FROM employees WHERE id = ? AND company_id = ?',
        [employee_id, req.user.companyId]
    );
    if (empRows.length === 0) return res.status(404).json({ error: 'Employee not found' });

    const [result] = await pool.query(
        `INSERT INTO shift_assignments (company_id, employee_id, shift_id, effective_from, effective_to)
         VALUES (?, ?, ?, ?, ?)`,
        [req.user.companyId, employee_id, shift_id, effective_from, effective_to || null]
    );
    return res.status(201).json({ id: result.insertId });
}));

// POST /shift-assignments/bulk - Shift Roster grid save.
// body: { cells: [{ employee_id, date: 'YYYY-MM-DD', shift_id: number|null }, ...] }
// One single-day row per (employee, date). A single-day row replaces any earlier single-day
// row for that cell; shift_id null just removes the single-day override (the employee falls
// back to their range assignment / their own shift).
router.post('/bulk', requireAdmin, asyncHandler(async (req, res) => {
    const cells = Array.isArray(req.body.cells) ? req.body.cells : null;
    if (!cells) return res.status(400).json({ error: 'cells (array) required' });
    if (cells.length > 20000) return res.status(400).json({ error: 'Too many cells in one save (max 20000)' });
    const companyId = req.user.companyId;
    const [emps] = await pool.query('SELECT id FROM employees WHERE company_id = ?', [companyId]);
    const [shifts] = await pool.query('SELECT id FROM shifts WHERE company_id = ?', [companyId]);
    const okEmp = new Set(emps.map((e) => e.id)), okShift = new Set(shifts.map((x) => x.id));
    const conn = await pool.getConnection();
    let saved = 0, cleared = 0;
    try {
        await conn.beginTransaction();
        for (const c of cells) {
            const eid = Number(c.employee_id), date = String(c.date || '');
            if (!okEmp.has(eid) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
            await conn.query(
                'DELETE FROM shift_assignments WHERE company_id = ? AND employee_id = ? AND effective_from = ? AND effective_to = ?',
                [companyId, eid, date, date]);
            if (c.shift_id == null) { cleared++; continue; }
            const sid = Number(c.shift_id);
            if (!okShift.has(sid)) continue;
            await conn.query(
                'INSERT INTO shift_assignments (company_id, employee_id, shift_id, effective_from, effective_to) VALUES (?, ?, ?, ?, ?)',
                [companyId, eid, sid, date, date]);
            saved++;
        }
        await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
    return res.json({ saved, cleared });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM shift_assignments WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json({ message: 'Deleted' });
}));

module.exports = router;
