const express = require('express');
const admin = require('firebase-admin');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');
const { loadWeeklyOffIndex, effectiveOffDaysBitmask, isAltSaturdayOff } = require('../utils/attendanceRules');
const { computeMonthlyPaidUsage } = require('../utils/leaveQuota');

const router = express.Router();
router.use(verifyFirebaseToken);

// Admin: all employees in their company. Employee: only their own record.
router.get('/', asyncHandler(async (req, res) => {
    if (req.user.role === 'admin') {
        const [rows] = await pool.query('SELECT * FROM employees WHERE company_id = ?', [req.user.companyId]);
        return res.json(rows);
    }
    const [rows] = await pool.query(
        'SELECT * FROM employees WHERE company_id = ? AND firebase_uid = ?',
        [req.user.companyId, req.user.uid]
    );
    return res.json(rows);
}));

/**
 * POST /employees
 * Called after a successful biometric enrollment (or manual add).
 * Auto-generates emp_code and stores the employee record.
 *
 * Login is opt-in, per employee, provisioned separately via
 * POST /employees/:id/login below - creating an employee here does
 * NOT create a login. (An earlier pass removed automatic per-employee
 * Firebase account creation on the theory that this app was
 * admin-only; that theory didn't hold - routes/mobilePunch.js and
 * routes/fieldTracking.js both require an employee's own
 * role:'employee' login to let them self-submit their own punches/
 * pings from a phone, which is the entire mechanism a mobile app needs.
 * migration_018 restores it as an explicit admin action instead of an
 * automatic one, since not every employee needs mobile access.)
 */
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { name, designation, department, department_id, designation_id, shift_id, doj, dob, salary, biometric_template_id, photo_url, emp_code, category_id, remote_location_enabled, branch_id,
        phone, personal_email, office_email, address, id_proof_type, id_proof_number, bank_account_holder, bank_account_no, bank_ifsc, bank_name, assigned_device_id,
        pf_percent, epf_percent, esi_percent, pf_limit, ot_rate_type, ot_rate_value, tds_amount, tds_percent, statutory_override_active } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    // migration_035 - Employee Extra Details v2 (statutory/OT overrides).
    // ot_rate_type is single-select like id_proof_type above - only
    // meaningful together with a value, and only one of 'fixed'/'percentage'.
    if (ot_rate_type !== undefined && ot_rate_type !== null && !['fixed', 'percentage'].includes(ot_rate_type)) {
        return res.status(400).json({ error: "ot_rate_type must be 'fixed' or 'percentage'" });
    }

    // id_proof_type is single-select (whichever one document the
    // employee actually provided - Aadhaar OR PAN OR Voter ID, never
    // more than one), matching the id_proof_type ENUM added by
    // migration_024. A number without a type (or vice versa) is
    // rejected rather than silently dropped.
    if ((id_proof_type && !id_proof_number) || (id_proof_number && !id_proof_type)) {
        return res.status(400).json({ error: 'id_proof_type and id_proof_number must be provided together' });
    }
    if (id_proof_type && !['aadhaar', 'pan', 'voter_id'].includes(id_proof_type)) {
        return res.status(400).json({ error: 'id_proof_type must be one of: aadhaar, pan, voter_id' });
    }

    // emp_code is normally auto-generated (see below) but can optionally be
    // supplied explicitly, e.g. to match an ID already printed on an
    // access card. Still digits-only either way - the device's User ID
    // field is a real integer, and CMD_USER_WRQ (used to push this ID +
    // name to the device from the app) requires a numeric uid too, so a
    // code like "ACME-0007" can't go into either.
    if (emp_code !== undefined && emp_code !== null && String(emp_code).trim() !== '') {
        if (!/^[0-9]+$/.test(String(emp_code).trim())) {
            return res.status(400).json({ error: 'emp_code must contain digits only (the device\'s User ID field is numeric)' });
        }
    }

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        let empCode;
        if (emp_code !== undefined && emp_code !== null && String(emp_code).trim() !== '') {
            empCode = String(emp_code).trim();
            const [dupRows] = await conn.query(
                'SELECT id FROM employees WHERE company_id = ? AND emp_code = ?',
                [req.user.companyId, empCode]
            );
            if (dupRows.length > 0) {
                await conn.rollback();
                return res.status(409).json({ error: `emp_code ${empCode} is already used by another employee` });
            }
        } else {
            // Plain sequential digits, unique per company - NOT slug-prefixed.
            // Uniqueness is still guaranteed per company via the employees
            // table's UNIQUE(company_id, emp_code) constraint.
            const [countRows] = await conn.query(
                'SELECT COUNT(*) AS cnt FROM employees WHERE company_id = ?',
                [req.user.companyId]
            );
            empCode = String(countRows[0].cnt + 1);
        }

        const [result] = await conn.query(
            `INSERT INTO employees
             (company_id, emp_code, name, designation, department, department_id, designation_id, shift_id, doj, dob, salary, photo_url, biometric_template_id, category_id, remote_location_enabled, branch_id,
              phone, personal_email, office_email, address, id_proof_type, id_proof_number, bank_account_holder, bank_account_no, bank_ifsc, bank_name, assigned_device_id,
              pf_percent, epf_percent, esi_percent, pf_limit, ot_rate_type, ot_rate_value, tds_amount, tds_percent, statutory_override_active, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
            [req.user.companyId, empCode, name, designation || null, department || null,
                department_id || null, designation_id || null, shift_id || null,
                doj || null, dob || null, salary || null, photo_url || null, biometric_template_id || null,
                category_id || null, !!remote_location_enabled, branch_id || null,
                phone || null, personal_email || null, office_email || null, address || null,
                id_proof_type || null, id_proof_number || null, bank_account_holder || null,
                bank_account_no || null, bank_ifsc || null, bank_name || null, assigned_device_id || null,
                pf_percent ?? null, epf_percent ?? null, esi_percent ?? null, pf_limit ?? null,
                ot_rate_type || null, ot_rate_value ?? null, tds_amount ?? null, tds_percent ?? null,
                !!statutory_override_active]
        );

        await conn.commit();
        return res.status(201).json({
            id: result.insertId,
            emp_code: empCode
        });
    } catch (err) {
        await conn.rollback();
        console.error('Employee creation failed:', err);
        return res.status(500).json({ error: 'Failed to create employee', detail: err.message });
    } finally {
        conn.release();
    }
}));

/**
 * POST /employees/:id/login
 * Provisions (or re-provisions) this employee's mobile login: creates
 * a Firebase Auth account with { company_id, role: 'employee' } custom
 * claims - the exact shape verifyFirebaseToken.js requires - and links
 * it via employees.firebase_uid, the same column mobilePunch.js's
 * _currentEmployeeId() and fieldTracking.js already key off. See
 * migration_018's header comment for why this exists.
 *
 * Deliberately admin-initiated and explicit rather than automatic on
 * every employee create: not every employee needs a phone-facing
 * login (e.g. someone who only ever punches at a fixed biometric
 * terminal), so this is a separate opt-in action, closer in spirit to
 * Device Admin/Device User privilege grants elsewhere in this app than
 * to a mandatory step of onboarding.
 */
/**
 * POST /employees/:id/login
 * body: { password }
 *
 * Sets (or resets) the password an employee uses to sign into the
 * Android app - see routes/auth.js's POST /employee-login for the
 * matching sign-in side. There is deliberately no `email` field here
 * anymore: employees sign in with Organization + Employee ID (emp_code)
 * + Password, never an email address. Firebase Auth still requires an
 * email-shaped identifier internally, so one is auto-generated
 * (`e{id}@mobile.internal`, using the globally-unique employees.id, not
 * emp_code which repeats across companies) and stored in
 * employees.email purely as that hidden identifier - it's never shown
 * to the employee and the app never asks for or displays it.
 */
router.post('/:id/login', requireAdmin, asyncHandler(async (req, res) => {
    const { password } = req.body;
    if (!password) {
        return res.status(400).json({ error: 'password is required' });
    }
    if (String(password).length < 6) {
        return res.status(400).json({ error: 'password must be at least 6 characters (Firebase Auth minimum)' });
    }

    const [empRows] = await pool.query(
        'SELECT id, firebase_uid, name, email FROM employees WHERE id = ? AND company_id = ?',
        [req.params.id, req.user.companyId]
    );
    if (empRows.length === 0) return res.status(404).json({ error: 'Employee not found' });
    const employee = empRows[0];

    if (employee.firebase_uid) {
        // Resetting a password (e.g. employee forgot it) reuses the
        // existing Firebase account and its already-generated hidden
        // email rather than creating a second account and orphaning
        // the first - UNLESS that account no longer actually exists.
        //
        // Real bug hit in testing: some employees carry a firebase_uid
        // left over from an OLDER version of this app (see this file's
        // POST /'s doc comment - it used to auto-create a Firebase
        // account per employee before that was removed and later
        // reintroduced as this explicit opt-in flow). That old
        // Firebase user may since have been deleted/never fully
        // existed, leaving a firebase_uid that points at nothing.
        // updateUser() on a nonexistent uid fails with
        // 'auth/user-not-found' - when that specific error happens,
        // self-heal by falling through to the same "create fresh"
        // path used for an employee who never had a login at all,
        // rather than permanently hard-failing the button.
        try {
            await admin.auth().updateUser(employee.firebase_uid, { password });
            await admin.auth().setCustomUserClaims(employee.firebase_uid, {
                company_id: req.user.companyId,
                role: 'employee',
            });
            return res.json({ message: `Mobile password reset for ${employee.name}` });
        } catch (err) {
            if (err.code !== 'auth/user-not-found') {
                return res.status(500).json({ error: 'Failed to update existing login', detail: err.message });
            }
            // Fall through - stale firebase_uid, treat as if this
            // employee never had a login and create a fresh one below.
        }
    }

    const generatedEmail = `e${employee.id}@mobile.internal`;
    try {
        const firebaseUser = await admin.auth().createUser({ email: generatedEmail, password, displayName: employee.name });
        await admin.auth().setCustomUserClaims(firebaseUser.uid, {
            company_id: req.user.companyId,
            role: 'employee',
        });
        await pool.query(
            'UPDATE employees SET firebase_uid = ?, email = ? WHERE id = ? AND company_id = ?',
            [firebaseUser.uid, generatedEmail, employee.id, req.user.companyId]
        );
        return res.status(201).json({ message: `Mobile login created for ${employee.name} (Employee ID: sign in with their emp_code + this password)` });
    } catch (err) {
        return res.status(409).json({ error: 'Failed to create login', detail: err.message });
    }
}));

// DELETE /employees/:id/login - revoke mobile access without deleting
// the employee record itself (same "sync both sides deliberately"
// spirit as Device Users' delete-time employee-sync prompt). Disables
// the Firebase account (rather than deleting it outright) so
// re-enabling later doesn't require creating a brand new account and
// losing the firebase_uid linkage the employees row already has.
router.delete('/:id/login', requireAdmin, asyncHandler(async (req, res) => {
    const [empRows] = await pool.query(
        'SELECT id, firebase_uid, name FROM employees WHERE id = ? AND company_id = ?',
        [req.params.id, req.user.companyId]
    );
    if (empRows.length === 0) return res.status(404).json({ error: 'Employee not found' });
    const employee = empRows[0];
    if (!employee.firebase_uid) {
        return res.status(400).json({ error: 'This employee has no mobile login to revoke' });
    }
    try {
        await admin.auth().updateUser(employee.firebase_uid, { disabled: true });
    } catch (err) {
        if (err.code !== 'auth/user-not-found') throw err;
        // Same stale-firebase_uid situation POST /:id/login self-heals
        // from (see its comment) - nothing to disable, so clear the
        // dangling reference here instead of reporting a false success
        // ("revoked" implies there was something to revoke) or a
        // confusing 500 for a login that, functionally, already
        // doesn't work.
        await pool.query('UPDATE employees SET firebase_uid = NULL, email = NULL WHERE id = ?', [employee.id]);
        return res.json({ message: `${employee.name} had no working mobile login (stale record) - cleared. They can be set up again from scratch.` });
    }
    return res.json({ message: `Mobile login revoked for ${employee.name}` });
}));

/**
 * PUT /employees/:id
 * `emp_code` is now editable (it wasn't before - only auto-generated at
 * create time). Kept numeric-only here too, not just in the Flutter form,
 * since the device write (CMD_USER_WRQ) and the UNIQUE(company_id,
 * emp_code) constraint both require it - never trust client-side
 * validation alone for a rule the DB/device actually depend on.
 *
 * Device-push dirtiness: whenever `name` or `emp_code` changes, this
 * flips `device_push_status` back to 'pending' automatically. That's the
 * server-side half of "if new changes are made, the Push button must
 * re-enable" - the Flutter button reads this field rather than trying to
 * track dirtiness itself in local widget state (which would be lost the
 * moment the screen is left and re-entered).
 */
router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
    // category_id, remote_location_enabled added by migration_015.
    // branch_id added by migration_016 (Holiday Group resolution needs
    // to know which branch an employee belongs to). phone/personal_email/
    // office_email/address/id_proof_type/id_proof_number/bank_* added by
    // migration_024 (Employees > Extra Details); assigned_device_id
    // added by migration_025 (which registered device this employee's
    // data was pushed to).
    // pf_percent/epf_percent/esi_percent/pf_limit/ot_rate_type/
    // ot_rate_value/tds_amount/tds_percent/statutory_override_active
    // added by migration_035 (Employee Extra Details v2 - per-employee
    // statutory/OT overrides; see that migration's header comment).
    const fields = ['name', 'designation', 'department', 'department_id', 'designation_id', 'shift_id', 'doj', 'dob', 'salary', 'status', 'photo_url', 'category_id', 'remote_location_enabled', 'branch_id',
        'phone', 'personal_email', 'office_email', 'address', 'id_proof_type', 'id_proof_number', 'bank_account_holder', 'bank_account_no', 'bank_ifsc', 'bank_name', 'assigned_device_id',
        'pf_percent', 'epf_percent', 'esi_percent', 'pf_limit', 'ot_rate_type', 'ot_rate_value', 'tds_amount', 'tds_percent', 'statutory_override_active'];
    if (req.body.id_proof_type !== undefined && req.body.id_proof_type !== null
        && !['aadhaar', 'pan', 'voter_id'].includes(req.body.id_proof_type)) {
        return res.status(400).json({ error: 'id_proof_type must be one of: aadhaar, pan, voter_id' });
    }
    if (req.body.ot_rate_type !== undefined && req.body.ot_rate_type !== null
        && !['fixed', 'percentage'].includes(req.body.ot_rate_type)) {
        return res.status(400).json({ error: "ot_rate_type must be 'fixed' or 'percentage'" });
    }
    const updates = [];
    const values = [];
    fields.forEach(f => {
        if (req.body[f] !== undefined) {
            updates.push(`${f} = ?`);
            values.push(req.body[f]);
        }
    });

    let empCodeChanging = false;
    if (req.body.emp_code !== undefined) {
        const newCode = String(req.body.emp_code).trim();
        if (!/^[0-9]+$/.test(newCode)) {
            return res.status(400).json({ error: 'emp_code must contain digits only (the device\'s User ID field is numeric)' });
        }
        const [dupRows] = await pool.query(
            'SELECT id FROM employees WHERE company_id = ? AND emp_code = ? AND id != ?',
            [req.user.companyId, newCode, req.params.id]
        );
        if (dupRows.length > 0) {
            return res.status(409).json({ error: `emp_code ${newCode} is already used by another employee` });
        }
        updates.push('emp_code = ?');
        values.push(newCode);
        empCodeChanging = true;
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    // Any change to name or emp_code invalidates whatever's currently on
    // the device for this employee - force the push button to re-enable
    // rather than silently leaving the device out of date.
    if (req.body.name !== undefined || empCodeChanging) {
        updates.push('device_push_status = ?');
        values.push('pending');
    }

    values.push(req.params.id, req.user.companyId);
    await pool.query(
        `UPDATE employees SET ${updates.join(', ')} WHERE id = ? AND company_id = ?`,
        values
    );
    return res.json({ message: 'Updated' });
}));

/**
 * PATCH /employees/:id/device-push
 * Called by the Flutter app immediately after ZkWriteService.pushUser()
 * (and, when the emp_code changed, after the old device slot has been
 * cleaned up) succeeds. Records exactly what was written so the button
 * can be correctly disabled until the next real edit - this endpoint is
 * the only thing that ever sets device_push_status back to 'pushed'.
 */
router.patch('/:id/device-push', requireAdmin, asyncHandler(async (req, res) => {
    const { emp_code, name } = req.body;
    if (!emp_code || !name) {
        return res.status(400).json({ error: 'emp_code and name are required to record a push' });
    }
    const [result] = await pool.query(
        `UPDATE employees
         SET device_push_status = 'pushed', last_pushed_emp_code = ?, last_pushed_name = ?, last_pushed_at = NOW()
         WHERE id = ? AND company_id = ?`,
        [emp_code, name, req.params.id, req.user.companyId]
    );
    if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Employee not found' });
    }
    const [rows] = await pool.query('SELECT * FROM employees WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json(rows[0]);
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM employees WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json({ message: 'Deleted' });
}));

/**
 * Employee > Assets Allotted (migration_023). "Flexible field" as
 * requested: asset_type/asset_details are free text the admin types
 * themselves (laptop, router, ID card, whatever a given company
 * issues) rather than a fixed list this schema would have to guess.
 * An employee can have many rows over time - some currently allotted
 * (returned_date NULL), some already returned.
 */
function isMissingAssetTable(err) {
    return err && err.code === 'ER_NO_SUCH_TABLE';
}
const MISSING_ASSET_TABLE_MESSAGE =
    'The employee assets table is missing - migration_023_employee_assets.sql has not been run against this database yet. Run it, then try again.';

router.get('/:id/assets', asyncHandler(async (req, res) => {
    if (req.user.role === 'employee') {
        const [selfRows] = await pool.query('SELECT id FROM employees WHERE firebase_uid = ? AND company_id = ?', [req.user.uid, req.user.companyId]);
        if (selfRows.length === 0 || String(selfRows[0].id) !== String(req.params.id)) {
            return res.status(403).json({ error: 'Not authorized to view this employee\'s assets' });
        }
    }
    try {
        const [rows] = await pool.query(
            'SELECT * FROM employee_assets WHERE employee_id = ? AND company_id = ? ORDER BY allotted_date DESC, id DESC',
            [req.params.id, req.user.companyId]
        );
        return res.json(rows);
    } catch (err) {
        if (isMissingAssetTable(err)) return res.status(503).json({ error: MISSING_ASSET_TABLE_MESSAGE });
        throw err;
    }
}));

router.post('/:id/assets', requireAdmin, asyncHandler(async (req, res) => {
    const { asset_type, asset_details, allotted_date, notes } = req.body;
    if (!asset_type || !asset_type.trim()) {
        return res.status(400).json({ error: 'asset_type is required' });
    }
    if (!allotted_date) {
        return res.status(400).json({ error: 'allotted_date is required' });
    }
    const [empRows] = await pool.query('SELECT id FROM employees WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    if (empRows.length === 0) return res.status(404).json({ error: 'Employee not found' });

    try {
        const [result] = await pool.query(
            `INSERT INTO employee_assets (company_id, employee_id, asset_type, asset_details, allotted_date, notes)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [req.user.companyId, req.params.id, asset_type.trim(), asset_details || null, allotted_date, notes || null]
        );
        return res.status(201).json({ id: result.insertId, message: 'Asset recorded' });
    } catch (err) {
        if (isMissingAssetTable(err)) return res.status(503).json({ error: MISSING_ASSET_TABLE_MESSAGE });
        throw err;
    }
}));

