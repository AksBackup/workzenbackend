const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Bonus Payroll (SCREENS.md 8.2). Unlike Loan/Advance, this IS wired
 * into payroll_records.bonus: every create/update/delete recomputes
 * SUM(amount) for that employee/year/month across all bonus line items
 * and upserts it into payroll_records.bonus, the same column
 * POST /payroll/:employeeId/bonus already writes to (payroll.js) - so a
 * single-value bonus set there and a multi-line-item bonus set here both
 * land in the same place, and payroll.js's GET /payroll response picks
 * up whichever was written last, same as before this migration.
 */
async function syncPayrollBonus(conn, companyId, employeeId, year, month) {
    const [sumRows] = await conn.query(
        'SELECT COALESCE(SUM(amount), 0) AS total FROM bonuses WHERE company_id = ? AND employee_id = ? AND year = ? AND month = ?',
        [companyId, employeeId, year, month]
    );
    const total = Number(sumRows[0].total);
    await conn.query(
        `INSERT INTO payroll_records (company_id, employee_id, year, month, bonus, total_pay)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE bonus = VALUES(bonus)`,
        [companyId, employeeId, year, month, total, total]
    );
}

router.get('/', requireAdmin, asyncHandler(async (req, res) => {
    const { year, month } = req.query;
    let sql = `SELECT b.*, e.name AS employee_name, e.emp_code AS employee_code
               FROM bonuses b
               JOIN employees e ON e.id = b.employee_id
               WHERE b.company_id = ?`;
    const params = [req.user.companyId];
    if (year && month) {
        sql += ' AND b.year = ? AND b.month = ?';
        params.push(year, month);
    }
    sql += ' ORDER BY b.created_at DESC';
    const [rows] = await pool.query(sql, params);
    return res.json(rows);
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { employee_id, year, month, amount, reason } = req.body;
    if (!employee_id || !year || !month || amount === undefined) {
        return res.status(400).json({ error: 'employee_id, year, month, amount required' });
    }
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [result] = await conn.query(
            `INSERT INTO bonuses (company_id, employee_id, year, month, amount, reason)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [req.user.companyId, employee_id, year, month, amount, reason || null]
        );
        await syncPayrollBonus(conn, req.user.companyId, employee_id, year, month);
        await conn.commit();
        return res.status(201).json({ id: result.insertId });
    } catch (err) {
        await conn.rollback();
        console.error('Bonus creation failed:', err);
        return res.status(500).json({ error: 'Failed to create bonus', detail: err.message });
    } finally {
        conn.release();
    }
}));

router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
    const [existingRows] = await pool.query(
        'SELECT * FROM bonuses WHERE id = ? AND company_id = ?',
        [req.params.id, req.user.companyId]
    );
    if (existingRows.length === 0) return res.status(404).json({ error: 'Bonus not found' });
    const existing = existingRows[0];

    const fields = ['amount', 'reason'];
    const updates = [];
    const values = [];
    fields.forEach(f => {
        if (req.body[f] !== undefined) {
            updates.push(`${f} = ?`);
            values.push(req.body[f]);
        }
    });
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        values.push(req.params.id, req.user.companyId);
        await conn.query(`UPDATE bonuses SET ${updates.join(', ')} WHERE id = ? AND company_id = ?`, values);
        await syncPayrollBonus(conn, req.user.companyId, existing.employee_id, existing.year, existing.month);
        await conn.commit();
        return res.json({ message: 'Updated' });
    } catch (err) {
        await conn.rollback();
        console.error('Bonus update failed:', err);
        return res.status(500).json({ error: 'Failed to update bonus', detail: err.message });
    } finally {
        conn.release();
    }
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    const [existingRows] = await pool.query(
        'SELECT * FROM bonuses WHERE id = ? AND company_id = ?',
        [req.params.id, req.user.companyId]
    );
    if (existingRows.length === 0) return res.status(404).json({ error: 'Bonus not found' });
    const existing = existingRows[0];

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query('DELETE FROM bonuses WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
        await syncPayrollBonus(conn, req.user.companyId, existing.employee_id, existing.year, existing.month);
        await conn.commit();
        return res.json({ message: 'Deleted' });
    } catch (err) {
        await conn.rollback();
        console.error('Bonus delete failed:', err);
        return res.status(500).json({ error: 'Failed to delete bonus', detail: err.message });
    } finally {
        conn.release();
    }
}));

module.exports = router;
