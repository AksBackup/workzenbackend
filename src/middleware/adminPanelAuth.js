const asyncHandler = require('../utils/asyncHandler');
const { authenticatePlatform } = require('./platformAuth');

/**
 * Guards the vendor endpoints (/license/admin/* and /panel/*) used by the
 * /admin and /254 consoles.
 *
 * Authentication is Firebase ONLY: a valid Firebase ID token (Bearer) whose
 * uid is a platform admin, i.e. in SUPER_ADMIN_UIDS (role 'super_admin'),
 * in ADMIN_UIDS or an active row in platform_admins (role 'admin'). The
 * legacy login (panel_sessions), the PANEL_SECRET / x-panel-key break-glass
 * and customer company tokens can NOT reach these routes.
 *
 *   no / invalid token            -> 401
 *   valid token, not a platform uid, or disabled -> 403
 *   plain admin on a super-only route            -> 403
 *
 * Sets req.platform = { uid, email, name, role }. req.panelAdmin is always
 * null (it referred to the legacy panel_admins table).
 *
 * Usage: `router.use(adminPanelAuth)` for "any platform admin"; add
 * `requireSuperAdmin` per route for super-only routes. requireSuperAdmin
 * also authenticates by itself when it is mounted alone.
 */
async function guard(req, res, next, superOnly) {
    if (!req.platform) {
        const r = await authenticatePlatform(req);
        if (!r.ok) return res.status(r.status).json({ error: r.error });
        req.platform = r.platform;
    }
    req.panelAdmin = null;
    req.panelRole = req.platform.role;
    if (superOnly && req.platform.role !== 'super_admin') {
        return res.status(403).json({ error: 'Super admin access required' });
    }
    return next();
}

const adminPanelAuth = asyncHandler((req, res, next) => guard(req, res, next, false));
const requireSuperAdmin = asyncHandler((req, res, next) => guard(req, res, next, true));

module.exports = adminPanelAuth;
module.exports.requireSuperAdmin = requireSuperAdmin;
