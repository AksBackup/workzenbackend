const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

// `devices` table already existed in schema.sql before this pass (id,
// company_id, device_name, serial_no, location, ip_address, status,
// last_heartbeat) - this route is just CRUD over it, no migration needed.
//
// "Check Now" (2.3 Device Health Monitoring) is implemented client-side
// in Flutter (ZkDeviceService.testConnection() re-run against the
// device's own ip_address) rather than as a backend round-trip - see
// PASS_NOTES.md for why. That means `status`/`last_heartbeat` here are
// simple admin-editable fields, not something this route updates
// automatically on a timer.

router.get('/', asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        'SELECT * FROM devices WHERE company_id = ? ORDER BY device_name ASC',
        [req.user.companyId]
    );
    return res.json(rows);
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { device_name, serial_no, location, ip_address, status } = req.body;
    if (!device_name) return res.status(400).json({ error: 'device_name required' });

    const [result] = await pool.query(
        `INSERT INTO devices (company_id, device_name, serial_no, location, ip_address, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [req.user.companyId, device_name, serial_no || null, location || null, ip_address || null, status || 'offline']
    );
    return res.status(201).json({ id: result.insertId, device_name, serial_no, location, ip_address, status: status || 'offline' });
}));

router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
    const fields = ['device_name', 'serial_no', 'location', 'ip_address', 'status'];
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
        `UPDATE devices SET ${updates.join(', ')} WHERE id = ? AND company_id = ?`,
        values
    );
    return res.json({ message: 'Updated' });
}));

// Records the result of a client-side "Check Now" re-test (see
// ZkDeviceService.testConnection() call site in device_health_screen.dart).
// Kept as a tiny dedicated PATCH rather than folding into the general PUT
// above so the Flutter side doesn't have to re-send the whole device row
// just to record a heartbeat result.
router.patch('/:id/heartbeat', requireAdmin, asyncHandler(async (req, res) => {
    const { status } = req.body;
    if (status !== 'online' && status !== 'offline') {
        return res.status(400).json({ error: "status must be 'online' or 'offline'" });
    }
    const [result] = await pool.query(
        'UPDATE devices SET status = ?, last_heartbeat = NOW() WHERE id = ? AND company_id = ?',
        [status, req.params.id, req.user.companyId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Device not found' });
    const [rows] = await pool.query('SELECT * FROM devices WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json(rows[0]);
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM devices WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json({ message: 'Deleted' });
}));

module.exports = router;
