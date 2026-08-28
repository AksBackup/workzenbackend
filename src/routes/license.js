const express = require('express');
const admin = require('firebase-admin');
const pool = require('../db');
const adminPanelAuth = require('../middleware/adminPanelAuth');
const generateLicenseKey = require('../utils/generateLicenseKey');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

/**
 * POST /license/activate
 * First-run flow: customer enters a license key, this creates the
 * company, the ONE admin account (Firebase Auth + admins row), and
 * binds the license permanently to that company.
 */
router.post('/activate', asyncHandler(async (req, res) => {
    const { license_key, company_name, admin_name, admin_email, admin_password, device_fingerprint } = req.body;
    if (!license_key || !company_name || !admin_name || !admin_email || !admin_password) {
        return res.status(400).json({ error: 'Missing required fields' });
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

        const [companyResult] = await conn.query(
            'INSERT INTO companies (name, license_id, status) VALUES (?, ?, ?)',
            [company_name, license.id, 'active']
        );
        const companyId = companyResult.insertId;

        const firebaseUser = await admin.auth().createUser({
            email: admin_email,
            password: admin_password,
            displayName: admin_name
        });
        await admin.auth().setCustomUserClaims(firebaseUser.uid, {
            company_id: companyId,
            role: 'admin'
        });

        // admins.company_id is UNIQUE - this enforces "one admin per company" at the DB level
        await conn.query(
            'INSERT INTO admins (company_id, firebase_uid, name, email) VALUES (?, ?, ?, ?)',
            [companyId, firebaseUser.uid, admin_name, admin_email]
        );

        await conn.query(
            `UPDATE licenses
             SET status = 'active', company_id = ?, activated_at = NOW(), device_fingerprint = ?
             WHERE id = ?`,
            [companyId, device_fingerprint || null, license.id]
        );

        await conn.commit();
        return res.status(201).json({
            company_id: companyId,
            message: 'License activated. Admin account created.'
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
 * POST /license/verify
 * Called on app startup when online. The Flutter app caches the last
 * good result and tolerates ~7 days offline before requiring a fresh check.
 */
router.post('/verify', asyncHandler(async (req, res) => {
    const { license_key } = req.body;
    if (!license_key) return res.status(400).json({ error: 'license_key required' });

    const [rows] = await pool.query(
        'SELECT status, expires_at FROM licenses WHERE license_key = ?',
        [license_key]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const license = rows[0];
    const expired = license.expires_at && new Date(license.expires_at) < new Date();
    const valid = license.status === 'active' && !expired;

    return res.json({ valid, status: expired ? 'expired' : license.status });
}));

/* ------------------------------------------------------------------
   Internal only - used by public/index.html, the vendor's own tool.
   Never expose these paths to customers.
   ------------------------------------------------------------------ */

router.post('/admin/generate', adminPanelAuth, asyncHandler(async (req, res) => {
    const { max_employees, expires_in_days } = req.body;
    const key = generateLicenseKey();
    const expiresAt = expires_in_days
        ? new Date(Date.now() + expires_in_days * 86400000)
        : null;

    await pool.query(
        'INSERT INTO licenses (license_key, max_employees, expires_at) VALUES (?, ?, ?)',
        [key, max_employees || 50, expiresAt]
    );
    return res.status(201).json({ license_key: key });
}));

router.get('/admin/list', adminPanelAuth, asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        `SELECT l.id, l.license_key, l.status, l.max_employees, l.expires_at, l.activated_at,
                c.name AS company_name
         FROM licenses l
         LEFT JOIN companies c ON c.id = l.company_id
         ORDER BY l.created_at DESC`
    );
    return res.json(rows);
}));

router.post('/admin/revoke/:id', adminPanelAuth, asyncHandler(async (req, res) => {
    await pool.query('UPDATE licenses SET status = "revoked" WHERE id = ?', [req.params.id]);
    return res.json({ message: 'Revoked' });
}));

module.exports = router;
