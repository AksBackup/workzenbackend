const express = require('express');
const pool = require('../db');
const { requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

/**
 * Cloud Server (ADMS) device control - the cloud equivalent of what the
 * desktop app does over TCP (WiFi / Ethernet). Mounted by devices.js at
 * /devices/:id/cloud, so verifyFirebaseToken already ran.
 *
 * A cloud device can't be called. Every action here QUEUES a command in
 * device_commands; routes/adms.js hands it to the device the next time it
 * polls /iclock/getrequest (~30s) and records the device's reply.
 *
 * Wire commands (confirmed against public ADMS implementations that were
 * tested on real firmware):
 *   DATA UPDATE USERINFO PIN=..<TAB>Name=..<TAB>Pri=..<TAB>Card=..
 *   DATA DELETE USERINFO PIN=..
 *   DATA QUERY USERINFO            (device answers by POSTing its users)
 *   SET OPTIONS DateTime=..        (time sync - encoding is firmware-
 *                                   dependent, see buildTimeCommands)
 */
const router = express.Router({ mergeParams: true });

const PIN_RE = /^[0-9]{1,9}$/; // device User ID is numeric only
const clean = (v) => String(v == null ? '' : v).replace(/[\t\r\n]/g, ' ').trim();

async function getDevice(req, res) {
    const [rows] = await pool.query(
        'SELECT id, company_id, adms_enabled, adms_last_seen FROM devices WHERE id = ? AND company_id = ?',
        [req.params.id, req.user.companyId]
    );
    if (!rows.length) { res.status(404).json({ error: 'Device not found' }); return null; }
    if (!rows[0].adms_enabled) {
        res.status(400).json({ error: 'Cloud Server (ADMS) is not enabled for this device' });
        return null;
    }
    return rows[0];
}

async function enqueue(device, type, text, fallbacks) {
    const [r] = await pool.query(
        'INSERT INTO device_commands (company_id, device_id, cmd_type, cmd_text, fallbacks) VALUES (?, ?, ?, ?, ?)',
        [device.company_id, device.id, type, text, fallbacks && (Array.isArray(fallbacks) ? fallbacks.length : true) ? JSON.stringify(fallbacks) : null]
    );
    return r.insertId;
}

const userCmd = ({ pin, name, privilege, card }) =>
    'DATA UPDATE USERINFO ' + [
        `PIN=${pin}`, `Name=${clean(name)}`, `Pri=${privilege || 0}`, `Privilege=${privilege || 0}`,
        'Passwd=', `Card=${clean(card)}`, 'Grp=1', 'TZ=0000000100000000',
    ].join('\t');

// ZK "encoded" time (used by the TCP protocol and older push firmware).
const zkEncode = (d) =>
    ((d.getFullYear() - 2000) * 12 * 31 + d.getMonth() * 31 + (d.getDate() - 1)) * 86400 +
    d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();

const pad = (n) => String(n).padStart(2, '0');

// The device stores wall-clock time. The admin's chosen wall-clock is sent as
// "seconds" with no timezone shift. Which numeric encoding firmware 8.0.4.2
// wants is NOT verified - default unix; set ADMS_TIME_FORMAT=zk to flip. The
// other encoding is queued as a fallback ONLY if the device rejects the first.
function buildTimeCommands(y, mo, d, h, mi, s) {
    const wall = new Date(y, mo - 1, d, h, mi, s);
    const unix = Math.floor(Date.UTC(y, mo - 1, d, h, mi, s) / 1000);
    // ADMS_TIME_FORMAT picks which encoding is tried FIRST: unix | zk | iso.
    // Devices often answer Return=0 to a time they did not actually apply, so the
    // only way to find the right one for your firmware is to try them one at a
    // time and look at the device's own clock.
    const iso = `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}:${pad(s)}`;
    const all = { unix, zk: zkEncode(wall), iso };
    const first = String(process.env.ADMS_TIME_FORMAT || 'unix').toLowerCase();
    const order = [first, ...['unix', 'zk', 'iso'].filter((k) => k !== first)].filter((k) => k in all);
    const forms = order.map((k) => all[k]);
    // Some firmware spells the verb SET OPTION (singular), some SET OPTIONS.
    // A rejected form (non-zero Return) automatically moves on to the next one.
    const out = [];
    for (const f of forms) for (const verb of ['SET OPTIONS', 'SET OPTION']) out.push(`${verb} DateTime=${f}`);
    return out;
}

// ---- status / polling ------------------------------------------------------
router.get('/status', asyncHandler(async (req, res) => {
    const device = await getDevice(req, res); if (!device) return;
    const [[cnt]] = await pool.query(
        'SELECT COUNT(*) AS total, MAX(punch_time) AS last_punch FROM raw_punches WHERE device_id = ?', [device.id]);
    const [[pend]] = await pool.query(
        "SELECT COUNT(*) AS n FROM device_commands WHERE device_id = ? AND status IN ('pending','sent')", [device.id]);
    const [[age]] = await pool.query(
        'SELECT TIMESTAMPDIFF(SECOND, adms_last_seen, NOW()) AS s FROM devices WHERE id = ?', [device.id]);
    const [recent] = await pool.query(
        'SELECT id, cmd_type, status, return_code, created_at FROM device_commands WHERE device_id = ? ORDER BY id DESC LIMIT 5', [device.id]);
    res.json({
        online: age.s !== null && age.s <= 180, last_seen_seconds_ago: age.s,
        stored_punches: cnt.total, last_punch: cnt.last_punch, pending_commands: pend.n, recent_commands: recent,
    });
}));

router.get('/commands/:cid', asyncHandler(async (req, res) => {
    const device = await getDevice(req, res); if (!device) return;
    const [rows] = await pool.query(
        `SELECT id, cmd_type, status, return_code, result_text, attempt,
                TIMESTAMPDIFF(SECOND, done_at, NOW()) AS quiet_s
           FROM device_commands WHERE id = ? AND device_id = ?`, [req.params.cid, device.id]);
    if (!rows.length) return res.status(404).json({ error: 'Command not found' });
    const c = rows[0];
    // A users query has no single "done" moment: the device acks, then streams
    // rows. Treat it as finished after 6s of quiet.
    if (c.cmd_type === 'query_users' && c.status === 'acked' && c.quiet_s !== null && c.quiet_s >= 6) c.status = 'done';
    res.json(c);
}));

// ---- users mirror ----------------------------------------------------------
router.get('/users', asyncHandler(async (req, res) => {
    const device = await getDevice(req, res); if (!device) return;
    const [rows] = await pool.query(
        'SELECT pin, name, privilege, card, disabled FROM device_cloud_users WHERE device_id = ? ORDER BY CAST(pin AS UNSIGNED)', [device.id]);
    res.json(rows);
}));

router.post('/users/refresh', requireAdmin, asyncHandler(async (req, res) => {
    const device = await getDevice(req, res); if (!device) return;
    const id = await enqueue(device, 'query_users', 'DATA QUERY USERINFO',
        ['DATA QUERY tablename=USERINFO,fielddesc=*,filter=*']);
    res.status(202).json({ id });
}));

// ---- push / delete / rename / card / admin --------------------------------
router.post('/users', requireAdmin, asyncHandler(async (req, res) => {
    const device = await getDevice(req, res); if (!device) return;
    const pin = clean(req.body.pin);
    if (!PIN_RE.test(pin)) return res.status(400).json({ error: 'pin must be numeric (device User ID is numeric only)' });
    const name = clean(req.body.name);
    if (!name) return res.status(400).json({ error: 'name required' });
    const [ex] = await pool.query('SELECT card, privilege FROM device_cloud_users WHERE device_id = ? AND pin = ?', [device.id, pin]);
    // Pushing an employee must never silently demote a device admin: only change
    // privilege when the caller states it, otherwise keep what the device has.
    const privilege = req.body.privilege !== undefined
        ? (Number(req.body.privilege) >= 14 ? 14 : 0)
        : ((ex[0] && ex[0].privilege >= 14) ? 14 : 0);
    const card = req.body.card !== undefined ? clean(req.body.card) : (ex[0] && ex[0].card) || '';
    const id = await enqueue(device, 'user_update', userCmd({ pin, name, privilege, card }));
    await pool.query(
        `INSERT INTO device_cloud_users (company_id, device_id, pin, name, privilege, card) VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), privilege = VALUES(privilege), card = VALUES(card)`,
        [device.company_id, device.id, pin, name, privilege, card || null]);
    res.status(202).json({ id });
}));

router.delete('/users/:pin', requireAdmin, asyncHandler(async (req, res) => {
    const device = await getDevice(req, res); if (!device) return;
    const pin = clean(req.params.pin);
    if (!PIN_RE.test(pin)) return res.status(400).json({ error: 'pin must be numeric' });
    const id = await enqueue(device, 'user_delete', `DATA DELETE USERINFO PIN=${pin}`);
    await pool.query('DELETE FROM device_cloud_users WHERE device_id = ? AND pin = ?', [device.id, pin]);
    res.status(202).json({ id });
}));

// Local-only flag: the device has no "disabled" state we can rely on, so
// adms.js simply skips attendance for disabled PINs (raw punches still kept).
router.put('/users/:pin/enabled', requireAdmin, asyncHandler(async (req, res) => {
    const device = await getDevice(req, res); if (!device) return;
    const pin = clean(req.params.pin);
    await pool.query(
        `INSERT INTO device_cloud_users (company_id, device_id, pin, disabled) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE disabled = VALUES(disabled)`,
        [device.company_id, device.id, pin, req.body.enabled === false ? 1 : 0]);
    res.json({ message: 'Saved' });
}));

router.post('/admins', requireAdmin, asyncHandler(async (req, res) => {
    const device = await getDevice(req, res); if (!device) return;
    const pin = clean(req.body.pin);
    if (!PIN_RE.test(pin)) return res.status(400).json({ error: 'pin must be numeric' });
    const name = clean(req.body.name);
    if (!name) return res.status(400).json({ error: 'name required' });
    const [ex] = await pool.query('SELECT card FROM device_cloud_users WHERE device_id = ? AND pin = ?', [device.id, pin]);
    const id = await enqueue(device, 'admin_grant', userCmd({ pin, name, privilege: 14, card: ex[0] && ex[0].card }));
    await pool.query(
        `INSERT INTO device_cloud_users (company_id, device_id, pin, name, privilege) VALUES (?, ?, ?, ?, 14)
         ON DUPLICATE KEY UPDATE name = VALUES(name), privilege = 14`,
        [device.company_id, device.id, pin, name]);
    res.status(202).json({ id });
}));

// Demote every admin. Needs the users list (refresh it first from the app).
router.post('/admins/clear', requireAdmin, asyncHandler(async (req, res) => {
    const device = await getDevice(req, res); if (!device) return;
    const [admins] = await pool.query(
        'SELECT pin, name, card FROM device_cloud_users WHERE device_id = ? AND privilege >= 14', [device.id]);
    let last = null;
    for (const a of admins) {
        last = await enqueue(device, 'admin_clear', userCmd({ pin: a.pin, name: a.name || a.pin, privilege: 0, card: a.card }));
    }
    await pool.query('UPDATE device_cloud_users SET privilege = 0 WHERE device_id = ? AND privilege >= 14', [device.id]);
    res.status(202).json({ id: last, count: admins.length });
}));

// ---- time -----------------------------------------------------------------
router.post('/time', requireAdmin, asyncHandler(async (req, res) => {
    const device = await getDevice(req, res); if (!device) return;
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(clean(req.body.time));
    if (!m) return res.status(400).json({ error: 'time must be "YYYY-MM-DD HH:MM[:SS]" (device wall-clock time)' });
    const [primary, ...fallbacks] = buildTimeCommands(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0));
    const wallText = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${pad(+(m[6] || 0))}`;
    const id = await enqueue(device, 'set_time', primary, { alts: fallbacks, wall: wallText });
    res.status(202).json({ id });
}));

module.exports = router;
