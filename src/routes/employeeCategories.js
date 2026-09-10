const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Employee Categories (CONTEXT.md, Conditions > "Employee Categories /
 * multiple", migration_015). Same shape/pattern as departments.js and
 * designations.js - a plain admin-editable named list, referenced from
 * employees.category_id. Assigning a category to an employee happens
 * through the existing PUT /employees/:id (category_id was added to
 * that route's editable `fields` array), not here - this file is only
 * the category list's own CRUD.
 */

router.get('/', asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        'SELECT * FROM employee_categories WHERE company_id = ? ORDER BY name ASC',
        [req.user.companyId]
    );
    return res.json(rows);
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const [result] = await pool.query(
        'INSERT INTO employee_categories (company_id, name) VALUES (?, ?)',
        [req.user.companyId, name]
    );
    return res.status(201).json({ id: result.insertId, name });
}));

router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    await pool.query(
        'UPDATE employee_categories SET name = ? WHERE id = ? AND company_id = ?',
        [name, req.params.id, req.user.companyId]
    );
    return res.json({ message: 'Updated' });
}));

// Any employee in this category falls back to "uncategorized"
// automatically (ON DELETE SET NULL, migration_015) - the employee
// record itself is never touched.
router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM employee_categories WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json({ message: 'Deleted' });
}));

module.exports = router;
