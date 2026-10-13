const pool = require('../db');
const { resolvePlatformRole } = require('./platformAuth');

/**
 * Company-wide lock for the payroll, salary, statutory, payment-window,
 * bonus, loan, ad-hoc payment, conveyance, geofence and field-tracking
 * features. Stored in the screen_locks table (migration_048).
 *
 * LOCKED BY DEFAULT: a company with no row for LOCK_KEY is locked. A
 * query error also fails closed (the error reaches the error handler, so
 * the request is refused and never falls through to the route).
 *
 * Only platform admins (ADMIN_UIDS / SUPER_ADMIN_UIDS) pass the gate.
 * Customer company admins are locked out like everyone else.
 */
const LOCK_KEY = 'payroll_geofence';
const LOCKED_MESSAGE = 'Payroll and geofence features are locked for your company. Contact your software provider to unlock them.';

async function readLock(companyId) {
    const [rows] = await pool.query(
        `SELECT locked, updated_by_email, updated_at FROM screen_locks
         WHERE company_id = ? AND lock_key = ?`,
        [companyId, LOCK_KEY]
    );
    if (rows.length === 0) {
        return { locked: true, updated_by_email: null, updated_at: null, is_default: true };
    }
    return {
        locked: !!rows[0].locked,
        updated_by_email: rows[0].updated_by_email || null,
        updated_at: rows[0].updated_at || null,
        is_default: false,
    };
}

/** Mount AFTER verifyFirebaseToken (it needs req.user). */
async function requireUnlocked(req, res, next) {
    try {
        if (!req.user) return res.status(403).json({ error: 'Admin access required' });
        if (await resolvePlatformRole(req.user.uid)) return next();
        const lock = await readLock(req.user.companyId);
        if (lock.locked) {
            return res.status(403).json({ error: LOCKED_MESSAGE, locked: true });
        }
        return next();
    } catch (err) {
        return next(err);
    }
}

module.exports = { requireUnlocked, readLock, LOCK_KEY, LOCKED_MESSAGE };
