const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * User Manager (SCREENS.md 10.1) needs to display *something* real for
 * the logged-in admin - name/email/company - rather than fake it. No
 * route already exposed the `admins` row itself (only Firebase custom
 * claims, which don't carry name/email). This is a small addition not
 * explicitly listed in FROZEN_CONTRACT_V2.md; flagged in PASS_NOTES.md
 * as a minimal necessary gap-fill, same small-CRUD-file shape as
 * holidays.js. Read-only - `admins.company_id` is UNIQUE (one admin per
 * company, enforced at the DB level, not revisited here per the
 * contract), so there is no "list other admins" or "add admin" route.
 */
router.get('/me', requireAdmin, asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        `SELECT a.id, a.name, a.email, a.created_at, c.name AS company_name
         FROM admins a
         JOIN companies c ON c.id = a.company_id
         WHERE a.firebase_uid = ?`,
        [req.user.uid]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Admin record not found' });
    return res.json(rows[0]);
}));

module.exports = router;
