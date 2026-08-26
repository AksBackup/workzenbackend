const express = require('express');
const admin = require('firebase-admin');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const { slugify, generateTempPassword } = require('../utils/employeeCodes');

const router = express.Router();
router.use(verifyFirebaseToken);

// Admin: all employees in their company. Employee: only their own record.
router.get('/', async (req, res) => {
    if (req.user.role === 'admin') {
        const [rows] = await pool.query('SELECT * FROM employees WHERE company_id = ?', [req.user.companyId]);
        return res.json(rows);
    }
    const [rows] = await pool.query(
        'SELECT * FROM employees WHERE company_id = ? AND firebase_uid = ?',
        [req.user.companyId, req.user.uid]
    );
    return res.json(rows);
});

/**
 * POST /employees
 * Called after a successful biometric enrollment (or manual add).
 * Auto-generates emp_code + a temp password + a Firebase Auth account,
 * and returns the credentials for the admin to hand to the employee.
 */
router.post('/', requireAdmin, async (req, res) => {
    const { name, designation, department, doj, salary, biometric_template_id, photo_url } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const [companyRows] = await conn.query('SELECT name FROM companies WHERE id = ?', [req.user.companyId]);
        const slug = slugify(companyRows[0] && companyRows[0].name);

        const [countRows] = await conn.query(
            'SELECT COUNT(*) AS cnt FROM employees WHERE company_id = ?',
            [req.user.companyId]
        );
        const empCode = `${slug}-${String(countRows[0].cnt + 1).padStart(4, '0')}`;
        const tempPassword = generateTempPassword();
        const syntheticEmail = `${empCode.toLowerCase()}@${slug.toLowerCase()}.local`;

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
             (company_id, emp_code, firebase_uid, name, designation, department, doj, salary, photo_url, biometric_template_id, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
            [req.user.companyId, empCode, firebaseUser.uid, name, designation || null, department || null,
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
});

router.put('/:id', requireAdmin, async (req, res) => {
    const fields = ['name', 'designation', 'department', 'doj', 'salary', 'status', 'photo_url'];
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
});

router.delete('/:id', requireAdmin, async (req, res) => {
    await pool.query('DELETE FROM employees WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json({ message: 'Deleted' });
});

module.exports = router;
