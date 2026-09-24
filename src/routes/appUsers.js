const express = require('express');
const bcrypt = require('bcryptjs');
const admin = require('firebase-admin');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

// GET /app-users/me/permissions - self-service, deliberately BEFORE
// router.use(requireAdmin) below so an app_user (who is never an
// admin) can call this about themselves. Everything after this point
// in the file IS admin-only (managing other app users).
router.get('/me/permissions', asyncHandler(async (req, res) => {
    if (req.user.role !== 'app_user') {
        // An admin calling this has no app_user row and no tab
        // restrictions - empty list, not an error, since the desktop
        // app's nav-filtering logic (home_shell.dart) only applies
        // this for role 'app_user' in the first place.
        return res.json([]);
    }
    const [rows] = await pool.query(
        `SELECT p.tab_key, p.allowed
         FROM app_user_permissions p
         JOIN app_users u ON u.id = p.app_user_id
         WHERE u.firebase_uid = ? AND u.company_id = ?`,
        [req.user.uid, req.user.companyId]
    );
    return res.json(rows);
}));

router.use(requireAdmin);

/**
 * Add Users / Accessibility (migration_030, migration_031). Login now
 * works end to end (migration_031 closed the gap migration_030's
 * comment flagged): each app_user gets a real Firebase Auth account,
 * synthetic email `au{id}@appuser.internal`, custom claims
 * { company_id, role: 'app_user' } - same pattern as an employee's
 * mobile login (routes/employees.js's POST /:id/login), and signs in
 * through POST /auth/app-user-login (routes/auth.js), which mirrors
 * POST /auth/employee-login exactly.
 *
 * STILL NOT DONE, flagged rather than guessed at: most existing routes
 * gate on `role === 'admin'` specifically (see requireAdmin in
 * verifyFirebaseToken.js). An app_user can now log in and get a valid
 * token, but will get 403 from any route that hasn't been updated to
 * also accept role 'app_user' - only this file's own routes, and
 * whatever else is explicitly noted as updated, currently do. Rolling
 * that out to every route a given Accessibility tab actually needs is
 * a route-by-route follow-up, not something safe to blanket-apply
 * (some admin routes genuinely should stay admin-only regardless of
 * tab access - e.g. this file's own user-management routes below).
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
    const [empRows] = await pool.query('SELECT id, name, emp_code FROM employees WHERE id = ? AND company_id = ?', [employee_id, req.user.companyId]);
    if (empRows.length === 0) return res.status(404).json({ error: 'Employee not found' });

    const [existing] = await pool.query('SELECT id FROM app_users WHERE employee_id = ?', [employee_id]);
    if (existing.length > 0) {
        return res.status(409).json({ error: 'This employee already has an app login. Use the reset-password action to change it.' });
    }

    // password_hash is kept for reference/consistency (migration_030)
    // but Firebase Auth is the actual source of truth for login,
    // exactly like employees.firebase_uid - see this file's header
    // comment.
    const passwordHash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
        'INSERT INTO app_users (company_id, employee_id, password_hash) VALUES (?, ?, ?)',
        [req.user.companyId, employee_id, passwordHash]
    );
    const appUserId = result.insertId;
    const generatedEmail = `au${appUserId}@appuser.internal`;
    try {
        const firebaseUser = await admin.auth().createUser({ email: generatedEmail, password, displayName: empRows[0].name });
        await admin.auth().setCustomUserClaims(firebaseUser.uid, { company_id: req.user.companyId, role: 'app_user', app_user_id: appUserId });
        await pool.query('UPDATE app_users SET firebase_uid = ? WHERE id = ?', [firebaseUser.uid, appUserId]);
    } catch (err) {
        // Roll back the app_users row rather than leave a login-less
        // "app user" record behind that Accessibility would show but
        // that can never actually sign in.
        await pool.query('DELETE FROM app_users WHERE id = ?', [appUserId]);
        return res.status(500).json({ error: 'Failed to create login', detail: err.message });
    }

    // Login id is the employee's own emp_code, per the client's request
    // ("id is emp id") - returned here so the admin can hand it to the
    // employee immediately.
    return res.status(201).json({ id: appUserId, login_id: empRows[0].emp_code });
}));

router.post('/:id/reset-password', asyncHandler(async (req, res) => {
    const { password } = req.body;
    if (!password || password.length < 6) {
        return res.status(400).json({ error: 'password (min 6 characters) is required' });
    }
    const [rows] = await pool.query('SELECT firebase_uid FROM app_users WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    if (rows.length === 0) return res.status(404).json({ error: 'App user not found' });
    if (rows[0].firebase_uid) {
        try {
            await admin.auth().updateUser(rows[0].firebase_uid, { password });
        } catch (err) {
            return res.status(500).json({ error: 'Failed to reset password', detail: err.message });
        }
    }
    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE app_users SET password_hash = ? WHERE id = ? AND company_id = ?', [passwordHash, req.params.id, req.user.companyId]);
    return res.json({ message: 'Password reset' });
}));

router.put('/:id/status', asyncHandler(async (req, res) => {
    const { status } = req.body;
    if (!['active', 'disabled'].includes(status)) {
        return res.status(400).json({ error: "status must be 'active' or 'disabled'" });
    }
    const [rows] = await pool.query('SELECT firebase_uid FROM app_users WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    if (rows.length === 0) return res.status(404).json({ error: 'App user not found' });
    if (rows[0].firebase_uid) {
        try {
            await admin.auth().updateUser(rows[0].firebase_uid, { disabled: status === 'disabled' });
        } catch (err) {
            return res.status(500).json({ error: 'Failed to update login status', detail: err.message });
        }
    }
    await pool.query('UPDATE app_users SET status = ? WHERE id = ? AND company_id = ?', [status, req.params.id, req.user.companyId]);
    return res.json({ message: 'Updated' });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
    const [rows] = await pool.query('SELECT firebase_uid FROM app_users WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    if (rows.length && rows[0].firebase_uid) {
        try {
            await admin.auth().deleteUser(rows[0].firebase_uid);
        } catch (err) {
            // Best-effort - a Firebase-side account already gone
            // (deleted manually, etc.) shouldn't block removing the
            // app_users row itself.
        }
    }
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
