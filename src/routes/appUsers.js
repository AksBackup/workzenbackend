const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);
router.use(requireAdmin);

/**
 * Add Users / Accessibility (migration_030). See that migration's
 * header comment for the important architectural note: this is CRUD +
 * permission storage only. There is no login/session flow here for an
 * app_user to actually sign in as themselves - that needs an auth
 * architecture decision this pass didn't have enough information to
 * make safely, so it's flagged rather than guessed at.
 */

router.get('/', asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        `SELECT u.id, u.employee_id, u.status, u.created_at, e.name AS employee_name, e.emp_code
         FROM app_users u
         JOIN employees e ON e.id = u.employee_id
         WHERE u.company_id = ?
         ORDER BY u.created_at DESC`,
        [req.user.companyId]
    );
    return res.json(rows);
}));

router.post('/', asyncHandler(async (req, res) => {
    const { employee_id, password } = req.body;
    if (!employee_id || !password || password.length < 6) {
        return res.status(400).json({ error: 'employee_id and a password (min 6 characters) are required' });
    }
    const [empRows] = await pool.query('SELECT id, emp_code FROM employees WHERE id = ? AND company_id = ?', [employee_id, req.user.companyId]);
    if (empRows.length === 0) return res.status(404).json({ error: 'Employee not found' });

    const [existing] = await pool.query('SELECT id FROM app_users WHERE employee_id = ?', [employee_id]);
    if (existing.length > 0) {
        return res.status(409).json({ error: 'This employee already has an app login. Use the reset-password action to change it.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
        'INSERT INTO app_users (company_id, employee_id, password_hash) VALUES (?, ?, ?)',
        [req.user.companyId, employee_id, passwordHash]
    );
    // Login id is the employee's own emp_code, per the client's request
    // ("id is emp id") - returned here so the admin can hand it to the
    // employee immediately.
    return res.status(201).json({ id: result.insertId, login_id: empRows[0].emp_code });
}));

router.post('/:id/reset-password', asyncHandler(async (req, res) => {
    const { password } = req.body;
    if (!password || password.length < 6) {
        return res.status(400).json({ error: 'password (min 6 characters) is required' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
        'UPDATE app_users SET password_hash = ? WHERE id = ? AND company_id = ?',
        [passwordHash, req.params.id, req.user.companyId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'App user not found' });
    return res.json({ message: 'Password reset' });
}));

router.put('/:id/status', asyncHandler(async (req, res) => {
    const { status } = req.body;
    if (!['active', 'disabled'].includes(status)) {
        return res.status(400).json({ error: "status must be 'active' or 'disabled'" });
    }
    await pool.query('UPDATE app_users SET status = ? WHERE id = ? AND company_id = ?', [status, req.params.id, req.user.companyId]);
    return res.json({ message: 'Updated' });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
    await pool.query(
        'DELETE FROM app_users WHERE id = ? AND company_id = ?',
        [req.params.id, req.user.companyId]
    );
    return res.json({ message: 'Deleted' });
}));

// --- Accessibility (per-tab permissions) ---

router.get('/:id/permissions', asyncHandler(async (req, res) => {
    const [userRows] = await pool.query('SELECT id FROM app_users WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    if (userRows.length === 0) return res.status(404).json({ error: 'App user not found' });
    const [rows] = await pool.query('SELECT tab_key, allowed FROM app_user_permissions WHERE app_user_id = ?', [req.params.id]);
    return res.json(rows);
}));

// Replaces the full permission set in one call - the Accessibility
// screen sends every tab's toggle state each time it saves, rather
// than one request per toggle.
router.put('/:id/permissions', asyncHandler(async (req, res) => {
    const { permissions } = req.body; // [{ tab_key, allowed }, ...]
    if (!Array.isArray(permissions)) {
        return res.status(400).json({ error: 'permissions must be an array of { tab_key, allowed }' });
    }
    const [userRows] = await pool.query('SELECT id FROM app_users WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    if (userRows.length === 0) return res.status(404).json({ error: 'App user not found' });

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query('DELETE FROM app_user_permissions WHERE app_user_id = ?', [req.params.id]);
        for (const p of permissions) {
            if (!p.tab_key) continue;
            await conn.query(
                'INSERT INTO app_user_permissions (app_user_id, tab_key, allowed) VALUES (?, ?, ?)',
                [req.params.id, p.tab_key, !!p.allowed]
            );
        }
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
    return res.json({ message: 'Permissions saved' });
}));

module.exports = router;
