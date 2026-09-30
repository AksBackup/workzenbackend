const express = require('express');
const pool = require('../db');
const asyncHandler = require('../utils/asyncHandler');
const { computeAndRecordOvertime } = require('../utils/overtime');
const { recordPunchEventsAndDeriveAttendance } = require('./attendance');

/**
 * Cloud Server ("ADMS" / iClock push) receiver - what a ZKTeco/eSSL
 * device's Comm -> Cloud Server Setting screen talks to (Server Mode
 * ADMS, Server Address, Server Port). Instead of this app pulling from
 * a device over TCP, the device pushes its attendance log here.
 *
 * Mounted at /iclock in index.js, deliberately WITHOUT
 * verifyFirebaseToken: a device has no way to log in. That makes this
 * the one public, weakly-authenticated door into the API, so it is
 * locked down in layers instead:
 *   1. A device is only accepted if its serial number (?SN=) matches a
 *      `devices.serial_no` AND an admin switched `adms_enabled` ON for
 *      it. Unknown/disabled serials get the same bland "OK" as real
 *      ones (no oracle for guessing serials) but nothing is stored.
 *   2. Per-IP rate limit (in-memory - fine for a single Render
 *      instance; move to a shared store if you ever scale out).
 *   3. Body size limit, strict SN format, defensive line parsing.
 * A serial number is NOT a secret (it's printed on the device), so this
 * is defence against junk/noise, not against a determined attacker who
 * knows a valid serial - be honest about that with customers. The
 * damage such an attacker can do is limited to injecting punch rows for
 * that one device's company.
 *
 * PROTOCOL NOTES (from public open-source ADMS implementations; NOT
 * verified against your specific eSSL firmware - test with the real
 * device and check the Render logs):
 *   GET  /iclock/cdata?SN=..            handshake -> option text below
 *   POST /iclock/cdata?SN=..&table=ATTLOG&Stamp=..   body: text lines
 *        PIN \t "YYYY-MM-DD HH:MM:SS" \t Status \t Verify \t WorkCode ...
 *        -> reply "OK: <n>"
 *   POST /iclock/cdata?...&table=OPERLOG (etc.)      -> acknowledged, ignored
 *   GET  /iclock/getrequest?SN=..       command poll -> "OK" (no commands)
 *   POST /iclock/devicecmd?SN=..        command result -> "OK"
 * Attendance ends up in the same tables the desktop app's pull/USB
 * import write to: raw_punches (browsable log) AND punch_events/
 * attendance via the shared recordPunchEventsAndDeriveAttendance.
 */
const router = express.Router();

// Devices POST text/plain (tab-separated), not JSON.
router.use(express.text({ type: () => true, limit: '1mb' }));

// ---- per-IP rate limit -------------------------------------------------
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 300;
const hits = new Map(); // ip -> { count, resetAt }
setInterval(() => {
    const now = Date.now();
    for (const [ip, h] of hits) if (h.resetAt <= now) hits.delete(ip);
}, WINDOW_MS).unref();

router.use((req, res, next) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    let h = hits.get(ip);
    if (!h || h.resetAt <= now) {
        h = { count: 0, resetAt: now + WINDOW_MS };
        hits.set(ip, h);
    }
    h.count++;
    if (h.count > MAX_REQUESTS_PER_WINDOW) {
        return res.status(429).type('text/plain').send('Too Many Requests');
    }
    next();
});

const SN_PATTERN = /^[A-Za-z0-9_-]{4,40}$/;
const VERIFY_LABELS = { 0: 'password', 1: 'fingerprint', 2: 'card', 15: 'face' };

async function findEnabledDevice(sn) {
    if (!sn || !SN_PATTERN.test(sn)) return null;
    const [rows] = await pool.query(
        'SELECT id, company_id, adms_last_stamp FROM devices WHERE serial_no = ? AND adms_enabled = TRUE LIMIT 1',
        [sn]
    );
    return rows[0] || null;
}