// PUT /employees/:id/assets/:assetId - edit any field, most commonly
// used to set returned_date when the asset comes back (leaving it out
// keeps whatever was already stored, same "only touch what's sent"
// convention as the email/statutory settings PUTs elsewhere).
router.put('/:id/assets/:assetId', requireAdmin, asyncHandler(async (req, res) => {
    const { asset_type, asset_details, allotted_date, returned_date, notes } = req.body;
    const [existingRows] = await pool.query(
        'SELECT * FROM employee_assets WHERE id = ? AND employee_id = ? AND company_id = ?',
        [req.params.assetId, req.params.id, req.user.companyId]
    );
    if (existingRows.length === 0) return res.status(404).json({ error: 'Asset record not found' });
    const existing = existingRows[0];

    await pool.query(
        `UPDATE employee_assets SET asset_type = ?, asset_details = ?, allotted_date = ?, returned_date = ?, notes = ?
         WHERE id = ? AND employee_id = ? AND company_id = ?`,
        [
            asset_type !== undefined && asset_type.trim() ? asset_type.trim() : existing.asset_type,
            asset_details !== undefined ? asset_details : existing.asset_details,
            allotted_date !== undefined ? allotted_date : existing.allotted_date,
            returned_date !== undefined ? returned_date : existing.returned_date,
            notes !== undefined ? notes : existing.notes,
            req.params.assetId, req.params.id, req.user.companyId,
        ]
    );
    return res.json({ message: 'Asset updated' });
}));

