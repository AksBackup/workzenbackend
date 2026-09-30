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
// `model` (migration_012_device_model.sql) was added later, when Flutter
// side support grew from F22-only to eight terminal models (K90, K30,
// K30 WiFi, MB160, MB20, F22, X990, uFace302). It's metadata only - every
// model talks over the identical protocol, so it doesn't change how this
// route works, just what gets stored/returned alongside a device.
//
// "Check Now" (2.3 Device Health Monitoring) is implemented client-side
// in Flutter (ZkDeviceService.testConnection() re-run against the
// device's own ip_address) rather than as a backend round-trip - see
// PASS_NOTES.md for why. That means `status`/`last_heartbeat` here are
// simple admin-editable fields, not something this route updates
// automatically on a timer.

router.get('/', asyncHandler(async (req, res) => {
    // For Cloud-Server (ADMS) devices the stored `status` is only ever set to
    // 'online' by a handshake and never flips back. So derive it from
    // adms_last_seen: online only if the device contacted us in the last 3 min.
    const [rows] = await pool.query(
        `SELECT *,
                CASE WHEN adms_last_seen IS NULL THEN NULL
                     ELSE TIMESTAMPDIFF(SECOND, adms_last_seen, NOW()) END AS adms_age_sec
           FROM devices WHERE company_id = ? ORDER BY device_name ASC`,
        [req.user.companyId]
    );
    return res.json(rows.map((r) => {
        if (!r.adms_enabled) return r;
        const fresh = r.adms_age_sec !== null && r.adms_age_sec <= 180;
        return { ...r, status: fresh ? 'online' : 'offline' };
    }));
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { device_name, device_code, serial_no, location, ip_address, port, comm_password, status, model, adms_enabled } = req.body;
    if (!device_name) return res.status(400).json({ error: 'device_name required' });
    // device_code (migration_025) is the alphanumeric ID the admin
    // assigns when registering this device - separate from serial_no
    // (the hardware's own serial) - used to pick a target device when
    // pushing employee data from the Employees screen. Optional but,
    // when given, must be alphanumeric and unique per company.
    if (device_code !== undefined && device_code !== null && String(device_code).trim() !== '') {
        if (!/^[a-zA-Z0-9]+$/.test(String(device_code).trim())) {
            return res.status(400).json({ error: 'device_code must be alphanumeric' });
        }
        const [dup] = await pool.query(
            'SELECT id FROM devices WHERE company_id = ? AND device_code = ?',
            [req.user.companyId, String(device_code).trim()]
        );
        if (dup.length > 0) {
            return res.status(409).json({ error: `device_code ${device_code} is already used by another device` });
        }
    }

    // Trim the serial (the ADMS lookup is an exact match, so a stray space
    // would silently break it) and coerce the toggle to a real boolean.
    const cleanSerial = typeof serial_no === 'string' ? serial_no.trim() : serial_no;
    const admsOn = adms_enabled === true || adms_enabled === 1 || adms_enabled === '1' || adms_enabled === 'true';

    const [result] = await pool.query(
        `INSERT INTO devices (company_id, device_name, device_code, serial_no, location, ip_address, port, comm_password, status, model, adms_enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.user.companyId, device_name, device_code || null, cleanSerial || null, location || null, ip_address || null, port || 4370, comm_password || null, status || 'offline', model || 'f22', admsOn ? 1 : 0]
    );
    return res.status(201).json({
        id: result.insertId, device_name, device_code: device_code || null, serial_no: cleanSerial || null, location, ip_address,
        port: port || 4370, comm_password: comm_password || null, status: status || 'offline',
        model: model || 'f22', adms_enabled: admsOn,
    });
}));

router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
    const fields = ['device_name', 'device_code', 'serial_no', 'location', 'ip_address', 'port', 'comm_password', 'status', 'model', 'adms_enabled'];
    if (req.body.device_code !== undefined && req.body.device_code !== null && String(req.body.device_code).trim() !== ''
        && !/^[a-zA-Z0-9]+$/.test(String(req.body.device_code).trim())) {
        return res.status(400).json({ error: 'device_code must be alphanumeric' });
    }
    const updates = [];
    const values = [];
    fields.forEach(f => {
        if (req.body[f] !== undefined) {
            updates.push(`${f} = ?`);
            let v = req.body[f];
            if (f === 'serial_no' && typeof v === 'string') v = v.trim() || null;
            if (f === 'adms_enabled') v = (v === true || v === 1 || v === '1' || v === 'true') ? 1 : 0;
            values.push(v);
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

// Feed for the desktop app's "X punched in at ..." toast, for CLOUD devices only
// (TCP devices already toast from the app's own pull, so they are excluded to
// avoid double toasts). First call (no since_id) just returns a baseline cursor.
router.get('/cloud-punches', asyncHandler(async (req, res) => {
    try {
        const [[cd]] = await pool.query('SELECT COUNT(*) AS n FROM devices WHERE company_id = ? AND adms_enabled = 1', [req.user.companyId]);
        if (!cd.n) return res.json({ cloud_devices: 0, latest_id: 0, punches: [] });
        const since = parseInt(req.query.since_id, 10);
        const scope = 'pe.company_id = ? AND pe.device_id IN (SELECT id FROM devices WHERE company_id = ? AND adms_enabled = 1)';
        if (Number.isNaN(since)) {
            const [[m]] = await pool.query(`SELECT COALESCE(MAX(pe.id), 0) AS id FROM punch_events pe WHERE ${scope}`, [req.user.companyId, req.user.companyId]);
            return res.json({ cloud_devices: cd.n, latest_id: m.id, punches: [] });
        }
        const [rows] = await pool.query(
            `SELECT pe.id, e.name AS employee_name, pe.punch_type, TIME_FORMAT(pe.punch_time, '%H:%i:%s') AS t
               FROM punch_events pe JOIN employees e ON e.id = pe.employee_id
              WHERE ${scope} AND pe.id > ? ORDER BY pe.id ASC LIMIT 20`,
            [req.user.companyId, req.user.companyId, since]);
        return res.json({ cloud_devices: cd.n, latest_id: rows.length ? rows[rows.length - 1].id : since, punches: rows });
    } catch (err) {
        return res.json({ cloud_devices: 0, latest_id: 0, punches: [] }); // never break the app over a toast
    }
}));

// Cloud Server (ADMS) control: queue commands to a device that can't be reached over TCP.
router.use('/:id/cloud', require('./deviceCloud'));

module.exports = router;
