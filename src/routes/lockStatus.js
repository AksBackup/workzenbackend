const express = require('express');
const pool = require('../db');
const asyncHandler = require('../utils/asyncHandler');
const {
    configuredPlatformAdmins,
    verifyCompanyOrPlatformToken,
    verifyPlatformToken,
    requireSuperAdminPlatform,
} = require('../middleware/platformAuth');
const { readLock, LOCK_KEY } = require('../middleware/screenLock');

/*
 * GET  /lock-status              any company user (own company) or platform admin
 *                                (?company_id= to pick another company)
 * POST /lock-status              platform admins only
 *                                body: { locked: boolean, company_id?: number }
 *
 * Mounted at /lock-status. The /platform router (mounted at /platform)
 * serves the web admin pages: who am I, the company lock list, and the
 * configured admin accounts (super admin only).
 *
 * Locking applies to every company user, including the company's own
 * admins. Only platform UIDs can change it.
 */
const lockStatusRouter = express.Router();

function lockPayload(companyId, companyName, lock, platform) {
    return {
        company_id: Number(companyId),
        company_name: companyName || null,
        lock_key: LOCK_KEY,
        locked: lock.locked,
        is_default: lock.is_default,
        updated_by_email: lock.updated_by_email,
        updated_at: lock.updated_at,
        can_change: !!platform,
        role: platform ? platform.role : null,
    };
}

async function companyExists(companyId) {
    const [rows] = await pool.query('SELECT id, name FROM companies WHERE id = ?', [companyId]);
    return rows[0] || null;
}

lockStatusRouter.get('/', verifyCompanyOrPlatformToken, asyncHandler(async (req, res) => {
    // Company users always see their own company. Only platform admins may name another one.
    const companyId = req.platform && req.query.company_id ? req.query.company_id : (req.user && req.user.companyId);
    if (!companyId) return res.status(400).json({ error: 'company_id is required' });
    const company = await companyExists(companyId);
    if (!company) return res.status(404).json({ error: 'Company not found' });
    const lock = await readLock(company.id);
    return res.json(lockPayload(company.id, company.name, lock, req.platform));
}));

lockStatusRouter.post('/', verifyPlatformToken, asyncHandler(async (req, res) => {
    const { locked, company_id } = req.body || {};
    if (typeof locked !== 'boolean') {
        return res.status(400).json({ error: 'locked (true or false) is required' });
    }
    const companyId = company_id || req.platform.companyId;
    if (!companyId) return res.status(400).json({ error: 'company_id is required' });
    const company = await companyExists(companyId);
    if (!company) return res.status(404).json({ error: 'Company not found' });

    await pool.query(
        `INSERT INTO screen_locks (company_id, lock_key, locked, updated_by_uid, updated_by_email)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE locked = VALUES(locked),
                                 updated_by_uid = VALUES(updated_by_uid),
                                 updated_by_email = VALUES(updated_by_email)`,
        [company.id, LOCK_KEY, locked ? 1 : 0, req.platform.uid, req.platform.email || null]
    );
    const lock = await readLock(company.id);
    return res.json(lockPayload(company.id, company.name, lock, req.platform));
}));

const platformRouter = express.Router();

// Who is signed in as a platform admin. Used by the web pages and by the Flutter admin login.
platformRouter.get('/me', verifyPlatformToken, (req, res) => {
    return res.json({
        uid: req.platform.uid,
        email: req.platform.email || null,
        role: req.platform.role,
        company_id: req.platform.companyId,
    });
});

// Every company with its lock state (a company with no row is locked).
platformRouter.get('/companies', verifyPlatformToken, asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        `SELECT c.id, c.name, COALESCE(sl.locked, 1) AS locked, sl.updated_by_email, sl.updated_at
         FROM companies c
         LEFT JOIN screen_locks sl ON sl.company_id = c.id AND sl.lock_key = ?
         ORDER BY c.name`,
        [LOCK_KEY]
    );
    return res.json(rows.map((r) => ({
        company_id: Number(r.id),
        company_name: r.name,
        locked: !!r.locked,
        updated_by_email: r.updated_by_email || null,
        updated_at: r.updated_at || null,
    })));
}));

// Configured platform accounts. Read-only: the lists come from the ADMIN_UIDS
// and SUPER_ADMIN_UIDS env vars, so changing them means editing env and restarting.
platformRouter.get('/admins', verifyPlatformToken, requireSuperAdminPlatform, (req, res) => {
    return res.json({ source: 'env', admins: configuredPlatformAdmins() });
});

module.exports = { lockStatusRouter, platformRouter };