router.delete('/:id/assets/:assetId', requireAdmin, asyncHandler(async (req, res) => {
    await pool.query(
        'DELETE FROM employee_assets WHERE id = ? AND employee_id = ? AND company_id = ?',
        [req.params.assetId, req.params.id, req.user.companyId]
    );
    return res.json({ message: 'Asset record deleted' });
}));

/**
 * GET /employees/:id/monthly-summary?year=YYYY&month=M
 *
 * Backs the new Employee Details "Attendance & Leave" table (a
 * non-push-to-device view - nothing here touches the biometric device).
 * Aggregates across attendance, holidays, approved leave_applications,
 * weekly_off_config, and overtime_records into one day-by-day grid plus
 * the month's headline numbers, so the Flutter side doesn't have to make
 * 5 separate calls and stitch them together itself.
 *
 * Per-day status precedence (a day can only be one thing): holiday >
 * approved leave > present (has a check-in) > weekly off > absent for
 * any day up to and including today; days after today are 'upcoming'
 * and excluded from every count below.
 */
router.get('/:id/monthly-summary', asyncHandler(async (req, res) => {
    const employeeId = req.params.id;
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const month = parseInt(req.query.month, 10) || (new Date().getMonth() + 1); // 1-12

    const [empRows] = await pool.query(
        'SELECT id, name, emp_code, dob, department, branch_id, shift_id FROM employees WHERE id = ? AND company_id = ?',
        [employeeId, req.user.companyId]
    );
    if (empRows.length === 0) return res.status(404).json({ error: 'Employee not found' });
    if (req.user.role === 'employee') {
        const [selfRows] = await pool.query(
            'SELECT id FROM employees WHERE firebase_uid = ? AND company_id = ?',
            [req.user.uid, req.user.companyId]
        );
        if (selfRows.length === 0 || String(selfRows[0].id) !== String(employeeId)) {
            return res.status(403).json({ error: 'Not authorized to view this employee' });
        }
    }
    const employee = empRows[0];

    const daysInMonth = new Date(year, month, 0).getDate();
    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

    const [attendanceRows] = await pool.query(
        'SELECT date, check_in, check_out, verify_mode FROM attendance WHERE employee_id = ? AND date BETWEEN ? AND ?',
        [employeeId, monthStart, monthEnd]
    );
    // This employee's own holiday group (via their branch, migration_016)
    // - NULL group means "only company-wide (ungrouped) holidays", same
    // as before this employee has a branch assigned.
    let employeeHolidayGroupId = null;
    if (employee.branch_id) {
        const [branchRows] = await pool.query('SELECT holiday_group_id FROM branches WHERE id = ? AND company_id = ?', [employee.branch_id, req.user.companyId]);
        employeeHolidayGroupId = branchRows.length > 0 ? branchRows[0].holiday_group_id : null;
    }
    const [holidayRows] = await pool.query(
        'SELECT date, name, holiday_group_id FROM holidays WHERE company_id = ? AND date BETWEEN ? AND ?',
        [req.user.companyId, monthStart, monthEnd]
    );
    // Only keep holidays that actually apply to this employee - either
    // ungrouped (company-wide) or in their own branch's group. A
    // group-specific holiday for a DIFFERENT group must not show up
    // here, which the old unfiltered query didn't distinguish at all.
    const holidayByDate = new Map();
    for (const row of holidayRows) {
        if (row.holiday_group_id != null && row.holiday_group_id !== employeeHolidayGroupId) continue;
        holidayByDate.set(toDateStr(row.date), row.name);
    }
    const weeklyOffIndex = await loadWeeklyOffIndex(req.user.companyId);
    // migration_027 - shift-level weekly-off (weekly_off_bitmask AND
    // alt_saturdays) now actually resolved via the employee's shift_id,
    // fixing the gap the previous comment here flagged.
    let empShift = null;
    if (employee.shift_id != null) {
        const [shiftRows] = await pool.query(
            'SELECT weekly_off_bitmask, alt_saturdays FROM shifts WHERE id = ? AND company_id = ?',
            [employee.shift_id, req.user.companyId]
        );
        empShift = shiftRows[0] ?? null;
    }
    const offBitmask = effectiveOffDaysBitmask(empShift, employee.department, weeklyOffIndex);
    const altSaturdays = empShift ? empShift.alt_saturdays : null;
    const [leaveRows] = await pool.query(
        `SELECT from_date, to_date FROM leave_applications
         WHERE employee_id = ? AND status = 'approved' AND from_date <= ? AND to_date >= ?`,
        [employeeId, monthEnd, monthStart]
    );

    // Shares computeMonthlyPaidUsage with routes/leaves.js so this
    // screen and Apply Leave/Payroll always agree - see that function's
    // header comment in utils/leaveQuota.js for why this is monthly
    // (by explicit request) rather than the annual-bank version an
    // earlier pass tried first, and how Opening Entry/Earn-Adjust
    // Leave (leave_balances) plug into a monthly reset without a month
    // column of their own.
    const [leaveTypeRows] = await pool.query(
        'SELECT id, name FROM leave_types WHERE company_id = ? ORDER BY name ASC',
        [req.user.companyId]
    );
    const leaveBalances = await Promise.all(leaveTypeRows.map(async lt => {
        const { quota, used } = await computeMonthlyPaidUsage(req.user.companyId, employeeId, lt.id, year, month);
        return {
            leave_type_id: lt.id,
            leave_type_name: lt.name,
            quota,
            used,
            remaining: Math.max(0, Math.round((quota - used) * 10) / 10),
        };
    }));
    const leaveQuota = leaveBalances.reduce((acc, b) => acc + b.quota, 0);



    const [policyRows] = await pool.query(
        'SELECT check_in_window_end FROM office_time_policy WHERE company_id = ?',
        [req.user.companyId]
    );
    // Grace window for an on-time check-in (migration_010) - a check-in
    // after this is still recorded/counted as present, just flagged
    // 'late' below rather than silently unrecorded.
    const checkInWindowEnd = policyRows.length > 0 ? policyRows[0].check_in_window_end : '09:45:00';
    const [overtimeRows] = await pool.query(
        `SELECT id, date, checkout_time, overtime_hours, rate_per_hour, amount, status
         FROM overtime_records WHERE employee_id = ? AND date BETWEEN ? AND ? ORDER BY date ASC`,
        [employeeId, monthStart, monthEnd]
    );

    const attendanceByDate = new Map(attendanceRows.map(r => [toDateStr(r.date), r]));
    const today = toDateStr(new Date());

    const days = [];
    let presentDays = 0, absentDays = 0, leaveDays = 0, holidayDays = 0, weeklyOffDays = 0;

    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const dow = new Date(year, month - 1, d).getDay(); // 0=Sun..6=Sat
        const isWeeklyOff = ((offBitmask >> dow) & 1) === 1 || isAltSaturdayOff(dateStr, altSaturdays);
        const holidayName = holidayByDate.get(dateStr);
        const onLeave = leaveRows.some(l => toDateStr(l.from_date) <= dateStr && toDateStr(l.to_date) >= dateStr);
        const att = attendanceByDate.get(dateStr);
        const isFuture = dateStr > today;

        let status;
        let isLate = false;
        if (holidayName) {
            status = 'holiday';
            holidayDays++;
        } else if (onLeave) {
            status = 'leave';
            leaveDays++;
        } else if (att && att.check_in) {
            status = 'present';
            presentDays++;
            if (timeOfDayStr(att.check_in) > checkInWindowEnd) {
                isLate = true;
            }
        } else if (isWeeklyOff) {
            status = 'weekly_off';
            weeklyOffDays++;
        } else if (isFuture) {
            status = 'upcoming';
        } else {
            status = 'absent';
            absentDays++;
        }

        days.push({
            date: dateStr,
            status,
            check_in: att?.check_in || null,
            check_out: att?.check_out || null,
            verify_mode: att?.verify_mode || null,
            holiday_name: holidayName || null,
            // migration_010: true only when status === 'present' and the
            // check-in landed after check_in_window_end - never changes
            // whether the day counts as present/absent, just flags it.
            is_late: isLate,
        });
    }

    const workingDaysElapsed = presentDays + absentDays;
    const attendancePercentage = workingDaysElapsed > 0
        ? Math.round((presentDays / workingDaysElapsed) * 1000) / 10
        : 0;
    const leaveUsed = leaveBalances.reduce((acc, b) => acc + b.used, 0);
    const leaveRemaining = leaveBalances.reduce((acc, b) => acc + b.remaining, 0);

    const overtimePending = overtimeRows.filter(o => o.status === 'pending');
    const overtimeApproved = overtimeRows.filter(o => o.status === 'approved');
    const sum = (rows, field) => rows.reduce((acc, r) => acc + parseFloat(r[field] || 0), 0);

    return res.json({
        employee_id: employee.id,
        name: employee.name,
        emp_code: employee.emp_code,
        dob: employee.dob,
        year,
        month,
        attendance_percentage: attendancePercentage,
        present_days: presentDays,
        absent_days: absentDays,
        leave_days: leaveDays,
        holiday_days: holidayDays,
        weekly_off_days: weeklyOffDays,
        // DEPRECATED (migration_010): flat sum across leave_balances
        // below, kept only for any caller not yet updated to the
        // per-type breakdown. leave_used here is paid-days-used summed
        // across types (so it can legitimately be less than leave_days,
        // which counts ALL on-leave calendar days regardless of type or
        // paid/unpaid split). leave_balances/leave_quota/leave_used/
        // leave_remaining reset every month (this `month`/`year`) - see
        // utils/leaveQuota.js's computeMonthlyPaidUsage for how Opening
        // Entry/Earn-Adjust Leave plug into that monthly figure.
        leave_quota: leaveQuota,
        leave_used: leaveUsed,
        leave_remaining: leaveRemaining,
        leave_balances: leaveBalances,
        overtime: {
            pending_hours: sum(overtimePending, 'overtime_hours'),
            pending_amount: sum(overtimePending, 'amount'),
            approved_hours: sum(overtimeApproved, 'overtime_hours'),
            approved_amount: sum(overtimeApproved, 'amount'),
            records: overtimeRows.map(o => ({ ...o, date: toDateStr(o.date) })),
        },
        days,
    });
}));

// mysql2 can return DATE columns as JS Date objects (driver-dependent on
// timezone config) or as plain 'YYYY-MM-DD' strings - normalizing here
// once means every comparison above can just do plain string equality
// instead of every call site guessing which shape it got.
function toDateStr(value) {
    if (value instanceof Date) {
        return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
    }
    return String(value).split('T')[0];
}

// attendance.check_in is a DATETIME (mysql2 hands it back as a JS Date),
// but office_time_policy.check_in_window_end is a TIME string
// ('HH:MM:SS') - this pulls just the time-of-day out of the Date so the
// two can be compared lexically (safe for zero-padded HH:MM:SS).
function timeOfDayStr(value) {
    if (value instanceof Date) {
        return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}:${String(value.getSeconds()).padStart(2, '0')}`;
    }
    // Already a string (e.g. 'YYYY-MM-DD HH:MM:SS' or 'HH:MM:SS') -
    // take whatever's after a space if present, else the whole thing.
    const str = String(value);
    return str.includes(' ') ? str.split(' ')[1] : str;
}

module.exports = router;
