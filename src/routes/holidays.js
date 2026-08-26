const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');

const router = express.Router();
router.use(verifyFirebaseToken);

router.get('/', async (req, res) => {
    const [rows] = await pool.query(
        'SELECT * FROM holidays WHERE company_id = ? ORDER BY date ASC',
        [req.user.companyId]
    );
    return res.json(rows);
});

router.post('/', requireAdmin, async (req, res) => {
    const { date, name, type } = req.body;
    if (!date || !name) return res.status(400).json({ error: 'date and name required' });

    await pool.query(
        'INSERT INTO holidays (company_id, date, name, type) VALUES (?, ?, ?, ?)',
        [req.user.companyId, date, name, type || 'festival']
    );
    return res.status(201).json({ message: 'Created' });
});

router.delete('/:id', requireAdmin, async (req, res) => {
    await pool.query('DELETE FROM holidays WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json({ message: 'Deleted' });
});

module.exports = router;
