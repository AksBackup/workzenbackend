const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');
const { computeAndRecordOvertime } = require('../utils/overtime');
const { checkAgainstZones, checkAgainstZone } = require('./geofenceZones');
const { hasColumn } = require('../utils/columnCache');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Mobile-submitted punch approval (CONTEXT.md section 7/8 item 1).
 *
 * Deliberately mirrors routes/manualPunch.js's shape: a pending-status
 * queue table (`mobile_punches`, migration_013) separate from the real
 * `attendance` table, with the exact same approve-time upsert pattern
 * and FOR UPDATE row locking so a double-tap approve/reject on the same
 * row can't race. The one thing this endpoint set intentionally does
 * NOT copy from manual_punches: manual punches are always admin-entered
 * (requireAdmin on every write), mobile punches are always
 * self-submitted by the employee whose attendance it is - POST / below
 * derives employee_id from the caller's own Firebase identity for the
 * 'employee' role, the same way POST /leave-applications does, rather
 * than trusting an employee_id in the request body. This is what stops
 * one employee's phone from submitting a punch for a co-worker.
 *
 * verify_mode 'mobile' (migration_013) has no live device to validate
 * against; the location reading is the closest thing to a
 * verification, which is exactly why it's captured and shown to the
 * approver rather than trusted outright. Geofencing (CONTEXT.md section
 * 8 item 2, still open) is what would eventually let some of this
 * queue auto-approve instead of every row needing a human look - not
 * built here, this endpoint just makes sure the coordinate exists to
 * check against once that lands.
 */

async function _currentAdminId(req) {
    const [rows] = await pool.query('SELECT id FROM admins WHERE firebase_uid = ?', [req.user.uid]);
    return rows[0] ? rows[0].id : null;
}

async function _currentEmployeeId(req) {
    const [rows] = await pool.query(
        'SELECT id FROM employees WHERE firebase_uid = ? AND company_id = ?',
        [req.user.uid, req.user.companyId]
    );
    return rows[0] ? rows[0].id : null;
}

// GET /mobile-punches?status=pending&employee_id=
// Admin: any employee in the company (optionally filtered). Employee:
// only their own submissions - same restriction shape as GET /attendance
// and GET /leave-applications.
router.get('/', asyncHandler(async (req, res) => {
    const { status, employee_id } = req.query;
    const params = [req.user.companyId];
    const hasGeo = await hasColumn('employees', 'geofence_enabled');
    const hasZone = await hasColumn('employees', 'geofence_zone_id');
    let sql = `SELECT mp.*, e.name AS employee_name, e.emp_code AS employee_code, e.remote_location_enabled${hasGeo ? ', e.geofence_enabled' : ''}${hasZone ? ', e.geofence_zone_id' : ''}
               FROM mobile_punches mp
               JOIN employees e ON e.id = mp.employee_id
               WHERE mp.company_id = ?`;

    if (req.user.role === 'employee') {
        sql += ' AND mp.employee_id = (SELECT id FROM employees WHERE firebase_uid = ? AND company_id = ?)';
        params.push(req.user.uid, req.user.companyId);
    } else if (employee_id) {
        sql += ' AND mp.employee_id = ?';
        params.push(employee_id);
    }

    if (status) {
        sql += ' AND mp.status = ?';
        params.push(status);
    }
    sql += ' ORDER BY mp.date DESC, mp.created_at DESC';

    const [rows] = await pool.query(sql, params);

    // migration_015: attach a geofence check to each row rather than
    // storing it at submission time - see geofenceZones.js's
    // checkAgainstZones comment for why a bad/no reading shouldn't hard
    // -block submission. remote_location_enabled employees skip the
    // check entirely (geofence is meaningless for them by definition -
    // see migration_015's header comment on what that flag means).
    // Computed here, at read time, so a zone added/edited/removed after
    // submission is always reflected against still-pending rows rather
    // than freezing a stale judgement from submission time.
    const rowsWithGeofence = await Promise.all(rows.map(async (row) => {
        // Geofencing is assigned per employee (migration_046): not assigned = may punch anywhere.
        if (hasGeo ? !row.geofence_enabled : row.remote_location_enabled) {
            return { ...row, geofence: { exempt: true } };
        }
        if (row.latitude == null || row.longitude == null) {
            return { ...row, geofence: { exempt: false, hasLocation: false } };
        }
        // Assigned to one specific zone (migration_047) -> judge against THAT zone only.
        const check = row.geofence_zone_id
            ? await checkAgainstZone(req.user.companyId, row.geofence_zone_id, parseFloat(row.latitude), parseFloat(row.longitude))
            : await checkAgainstZones(req.user.companyId, parseFloat(row.latitude), parseFloat(row.longitude));
        return { ...row, geofence: { exempt: false, hasLocation: true, ...check } };
    }));

    return res.json(rowsWithGeofence);
}));

