const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');
const { resolvePaymentWindow } = require('../utils/paymentWindow');

const router = express.Router();
router.use(verifyFirebaseToken);

/** GET /payroll-payment-window -> { settings, overrides[] } */
router.get('/', requireAdmin, asyncHandler(async (req, res) => {
    let settings = { default_start_day: null, default_end_day: null, enforce: true };
    let overrides = [];
    try {
        const [s] = await pool.query('SELECT default_start_day, default_end_day, enforce FROM payroll_payment_settings WHERE company_id = ?', [req.user.companyId]);
        if (s.length) settings = { ...s[0], enforce: !!s[0].enforce };
        const [o] = await pool.query(
            `SELECT year, month, DATE_FORMAT(start_date,'%Y-%m-%d') AS start_date, DATE_FORMAT(end_date,'%Y-%m-%d') AS end_date
             FROM payroll_payment_windows WHERE company_id = ? ORDER BY year DESC, month DESC`, [req.user.companyId]);
        overrides = o;
    } catch (err) { if (err.code !== 'ER_NO_SUCH_TABLE') throw err; }
    return res.json({ settings, overrides });
}));

/** GET /payroll-payment-window/resolve?year=&month= -> effective window for a month */
router.get('/resolve', requireAdmin, asyncHandler(async (req, res) => {
    const year = parseInt(req.query.year, 10), month = parseInt(req.query.month, 10);
    if (!year || !month || month < 1 || month > 12) return res.status(400).json({ error: 'year and month (1-12) required' });
    return res.json(await resolvePaymentWindow(req.user.companyId, year, month));
}));

/** PUT /payroll-payment-window/settings  body: { default_start_day, default_end_day, enforce } (days 1-28 of the FOLLOWING month) */
router.put('/settings', requireAdmin, asyncHandler(async (req, res) => {
    const start = req.body.default_start_day == null ? null : parseInt(req.body.default_start_day, 10);
    const end = req.body.default_end_day == null ? null : parseInt(req.body.default_end_day, 10);
    const enforce = req.body.enforce === false || req.body.enforce === 0 ? 0 : 1;
    if ((start == null) !== (end == null)) return res.status(400).json({ error: 'Set both start day and end day, or neither.' });
    if (start != null && (start < 1 || start > 31 || end < 1 || end > 31 || end < start)) {
        return res.status(400).json({ error: 'Days must be 1-31 and end day cannot be before start day.' });
    }
    await pool.query(
        `INSERT INTO payroll_payment_settings (company_id, default_start_day, default_end_day, enforce) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE default_start_day = VALUES(default_start_day), default_end_day = VALUES(default_end_day), enforce = VALUES(enforce)`,
        [req.user.companyId, start, end, enforce]);
    return res.json({ message: 'Saved' });
}));

/** PUT /payroll-payment-window/month  body: { year, month, start_date, end_date } - explicit window for one payroll month */
router.put('/month', requireAdmin, asyncHandler(async (req, res) => {
    const { year, month, start_date, end_date } = req.body;
    if (!year || !month || !start_date || !end_date) return res.status(400).json({ error: 'year, month, start_date, end_date required' });
    if (end_date < start_date) return res.status(400).json({ error: 'end_date cannot be before start_date' });
    await pool.query(
        `INSERT INTO payroll_payment_windows (company_id, year, month, start_date, end_date) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE start_date = VALUES(start_date), end_date = VALUES(end_date)`,
        [req.user.companyId, year, month, start_date, end_date]);
    return res.json({ message: 'Saved' });
}));

router.delete('/month/:year/:month', requireAdmin, asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM payroll_payment_windows WHERE company_id = ? AND year = ? AND month = ?',
        [req.user.companyId, req.params.year, req.params.month]);
    return res.json({ message: 'Removed' });
}));

module.exports = router;
