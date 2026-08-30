const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * GET /dashboard-notes - the Dashboard notes widget's single scratchpad
 * for this company. Returns { content: '' } (not 404) when nothing has
 * been saved yet, so the widget can render an empty text box on first
 * load without special-casing "no note exists".
 */
router.get('/', asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        'SELECT content, updated_at FROM dashboard_notes WHERE company_id = ?',
        [req.user.companyId]
    );
    if (!rows.length) return res.json({ content: '', updated_at: null });
    return res.json(rows[0]);
}));

/**
 * PUT /dashboard-notes body: { content }. Upserts the one row for this
 * company - admin-only, same as every other write in this app, but any
 * authenticated user in the company can read it (matches the read-only
 * GET above, no requireAdmin there).
 */
router.put('/', requireAdmin, asyncHandler(async (req, res) => {
    const { content } = req.body;
    await pool.query(
        `INSERT INTO dashboard_notes (company_id, content) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE content = VALUES(content)`,
        [req.user.companyId, content ?? '']
    );
    return res.json({ message: 'Saved' });
}));

module.exports = router;
