const express = require('express');
const pool = require('../db');
const { requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

/**
 * POST /employees/:id/push-to-devices   (admin)
 * body: { deviceIds: number[] }
 *
 * Pushes ONE employee's record (device user ID = emp_code, name, card) to each
 * selected device that is LIVE right now. Mounted from routes/employees.js.
 *
 * Only Cloud Server (ADMS) devices can be reached from here: a cloud device is
 * sent the user write as a queued command and applies it on its next poll. A
 * cloud device counts as live when it contacted the server in the last 180 s
 * (same rule as GET /devices). Wired / WiFi (TCP) devices cannot be called from
 * the server, so they come back as "skipped" and the app pushes to them directly.
 *
 * Fingerprint templates, face templates and device passwords are not stored on
 * the server, so this route never sends them. They stay on the device and are
 * captured there.
 */
const router = express.Router();

const LIVE_WINDOW_SECONDS = 180;
const PIN_RE = /^[0-9]{1,9}$/; // the device User ID is numeric only
const MAX_DEVICES = 50;
const clean = (v) => String(v == null ? '' : v).replace(/[\t\r\n]/g, ' ').trim();

// Same wire format as routes/deviceCloud.js's userCmd (kept here rather than exported from that file).
function userCommand({ pin, name, privilege, card }) {
    return 'DATA UPDATE USERINFO ' + [
        `PIN=${pin}`, `Name=${clean(name)}`, `Pri=${privilege}`, `Privilege=${privilege}`,
        'Passwd=', `Card=${clean(card)}`, 'Grp=1', 'TZ=0000000100000000',
    ].join('\t');
}

router.post('/:id/push-to-devices', requireAdmin, asyncHandler(async (req, res) => {
    const companyId = req.user.companyId;

    const [empRows] = await pool.query(
        'SELECT id, emp_code, name, card_no FROM employees WHERE id = ? AND company_id = ?',
        [req.params.id, companyId]
    );
    if (empRows.length === 0) return res.status(404).json({ error: 'Employee not found' });
    const emp = empRows[0];

    if (!Array.isArray(req.body.deviceIds)) return res.status(400).json({ error: 'deviceIds (array) required' });
    const deviceIds = [...new Set(req.body.deviceIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (deviceIds.length === 0) return res.status(400).json({ error: 'Pick at least one device' });
    if (deviceIds.length > MAX_DEVICES) return res.status(400).json({ error: `At most ${MAX_DEVICES} devices per push` });

    const [devices] = await pool.query(
        `SELECT id, device_name, device_code, adms_enabled,
                TIMESTAMPDIFF(SECOND, adms_last_seen, NOW()) AS adms_age_sec
         FROM devices WHERE company_id = ? AND id IN (?)`,
        [companyId, deviceIds]
    );
    const byId = new Map(devices.map((d) => [d.id, d]));

    const results = [];
    for (const deviceId of deviceIds) {
        const d = byId.get(deviceId);
        if (!d) { results.push({ device_id: deviceId, status: 'skipped', reason: 'not_found', message: 'Device not found' }); continue; }
        const label = d.device_code || d.device_name;
        if (!d.adms_enabled) {
            results.push({ device_id: d.id, device_name: label, status: 'skipped', reason: 'not_cloud',
                message: 'Wired/WiFi device: the app pushes to it directly while it is connected.' });
            continue;
        }
        if (d.adms_age_sec === null || d.adms_age_sec > LIVE_WINDOW_SECONDS) {
            results.push({ device_id: d.id, device_name: label, status: 'skipped', reason: 'offline',
                message: 'Device is offline - it has not contacted the server recently.' });
            continue;
        }
        const pin = clean(emp.emp_code);
        if (!PIN_RE.test(pin)) {
            results.push({ device_id: d.id, device_name: label, status: 'skipped', reason: 'invalid_pin',
                message: 'Emp ID must be digits only to be pushed to a device.' });
            continue;
        }

        // Keep what the device already has for this PIN (admin privilege, card) unless this employee has one.
        const [ex] = await pool.query('SELECT card, privilege FROM device_cloud_users WHERE device_id = ? AND pin = ?', [d.id, pin]);
        const privilege = ex.length && ex[0].privilege >= 14 ? 14 : 0;
        const card = clean(emp.card_no) || (ex.length && ex[0].card) || '';

        const [cmd] = await pool.query(
            "INSERT INTO device_commands (company_id, device_id, cmd_type, cmd_text, fallbacks) VALUES (?, ?, 'user_update', ?, NULL)",
            [companyId, d.id, userCommand({ pin, name: emp.name, privilege, card })]
        );
        await pool.query(
            `INSERT INTO device_cloud_users (company_id, device_id, pin, name, privilege, card) VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name), privilege = VALUES(privilege), card = VALUES(card)`,
            [companyId, d.id, pin, clean(emp.name), privilege, card || null]
        );
        results.push({ device_id: d.id, device_name: label, status: 'queued', command_id: cmd.insertId,
            message: 'Queued - the device applies it on its next check-in (about 30 seconds).' });
    }

    return res.json({
        employee_id: emp.id,
        queued: results.filter((r) => r.status === 'queued').length,
        skipped: results.filter((r) => r.status === 'skipped').length,
        not_sent: ['fingerprint', 'face', 'password'],
        results,
    });
}));

module.exports = router;
