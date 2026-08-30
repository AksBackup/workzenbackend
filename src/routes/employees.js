const express = require('express');
const admin = require('firebase-admin');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const { generateTempPassword } = require('../utils/employeeCodes');
const asyncHandler = require('../utils/asyncHandler');

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
 * Auto-generates emp_code + a temp password + a Firebase Auth account,
 * and returns the credentials for the admin to hand to the employee.
 */
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { name, designation, department, department_id, designation_id, doj, salary, biometric_template_id, photo_url, emp_code } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

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
        const tempPassword = generateTempPassword();
        // Synthetic login email - never shown to the employee (they only
        // ever see emp_code + tempPassword), so it doesn't need to be
        // pretty, just unique. Company ID keeps it unique across tenants
        // without needing a separate slug function.
        const syntheticEmail = `emp${empCode}@company${req.user.companyId}.local`;

        const firebaseUser = await admin.auth().createUser({
            email: syntheticEmail,
            password: tempPassword,
            displayName: name
        });
        await admin.auth().setCustomUserClaims(firebaseUser.uid, {
            company_id: req.user.companyId,
            role: 'employee'
        });

        const [result] = await conn.query(
            `INSERT INTO employees
             (company_id, emp_code, firebase_uid, name, designation, department, department_id, designation_id, doj, salary, photo_url, biometric_template_id, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
            [req.user.companyId, empCode, firebaseUser.uid, name, designation || null, department || null,
                department_id || null, designation_id || null,
                doj || null, salary || null, photo_url || null, biometric_template_id || null]
        );

        await conn.commit();
        return res.status(201).json({
            id: result.insertId,
            emp_code: empCode,
            login_email: syntheticEmail,
            temp_password: tempPassword
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
    const fields = ['name', 'designation', 'department', 'department_id', 'designation_id', 'doj', 'salary', 'status', 'photo_url'];
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

module.exports = router;
