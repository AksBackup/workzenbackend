const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Salary Structure (migration_029) - Basic + HRA + Conveyance + Special
 * Allowance per employee. gross_salary (the sum) is copied into
 * employees.salary on every save, which is the ONLY field
 * payroll.js's computeMonthlyPayroll actually reads - this table is
 * purely what feeds that field from named components instead of an
 * admin typing one flat number directly on the employee record.
 * computeMonthlyPayroll needed NO changes for this to work.
 */

router.get('/:employeeId', requireAdmin, asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        'SELECT * FROM salary_structures WHERE employee_id = ? AND company_id = ?',
        [req.params.employeeId, req.user.companyId]
    );
    if (rows.length === 0) return res.json(null);
    return res.json(rows[0]);
}));

router.put('/:employeeId', requireAdmin, asyncHandler(async (req, res) => {
    const { basic, hra, conveyance, special_allowance, effective_from } = req.body;
    const b = Number(basic) || 0;
    const h = Number(hra) || 0;
    const c = Number(conveyance) || 0;
    const s = Number(special_allowance) || 0;
    const gross = b + h + c + s;
    if (gross <= 0) {
        return res.status(400).json({ error: 'At least one component must be greater than 0' });
    }
    const [empRows] = await pool.query('SELECT id FROM employees WHERE id = ? AND company_id = ?', [req.params.employeeId, req.user.companyId]);
    if (empRows.length === 0) return res.status(404).json({ error: 'Employee not found' });

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query(
            `INSERT INTO salary_structures (company_id, employee_id, basic, hra, conveyance, special_allowance, gross_salary, effective_from)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                basic = VALUES(basic), hra = VALUES(hra), conveyance = VALUES(conveyance),
                special_allowance = VALUES(special_allowance), gross_salary = VALUES(gross_salary),
                effective_from = VALUES(effective_from)`,
            [req.user.companyId, req.params.employeeId, b, h, c, s, gross, effective_from || new Date()]
        );
        // The one line that actually feeds payroll - see this file's
        // header comment.
        await conn.query('UPDATE employees SET salary = ? WHERE id = ? AND company_id = ?', [gross, req.params.employeeId, req.user.companyId]);
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
    return res.json({ message: 'Salary structure saved', gross_salary: gross });
}));

module.exports = router;
