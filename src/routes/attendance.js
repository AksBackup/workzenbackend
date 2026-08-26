const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');

const router = express.Router();
router.use(verifyFirebaseToken);

// Admin: any employee in the company (optionally filtered). Employee: only self.
router.get('/', async (req, res) => {
    const { employee_id, month, year } = req.query;
    const params = [req.user.companyId];
    let sql = 'SELECT * FROM attendance WHERE company_id = ?';

    if (req.user.role === 'employee') {
        sql += ' AND employee_id = (SELECT id FROM employees WHERE firebase_uid = ? AND company_id = ?)';
        params.push(req.user.uid, req.user.companyId);
    } else if (employee_id) {
        sql += ' AND employee_id = ?';
        params.push(employee_id);
    }

    if (month && year) {
        sql += ' AND MONTH(date) = ? AND YEAR(date) = ?';
        params.push(month, year);
    }
    sql += ' ORDER BY date DESC';

    const [rows] = await pool.query(sql, params);
    return res.json(rows);
});

// Single punch write (e.g. an online-connected device posting directly)
router.post('/', requireAdmin, async (req, res) => {
    const { employee_id, date, check_in, check_out, source, device_id } = req.body;
    if (!employee_id || !date) return res.status(400).json({ error: 'employee_id and date required' });

    await pool.query(
        `INSERT INTO attendance (company_id, employee_id, date, check_in, check_out, source, device_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           check_in = COALESCE(VALUES(check_in), check_in),
           check_out = COALESCE(VALUES(check_out), check_out)`,
        [req.user.companyId, employee_id, date, check_in || null, check_out || null, source || 'manual', device_id || null]
    );
    return res.status(201).json({ message: 'Recorded' });
});

/**
 * POST /attendance/sync
 * Batch endpoint for the Flutter app's local SQLite offline queue.
 * Idempotent against the (employee_id, date) unique constraint - safe
 * to retry/resend the same batch if a sync gets interrupted.
 */
router.post('/sync', requireAdmin, async (req, res) => {
    const { records } = req.body;
    if (!Array.isArray(records) || records.length === 0) {
        return res.status(400).json({ error: 'records array required' });
    }

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        for (const r of records) {
            await conn.query(
                `INSERT INTO attendance (company_id, employee_id, date, check_in, check_out, source, device_id, synced_from_local)
                 VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)
                 ON DUPLICATE KEY UPDATE
                   check_in = COALESCE(VALUES(check_in), check_in),
                   check_out = COALESCE(VALUES(check_out), check_out)`,
                [req.user.companyId, r.employee_id, r.date, r.check_in || null, r.check_out || null,
                    r.source || 'scanner', r.device_id || null]
            );
        }
        await conn.commit();
        return res.json({ message: `Synced ${records.length} records` });
    } catch (err) {
        await conn.rollback();
        console.error('Sync failed:', err);
        return res.status(500).json({ error: 'Sync failed', detail: err.message });
    } finally {
        conn.release();
    }
});

module.exports = router;
