const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

// `companies` table already existed (name, address, phone, email) - one
// row per company (3.1 Company Details is just an edit form over it, no
// new table). Scoped by req.user.companyId same as every other route,
// even though there's only ever one row a given token could reach.
//
// migration_020: company_code is what an employee types into the
// Android app's login (routes/auth.js) to identify which company
// they belong to - see that migration's header comment for why this
// replaced a name-based lookup. Auto-generated at signup
// (routes/license.js), shown here so an admin can hand it to
// employees, and editable below to something more memorable if they
// want (still enforced unique).

router.get('/', asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        'SELECT id, name, company_code, address, phone, email, status FROM companies WHERE id = ?',
        [req.user.companyId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Company not found' });
    return res.json(rows[0]);
}));

router.put('/', requireAdmin, asyncHandler(async (req, res) => {
    const fields = ['name', 'address', 'phone', 'email'];
    const updates = [];
    const values = [];
    fields.forEach(f => {
        if (req.body[f] !== undefined) {
            updates.push(`${f} = ?`);
            values.push(req.body[f]);
        }
    });

    // company_code handled separately from the loop above since it
    // needs its own uniqueness check (a plain UPDATE would just throw a
    // raw MySQL duplicate-key error otherwise) and a normalization step
    // (uppercased, trimmed - matches how routes/auth.js compares it at
    // login, so "acme2026" saved here still matches "ACME2026" typed on
    // a phone).
    if (req.body.company_code !== undefined) {
        const code = String(req.body.company_code).trim().toUpperCase();
        if (!code) return res.status(400).json({ error: 'company_code cannot be empty' });
        const [existing] = await pool.query(
            'SELECT id FROM companies WHERE company_code = ? AND id != ?',
            [code, req.user.companyId]
        );
        if (existing.length > 0) {
            return res.status(409).json({ error: `Company code "${code}" is already in use by another company.` });
        }
        updates.push('company_code = ?');
        values.push(code);
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    values.push(req.user.companyId);
    await pool.query(`UPDATE companies SET ${updates.join(', ')} WHERE id = ?`, values);
    return res.json({ message: 'Updated' });
}));

module.exports = router;
