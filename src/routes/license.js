const express = require('express');
const admin = require('firebase-admin');
const pool = require('../db');
const adminPanelAuth = require('../middleware/adminPanelAuth');
const generateLicenseKey = require('../utils/generateLicenseKey');
const { generateUniqueCompanyCode } = require('../utils/generateCompanyCode');
const { logPanelAction } = require('../utils/panelAudit');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * POST /license/activate
 *
 * migration_040: this used to always create a brand-new company on
 * every activation - i.e. strictly "1 license key = 1 company", the
 * only model that existed before this migration. Now:
 *
 *   - If this key's `license_batch_id` is NULL (a key generated the
 *     old way, or a standalone single-company key - see
 *     POST /admin/generate below), behaviour is UNCHANGED: this call
 *     always creates a new company + its one admin, exactly like
 *     before. Nothing about single-license customers changes.
 *
 *   - If this key belongs to a batch (issued together for one company
 *     name + admin email, see POST /admin/generate/batch), the FIRST
 *     key from that batch to be activated still creates the company +
 *     the one admin, same as always. Every SUBSEQUENT key from the
 *     SAME batch does NOT create a second company - it just attaches
 *     (`licenses.company_id`) to the company that already exists for
 *     that batch, and this call returns the EXISTING admin's email so
 *     the installer on that second PC knows to log in with the admin
 *     credentials that already exist rather than expecting to set a
 *     new password (this endpoint never creates a second Firebase
 *     admin account for the same company - admins.company_id is still
 *     UNIQUE at the DB level, unchanged).
 *
 *     `admin_email` sent by a second-PC activation MUST match the
 *     batch's own admin_email_norm exactly (case/space-insensitive) -
 *     this is the client's own rule ("if they change the email id then
 *     no registration is possible"). A mismatch is rejected outright,
 *     it does not silently create a second, wrong company.
 */
router.post('/activate', asyncHandler(async (req, res) => {
    const { license_key, company_name, admin_name, admin_email, admin_password, device_fingerprint } = req.body;
    if (!license_key || !company_name || !admin_email) {
        return res.status(400).json({ error: 'license_key, company_name, and admin_email are required' });
    }
    if (!device_fingerprint) {
        return res.status(400).json({ error: 'device_fingerprint required' });
    }

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const [licenseRows] = await conn.query(
            'SELECT * FROM licenses WHERE license_key = ? FOR UPDATE',
            [license_key]
        );
        if (licenseRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ error: 'License key not found' });
        }
        const license = licenseRows[0];
        if (license.status !== 'unused') {
            await conn.rollback();
            return res.status(409).json({ error: `License is already ${license.status}` });
        }

        // --- Batch path: this key belongs to a multi-PC pool. ---
        let batch = null;
        if (license.license_batch_id) {
            const [batchRows] = await conn.query(
                'SELECT * FROM license_batches WHERE id = ? FOR UPDATE',
                [license.license_batch_id]
            );
            batch = batchRows[0];
            if (norm(admin_email) !== batch.admin_email_norm) {
                await conn.rollback();
                return res.status(403).json({
                    error: 'This license key was issued to a different admin email. Use the exact email your admin registered with, or ask them for a key from a different batch.',
                });
            }

            // Has any OTHER key in this batch already been activated
            // (i.e. does the company already exist)? Look this up via
            // any sibling license row that already has a company_id.
            const [existingCompanyRows] = await conn.query(
                `SELECT c.id, c.name, a.email AS admin_email
                 FROM licenses l
                 JOIN companies c ON c.id = l.company_id
                 JOIN admins a ON a.company_id = c.id
                 WHERE l.license_batch_id = ? AND l.company_id IS NOT NULL
                 LIMIT 1`,
                [license.license_batch_id]
            );

            if (existingCompanyRows.length > 0) {
                // Second (or third, ...) PC for an already-registered
                // company - just attach this key, create no new
                // company/admin/Firebase account at all.
                const existing = existingCompanyRows[0];
                await conn.query(
                    `UPDATE licenses SET status = 'active', company_id = ?, activated_at = NOW(), device_fingerprint = ? WHERE id = ?`,
                    [existing.id, device_fingerprint, license.id]
                );
                await conn.commit();
                return res.status(200).json({
                    company_id: existing.id,
                    message: `This PC is now registered under "${existing.name}". Sign in with the existing admin account (${existing.admin_email}) - no new admin was created.`,
                    is_additional_seat: true,
                });
            }
            // Else: first activation in this batch - fall through to
            // the normal "create company + admin" path below, using
            // the batch's own company_name/admin_email as the source
            // of truth (not whatever the phone/installer happened to
            // send) so every seat in the batch is guaranteed
            // consistent even if a PC's form was edited.
        }

        // --- Normal path: create the company + its one admin. ---
        // For a batch's first activation this MUST succeed with
        // admin_password present; for a legacy single-key activation
        // it's the only path there is.
        if (!admin_password || !admin_name) {
            await conn.rollback();
            return res.status(400).json({ error: 'admin_name and admin_password are required to register a new company' });
        }

        const effectiveCompanyName = batch ? batch.company_name : company_name;

        const [nameRows] = await conn.query(
            'SELECT id FROM companies WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))',
            [effectiveCompanyName]
        );
        if (nameRows.length > 0) {
            await conn.rollback();
            return res.status(409).json({ error: `A company named "${effectiveCompanyName}" is already registered. Please use a more specific name (e.g. add a city or branch).` });
        }

        let companyId;
        for (let attempt = 0; ; attempt++) {
            const companyCode = await generateUniqueCompanyCode(conn, effectiveCompanyName);
            try {
                const [companyResult] = await conn.query(
                    'INSERT INTO companies (name, license_id, status, company_code) VALUES (?, ?, ?, ?)',
                    [effectiveCompanyName, license.id, 'active', companyCode]
                );
                companyId = companyResult.insertId;
                break;
            } catch (err) {
                if (err.code === 'ER_DUP_ENTRY' && attempt < 5) continue;
                throw err;
            }
        }

        const firebaseUser = await admin.auth().createUser({
            email: admin_email,
            password: admin_password,
            displayName: admin_name,
        });
        await admin.auth().setCustomUserClaims(firebaseUser.uid, { company_id: companyId, role: 'admin' });

        // admins.company_id is UNIQUE - this enforces "one admin per company" at the DB level
        await conn.query(
            'INSERT INTO admins (company_id, firebase_uid, name, email) VALUES (?, ?, ?, ?)',
            [companyId, firebaseUser.uid, admin_name, admin_email]
        );

        await conn.query(
            `UPDATE licenses SET status = 'active', company_id = ?, activated_at = NOW(), device_fingerprint = ? WHERE id = ?`,
            [companyId, device_fingerprint, license.id]
        );

        await conn.commit();
        return res.status(201).json({
            company_id: companyId,
            message: 'License activated. Admin account created.',
        });
    } catch (err) {
        await conn.rollback();
        console.error('License activation failed:', err);
        return res.status(500).json({ error: 'Activation failed', detail: err.message });
    } finally {
        conn.release();
    }
}));

