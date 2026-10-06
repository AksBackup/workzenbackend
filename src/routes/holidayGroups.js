const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Holiday Groups (CONTEXT.md, Conditions > "Add Holiday / Create
 * Holiday Group", migration_015). A group is just a name a set of
 * holidays and a set of branches can both point at - GET /holidays
 * itself is unchanged by this file; branches.js and holidays.js each
 * gained a `holiday_group_id` column they can filter/assign against,
 * this file is purely the CRUD for the groups themselves.
 */

router.get('/', asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        'SELECT * FROM holiday_groups WHERE company_id = ? ORDER BY name ASC',
        [req.user.companyId]
    );
    return res.json(rows);
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const [result] = await pool.query(
        'INSERT INTO holiday_groups (company_id, name) VALUES (?, ?)',
        [req.user.companyId, name]
    );
    return res.status(201).json({ id: result.insertId, name });
}));

router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    await pool.query(
        'UPDATE holiday_groups SET name = ? WHERE id = ? AND company_id = ?',
        [name, req.params.id, req.user.companyId]
    );
    return res.json({ message: 'Updated' });
}));

// DELETE - any holiday or branch pointed at this group falls back to
// "ungrouped/company-wide" automatically (ON DELETE SET NULL on both
// FKs, migration_015), it does not delete the holidays or branches
// themselves.
router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM holiday_groups WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json({ message: 'Deleted' });
}));

// ---------------------------------------------------------------------------
// Holiday Group screen v2 (migration_044): a group owns its holidays AND an
// explicit list of employees. An employee's own holiday_group_id wins over the
// group of their branch (see utils/attendanceRules.js loadEmployeeHolidayGroups).
// ---------------------------------------------------------------------------

// GET /holiday-groups/employee-assignments - every employee + their explicit group + their branch's group
router.get('/employee-assignments', asyncHandler(async (req, res) => {
    let rows;
    try {
        [rows] = await pool.query(
            `SELECT e.id, e.emp_code, e.name, e.department, e.status, e.holiday_group_id,
                    b.name AS branch_name, b.holiday_group_id AS branch_holiday_group_id
             FROM employees e LEFT JOIN branches b ON b.id = e.branch_id
             WHERE e.company_id = ? ORDER BY CAST(e.emp_code AS UNSIGNED), e.name`, [req.user.companyId]);
    } catch (err) {
        if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
        return res.status(500).json({ error: 'Run migration_044_multi_shift_holiday_group.sql first (employees.holiday_group_id is missing).' });
    }
    return res.json(rows);
}));

// GET /holiday-groups/:id/holidays
router.get('/:id/holidays', asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        'SELECT id, date, name, type, holiday_group_id FROM holidays WHERE company_id = ? AND holiday_group_id = ? ORDER BY date ASC',
        [req.user.companyId, req.params.id]);
    return res.json(rows);
}));

// POST /holiday-groups/:id/holidays  { date, name, type? }  - also accepts { holidays: [{date,name,type}, ...] }
router.post('/:id/holidays', requireAdmin, asyncHandler(async (req, res) => {
    const list = Array.isArray(req.body.holidays) ? req.body.holidays : [req.body];
    const [g] = await pool.query('SELECT id FROM holiday_groups WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    if (g.length === 0) return res.status(404).json({ error: 'Holiday group not found' });
    let added = 0;
    for (const h of list) {
        if (!h || !h.date || !h.name || !/^\d{4}-\d{2}-\d{2}$/.test(String(h.date))) {
            return res.status(400).json({ error: 'Every holiday needs a name and a date (YYYY-MM-DD)' });
        }
        const [dup] = await pool.query(
            'SELECT id FROM holidays WHERE company_id = ? AND holiday_group_id = ? AND date = ?',
            [req.user.companyId, req.params.id, h.date]);
        if (dup.length) continue; // same date already in this group
        await pool.query(
            'INSERT INTO holidays (company_id, date, name, type, holiday_group_id) VALUES (?, ?, ?, ?, ?)',
            [req.user.companyId, h.date, h.name, h.type || 'festival', req.params.id]);
        added++;
    }
    return res.status(201).json({ added });
}));

// PUT /holiday-groups/:id/members  { employee_ids: [..] }
// Replaces the group's explicit membership: listed employees join, employees that
// were in the group but are not listed fall back to their branch's group.
router.put('/:id/members', requireAdmin, asyncHandler(async (req, res) => {
    const ids = Array.isArray(req.body.employee_ids) ? req.body.employee_ids.map(Number).filter(Number.isInteger) : null;
    if (!ids) return res.status(400).json({ error: 'employee_ids (array) required' });
    const [g] = await pool.query('SELECT id FROM holiday_groups WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    if (g.length === 0) return res.status(404).json({ error: 'Holiday group not found' });
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        if (ids.length) {
            await conn.query('UPDATE employees SET holiday_group_id = NULL WHERE company_id = ? AND holiday_group_id = ? AND id NOT IN (?)',
                [req.user.companyId, req.params.id, ids]);
            await conn.query('UPDATE employees SET holiday_group_id = ? WHERE company_id = ? AND id IN (?)',
                [req.params.id, req.user.companyId, ids]);
        } else {
            await conn.query('UPDATE employees SET holiday_group_id = NULL WHERE company_id = ? AND holiday_group_id = ?',
                [req.user.companyId, req.params.id]);
        }
        await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
    return res.json({ message: 'Members updated', count: ids.length });
}));

module.exports = router;
