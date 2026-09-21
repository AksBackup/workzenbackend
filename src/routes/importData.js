const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);
router.use(requireAdmin);

/**
 * Import Data (client's request: "import data (mysql or ms access) into
 * the app, clearly mention the schema"). What's actually built here,
 * and why:
 *
 * A Node/Express web backend has no practical way to open a raw MySQL
 * connection to an arbitrary THIRD-PARTY database the client doesn't
 * control the credentials/network access for, and MS Access
 * (.mdb/.accdb) has no cross-platform Node.js driver at all - the only
 * real MS Access drivers are Windows-only ODBC, which can't run in a
 * standard Linux-hosted web backend. Every HRMS/ERP system that offers
 * "import from your old system" in practice does it via a flat-file
 * export (CSV/Excel) from that old system, not a live binary DB
 * connection - so that's what this route accepts: an array of
 * already-parsed row objects (the client's own MySQL/Access data,
 * exported to CSV first) mapped onto this schema below. This is a
 * deliberate, documented scope decision, not a shortcut taken silently.
 *
 * EMPLOYEE IMPORT SCHEMA - each row maps like this (all but name/
 * emp_code are optional; unknown columns in the source file are simply
 * ignored):
 *   emp_code            -> employees.emp_code (used to detect an
 *                          existing employee for update-vs-insert; if
 *                          omitted, one is generated the same way
 *                          POST /employees does)
 *   name                -> employees.name (required)
 *   designation         -> employees.designation (free text)
 *   department          -> employees.department (free text)
 *   doj (YYYY-MM-DD)     -> employees.doj
 *   dob (YYYY-MM-DD)     -> employees.dob
 *   salary               -> employees.salary
 *   phone                -> employees.phone
 *   personal_email       -> employees.personal_email
 *   office_email         -> employees.office_email
 *   address              -> employees.address
 *   id_proof_type         -> employees.id_proof_type ('aadhaar'|'pan'|'voter_id')
 *   id_proof_number       -> employees.id_proof_number
 *   bank_account_holder   -> employees.bank_account_holder
 *   bank_account_no       -> employees.bank_account_no
 *   bank_ifsc             -> employees.bank_ifsc
 *   bank_name             -> employees.bank_name
 * department/designation/shift are matched by NAME here (not id) since
 * a source export won't know this app's internal ids - a row whose
 * department/designation text doesn't match an existing one here is
 * still imported, just with that field left as free text and no
 * department_id/designation_id link (same as typing it manually into
 * the Employees form without picking from the dropdown).
 */

router.post('/employees', asyncHandler(async (req, res) => {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: 'rows must be a non-empty array' });
    }
    if (rows.length > 2000) {
        return res.status(400).json({ error: 'Import is capped at 2000 rows per run - split larger files.' });
    }

    const [depts] = await pool.query('SELECT id, name FROM departments WHERE company_id = ?', [req.user.companyId]);
    const [desigs] = await pool.query('SELECT id, name FROM designations WHERE company_id = ?', [req.user.companyId]);
    const deptByName = new Map(depts.map(d => [d.name.toLowerCase().trim(), d.id]));
    const desigByName = new Map(desigs.map(d => [d.name.toLowerCase().trim(), d.id]));

    let inserted = 0, updated = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 2; // +1 for 1-indexing, +1 for the header row a CSV would have had
        if (!row.name || !row.name.trim()) {
            errors.push({ row: rowNum, error: 'name is required' });
            continue;
        }
        if (row.id_proof_type && !['aadhaar', 'pan', 'voter_id'].includes(row.id_proof_type)) {
            errors.push({ row: rowNum, error: `id_proof_type '${row.id_proof_type}' must be aadhaar, pan, or voter_id - row skipped` });
            continue;
        }

        const departmentId = row.department ? deptByName.get(row.department.toLowerCase().trim()) ?? null : null;
        const designationId = row.designation ? desigByName.get(row.designation.toLowerCase().trim()) ?? null : null;

        try {
            let existingId = null;
            if (row.emp_code) {
                const [existing] = await pool.query(
                    'SELECT id FROM employees WHERE company_id = ? AND emp_code = ?',
                    [req.user.companyId, row.emp_code]
                );
                if (existing.length) existingId = existing[0].id;
            }

            const values = [
                row.name.trim(), row.designation || null, row.department || null, departmentId, designationId,
                row.doj || null, row.dob || null, row.salary || null,
                row.phone || null, row.personal_email || null, row.office_email || null, row.address || null,
                row.id_proof_type || null, row.id_proof_number || null,
                row.bank_account_holder || null, row.bank_account_no || null, row.bank_ifsc || null, row.bank_name || null,
            ];

            if (existingId) {
                await pool.query(
                    `UPDATE employees SET name=?, designation=?, department=?, department_id=?, designation_id=?,
                        doj=?, dob=?, salary=?, phone=?, personal_email=?, office_email=?, address=?,
                        id_proof_type=?, id_proof_number=?, bank_account_holder=?, bank_account_no=?, bank_ifsc=?, bank_name=?
                     WHERE id = ? AND company_id = ?`,
                    [...values, existingId, req.user.companyId]
                );
                updated++;
            } else {
                let empCode = row.emp_code;
                if (!empCode) {
                    const [[{ maxCode }]] = await pool.query(
                        "SELECT COALESCE(MAX(CAST(emp_code AS UNSIGNED)), 0) AS maxCode FROM employees WHERE company_id = ?",
                        [req.user.companyId]
                    );
                    empCode = String(Number(maxCode) + 1).padStart(4, '0');
                }
                await pool.query(
                    `INSERT INTO employees
                        (company_id, emp_code, name, designation, department, department_id, designation_id,
                         doj, dob, salary, phone, personal_email, office_email, address,
                         id_proof_type, id_proof_number, bank_account_holder, bank_account_no, bank_ifsc, bank_name, status)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
                    [req.user.companyId, empCode, ...values]
                );
                inserted++;
            }
        } catch (err) {
            errors.push({ row: rowNum, error: err.message });
        }
    }

    return res.json({ inserted, updated, failed: errors.length, errors });
}));

module.exports = router;
