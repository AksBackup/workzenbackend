const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * PF / ESI / PT (migration_021). See that migration's header comment
 * for the full reasoning and caveats (rates/ceilings are pre-filled
 * defaults, not compliance guidance - every company should confirm
 * its own numbers). This file is settings-only; the actual per-
 * employee calculation each pay run lives in routes/payroll.js
 * (computeStatutoryDeductions), which reads what's saved here.
 */
const DEFAULTS = {
    pf_enabled: false,
    pf_employee_rate: 12.00,
    pf_employer_rate: 12.00,
    pf_apply_ceiling: true,
    pf_wage_ceiling: 15000.00,
    esi_enabled: false,
    esi_employee_rate: 0.75,
    esi_employer_rate: 3.25,
    esi_wage_ceiling: 21000.00,
    pt_enabled: false,
};

function rowToJson(row) {
    if (!row) return { ...DEFAULTS };
    return {
        pf_enabled: !!row.pf_enabled,
        pf_employee_rate: Number(row.pf_employee_rate),
        pf_employer_rate: Number(row.pf_employer_rate),
        pf_apply_ceiling: !!row.pf_apply_ceiling,
        pf_wage_ceiling: Number(row.pf_wage_ceiling),
        esi_enabled: !!row.esi_enabled,
        esi_employee_rate: Number(row.esi_employee_rate),
        esi_employer_rate: Number(row.esi_employer_rate),
        esi_wage_ceiling: Number(row.esi_wage_ceiling),
        pt_enabled: !!row.pt_enabled,
    };
}

// GET /statutory-settings - current PF/ESI/PT config, defaults if the
// company has never saved any (matches office-time-policy's own
// "no row yet = defaults" convention).
router.get('/', asyncHandler(async (req, res) => {
    const [rows] = await pool.query('SELECT * FROM statutory_settings WHERE company_id = ?', [req.user.companyId]);
    return res.json(rowToJson(rows[0]));
}));

// PUT /statutory-settings - upsert, admin-only (this changes what gets
// deducted from every employee's pay - not a setting a regular
// approver should be able to flip).
router.put('/', requireAdmin, asyncHandler(async (req, res) => {
    const merged = { ...DEFAULTS, ...req.body };

    for (const rateField of ['pf_employee_rate', 'pf_employer_rate', 'esi_employee_rate', 'esi_employer_rate']) {
        const v = Number(merged[rateField]);
        if (!Number.isFinite(v) || v < 0 || v > 100) {
            return res.status(400).json({ error: `${rateField} must be a number between 0 and 100` });
        }
    }
    for (const ceilingField of ['pf_wage_ceiling', 'esi_wage_ceiling']) {
        const v = Number(merged[ceilingField]);
        if (!Number.isFinite(v) || v < 0) {
            return res.status(400).json({ error: `${ceilingField} must be a non-negative number` });
        }
    }

    await pool.query(
        `INSERT INTO statutory_settings
           (company_id, pf_enabled, pf_employee_rate, pf_employer_rate, pf_apply_ceiling, pf_wage_ceiling,
            esi_enabled, esi_employee_rate, esi_employer_rate, esi_wage_ceiling, pt_enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           pf_enabled = VALUES(pf_enabled),
           pf_employee_rate = VALUES(pf_employee_rate),
           pf_employer_rate = VALUES(pf_employer_rate),
           pf_apply_ceiling = VALUES(pf_apply_ceiling),
           pf_wage_ceiling = VALUES(pf_wage_ceiling),
           esi_enabled = VALUES(esi_enabled),
           esi_employee_rate = VALUES(esi_employee_rate),
           esi_employer_rate = VALUES(esi_employer_rate),
           esi_wage_ceiling = VALUES(esi_wage_ceiling),
           pt_enabled = VALUES(pt_enabled)`,
        [
            req.user.companyId,
            merged.pf_enabled ? 1 : 0, merged.pf_employee_rate, merged.pf_employer_rate,
            merged.pf_apply_ceiling ? 1 : 0, merged.pf_wage_ceiling,
            merged.esi_enabled ? 1 : 0, merged.esi_employee_rate, merged.esi_employer_rate, merged.esi_wage_ceiling,
            merged.pt_enabled ? 1 : 0,
        ]
    );
    return res.json({ message: 'Statutory settings saved' });
}));

// GET /statutory-settings/pt-slabs - this company's PT brackets,
// lowest min_wage first.
router.get('/pt-slabs', asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        'SELECT id, min_wage, max_wage, pt_amount FROM pt_slabs WHERE company_id = ? ORDER BY min_wage ASC',
        [req.user.companyId]
    );
    return res.json(rows.map(r => ({
        id: r.id, min_wage: Number(r.min_wage), max_wage: r.max_wage === null ? null : Number(r.max_wage), pt_amount: Number(r.pt_amount),
    })));
}));

// PUT /statutory-settings/pt-slabs - replaces the WHOLE slab table for
// this company in one call (body: { slabs: [{min_wage, max_wage,
// pt_amount}, ...] }). A full-replace rather than individual add/
// edit/delete endpoints because slabs only make sense evaluated as one
// complete, non-overlapping table - editing them one row at a time
// invites a state where two rows overlap or a gap is left mid-range.
router.put('/pt-slabs', requireAdmin, asyncHandler(async (req, res) => {
    const { slabs } = req.body;
    if (!Array.isArray(slabs)) {
        return res.status(400).json({ error: 'slabs must be an array' });
    }
    const clean = [];
    for (const s of slabs) {
        const minWage = Number(s.min_wage);
        const maxWage = s.max_wage === null || s.max_wage === undefined || s.max_wage === '' ? null : Number(s.max_wage);
        const ptAmount = Number(s.pt_amount);
        if (!Number.isFinite(minWage) || minWage < 0) {
            return res.status(400).json({ error: 'Each slab needs a non-negative min_wage' });
        }
        if (maxWage !== null && (!Number.isFinite(maxWage) || maxWage <= minWage)) {
            return res.status(400).json({ error: 'max_wage must be greater than min_wage, or left blank for an open-ended top bracket' });
        }
        if (!Number.isFinite(ptAmount) || ptAmount < 0) {
            return res.status(400).json({ error: 'Each slab needs a non-negative pt_amount' });
        }
        clean.push({ minWage, maxWage, ptAmount });
    }
    clean.sort((a, b) => a.minWage - b.minWage);
    for (let i = 1; i < clean.length; i++) {
        const prev = clean[i - 1];
        if (prev.maxWage === null || prev.maxWage > clean[i].minWage) {
            return res.status(400).json({ error: `Slabs overlap or are out of order around ₹${clean[i].minWage}` });
        }
    }

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query('DELETE FROM pt_slabs WHERE company_id = ?', [req.user.companyId]);
        for (const s of clean) {
            await conn.query(
                'INSERT INTO pt_slabs (company_id, min_wage, max_wage, pt_amount) VALUES (?, ?, ?, ?)',
                [req.user.companyId, s.minWage, s.maxWage, s.ptAmount]
            );
        }
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
    return res.json({ message: 'PT slabs saved', count: clean.length });
}));

module.exports = router;