// Parse user rows the device sends (reply to DATA QUERY USERINFO, or USER lines
// inside OPERLOG) and mirror them into device_cloud_users.
async function ingestUsers(device, body) {
    if (typeof body !== 'string' || !body) return 0;
    let n = 0;
    for (const raw of body.split(/\r\n|\r|\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const m = /^(?:USERINFO|USER)\s+(.*)$/i.exec(line);
        const rest = m ? m[1] : line;
        if (!/(^|[\s\t])PIN=/i.test(rest) && !/^pin=/i.test(rest)) continue;
        const kv = {};
        for (const part of rest.split(/\t|\s(?=[A-Za-z]+=)/)) {
            const i = part.indexOf('=');
            if (i > 0) kv[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
        }
        const pin = kv.pin;
        if (!pin || !/^[0-9]{1,9}$/.test(pin)) continue;
        const pri = parseInt(kv.pri !== undefined ? kv.pri : kv.privilege, 10);
        let card = kv.card !== undefined ? kv.card : kv.cardno;
        if (card === '0' || card === '') card = null;
        await pool.query(
            `INSERT INTO device_cloud_users (company_id, device_id, pin, name, privilege, card) VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name), privilege = VALUES(privilege), card = VALUES(card)`,
            [device.company_id, device.id, pin, (kv.name || '').slice(0, 100) || null, Number.isNaN(pri) ? 0 : pri, card]
        );
        n++;
    }
    if (n > 0) {
        await pool.query(
            "UPDATE device_commands SET status = 'acked', done_at = NOW() WHERE device_id = ? AND cmd_type = 'query_users' AND status IN ('sent','acked')",
            [device.id]
        );
        console.log(`[adms] device ${device.id}: ingested ${n} user row(s)`);
    }
    return n;
}

const ok = (res, body = 'OK') => res.status(200).type('text/plain').send(body);

// Handshake - the device asks how to behave when it boots / reconnects.
router.get('/cdata', asyncHandler(async (req, res) => {
    const sn = String(req.query.SN || '');
    const device = await findEnabledDevice(sn);
    if (device) {
        await pool.query('UPDATE devices SET adms_last_seen = NOW(), status = ? WHERE id = ?', ['online', device.id]);
    } else {
        console.warn(`[adms] handshake from unregistered/disabled SN ${sn.slice(0, 40)} (ip ${req.ip})`);
    }
    // Same body either way (see header comment). ATTLOGStamp=None asks
    // for everything; once we have a stamp from a previous push we
    // return it so the device only resends newer records.
    const stamp = device && device.adms_last_stamp ? device.adms_last_stamp : 'None';
    return ok(res, [
        `GET OPTION FROM: ${sn}`,
        `ATTLOGStamp=${stamp}`,
        'OPERLOGStamp=9999',
        'ErrorDelay=30',
        'Delay=30',
        'TransTimes=00:00;14:05',
        'TransInterval=1',
        'TransFlag=TransData AttLog',
        'Realtime=1',
        'Encrypt=0',
    ].join('\n'));
}));

// Data push.
router.post('/cdata', asyncHandler(async (req, res) => {
    const sn = String(req.query.SN || '');
    const table = String(req.query.table || '').toUpperCase();
    const device = await findEnabledDevice(sn);
    if (!device) {
        console.warn(`[adms] push from unregistered/disabled SN ${sn.slice(0, 40)} table=${table} (ip ${req.ip})`);
        return ok(res); // same reply as a real device - see header comment
    }
    await pool.query('UPDATE devices SET adms_last_seen = NOW(), status = ? WHERE id = ?', ['online', device.id]);

    if (table === 'USERINFO' || table === 'USER' || table === 'OPERLOG') {
        await ingestUsers(device, typeof req.body === 'string' ? req.body : '')
            .catch((err) => console.error('[adms] user ingest failed:', err.message));
        return ok(res);
    }
    if (table !== 'ATTLOG') return ok(res); // other tables: acknowledged, not stored

    const body = typeof req.body === 'string' ? req.body : '';
    const parsed = [];
    for (const rawLine of body.split(/\r\n|\r|\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const f = line.split('\t');
        const fields = f.length >= 2 ? f : line.split(/\s+/);
        const pin = (fields[0] || '').trim();
        let idx = 1;
        let ts = (fields[1] || '').trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(ts) && fields[2]) { ts = `${ts} ${fields[2].trim()}`; idx = 2; }
        if (!/^[0-9]+$/.test(pin) || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts)) continue; // malformed - skip
        const status = parseInt(fields[idx + 1], 10);
        const verify = parseInt(fields[idx + 2], 10);
        parsed.push({ pin, ts, status: Number.isNaN(status) ? null : status, verify: Number.isNaN(verify) ? null : verify });
    }

    const companyId = device.company_id;
    const [empRows] = await pool.query('SELECT id, emp_code FROM employees WHERE company_id = ?', [companyId]);
    // Exact match only: the device's User ID is numeric, and "001" vs "1" are
    // deliberately treated as two different IDs.
    const empByCode = new Map(empRows.map((e) => [String(e.emp_code).trim(), e.id]));
    // PINs an admin switched off in Device Users: keep their raw punches but
    // create no attendance (the device itself has no reliable "disabled").
    let disabledPins = new Set();
    try {
        const [dis] = await pool.query('SELECT pin FROM device_cloud_users WHERE device_id = ? AND disabled = 1', [device.id]);
        disabledPins = new Set(dis.map((r) => String(r.pin)));
    } catch (_) { /* table not migrated yet - nothing disabled */ }
    const unmatched = [...new Set(parsed.map((p) => p.pin).filter((pin) => !empByCode.get(pin)))];
    if (unmatched.length) {
        console.warn(`[adms] SN ${sn}: PIN(s) ${unmatched.join(', ')} match no employee emp_code in company ${companyId} - stored in raw_punches only, NO attendance created`);
    }

    // 1) raw_punches (browsable log) - same dedup as POST /raw-punches/bulk.
    let stored = 0;
    for (const p of parsed) {
        const [dup] = await pool.query(
            'SELECT id FROM raw_punches WHERE device_id = ? AND device_user_id = ? AND punch_time = ?',
            [device.id, p.pin, p.ts]
        );
        if (dup.length > 0) continue;
        await pool.query(
            `INSERT INTO raw_punches (company_id, device_id, device_user_id, employee_id, punch_time, verify_mode, in_out_mode)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [companyId, device.id, p.pin, empByCode.get(p.pin) || null, p.ts, p.verify, p.status]
        );
        stored++;
    }

    // 2) attendance - first punch of the day = in, last = out, ignoring
    // the device's own unreliable in/out flag (same rule as the desktop
    // app's pull and USB import). Only employees whose PIN matches an
    // emp_code get attendance; the rest stay visible in raw_punches.
    const groups = new Map(); // "empId|date" -> { employeeId, date, times[], verify }
    for (const p of parsed) {
        const employeeId = empByCode.get(p.pin);
        if (!employeeId || disabledPins.has(p.pin)) continue;
        const date = p.ts.slice(0, 10);
        const key = `${employeeId}|${date}`;
        if (!groups.has(key)) groups.set(key, { employeeId, date, times: [], verify: p.verify });
        groups.get(key).times.push(p.ts);
    }
    for (const g of groups.values()) {
        try {
            g.times.sort();
            const first = g.times[0];
            const last = g.times[g.times.length - 1];
            const [existing] = await pool.query(
                'SELECT punch_time, punch_type FROM punch_events WHERE company_id = ? AND employee_id = ? AND date = ?',
                [companyId, g.employeeId, g.date]
            );
            let checkIn = null;
            let checkOut = null;
            if (existing.length === 0) {
                checkIn = first;
                if (last !== first) checkOut = last;
            } else {
                const stamps = existing.map((e) => new Date(e.punch_time).getTime());
                const earliest = Math.min(...stamps);
                const latest = Math.max(...stamps);
                if (new Date(first.replace(' ', 'T')).getTime() < earliest) checkIn = first; // backdated earlier punch
                if (new Date(last.replace(' ', 'T')).getTime() > latest) checkOut = last; // later than anything recorded
            }
            if (!checkIn && !checkOut) continue; // nothing new for this day
            await recordPunchEventsAndDeriveAttendance({
                companyId, employeeId: g.employeeId, date: g.date, checkIn, checkOut,
                source: 'scanner', deviceId: device.id,
                verifyMode: VERIFY_LABELS[g.verify] || 'unknown', syncedFromLocal: false,
            });
            if (checkOut) {
                await computeAndRecordOvertime(companyId, g.employeeId, g.date, checkOut)
                    .catch((err) => console.error('[adms] overtime computation failed:', err.message));
            }
        } catch (err) {
            console.error('[adms] failed to record attendance for one employee-day:', err.message);
        }
    }

    if (req.query.Stamp) {
        await pool.query('UPDATE devices SET adms_last_stamp = ? WHERE id = ?', [String(req.query.Stamp).slice(0, 40), device.id]);
    }
    console.log(`[adms] SN ${sn}: ${parsed.length} line(s) parsed, ${stored} new raw punch(es)`);
    return ok(res, `OK: ${parsed.length}`);
}));

// Command poll: hand the device its queued commands (see routes/deviceCloud.js).
router.get('/getrequest', asyncHandler(async (req, res) => {
    const device = await findEnabledDevice(String(req.query.SN || ''));
    if (!device) return ok(res);
    await pool.query('UPDATE devices SET adms_last_seen = NOW() WHERE id = ?', [device.id]);
    try {
        // A command handed out but never answered: retry it, give up after 3 sends.
        await pool.query("UPDATE device_commands SET status = 'failed', done_at = NOW(), result_text = 'No reply from device' WHERE device_id = ? AND status = 'sent' AND sent_at < NOW() - INTERVAL 120 SECOND AND attempt >= 3", [device.id]);
        await pool.query("UPDATE device_commands SET status = 'pending' WHERE device_id = ? AND status = 'sent' AND sent_at < NOW() - INTERVAL 120 SECOND AND attempt < 3", [device.id]);
        const [cmds] = await pool.query("SELECT id, cmd_text FROM device_commands WHERE device_id = ? AND status = 'pending' ORDER BY id ASC LIMIT 10", [device.id]);
        if (cmds.length === 0) return ok(res);
        await pool.query("UPDATE device_commands SET status = 'sent', sent_at = NOW(), attempt = attempt + 1 WHERE id IN (?)", [cmds.map((c) => c.id)]);
        console.log(`[adms] SN ${device.id}: sending ${cmds.length} command(s): ${cmds.map((c) => c.cmd_text.split('\t')[0]).join(' | ')}`);
        return ok(res, cmds.map((c) => `C:${c.id}:${c.cmd_text}`).join('\n'));
    } catch (err) {
        console.error('[adms] command delivery failed (is migration_039 applied?):', err.message);
        return ok(res);
    }
}));

// Command result: "ID=<id>&Return=<code>&CMD=<...>" (one or more lines).
async function handleCmdResult(req, res) {
    const device = await findEnabledDevice(String(req.query.SN || ''));
    if (!device) return ok(res);
    try {
        const lines = (typeof req.body === 'string' ? req.body : '').split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
        if (!lines.length && req.query.ID) lines.push(new URLSearchParams(req.query).toString());
        for (const line of lines) {
            const q = new URLSearchParams(line);
            const id = parseInt(q.get('ID'), 10);
            if (Number.isNaN(id)) continue;
            const rc = parseInt(q.get('Return'), 10);
            const [rows] = await pool.query('SELECT id, cmd_type, fallbacks, attempt FROM device_commands WHERE id = ? AND device_id = ?', [id, device.id]);
            if (!rows.length) continue;
            const c = rows[0];
            console.log(`[adms] device ${device.id} result cmd ${id} (${c.cmd_type}): ${line.slice(0, 120)}`);
            if (rc === 0) {
                await pool.query('UPDATE device_commands SET status = ?, return_code = 0, result_text = ?, done_at = NOW() WHERE id = ?',
                    [c.cmd_type === 'query_users' ? 'acked' : 'done', line.slice(0, 500), id]);
                continue;
            }
            let fb = [];
            try { fb = c.fallbacks ? JSON.parse(c.fallbacks) : []; } catch (_) { fb = []; }
            if (fb.length) {
                const [next, ...rest] = fb;
                await pool.query("UPDATE device_commands SET cmd_text = ?, fallbacks = ?, status = 'pending', return_code = ?, result_text = ? WHERE id = ?",
                    [next, rest.length ? JSON.stringify(rest) : null, Number.isNaN(rc) ? null : rc, `First form rejected (${line.slice(0, 200)}); retrying alternate form`, id]);
            } else {
                await pool.query("UPDATE device_commands SET status = 'failed', return_code = ?, result_text = ?, done_at = NOW() WHERE id = ?",
                    [Number.isNaN(rc) ? null : rc, line.slice(0, 500), id]);
            }
        }
    } catch (err) {
        console.error('[adms] devicecmd handling failed:', err.message);
    }
    return ok(res);
}
router.post('/devicecmd', asyncHandler(handleCmdResult));
router.get('/devicecmd', asyncHandler(handleCmdResult));

// Table rows the device returns for DATA QUERY (alternate form).
router.post('/querydata', asyncHandler(async (req, res) => {
    const device = await findEnabledDevice(String(req.query.SN || ''));
    if (device) {
        await ingestUsers(device, typeof req.body === 'string' ? req.body : '')
            .catch((err) => console.error('[adms] querydata ingest failed:', err.message));
    }
    return ok(res);
}));
router.get('/ping', (req, res) => ok(res));

module.exports = router;
