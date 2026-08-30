const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * GET /calendar-events?year=&month=
 * Backs the Dashboard calendar widget's month view. Both params
 * optional - omitting them returns every event for the company (used
 * nowhere yet, but keeps this consistent with how /attendance handles
 * an unfiltered GET).
 */
router.get('/', asyncHandler(async (req, res) => {
    const year = req.query.year ? parseInt(req.query.year, 10) : null;
    const month = req.query.month ? parseInt(req.query.month, 10) : null; // 1-12

    let sql = 'SELECT * FROM calendar_events WHERE company_id = ?';
    const params = [req.user.companyId];

    if (year && month) {
        sql += ' AND YEAR(event_date) = ? AND MONTH(event_date) = ?';
        params.push(year, month);
    }
    sql += ' ORDER BY event_date ASC';

    const [rows] = await pool.query(sql, params);
    return res.json(rows);
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { date, title } = req.body;
    if (!date || !title || !String(title).trim()) {
        return res.status(400).json({ error: 'date and title are required' });
    }
    const [result] = await pool.query(
        'INSERT INTO calendar_events (company_id, event_date, title) VALUES (?, ?, ?)',
        [req.user.companyId, date, String(title).trim()]
    );
    return res.status(201).json({ id: result.insertId, event_date: date, title: String(title).trim() });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM calendar_events WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json({ message: 'Deleted' });
}));

module.exports = router;
