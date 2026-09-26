const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const adminPanelAuth = require('../middleware/adminPanelAuth');
const { requireSuperAdmin } = adminPanelAuth;
const asyncHandler = require('../utils/asyncHandler');
const { logPanelAction } = require('../utils/panelAudit');

const router = express.Router();

const SESSION_TTL_HOURS = 12;

/**
 * POST /panel/login - the two-tier backend admin login. Deliberately
 * NOT behind adminPanelAuth (no session exists yet, same "public by
 * omission" pattern as routes/license.js's POST /activate and
 * routes/auth.js's employee login).
 *
 * body: { email, password }
 * response: { token, expires_at, admin: { id, name, email, role } }
 */
router.post('/login', asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'email and password are required' });
    }
    const [rows] = await pool.query(
        'SELECT id, email, password_hash, name, role, status FROM panel_admins WHERE email = ?',
        [String(email).trim().toLowerCase()]
    );
    // Same message whether the email doesn't exist or the password is
    // wrong - distinguishing the two would let someone probe which
    // panel-admin emails are real, same reasoning as auth.js.
    if (rows.length === 0) {
        return res.status(401).json({ error: 'Incorrect email or password.' });
    }
    const account = rows[0];
    if (account.status !== 'active') {
        return res.status(403).json({ error: 'This account has been disabled.' });
    }
    const match = await bcrypt.compare(password, account.password_hash);
    if (!match) {
        return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000);
    await pool.query(
        'INSERT INTO panel_sessions (token, panel_admin_id, expires_at) VALUES (?, ?, ?)',
        [token, account.id, expiresAt]
    );

    return res.json({
        token,
        expires_at: expiresAt,
        admin: { id: account.id, name: account.name, email: account.email, role: account.role },
    });
}));

router.use(adminPanelAuth);

// POST /panel/logout - invalidate just this one session (not every
// session this account might have open elsewhere).
router.post('/logout', asyncHandler(async (req, res) => {
    const bearer = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (bearer) await pool.query('DELETE FROM panel_sessions WHERE token = ?', [bearer]);
    return res.json({ message: 'Logged out' });
}));

// GET /panel/me - whoever's session/key this is. Works for the
// PANEL_SECRET break-glass path too (req.panelAdmin is null there).
router.get('/me', asyncHandler(async (req, res) => {
    return res.json({
        admin: req.panelAdmin,
        role: req.panelRole,
        via: req.panelAdmin ? 'account' : 'legacy_panel_secret',
    });
}));

// GET /panel/audit-log - super_admin only. "another is super admin,
// who can see what backend admin is doing" - this is that screen's
// data source. Newest first, capped so one query can't be used to
// pull the entire history as one giant unpaginated blob.
router.get('/audit-log', requireSuperAdmin, asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const [rows] = await pool.query(
        `SELECT l.id, l.action, l.target_type, l.target_id, l.detail, l.created_at,
                a.name AS panel_admin_name, a.email AS panel_admin_email
         FROM panel_audit_log l
         LEFT JOIN panel_admins a ON a.id = l.panel_admin_id
         ORDER BY l.created_at DESC
         LIMIT ?`,
        [limit]
    );
    return res.json(rows);
}));

// GET /panel/companies - super_admin only. "see all user/company
// details, like company name, how many employees they have, other
// relevant details". Deliberately a read-only aggregate view, no
// per-employee PII beyond the count.
router.get('/companies', requireSuperAdmin, asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        `SELECT c.id, c.name, c.company_code, c.status, c.feature_flags, c.created_at,
                a.name AS admin_name, a.email AS admin_email,
                (SELECT COUNT(*) FROM employees e WHERE e.company_id = c.id AND e.status = 'active') AS active_employee_count,
                (SELECT COUNT(*) FROM licenses l WHERE l.company_id = c.id) AS license_count,
                (SELECT COUNT(*) FROM licenses l WHERE l.company_id = c.id AND l.status = 'active') AS active_license_count
         FROM companies c
         LEFT JOIN admins a ON a.company_id = c.id
         ORDER BY c.created_at DESC`
    );
    return res.json(rows);
}));

// ---- Managing panel_admins accounts (super_admin only) ----

router.get('/admins', requireSuperAdmin, asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        'SELECT id, email, name, role, status, created_at FROM panel_admins ORDER BY created_at ASC'
    );
    return res.json(rows);
}));

router.post('/admins', requireSuperAdmin, asyncHandler(async (req, res) => {
    const { email, password, name, role } = req.body;
    if (!email || !password || !name) {
        return res.status(400).json({ error: 'email, password, and name are required' });
    }
    if (password.length < 8) {
        return res.status(400).json({ error: 'password must be at least 8 characters (this account can generate/revoke real customer licenses)' });
    }
    const finalRole = role === 'super_admin' ? 'super_admin' : 'admin';
    const passwordHash = await bcrypt.hash(password, 10);
    try {
        const [result] = await pool.query(
            'INSERT INTO panel_admins (email, password_hash, name, role) VALUES (?, ?, ?, ?)',
            [String(email).trim().toLowerCase(), passwordHash, name, finalRole]
        );
        await logPanelAction(req, 'create_panel_admin', 'panel_admin', result.insertId, { email, role: finalRole });
        return res.status(201).json({ id: result.insertId });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'A panel account with this email already exists' });
        }
        throw err;
    }
}));

// PUT /panel/admins/:id/status - disable/re-enable another account.
// A super_admin cannot disable their own only account this way in the
// same breath as removing every super_admin - checked below - to avoid
// a fat-fingered click locking everyone out of the panel entirely.
router.put('/admins/:id/status', requireSuperAdmin, asyncHandler(async (req, res) => {
    const { status } = req.body;
    if (!['active', 'disabled'].includes(status)) {
        return res.status(400).json({ error: "status must be 'active' or 'disabled'" });
    }
    if (status === 'disabled') {
        const [[{ activeSuperAdmins }]] = await pool.query(
            `SELECT COUNT(*) AS activeSuperAdmins FROM panel_admins WHERE role = 'super_admin' AND status = 'active' AND id != ?`,
            [req.params.id]
        );
        const [[target]] = await pool.query('SELECT role FROM panel_admins WHERE id = ?', [req.params.id]);
        if (target && target.role === 'super_admin' && activeSuperAdmins === 0) {
            return res.status(409).json({ error: 'Cannot disable the last active super admin.' });
        }
    }
    await pool.query('UPDATE panel_admins SET status = ? WHERE id = ?', [status, req.params.id]);
    if (status === 'disabled') {
        // Kill any live sessions immediately rather than waiting for them to expire.
        await pool.query(
            'DELETE FROM panel_sessions WHERE panel_admin_id = ?',
            [req.params.id]
        );
    }
    await logPanelAction(req, 'set_panel_admin_status', 'panel_admin', req.params.id, { status });
    return res.json({ message: 'Updated' });
}));

router.post('/admins/:id/reset-password', requireSuperAdmin, asyncHandler(async (req, res) => {
    const { password } = req.body;
    if (!password || password.length < 8) {
        return res.status(400).json({ error: 'password must be at least 8 characters' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE panel_admins SET password_hash = ? WHERE id = ?', [passwordHash, req.params.id]);
    await pool.query('DELETE FROM panel_sessions WHERE panel_admin_id = ?', [req.params.id]);
    await logPanelAction(req, 'reset_panel_admin_password', 'panel_admin', req.params.id, {});
    return res.json({ message: 'Password reset. That account has been signed out everywhere.' });
}));

module.exports = router;
