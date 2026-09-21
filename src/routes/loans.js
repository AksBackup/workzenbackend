const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Loan / Advance (SCREENS.md 8.1). Two repayment modes as of
 * migration_028 - see that migration's header comment and
 * payroll.js's mark-paid handler for how 'salary_percent' loans are
 * now actually auto-deducted each payroll run (they weren't before -
 * this used to be standalone CRUD only, flagged as a gap in
 * PASS_NOTES.md). 'installments' loans are tracked here via
 * loan_payments but never auto-touched by payroll.
 */

router.get('/', requireAdmin, asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        `SELECT l.*, e.name AS employee_name, e.emp_code AS employee_code,
                COALESCE((SELECT SUM(amount) FROM loan_payments WHERE loan_id = l.id), 0) AS paid_so_far
         FROM loans l
         JOIN employees e ON e.id = l.employee_id
         WHERE l.company_id = ?
         ORDER BY l.created_at DESC`,
        [req.user.companyId]
    );
    // outstanding_balance is derived here rather than stored, so it can
    // never drift from the actual loan_payments ledger.
    const withBalance = rows.map(r => ({
        ...r,
        outstanding_balance: Math.max(0, Number(r.principal_amount) - Number(r.paid_so_far)),
    }));
    return res.json(withBalance);
}));

// GET /loans/:id/payments - the full ledger for one loan (both manual
// installments and payroll_auto salary deductions, in one list, so the
// client's example - 700000 principal, 30000 then 20000... - shows up
// exactly as entered rather than split across two views).
router.get('/:id/payments', requireAdmin, asyncHandler(async (req, res) => {
    const [loanRows] = await pool.query('SELECT id FROM loans WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    if (loanRows.length === 0) return res.status(404).json({ error: 'Loan not found' });
    const [rows] = await pool.query(
        'SELECT * FROM loan_payments WHERE loan_id = ? ORDER BY payment_date DESC, id DESC',
        [req.params.id]
    );
    return res.json(rows);
}));

// POST /loans/:id/payments - log one manual installment (the client's
// "first 30000, then 20000..." flow). Not for 'salary_percent' loans'
// automatic deductions - those are written by payroll.js's mark-paid
// handler only, with source='payroll_auto'.
router.post('/:id/payments', requireAdmin, asyncHandler(async (req, res) => {
    const { amount, payment_date, note } = req.body;
    if (!(amount > 0) || !payment_date) {
        return res.status(400).json({ error: 'amount (> 0) and payment_date are required' });
    }
    const [loanRows] = await pool.query(
        `SELECT l.id, l.principal_amount, COALESCE((SELECT SUM(amount) FROM loan_payments WHERE loan_id = l.id), 0) AS paid_so_far
         FROM loans l WHERE l.id = ? AND l.company_id = ?`,
        [req.params.id, req.user.companyId]
    );
    if (loanRows.length === 0) return res.status(404).json({ error: 'Loan not found' });
    const loan = loanRows[0];
    const outstanding = Number(loan.principal_amount) - Number(loan.paid_so_far);
    if (amount > outstanding + 0.01) {
        return res.status(400).json({ error: `Amount exceeds outstanding balance (${outstanding.toFixed(2)})` });
    }

    const [adminRows] = await pool.query('SELECT id FROM admins WHERE firebase_uid = ?', [req.user.uid]);
    const adminId = adminRows[0] ? adminRows[0].id : null;

    await pool.query(
        `INSERT INTO loan_payments (company_id, loan_id, amount, payment_date, source, note, created_by)
         VALUES (?, ?, ?, ?, 'manual', ?, ?)`,
        [req.user.companyId, req.params.id, amount, payment_date, note || null, adminId]
    );
    if (amount >= outstanding - 0.01) {
        await pool.query("UPDATE loans SET status = 'closed' WHERE id = ? AND company_id = ?", [req.params.id, req.user.companyId]);
    }
    return res.status(201).json({ message: 'Payment recorded' });
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    // migration_028: repayment_mode required going forward -
    // 'salary_percent' (needs salary_deduction_percent) or
    // 'installments' (monthly_deduction is then just a display hint,
    // not auto-applied - see this file's header comment and
    // payroll.js's mark-paid handler for what actually deducts it).
    const { employee_id, principal_amount, monthly_deduction, start_month, start_year,
        repayment_mode = 'installments', salary_deduction_percent, interest_rate } = req.body;
    if (!employee_id || !principal_amount || !start_month || !start_year) {
        return res.status(400).json({ error: 'employee_id, principal_amount, start_month, start_year required' });
    }
    if (!['installments', 'salary_percent'].includes(repayment_mode)) {
        return res.status(400).json({ error: "repayment_mode must be 'installments' or 'salary_percent'" });
    }
    if (repayment_mode === 'salary_percent' && !(salary_deduction_percent > 0)) {
        return res.status(400).json({ error: 'salary_deduction_percent (> 0) is required when repayment_mode is salary_percent' });
    }
    const [result] = await pool.query(
        `INSERT INTO loans (company_id, employee_id, principal_amount, monthly_deduction, repayment_mode, salary_deduction_percent, interest_rate, start_month, start_year)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.user.companyId, employee_id, principal_amount, monthly_deduction || null, repayment_mode,
            salary_deduction_percent || null, interest_rate || null, start_month, start_year]
    );
    return res.status(201).json({ id: result.insertId });
}));

router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
    const fields = ['principal_amount', 'monthly_deduction', 'repayment_mode', 'salary_deduction_percent', 'interest_rate', 'start_month', 'start_year', 'status'];
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
    await pool.query(`UPDATE loans SET ${updates.join(', ')} WHERE id = ? AND company_id = ?`, values);
    return res.json({ message: 'Updated' });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM loans WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json({ message: 'Deleted' });
}));

module.exports = router;
