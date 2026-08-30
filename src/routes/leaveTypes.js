const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

// `leave_types` table has existed in schema.sql since Phase 1 (id,
// company_id, name, yearly_quota, carry_forward), but no route ever
// exposed it - flagged as a gap in an earlier pass's
// models/leave_application.dart comments ("no GET /leave-types route
// registered in src/index.js"). This is leave *types*
// (Casual/Sick/Earned...), not leave *requests* - 4.3/4.4
// (leave_applications) already exist at /leave-applications.
//
// MERGE NOTE: Agent A (3.8 Define Leave) and Agent B (needed by 4.2
// Leave Opening Entry) independently built this same route in the
// Phase 5 pass - a genuine collision, since this table sits on the
// boundary between "masters" and "leave ops". This merged version keeps
// both agents' real logic: Agent A's PUT (Define Leave needs to edit an
// existing type, not just add/remove) and Agent B's duplicate-name
// guard on create (so Leave Opening Entry's "add a type on the fly"
// flow can't silently create two "Casual Leave" rows for one company).

router.get('/', asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        'SELECT * FROM leave_types WHERE company_id = ? ORDER BY name ASC',
        [req.user.companyId]
    );
    return res.json(rows);
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { name, yearly_quota, carry_forward } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const [existing] = await pool.query(
        'SELECT id FROM leave_types WHERE company_id = ? AND name = ?',
        [req.user.companyId, name]
    );
    if (existing.length > 0) {
        return res.status(409).json({ error: 'A leave type with this name already exists' });
    }

    const [result] = await pool.query(
        'INSERT INTO leave_types (company_id, name, yearly_quota, carry_forward) VALUES (?, ?, ?, ?)',
        [req.user.companyId, name, yearly_quota || 0, !!carry_forward]
    );
    return res.status(201).json({ id: result.insertId, name, yearly_quota: yearly_quota || 0, carry_forward: !!carry_forward });
}));

router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
    const fields = ['name', 'yearly_quota', 'carry_forward'];
    const updates = [];
    const values = [];
    fields.forEach(f => {
        if (req.body[f] !== undefined) {
            updates.push(`${f} = ?`);
            values.push(req.body[f]);
        }
    });
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    if (req.body.name !== undefined) {
        const [dupRows] = await pool.query(
            'SELECT id FROM leave_types WHERE company_id = ? AND name = ? AND id != ?',
            [req.user.companyId, req.body.name, req.params.id]
        );
        if (dupRows.length > 0) {
            return res.status(409).json({ error: 'A leave type with this name already exists' });
        }
    }

    values.push(req.params.id, req.user.companyId);
    await pool.query(
        `UPDATE leave_types SET ${updates.join(', ')} WHERE id = ? AND company_id = ?`,
        values
    );
    return res.json({ message: 'Updated' });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    // leave_applications.leave_type_id has no ON DELETE clause (defaults
    // to RESTRICT) - a leave type still referenced by an application will
    // fail this delete with an FK error rather than silently orphaning
    // history. Surfaced as a normal 500 via the shared error handler
    // (matches how every other route here lets FK errors surface).
    await pool.query('DELETE FROM leave_types WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json({ message: 'Deleted' });
}));

module.exports = router;
