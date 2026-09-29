const admin = require('firebase-admin');
const pool = require('../db');

/**
 * Verifies the Firebase ID token on every protected route and attaches
 * { uid, companyId, role, email } to req.user.
 *
 * This is the ONLY tenant isolation this schema has (MySQL has no RLS).
 * Every route handler MUST filter its queries by req.user.companyId -
 * never by a company_id supplied in the request body/query string.
 */
async function verifyFirebaseToken(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
        return res.status(401).json({ error: 'Missing bearer token' });
    }

    try {
        const decoded = await admin.auth().verifyIdToken(token);
        const companyId = decoded.company_id;
        const role = decoded.role;

        if (!companyId || !role) {
            return res.status(403).json({ error: 'Account has no company_id/role claim set' });
        }

        req.user = {
            uid: decoded.uid,
            companyId,
            role,
            email: decoded.email
        };
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

// Which Accessibility tab_keys (app_user_permissions) unlock which route
// group for an app_user. An app_user passes requireAdmin on a mapped
// route only if at least one of its tabs is allowed. Routes NOT listed
// here fall back to "any allowed tab". Truly admin-only routes use
// requireAdminOnly instead.
const ROUTE_TABS = {
    '/employees': ['employees'],
    '/attendance': ['attendance', 'daily_report', 'monthly_report'],
    '/leave-applications': ['leave'],
    '/leave-types': ['leave_types'],
    '/leave-balances': ['leave_opening'],
    '/leave-adjustments': ['leave_adjustment'],
    '/shifts': ['shift_roaster', 'shift_change', 'generate_shift'],
    '/shift-assignments': ['shift_roaster', 'shift_change', 'generate_shift'],
    '/manual-punches': ['manual_punch', 'bulk_manual_punch', 'approval_manual_punch'],
    '/mobile-punches': ['mobile_punch_approval'],
    '/raw-punches': ['raw_punches'],
    '/field-tracking': ['field_tracking'],
    '/geofence-zones': ['field_tracking'],
    '/visitors': ['visitor_management'],
    '/canteen': ['canteen_management'],
    '/loans': ['loans'],
    '/payroll': ['payroll', 'salary_report'],
    '/salary-structures': ['salary_structure'],
    '/ad-hoc-payments': ['ad_hoc_payment'],
    '/bonuses': ['bonus_payroll'],
    '/conveyance': ['conveyance'],
    '/overtime': ['overtime_report', 'attendance'],
    '/reports': ['daily_report', 'monthly_report', 'old_monthly_report', 'missed_punch_report', 'weekly_report', 'na_shift_report', 'late_early_report', 'overtime_report', 'salary_report'],
    '/devices': ['device_connect', 'add_edit_machine', 'download_logs', 'device_users', 'device_admin'],
};

const permCache = new Map(); // uid -> { at, allowed:Set }
async function allowedTabs(user) {
    const hit = permCache.get(user.uid);
    if (hit && Date.now() - hit.at < 30000) return hit.allowed;
    const [rows] = await pool.query(
        `SELECT p.tab_key FROM app_user_permissions p
         JOIN app_users u ON u.id = p.app_user_id
         WHERE u.firebase_uid = ? AND u.company_id = ? AND u.status = 'active' AND p.allowed = TRUE`,
        [user.uid, user.companyId]
    );
    const allowed = new Set(rows.map((r) => r.tab_key));
    permCache.set(user.uid, { at: Date.now(), allowed });
    return allowed;
}

// Admin OR an app_user whose Accessibility grants the matching tab.
async function requireAdmin(req, res, next) {
    try {
        if (!req.user) return res.status(403).json({ error: 'Admin access required' });
        if (req.user.role === 'admin') return next();
        if (req.user.role === 'app_user') {
            const allowed = await allowedTabs(req.user);
            const need = ROUTE_TABS[req.baseUrl];
            const ok = need ? need.some((t) => allowed.has(t)) : allowed.size > 0;
            if (ok) return next();
        }
        return res.status(403).json({ error: 'Admin access required' });
    } catch (err) {
        next(err);
    }
}

// Strictly company admins (user management, backup, licence...).
function requireAdminOnly(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

// True for anyone who should see company-wide data (not just self).
const isStaff = (user) => !!user && (user.role === 'admin' || user.role === 'app_user');

// Company-level feature lock (companies.feature_flags, set from the
// vendor panel). Server-side twin of the desktop app's nav lock, so a
// locked company cannot reach the routes even by calling the API.
function requireFeature(flag) {
    return async (req, res, next) => {
        try {
            const [rows] = await pool.query('SELECT feature_flags FROM companies WHERE id = ?', [req.user.companyId]);
            let flags = rows[0] && rows[0].feature_flags;
            if (typeof flags === 'string') { try { flags = JSON.parse(flags); } catch (_) { flags = {}; } }
            if (flags && flags[flag] === false) {
                return res.status(403).json({ error: 'This feature is locked for your company. Contact support to enable it.' });
            }
            next();
        } catch (err) { next(err); }
    };
}

module.exports = { requireFeature, verifyFirebaseToken, requireAdmin, requireAdminOnly, isStaff };
