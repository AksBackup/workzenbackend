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
    const { name, designation, department, department_id, designation_id, doj, salary, biometric_template_id, photo_url } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // Plain sequential digits, unique per company - NOT slug-prefixed.
        // The F22's own User ID field on the device is a real integer, and
        // CMD_USER_WRQ (used to push this ID + name to the device from the
        // app) requires a numeric uid too - a code like "ACME-0007" can't
        // go into either. Uniqueness is still guaranteed per company via
        // the employees table's UNIQUE(company_id, emp_code) constraint.
        const [countRows] = await conn.query(
            'SELECT COUNT(*) AS cnt FROM employees WHERE company_id = ?',
            [req.user.companyId]
        );
        const empCode = String(countRows[0].cnt + 1);
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
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    values.push(req.params.id, req.user.companyId);
    await pool.query(
        `UPDATE employees SET ${updates.join(', ')} WHERE id = ? AND company_id = ?`,
        values
    );
    return res.json({ message: 'Updated' });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM employees WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json({ message: 'Deleted' });
}));

module.exports = router;
