const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

/**
 * Multi-device employees (migration_050) and device-to-device user copy.
 *
 * Mounted in index.js as TWO prefixes from this one file:
 *   app.use('/employee-devices', employeeDevicesRouter);   -> GET/PUT /employee-devices/:employeeId
 *   app.use('/device-users', deviceUserCopyRouter);        -> POST /device-users/copy
 *
 * "Live" (connection status, same signals routes/devices.js already tracks):
 *   - Cloud Server (ADMS) device: adms_last_seen within the last 180 s.
 *   - TCP/WiFi device: status = 'online' and last_heartbeat within 10 min.
 *     The app writes that heartbeat (PATCH /devices/:id/heartbeat) after it has
 *     actually connected to the device, so this is only as fresh as the app's
 *     last successful connection.
 *
 * The server cannot reach LAN (TCP) devices, so the user copy itself runs in the
 * Flutter app (DeviceUserCopyService). POST /device-users/copy is the gate: it
 * re-checks that the source and every target are live and returns the approved
 * plan. It writes nothing to any device.
 */

const FACE_MODELS = new Set(['mb160', 'mb20', 'x990', 'uface302']); // mirror of DeviceModel.supportsFace (Flutter)
const ADMS_LIVE_SECONDS = 180;
const TCP_HEARTBEAT_LIVE_SECONDS = 600;

const parseId = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
};

async function loadDevices(companyId, ids) {
    if (!ids.length) return [];
    const [rows] = await pool.query(
        `SELECT id, device_name, device_code, location, model, status, adms_enabled,
                TIMESTAMPDIFF(SECOND, adms_last_seen, NOW()) AS adms_age_sec,
                TIMESTAMPDIFF(SECOND, last_heartbeat, NOW()) AS hb_age_sec
           FROM devices WHERE company_id = ? AND id IN (?)`,
        [companyId, ids]
    );
    return rows;
}

function isLive(d) {
    if (d.adms_enabled) return d.adms_age_sec !== null && d.adms_age_sec <= ADMS_LIVE_SECONDS;
    return d.status === 'online' && d.hb_age_sec !== null && d.hb_age_sec <= TCP_HEARTBEAT_LIVE_SECONDS;
}

function describe(d) {
    return {
        id: d.id,
        device_name: d.device_name,
        device_code: d.device_code || null,
        location: d.location || null,
        model: d.model || null,
        transport: d.adms_enabled ? 'adms' : 'tcp',
        live: isLive(d),
        face_capable: FACE_MODELS.has(d.model),
    };
}

async function assignedDevices(companyId, employeeId) {
    const [rows] = await pool.query(
        `SELECT d.id, d.device_name, d.device_code, d.location, d.model, d.status, d.adms_enabled,
                TIMESTAMPDIFF(SECOND, d.adms_last_seen, NOW()) AS adms_age_sec,
                TIMESTAMPDIFF(SECOND, d.last_heartbeat, NOW()) AS hb_age_sec
           FROM employee_devices ed
           JOIN devices d ON d.id = ed.device_id AND d.company_id = ed.company_id
          WHERE ed.employee_id = ? AND ed.company_id = ?
          ORDER BY d.device_name ASC`,
        [employeeId, companyId]
    );
    return rows.map(describe);
}

// ---- employee <-> devices --------------------------------------------------
const employeeRouter = express.Router();
employeeRouter.use(verifyFirebaseToken);

// -> { employee_id, devices: [{ id, device_name, device_code, location, model,
//      transport: 'adms'|'tcp', live, face_capable }] }
employeeRouter.get('/:employeeId', asyncHandler(async (req, res) => {
    const employeeId = parseId(req.params.employeeId);
    if (!employeeId) return res.status(400).json({ error: 'employeeId must be a positive integer' });
    const [emp] = await pool.query('SELECT id FROM employees WHERE id = ? AND company_id = ?', [employeeId, req.user.companyId]);
    if (!emp.length) return res.status(404).json({ error: 'Employee not found' });
    return res.json({ employee_id: employeeId, devices: await assignedDevices(req.user.companyId, employeeId) });
}));