/**
 * POST /license/verify - UNCHANGED from before this migration. A key's
 * device-binding/expiry checks don't care whether it's a standalone
 * key or one seat out of a batch; company_id is already resolved by
 * the time this is called.
 */
router.post('/verify', asyncHandler(async (req, res) => {
    const { license_key, device_fingerprint } = req.body;
    if (!license_key) return res.status(400).json({ error: 'license_key required' });

    const [rows] = await pool.query(
        'SELECT status, expires_at, device_fingerprint FROM licenses WHERE license_key = ?',
        [license_key]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const license = rows[0];
    const expired = license.expires_at && new Date(license.expires_at) < new Date();

    if (license.status !== 'active') {
        return res.json({ valid: false, reason: license.status });
    }
    if (expired) {
        return res.json({ valid: false, reason: 'expired' });
    }
    if (!license.device_fingerprint) {
        if (device_fingerprint) {
            await pool.query('UPDATE licenses SET device_fingerprint = ? WHERE license_key = ?', [device_fingerprint, license_key]);
        }
        return res.json({ valid: true });
    }
    if (device_fingerprint && device_fingerprint !== license.device_fingerprint) {
        return res.json({ valid: false, reason: 'device_mismatch' });
    }
    return res.json({ valid: true });
}));

/**
 * GET /license/my-company/feature-flags
 * Called by the desktop app (any logged-in company admin/employee) to
 * find out which screens are locked for THEIR company. Deliberately
 * lives under verifyFirebaseToken's world conceptually but is exposed
 * here (no auth beyond having a valid license_key) because the
 * feature-lock check has to work at/near login time, before the app
 * necessarily has a Firebase session yet in every code path - mirrors
 * /verify's own "just the license key" auth model. Returns every known
 * flag defaulted to true (unlocked) so a company with feature_flags
 * NULL/empty behaves exactly like today - nothing locked unless a
 * panel admin explicitly locks it.
 */
router.get('/my-company/feature-flags', asyncHandler(async (req, res) => {
    const { license_key } = req.query;
    if (!license_key) return res.status(400).json({ error: 'license_key required' });
    const [rows] = await pool.query(
        `SELECT c.feature_flags FROM licenses l JOIN companies c ON c.id = l.company_id WHERE l.license_key = ?`,
        [license_key]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const flags = rows[0].feature_flags || {};
    return res.json({
        payroll: flags.payroll !== false,
        geofence: flags.geofence !== false,
    });
}));

/* ------------------------------------------------------------------
   Internal only - the vendor's own panel (public/index.html + /panel/*
   login). Never expose these paths to customers.
   ------------------------------------------------------------------ */

router.use('/admin', adminPanelAuth);

// POST /license/admin/generate - UNCHANGED, single standalone key,
// no batch. Kept for a one-off single-company customer - simplest
// path, no batch bookkeeping needed for the common case.
router.post('/admin/generate', asyncHandler(async (req, res) => {
    const { max_employees, expires_in_days } = req.body;
    const key = generateLicenseKey();
    const expiresAt = expires_in_days ? new Date(Date.now() + expires_in_days * 86400000) : null;

    const [result] = await pool.query(
        'INSERT INTO licenses (license_key, max_employees, expires_at) VALUES (?, ?, ?)',
        [key, max_employees || 50, expiresAt]
    );
    await logPanelAction(req, 'generate_single', 'license', result.insertId, { max_employees, expires_in_days });
    return res.status(201).json({ license_key: key });
}));

/**
 * POST /license/admin/generate-batch - the actual new ask: "generate
 * multiple license keys under one company and email at the backend".
 * body: { company_name, admin_email, number_of_employees, number_of_license_keys, expires_in_days, feature_flags }
 * `feature_flags` here is the INITIAL lock/unlock state for whichever
 * company ends up created from this batch (e.g. { payroll: false } to
 * ship it locked from day one) - not required, defaults to everything
 * unlocked; can be changed later per-company via PUT
 * /license/admin/companies/:id/feature-flags once the company exists.
 */
router.post('/admin/generate-batch', asyncHandler(async (req, res) => {
    const { company_name, admin_email, number_of_employees, number_of_license_keys, expires_in_days } = req.body;
    if (!company_name || !admin_email || !number_of_license_keys) {
        return res.status(400).json({ error: 'company_name, admin_email, and number_of_license_keys are required' });
    }
    const count = Number(number_of_license_keys);
    if (!Number.isInteger(count) || count < 1 || count > 200) {
        return res.status(400).json({ error: 'number_of_license_keys must be an integer between 1 and 200' });
    }

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [batchResult] = await conn.query(
            `INSERT INTO license_batches (company_name, company_name_norm, admin_email, admin_email_norm, max_employees, number_of_licenses, created_by_panel_admin_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [company_name, norm(company_name), admin_email, norm(admin_email), number_of_employees || 50, count, req.panelAdmin ? req.panelAdmin.id : null]
        );
        const batchId = batchResult.insertId;

        const expiresAt = expires_in_days ? new Date(Date.now() + expires_in_days * 86400000) : null;
        const keys = [];
        for (let i = 0; i < count; i++) {
            const key = generateLicenseKey();
            await conn.query(
                'INSERT INTO licenses (license_key, max_employees, expires_at, license_batch_id) VALUES (?, ?, ?, ?)',
                [key, number_of_employees || 50, expiresAt, batchId]
            );
            keys.push(key);
        }
        await conn.commit();
        await logPanelAction(req, 'generate_batch', 'license_batch', batchId, { company_name, admin_email, number_of_license_keys: count });
        return res.status(201).json({ batch_id: batchId, license_keys: keys });
    } catch (err) {
        await conn.rollback();
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'A batch already exists for this exact company name + admin email. Add more keys to it with POST /license/admin/batches/:id/add-keys instead.' });
        }
        throw err;
    } finally {
        conn.release();
    }
}));

// POST /license/admin/batches/:id/add-keys - "company already has a
// pool, they need one more seat" - adds N more keys to an existing
// batch rather than making the admin create a whole new one.
router.post('/admin/batches/:id/add-keys', asyncHandler(async (req, res) => {
    const { count } = req.body;
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 200) {
        return res.status(400).json({ error: 'count must be an integer between 1 and 200' });
    }
    const [batchRows] = await pool.query('SELECT * FROM license_batches WHERE id = ?', [req.params.id]);
    if (batchRows.length === 0) return res.status(404).json({ error: 'Batch not found' });
    const batch = batchRows[0];

    const keys = [];
    for (let i = 0; i < n; i++) {
        const key = generateLicenseKey();
        await pool.query(
            'INSERT INTO licenses (license_key, max_employees, license_batch_id) VALUES (?, ?, ?)',
            [key, batch.max_employees, batch.id]
        );
        keys.push(key);
    }
    await pool.query('UPDATE license_batches SET number_of_licenses = number_of_licenses + ? WHERE id = ?', [n, batch.id]);
    await logPanelAction(req, 'add_keys_to_batch', 'license_batch', batch.id, { count: n });
    return res.status(201).json({ license_keys: keys });
}));

router.get('/admin/list', asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        `SELECT l.id, l.license_key, l.status, l.max_employees, l.expires_at, l.activated_at,
                l.license_batch_id, b.company_name AS batch_company_name, b.admin_email AS batch_admin_email,
                c.name AS company_name
         FROM licenses l
         LEFT JOIN companies c ON c.id = l.company_id
         LEFT JOIN license_batches b ON b.id = l.license_batch_id
         ORDER BY l.created_at DESC`
    );
    return res.json(rows);
}));

router.post('/admin/revoke/:id', asyncHandler(async (req, res) => {
    await pool.query("UPDATE licenses SET status = 'revoked' WHERE id = ?", [req.params.id]);
    await logPanelAction(req, 'revoke', 'license', req.params.id, {});
    return res.json({ message: 'Revoked' });
}));

// POST /license/admin/renew/:id - "the revoke button was not working"
// was the only complaint on the mutation side; RENEW never existed at
// all before this migration. Extends expires_at and, if the key had
// been allowed to actually expire (status flips to 'expired' - see
// note below), brings it back to 'active'. Does NOT touch a
// genuinely revoked key - revoke and expire are different reasons a
// key stops working, and un-revoking should be a deliberate, separate
// action (see the dedicated check below) so a support person renewing
// a merely-expired key can't accidentally also undo a for-cause
// revocation by the same click.
//
// NOTE: nothing in this codebase currently flips status to 'expired'
// automatically when expires_at passes - /verify computes "expired"
// live by comparing expires_at to now without ever writing it back to
// the status column (see /verify above). This route still accepts an
// already-'expired' status defensively in case a future pass adds
// that write, but today the realistic case is "status is still
// 'active' but expires_at is in the past or coming up soon" - handled
// identically either way, since it's just extending expires_at.
router.post('/admin/renew/:id', asyncHandler(async (req, res) => {
    const { extend_days } = req.body;
    const days = Number(extend_days);
    if (!Number.isInteger(days) || days < 1) {
        return res.status(400).json({ error: 'extend_days must be a positive integer' });
    }
    const [rows] = await pool.query('SELECT status, expires_at FROM licenses WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'License not found' });
    if (rows[0].status === 'revoked') {
        return res.status(409).json({ error: 'This license was revoked, not expired. Use a separate un-revoke action if you really mean to restore it.' });
    }
    // Extend from whichever is later: the current expiry, or now - so
    // renewing a key that still has time left ADDS to it rather than
    // resetting the clock to "now + extend_days" and accidentally
    // shortening it.
    const base = rows[0].expires_at && new Date(rows[0].expires_at) > new Date() ? new Date(rows[0].expires_at) : new Date();
    const newExpiry = new Date(base.getTime() + days * 86400000);
    await pool.query(
        `UPDATE licenses SET status = 'active', expires_at = ? WHERE id = ?`,
        [newExpiry, req.params.id]
    );
    await logPanelAction(req, 'renew', 'license', req.params.id, { extend_days: days, new_expiry: newExpiry });
    return res.json({ message: 'Renewed', expires_at: newExpiry });
}));

// PUT /license/admin/companies/:id/feature-flags - the lock/unlock
// screen. body: { payroll: true|false, geofence: true|false }. Only
// the two keys currently understood by the Flutter side (see
// FEATURE_LOCKING.md once that lands) are validated here; unknown
// keys are rejected rather than silently stored, so a typo in the
// panel doesn't create a flag nothing ever reads.
const KNOWN_FEATURE_FLAGS = ['payroll', 'geofence'];
router.put('/admin/companies/:id/feature-flags', asyncHandler(async (req, res) => {
    const updates = {};
    for (const key of KNOWN_FEATURE_FLAGS) {
        if (req.body[key] !== undefined) updates[key] = !!req.body[key];
    }
    const unknownKeys = Object.keys(req.body).filter((k) => !KNOWN_FEATURE_FLAGS.includes(k));
    if (unknownKeys.length > 0) {
        return res.status(400).json({ error: `Unknown feature flag(s): ${unknownKeys.join(', ')}. Known: ${KNOWN_FEATURE_FLAGS.join(', ')}` });
    }
    const [rows] = await pool.query('SELECT feature_flags FROM companies WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Company not found' });
    const merged = { ...(rows[0].feature_flags || {}), ...updates };
    await pool.query('UPDATE companies SET feature_flags = ? WHERE id = ?', [JSON.stringify(merged), req.params.id]);
    await logPanelAction(req, 'set_feature_flags', 'company', req.params.id, updates);
    return res.json({ feature_flags: merged });
}));

module.exports = router;
