const pool = require('../db');
const asyncHandler = require('../utils/asyncHandler');

/**
 * Guards the internal license-generation panel (public/index.html and its
 * /license/admin/* and /panel/* routes). Deliberately separate from
 * verifyFirebaseToken - this is YOUR tool as the vendor, it must never be
 * reachable using a customer's admin login.
 *
 * migration_040: this used to be a single shared PANEL_SECRET checked
 * against `x-panel-key` - anyone with that one string had full access,
 * with no way to tell two people apart or revoke just one of them.
 * Replaced with real per-person accounts (`panel_admins`) + DB-backed
 * bearer sessions (`panel_sessions`), so:
 *   - revoking one person's access doesn't require rotating the secret
 *     everyone else also uses
 *   - every write action can be attributed to a named person in
 *     `panel_audit_log` (see routes/panelAdmins.js / routes/license.js)
 *   - a 'super_admin' can see everything an 'admin' does; an 'admin'
 *     cannot see or manage other panel_admins at all
 *
 * PANEL_SECRET is kept as a break-glass fallback ONLY - if
 * `x-panel-key` matches it, the caller is treated as an anonymous
 * super_admin (req.panelAdmin = null, req.panelRole = 'super_admin',
 * logged in the audit trail as panel_admin_id NULL). This exists so a
 * server is never permanently locked out if the panel_admins table is
 * ever empty or misconfigured - it is NOT meant for routine daily use
 * once real accounts exist. Rotate/retire PANEL_SECRET once your real
 * accounts are set up; don't hand it out like a normal login.
 *
 * Usage: `router.use(adminPanelAuth)` for "any panel account", or
 * `router.use(requireSuperAdmin)` for super_admin-only routes (see
 * routes/panelAdmins.js). Both are exported off the same module.
 */

/** Shared lookup, NOT wrapped in asyncHandler itself - both exported
 * middlewares wrap their own call to this so a thrown/rejected DB error
 * is always caught by whichever one is actually mounted on the route. */
async function resolvePanelCaller(req) {
    const bearer = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    const legacyKey = req.headers['x-panel-key'];

    if (bearer) {
        const [rows] = await pool.query(
            `SELECT s.panel_admin_id, a.role, a.status, a.name, a.email
             FROM panel_sessions s
             JOIN panel_admins a ON a.id = s.panel_admin_id
             WHERE s.token = ? AND s.expires_at > NOW()`,
            [bearer]
        );
        if (rows.length > 0 && rows[0].status === 'active') {
            return {
                ok: true,
                panelAdmin: { id: rows[0].panel_admin_id, name: rows[0].name, email: rows[0].email },
                role: rows[0].role,
            };
        }
        return { ok: false, status: 401, error: 'Session expired or invalid. Please log in again.' };
    }

    if (legacyKey && process.env.PANEL_SECRET && legacyKey === process.env.PANEL_SECRET) {
        return { ok: true, panelAdmin: null, role: 'super_admin' };
    }

    return { ok: false, status: 401, error: 'Unauthorized' };
}

const adminPanelAuth = asyncHandler(async function adminPanelAuth(req, res, next) {
    const result = await resolvePanelCaller(req);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    req.panelAdmin = result.panelAdmin;
    req.panelRole = result.role;
    return next();
});

const requireSuperAdmin = asyncHandler(async function requireSuperAdmin(req, res, next) {
    const result = await resolvePanelCaller(req);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    if (result.role !== 'super_admin') {
        return res.status(403).json({ error: 'Super admin access required' });
    }
    req.panelAdmin = result.panelAdmin;
    req.panelRole = result.role;
    return next();
});

module.exports = adminPanelAuth;
module.exports.requireSuperAdmin = requireSuperAdmin;
