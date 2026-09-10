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

module.exports = router;
