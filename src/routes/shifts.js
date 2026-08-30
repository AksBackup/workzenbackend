const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

// IMPORTANT: this table's shape (id, company_id, name, start_time,
// end_time, is_default) is committed and relied on by Agent B's Shift
// Change / Generate Shift / Shift Roaster screens. Do not rename
// existing columns here without checking with that pass first.
//
// migration_010: `is_default` - every company should always have at
// least one shift that can't be deleted (can still be renamed/retimed),
// so there's always a fallback shift to assign. Rather than needing a
// signup-time hook, this is seeded lazily: the first time GET /shifts
// finds zero rows for a company, it creates one default "General Shift"
// (09:00-18:00) and returns it. Existing companies that already had
// shifts before this migration got their earliest shift promoted to
// default by migration_010's backfill, so this lazy path only ever
// fires for a genuinely shift-less company.

async function ensureDefaultShift(companyId) {
    const [existing] = await pool.query(
        'SELECT COUNT(*) AS cnt FROM shifts WHERE company_id = ?',
        [companyId]
    );
    if (existing[0].cnt > 0) return;
    await pool.query(
        'INSERT INTO shifts (company_id, name, start_time, end_time, is_default) VALUES (?, ?, ?, ?, TRUE)',
        [companyId, 'General Shift', '09:00:00', '18:00:00']
    );
}

router.get('/', asyncHandler(async (req, res) => {
    await ensureDefaultShift(req.user.companyId);
    const [rows] = await pool.query(
        'SELECT * FROM shifts WHERE company_id = ? ORDER BY is_default DESC, start_time ASC',
        [req.user.companyId]
    );
    return res.json(rows);
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { name, start_time, end_time } = req.body;
    if (!name || !start_time || !end_time) {
        return res.status(400).json({ error: 'name, start_time and end_time are required' });
    }

    const [result] = await pool.query(
        'INSERT INTO shifts (company_id, name, start_time, end_time) VALUES (?, ?, ?, ?)',
        [req.user.companyId, name, start_time, end_time]
    );
    return res.status(201).json({ id: result.insertId, name, start_time, end_time, is_default: false });
}));

router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
    // Name/time are editable on the default shift same as any other -
    // only DELETE is blocked for it. `is_default` itself is never
    // accepted here, so a client can't promote/demote a shift's
    // protected status through this route.
    const fields = ['name', 'start_time', 'end_time'];
    const updates = [];
    const values = [];
    fields.forEach(f => {
        if (req.body[f] !== undefined) {
            updates.push(`${f} = ?`);
            values.push(req.body[f]);
        }
    });
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    values.push(req.params.id, req.user.companyId);
    await pool.query(
        `UPDATE shifts SET ${updates.join(', ')} WHERE id = ? AND company_id = ?`,
        values
    );
    return res.json({ message: 'Updated' });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        'SELECT is_default FROM shifts WHERE id = ? AND company_id = ?',
        [req.params.id, req.user.companyId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Shift not found' });
    if (rows[0].is_default) {
        return res.status(400).json({
            error: 'This is the default shift and can\'t be deleted. You can still rename it or change its time.'
        });
    }
    await pool.query('DELETE FROM shifts WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json({ message: 'Deleted' });
}));

module.exports = router;