// POST /mobile-punches - the phone submits HERE, never straight to
// /attendance or /attendance/sync (see CONTEXT.md section 7: that's
// the entire point of this queue existing).
// body: { date, check_in?, check_out?, latitude?, longitude?, accuracy_meters?, remark?, employee_id?, photo_base64? }
// employee_id in the body is only honored for an admin caller (e.g. an
// admin keying in a correction later, per migration_013's submitted_by
// comment) - an 'employee' caller always gets their own id, ignoring
// anything sent in the body, so this can't be used to submit on behalf
// of someone else.
// photo_base64 (migration_032) is entirely optional - a punch with no
// photo attached must still succeed exactly as before this migration.
router.post('/', asyncHandler(async (req, res) => {
    const { date, check_in, check_out, latitude, longitude, accuracy_meters, remark, photo_base64 } = req.body;
    if (!date) return res.status(400).json({ error: 'date required' });
    if (!check_in && !check_out) {
        return res.status(400).json({ error: 'At least one of check_in or check_out is required' });
    }

    let employeeId;
    if (req.user.role === 'employee') {
        employeeId = await _currentEmployeeId(req);
        if (!employeeId) return res.status(404).json({ error: 'Employee record not found' });
    } else {
        employeeId = req.body.employee_id;
        if (!employeeId) return res.status(400).json({ error: 'employee_id required for admin-submitted mobile punch' });
    }

    // ---- Geofencing (per employee, migration_046) ---------------------------------------------
    // An employee who is ASSIGNED geofencing can only punch from inside a zone AND only with a
    // photo that was captured and confirmed on the phone. The app must call this endpoint ONLY
    // after the photo is confirmed - cancelling / Back / leaving the camera sends nothing, so no
    // punch exists. The server enforces both rules too, so a modified app cannot skip them.
    // Employees without geofencing may punch from anywhere (location and photo stay optional).
    // Admin-submitted punches are not restricted.
    if (req.user.role === 'employee' && await hasColumn('employees', 'geofence_enabled')) {
        const hasZoneCol = await hasColumn('employees', 'geofence_zone_id');
        const [[emp]] = await pool.query(`SELECT geofence_enabled${hasZoneCol ? ', geofence_zone_id' : ''} FROM employees WHERE id = ?`, [employeeId]);
        if (emp && emp.geofence_enabled) {
            if (!photo_base64) {
                return res.status(400).json({ error: 'A photo is required for this punch. Capture and confirm your photo, then punch again.', code: 'photo_required' });
            }
            if (latitude == null || longitude == null) {
                return res.status(400).json({ error: 'Your location could not be read. Turn on location and try again.', code: 'location_required' });
            }
            // Tied to a specific zone (migration_047) -> only THAT zone counts; otherwise any active zone.
            const zone = emp.geofence_zone_id
                ? await checkAgainstZone(req.user.companyId, emp.geofence_zone_id, parseFloat(latitude), parseFloat(longitude))
                : await checkAgainstZones(req.user.companyId, parseFloat(latitude), parseFloat(longitude));
            if (!zone.inside) {
                return res.status(403).json({
                    error: `You are outside the allowed location${zone.nearestZoneName ? ` (nearest: ${zone.nearestZoneName}, ${zone.nearestDistanceMeters} m away)` : ''}. Move inside the geofence to punch.`,
                    code: 'outside_geofence',
                });
            }
        }
    }

    // ---- First punch of the day is the IN, every later one is an OUT / next punch --------------
    // Whatever the app labelled it, and whichever source made the earlier punches (biometric
    // machine, GPS/mobile, manual, anything else): if the employee has no earlier punch on this
    // date it is the IN, otherwise it is an OUT / next punch.
    const punchTime = check_in || check_out;
    const dayStart = String(date).slice(0, 10);
    const [[prior]] = await pool.query(
        `SELECT
           (SELECT COUNT(*) FROM attendance WHERE employee_id = ? AND date = ? AND (check_in IS NOT NULL OR check_out IS NOT NULL)) +
           (SELECT COUNT(*) FROM manual_punches WHERE employee_id = ? AND date = ? AND status <> 'rejected') +
           (SELECT COUNT(*) FROM mobile_punches WHERE employee_id = ? AND date = ? AND status <> 'rejected') AS n`,
        [employeeId, dayStart, employeeId, dayStart, employeeId, dayStart]);
    const isFirstOfDay = Number(prior.n) === 0;
    const finalCheckIn = isFirstOfDay ? punchTime : null;
    const finalCheckOut = isFirstOfDay ? null : punchTime;

    const [result] = await pool.query(
        `INSERT INTO mobile_punches
            (company_id, employee_id, date, check_in, check_out, latitude, longitude, accuracy_meters, photo_base64, remark, submitted_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            req.user.companyId, employeeId, date, finalCheckIn, finalCheckOut,
            latitude ?? null, longitude ?? null, accuracy_meters ?? null, photo_base64 || null, remark || null, employeeId
        ]
    );
    return res.status(201).json({ id: result.insertId, direction: isFirstOfDay ? 'in' : 'out' });
}));

/**
 * POST /mobile-punches/:id/approve
 *
 * Same upsert shape as manual_punches' approve route and
 * POST /attendance/sync: ON DUPLICATE KEY UPDATE against the
 * (employee_id, date) unique key on `attendance`, check_in/check_out
 * COALESCEd so approving a check-out-only submission doesn't null out
 * an already-recorded check-in for that day (e.g. a scanner punch
 * earlier that morning), and vice versa. source='mobile',
 * verify_mode='mobile' (migration_013) - distinguishable from both a
 * scanner punch and an admin-keyed manual punch downstream in Reports/
 * Payroll.
 */
router.post('/:id/approve', requireAdmin, asyncHandler(async (req, res) => {
    // location_type (migration_026): the approver's Office/Field call
    // for this punch, editable per-punch from the approval screen -
    // never a gate on approval itself (see checkAgainstZones), just a
    // record of the approver's judgement on why an outside-geofence
    // punch is fine.
    const { location_type } = req.body;
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const [rows] = await conn.query(
            'SELECT * FROM mobile_punches WHERE id = ? AND company_id = ? FOR UPDATE',
            [req.params.id, req.user.companyId]
        );
        if (rows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ error: 'Mobile punch not found' });
        }
        const punch = rows[0];
        if (punch.status === 'approved') {
            await conn.rollback();
            return res.status(409).json({ error: `Already ${punch.status}` });
        }

        // Remember the day's attendance as it is BEFORE this approval, so Revert / Delete can restore it exactly.
        const _snap = await require('../utils/punchRevert').snapshotAttendance(conn, req.user.companyId, punch.employee_id, punch.date);

        await conn.query(
            `INSERT INTO attendance (company_id, employee_id, date, check_in, check_out, source, verify_mode)
             VALUES (?, ?, ?, ?, ?, 'mobile', 'mobile')
             ON DUPLICATE KEY UPDATE
               -- First punch of the day is the IN, the latest is the OUT (any source). check_out is
               -- assigned first so it can still see the OLD check_in (MySQL applies SETs left to right).
               check_out = CASE
                 WHEN VALUES(check_in) IS NOT NULL AND check_in IS NOT NULL AND VALUES(check_in) < check_in AND check_out IS NULL THEN check_in
                 WHEN VALUES(check_out) IS NULL THEN check_out
                 WHEN check_out IS NULL THEN VALUES(check_out)
                 ELSE GREATEST(check_out, VALUES(check_out)) END,
               check_in = CASE
                 WHEN VALUES(check_in) IS NULL THEN check_in
                 WHEN check_in IS NULL THEN VALUES(check_in)
                 ELSE LEAST(check_in, VALUES(check_in)) END,
               verify_mode = 'mobile'`,
            [req.user.companyId, punch.employee_id, punch.date, punch.check_in, punch.check_out]
        );

        await require('../utils/punchRevert').saveSnapshot(conn, 'mobile', punch.id, _snap);
        const adminId = await _currentAdminId(req);
        const lt = location_type ? ', location_type = ?' : '';
        const ltVal = location_type ? [location_type] : [];
        await conn.query(
            `UPDATE mobile_punches SET status = 'approved', approved_by = ?, approved_on = NOW()${lt}
             WHERE id = ? AND company_id = ?`,
            [adminId, ...ltVal, req.params.id, req.user.companyId]
        );

        await conn.commit();
        const payrollUpdated = await require('../utils/punchRevert').refreshPayrollSafe(req.user.companyId, punch.employee_id, punch.date);
        if (punch.check_out) {
            await computeAndRecordOvertime(req.user.companyId, punch.employee_id, punch.date, punch.check_out).catch(err =>
                console.error('Overtime computation failed:', err)
            );
        }
        return res.json({ message: 'Approved and written to attendance', payroll_updated: payrollUpdated });
    } catch (err) {
        await conn.rollback();
        console.error('Mobile punch approval failed:', err);
        return res.status(500).json({ error: 'Approval failed', detail: err.message });
    } finally {
        conn.release();
    }
}));

// migration_026 - set/change the Office/Field label on a pending punch
// independent of approving it, so the dropdown in the approval screen
// can save immediately as the approver changes it rather than only on
// final Approve.
router.patch('/:id/location-type', requireAdmin, asyncHandler(async (req, res) => {
    const { location_type } = req.body;
    if (!location_type) return res.status(400).json({ error: 'location_type is required' });
    await pool.query(
        'UPDATE mobile_punches SET location_type = ? WHERE id = ? AND company_id = ?',
        [location_type, req.params.id, req.user.companyId]
    );
    return res.json({ message: 'Updated' });
}));

router.post('/:id/reject', requireAdmin, asyncHandler(require('../utils/punchRevert').makeRejectHandler({ pool, table: 'mobile_punches', kind: 'mobile', currentAdminId: _currentAdminId })));

require('../utils/punchRevert').addRevertAndDelete(router, { pool, requireAdmin, asyncHandler, table: 'mobile_punches', kind: 'mobile' });

module.exports = router;