// body: { deviceIds: [number, ...] } - replaces the whole set. [] clears it.
employeeRouter.put('/:employeeId', requireAdmin, asyncHandler(async (req, res) => {
    const companyId = req.user.companyId;
    const employeeId = parseId(req.params.employeeId);
    if (!employeeId) return res.status(400).json({ error: 'employeeId must be a positive integer' });
    const raw = req.body && req.body.deviceIds;
    if (!Array.isArray(raw)) return res.status(400).json({ error: 'deviceIds must be an array' });
    const ids = [...new Set(raw.map(parseId))];
    if (ids.some((id) => id === null)) return res.status(400).json({ error: 'deviceIds must contain only positive integers' });

    const [emp] = await pool.query('SELECT id FROM employees WHERE id = ? AND company_id = ?', [employeeId, companyId]);
    if (!emp.length) return res.status(404).json({ error: 'Employee not found' });

    if (ids.length) {
        const found = await loadDevices(companyId, ids);
        if (found.length !== ids.length) {
            return res.status(400).json({ error: 'One or more deviceIds do not belong to this company' });
        }
    }

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query('DELETE FROM employee_devices WHERE employee_id = ? AND company_id = ?', [employeeId, companyId]);
        if (ids.length) {
            await conn.query(
                'INSERT INTO employee_devices (employee_id, device_id, company_id) VALUES ?',
                [ids.map((d) => [employeeId, d, companyId])]
            );
        }
        // Keep the legacy single column in step (first device, or NULL), for older readers.
        await conn.query(
            'UPDATE employees SET assigned_device_id = ? WHERE id = ? AND company_id = ?',
            [ids.length ? ids[0] : null, employeeId, companyId]
        );
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
    return res.json({ employee_id: employeeId, devices: await assignedDevices(companyId, employeeId) });
}));

// ---- device user copy gate -------------------------------------------------
const deviceUserCopyRouter = express.Router();
deviceUserCopyRouter.use(verifyFirebaseToken);

// body: { sourceDeviceId, targetDeviceIds: [..], conflict: 'overwrite'|'skip' }
// 200 -> { ok: true, conflict, source: {...}, targets: [{...}] }  (see describe())
// 409 -> { error, not_live: [{ id, device_name }] } when any device is not live.
deviceUserCopyRouter.post('/copy', requireAdmin, asyncHandler(async (req, res) => {
    const companyId = req.user.companyId;
    const { sourceDeviceId, targetDeviceIds, conflict } = req.body || {};

    const source = parseId(sourceDeviceId);
    if (!source) return res.status(400).json({ error: 'sourceDeviceId must be a positive integer' });
    if (!Array.isArray(targetDeviceIds) || targetDeviceIds.length === 0) {
        return res.status(400).json({ error: 'targetDeviceIds must be a non-empty array' });
    }
    const targets = [...new Set(targetDeviceIds.map(parseId))];
    if (targets.some((t) => t === null)) return res.status(400).json({ error: 'targetDeviceIds must contain only positive integers' });
    if (targets.includes(source)) return res.status(400).json({ error: 'The source device cannot also be a target' });
    if (conflict !== 'overwrite' && conflict !== 'skip') {
        return res.status(400).json({ error: "conflict must be 'overwrite' or 'skip'" });
    }

    const rows = await loadDevices(companyId, [source, ...targets]);
    if (rows.length !== targets.length + 1) return res.status(404).json({ error: 'Device not found' });

    const byId = new Map(rows.map((r) => [r.id, r]));
    const notLive = rows.filter((r) => !isLive(r)).map((r) => ({ id: r.id, device_name: r.device_name }));
    if (notLive.length) {
        return res.status(409).json({
            error: 'Every source and target device must be connected before copying users. Connect the device(s) listed and try again.',
            not_live: notLive,
        });
    }

    console.log(`[device-users/copy] company ${companyId}: source ${source} -> targets [${targets.join(', ')}], conflict ${conflict}`);
    return res.json({
        ok: true,
        conflict,
        source: describe(byId.get(source)),
        targets: targets.map((t) => describe(byId.get(t))),
    });
}));

module.exports = { employeeDevicesRouter: employeeRouter, deviceUserCopyRouter };
