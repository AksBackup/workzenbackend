const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Current time as a wall-clock 'YYYY-MM-DD HH:mm:ss' string in the company's local
 * zone (PAYROLL_UTC_OFFSET_MIN, default 330 = IST), the same convention as device
 * punches (see index.js). Stamping in SQL with NOW() / CURRENT_TIMESTAMP uses the DB
 * server's own clock instead (often UTC), which is why these times could be hours off.
 */
function wallClockNow() {
    const offset = Number(process.env.PAYROLL_UTC_OFFSET_MIN ?? 330);
    return new Date(Date.now() + offset * 60000).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Canteen Management (5.2) - same "stub" treatment as visitors.js: real
 * persisted CRUD, just no attendance/payroll linkage.
 */

router.get('/', asyncHandler(async (req, res) => {
    // ?date=YYYY-MM-DD for one day (by canteen date), or ?from=&to= (either optional) for an inclusive range.
    const { date, from, to } = req.query;
    const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
    if ((date && !isDay(date)) || (from && !isDay(from)) || (to && !isDay(to))) {
        return res.status(400).json({ error: 'date, from and to must be YYYY-MM-DD' });
    }
    const params = [req.user.companyId];
    let sql = `SELECT c.*, e.name AS employee_name, e.emp_code AS employee_code
               FROM canteen_usage c
               JOIN employees e ON e.id = c.employee_id
               WHERE c.company_id = ?`;
    if (date) {
        sql += ' AND c.date = ?';
        params.push(date);
    }
    if (!date && from) {
        sql += ' AND c.date >= ?';
        params.push(from);
    }
    if (!date && to) {
        sql += ' AND c.date <= ?';
        params.push(to);
    }
    sql += ' ORDER BY c.punch_time DESC';

    const [rows] = await pool.query(sql, params);
    return res.json(rows);
}));

router.post('/', asyncHandler(async (req, res) => {
    const { employee_id, date, meal_type, subsidy, amount } = req.body;
    if (!employee_id || !date) return res.status(400).json({ error: 'employee_id and date required' });

    const [empRows] = await pool.query(
        'SELECT id FROM employees WHERE id = ? AND company_id = ?',
        [employee_id, req.user.companyId]
    );
    if (empRows.length === 0) return res.status(404).json({ error: 'Employee not found' });

    // punch_time is the actual moment of the punch, stamped in wall-clock time (not the DB clock).
    const [result] = await pool.query(
        `INSERT INTO canteen_usage (company_id, employee_id, date, punch_time, meal_type, subsidy, amount)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [req.user.companyId, employee_id, date, wallClockNow(), meal_type || 'lunch', subsidy || null, amount || null]
    );
    return res.status(201).json({ id: result.insertId });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM canteen_usage WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json({ message: 'Deleted' });
}));

module.exports = router;
