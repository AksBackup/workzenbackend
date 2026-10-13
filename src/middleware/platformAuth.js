const admin = require('firebase-admin');
const pool = require('../db');

/**
 * Platform (vendor-level) identity for the /admin and /254 web pages, the
 * Flutter admin login, and the screen-lock endpoints.
 *
 * A platform admin is a Firebase user whose UID is listed in an env var:
 *   - ADMIN_UIDS:        comma-separated UIDs, role 'admin'
 *   - SUPER_ADMIN_UIDS:  comma-separated UIDs, role 'super_admin' (has every
 *                        admin permission as well)
 * Extra 'admin' accounts created from the /254 Panel Admins tab live in the
 * platform_admins table (migration_052); an active row there also makes a UID
 * an 'admin'. super_admin can ONLY come from SUPER_ADMIN_UIDS. A row with
 * status 'disabled' blocks an admin UID even when it is also in ADMIN_UIDS.
 * Only these UIDs are authorised. Customer company users (the custom
 * company_id / role claims checked by verifyFirebaseToken) are NOT platform
 * admins, even when their role claim is 'admin'.
 *
 * The env vars are read on every call, so editing them only needs a restart.
 * (platformRoleFor below is the synchronous, env-only check kept for
 * middleware/screenLock.js; the token middlewares use the async lookup.)
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

/**
 * Role for a UID including the DB table. Returns
 * { role: 'super_admin'|'admin'|null, disabled: boolean, row }.
 * A missing platform_admins table (migration_052 not applied) is treated as
 * "no rows", so the env lists keep working.
 */
async function resolvePlatformIdentity(uid) {
    if (!uid) return { role: null, disabled: false, row: null };
    if (uidList('SUPER_ADMIN_UIDS').includes(uid)) return { role: 'super_admin', disabled: false, row: null };
    const inEnv = uidList('ADMIN_UIDS').includes(uid);
    let row = null;
    try {
        const [rows] = await pool.query(
            'SELECT firebase_uid, email, name, role, status FROM platform_admins WHERE firebase_uid = ?',
            [uid]
        );
        row = rows[0] || null;
    } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE' && err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    }
    if (row && row.status !== 'active') return { role: null, disabled: true, row };
    if (inEnv || row) return { role: 'admin', disabled: false, row };
    return { role: null, disabled: false, row: null };
}

async function resolvePlatformRole(uid) {
    return (await resolvePlatformIdentity(uid)).role;
}

/**
 * Verifies the bearer token and maps it to a platform account.
 * -> { ok: true, platform: { uid, email, name, role, companyId } }
 *  | { ok: false, status, error }   (401 bad token, 403 not/disabled admin)
 */
async function authenticatePlatform(req) {
    const r = await decodeBearer(req);
    if (r.error) return { ok: false, status: r.status, error: r.error };
    const d = r.decoded;
    const id = await resolvePlatformIdentity(d.uid);
    if (id.disabled) return { ok: false, status: 403, error: 'This admin account has been disabled.' };
    if (!id.role) return { ok: false, status: 403, error: 'Admin access required' };
    return {
        ok: true,
        platform: {
            uid: d.uid,
            email: d.email || (id.row && id.row.email) || null,
            name: d.name || (id.row && id.row.name) || null,
            role: id.role,
            companyId: d.company_id || null,
        },
    };
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
    try {
        const r = await decodeBearer(req);
        if (r.error) return res.status(r.status).json({ error: r.error });
        const d = r.decoded;
        const role = await resolvePlatformRole(d.uid);
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
    } catch (err) {
        return next(err);
    }
}

/** Platform admins only (SUPER_ADMIN_UIDS, ADMIN_UIDS or active platform_admins row). Sets req.platform. */
async function verifyPlatformToken(req, res, next) {
    try {
        const r = await authenticatePlatform(req);
        if (!r.ok) return res.status(r.status).json({ error: r.error });
        req.platform = r.platform;
        return next();
    } catch (err) {
        return next(err);
    }
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
    resolvePlatformRole,
    resolvePlatformIdentity,
    authenticatePlatform,
    verifyCompanyOrPlatformToken,
    verifyPlatformToken,
    requireSuperAdminPlatform,
};
