const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

router.get('/', asyncHandler(async (req, res) => {
    // migration_015: ?branch_id= resolves that branch's holiday_group_id
    // and returns only holidays in that group PLUS every ungrouped
    // (company-wide) holiday - see migration_015's header comment.
    // Omitting branch_id keeps the original unfiltered behaviour
    // (every holiday in the company, grouped or not) for any existing
    // caller that doesn't know about groups yet.
    const { branch_id } = req.query;
    if (branch_id) {
        const [branchRows] = await pool.query(
            'SELECT holiday_group_id FROM branches WHERE id = ? AND company_id = ?',
            [branch_id, req.user.companyId]
        );
        if (branchRows.length === 0) return res.status(404).json({ error: 'Branch not found' });
        const groupId = branchRows[0].holiday_group_id;
        const [rows] = await pool.query(
            groupId
                ? 'SELECT * FROM holidays WHERE company_id = ? AND (holiday_group_id = ? OR holiday_group_id IS NULL) ORDER BY date ASC'
                : 'SELECT * FROM holidays WHERE company_id = ? AND holiday_group_id IS NULL ORDER BY date ASC',
            groupId ? [req.user.companyId, groupId] : [req.user.companyId]
        );
        return res.json(rows);
    }

    const [rows] = await pool.query(
        'SELECT * FROM holidays WHERE company_id = ? ORDER BY date ASC',
        [req.user.companyId]
    );
    return res.json(rows);
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { date, name, type, holiday_group_id } = req.body;
    if (!date || !name) return res.status(400).json({ error: 'date and name required' });

    await pool.query(
        'INSERT INTO holidays (company_id, date, name, type, holiday_group_id) VALUES (?, ?, ?, ?, ?)',
        [req.user.companyId, date, name, type || 'festival', holiday_group_id || null]
    );
    return res.status(201).json({ message: 'Created' });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM holidays WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json({ message: 'Deleted' });
}));

module.exports = router;
