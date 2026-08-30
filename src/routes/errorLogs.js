const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * View Error Logs (SCREENS.md 10.3). Rows are written by src/index.js's
 * global error handler (the one added for the crash-safety fix - see
 * CONTEXT.md), not by any route in this file - this file is read-only.
 * Scoped to the caller's own company; rows with company_id = NULL
 * (errors that occurred before verifyFirebaseToken ran) never show up
 * here, by design - they're vendor-only debugging, not a customer's data.
 */
router.get('/', requireAdmin, asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    const [rows] = await pool.query(
        'SELECT * FROM error_logs WHERE company_id = ? ORDER BY occurred_at DESC LIMIT ?',
        [req.user.companyId, limit]
    );
    return res.json(rows);
}));

module.exports = router;
