const admin = require('firebase-admin');

/**
 * Platform (vendor-level) identity for the /admin and /254 web pages, the
 * Flutter admin login, and the screen-lock endpoints.
 *
 * A platform admin is a Firebase user whose UID is listed in an env var:
 *   - ADMIN_UIDS:        comma-separated UIDs, role 'admin'
 *   - SUPER_ADMIN_UIDS:  comma-separated UIDs, role 'super_admin' (has every
 *                        admin permission as well)
 * Only these UIDs are authorised. Customer company users (the custom
 * company_id / role claims checked by verifyFirebaseToken) are NOT platform
 * admins, even when their role claim is 'admin'.
 *
 * The env vars are read on every call, so editing them only needs a restart.
 */

function uidList(envName) {
    return String(process.env[envName] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

/** 'super_admin' | 'admin' | null for a Firebase UID. */
function platformRoleFor(uid) {
    if (!uid) return null;
    if (uidList('SUPER_ADMIN_UIDS').includes(uid)) return 'super_admin';
    if (uidList('ADMIN_UIDS').includes(uid)) return 'admin';
    return null;
}

/** The configured platform accounts, for the super admin's admin-management view. */
function configuredPlatformAdmins() {
    return [
        ...uidList('SUPER_ADMIN_UIDS').map((uid) => ({ uid, role: 'super_admin' })),
        ...uidList('ADMIN_UIDS')
            .filter((uid) => !uidList('SUPER_ADMIN_UIDS').includes(uid))
            .map((uid) => ({ uid, role: 'admin' })),
    ];
}

async function decodeBearer(req) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return { status: 401, error: 'Missing bearer token' };
    try {
        return { decoded: await admin.auth().verifyIdToken(token) };
    } catch (err) {
        return { status: 401, error: 'Invalid or expired token' };
    }
}

/**
 * Accepts EITHER a company user (company_id + role claims, same rules as
 * verifyFirebaseToken) OR a platform admin. Sets req.user for company users
 * and req.platform for platform admins. Used by read-only endpoints that
 * both kinds of user need (GET /lock-status).
 */
async function verifyCompanyOrPlatformToken(req, res, next) {
    const r = await decodeBearer(req);
    if (r.error) return res.status(r.status).json({ error: r.error });
    const d = r.decoded;
    const role = platformRoleFor(d.uid);
    if (d.company_id && d.role) {
        req.user = { uid: d.uid, companyId: d.company_id, role: d.role, email: d.email };
    }
    if (role) {
        req.platform = { uid: d.uid, email: d.email, role, companyId: d.company_id || null };
    }
    if (!req.user && !req.platform) {
        return res.status(403).json({ error: 'Account has no company_id/role claim set' });
    }
    return next();
}

/** Platform admins only (ADMIN_UIDS or SUPER_ADMIN_UIDS). Sets req.platform. */
async function verifyPlatformToken(req, res, next) {
    const r = await decodeBearer(req);
    if (r.error) return res.status(r.status).json({ error: r.error });
    const d = r.decoded;
    const role = platformRoleFor(d.uid);
    if (!role) return res.status(403).json({ error: 'Admin access required' });
    req.platform = { uid: d.uid, email: d.email, role, companyId: d.company_id || null };
    return next();
}

/** Must run after verifyPlatformToken. */
function requireSuperAdminPlatform(req, res, next) {
    if (!req.platform || req.platform.role !== 'super_admin') {
        return res.status(403).json({ error: 'Super admin access required' });
    }
    return next();
}

module.exports = {
    platformRoleFor,
    configuredPlatformAdmins,
    verifyCompanyOrPlatformToken,
    verifyPlatformToken,
    requireSuperAdminPlatform,
};
