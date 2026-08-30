const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Backup & Restore (SCREENS.md 10.4). Exports/restores every
 * company-scoped operational table EXCEPT `licenses` (per SCREENS.md:
 * "not the license/account record itself"). This implementation also
 * excludes `companies` and `admins` - both are account-identity records
 * tied 1:1 to the license (admins.company_id is UNIQUE), not
 * "operational data" in the sense the other tables are, and
 * re-inserting an admins row on restore risks fighting the Firebase
 * account that already exists for that firebase_uid. Flagged explicitly
 * here and in PASS_NOTES.md since SCREENS.md doesn't spell out this
 * boundary - if the merge agent or product owner wants admins/companies
 * included too, this is the line to revisit.
 *
 * Table list built by reading schema.sql + migration_001 +
 * migration_002 + this agent's own migration_005 table-by-table (see
 * PASS_NOTES.md for the full list and cross-check note for the merge
 * agent, once Agent A/B's own migrations exist alongside these).
 *
 * TABLES is ordered parent-before-child (matches FK dependency order)
 * so restore can insert in this order and delete in reverse order
 * without hitting a foreign-key constraint. `scope` is either the plain
 * company_id column name, or 'via_employees' for the one table
 * (leave_balances) that has no company_id column of its own and is
 * scoped indirectly through employee ownership.
 *
 * Restore strategy: within one transaction, DELETE every existing row
 * for this company across every table (children first), then
 * re-INSERT the exported rows INCLUDING their original numeric `id`
 * columns. This is safe specifically because MySQL AUTO_INCREMENT
 * counters never go backwards or get reused - once an id has been
 * used, deleting that row frees the id *value* but the table's
 * AUTO_INCREMENT counter has already moved past it, so no future
 * INSERT (from this company or any other on the same shared DB) will
 * collide with a restored id. Preserving original ids (rather than
 * remapping every foreign key to freshly-generated ids) is what keeps
 * this restore logic simple and correct in one pass instead of needing
 * a two-phase id-remap per table.
 */
const TABLES = [
    { name: 'departments', scope: 'company_id' },
    { name: 'designations', scope: 'company_id' },
    // --- Added at merge time (Agent D): these 7 tables were introduced
    // by Agent A (branches, shifts, work_codes) and Agent B
    // (manual_punches, visitors, canteen_usage, shift_assignments) and
    // were missing from Agent C's original TABLES list, which was
    // written before A/B's migrations existed to cross-check against
    // (flagged explicitly for this in PASS_NOTES_AGENT_C.md). Without
    // these, a backup taken after this merge would have silently
    // dropped 7 tables with no error to catch it.
    { name: 'branches', scope: 'company_id' },
    { name: 'shifts', scope: 'company_id' },
    { name: 'work_codes', scope: 'company_id' },
    { name: 'leave_types', scope: 'company_id' },
    { name: 'employees', scope: 'company_id' },
    { name: 'devices', scope: 'company_id' },
    { name: 'office_time_policy', scope: 'company_id' },
    { name: 'attendance', scope: 'company_id' },
    { name: 'leave_balances', scope: 'via_employees' },
    { name: 'leave_applications', scope: 'company_id' },
    // Added at merge time - depend on employees (and, for the last one,
    // shifts/work_codes above), so must come after those.
    { name: 'manual_punches', scope: 'company_id' },
    { name: 'visitors', scope: 'company_id' },
    { name: 'canteen_usage', scope: 'company_id' },
    { name: 'shift_assignments', scope: 'company_id' },
    { name: 'payroll_records', scope: 'company_id' },
    { name: 'loans', scope: 'company_id' },
    { name: 'bonuses', scope: 'company_id' },
    { name: 'conveyance_claims', scope: 'company_id' },
    { name: 'tasks', scope: 'company_id' },
    { name: 'holidays', scope: 'company_id' },
    { name: 'weekly_off_config', scope: 'company_id' },
    { name: 'notifications', scope: 'company_id' },
    { name: 'error_logs', scope: 'company_id' },
];

router.get('/export', requireAdmin, asyncHandler(async (req, res) => {
    const companyId = req.user.companyId;
    const backup = { exported_at: new Date().toISOString(), company_id: companyId };

    for (const table of TABLES) {
        if (table.scope === 'via_employees') {
            const [rows] = await pool.query(
                `SELECT lb.* FROM ${table.name} lb
                 JOIN employees e ON e.id = lb.employee_id
                 WHERE e.company_id = ?`,
                [companyId]
            );
            backup[table.name] = rows;
        } else {
            const [rows] = await pool.query(`SELECT * FROM ${table.name} WHERE company_id = ?`, [companyId]);
            backup[table.name] = rows;
        }
    }

    return res.json(backup);
}));

router.post('/restore', requireAdmin, asyncHandler(async (req, res) => {
    const companyId = req.user.companyId;
    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
        return res.status(400).json({ error: 'Request body must be a previously-exported backup object' });
    }

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // Delete existing company data, children first (reverse of TABLES).
        for (let i = TABLES.length - 1; i >= 0; i--) {
            const table = TABLES[i];
            if (table.scope === 'via_employees') {
                await conn.query(
                    `DELETE lb FROM ${table.name} lb JOIN employees e ON e.id = lb.employee_id WHERE e.company_id = ?`,
                    [companyId]
                );
            } else {
                await conn.query(`DELETE FROM ${table.name} WHERE company_id = ?`, [companyId]);
            }
        }

        // Re-insert, parents first, preserving original ids (see file header).
        let totalRows = 0;
        for (const table of TABLES) {
            const rows = Array.isArray(payload[table.name]) ? payload[table.name] : [];
            for (const row of rows) {
                const data = { ...row };
                // Defensive: force company_id to the caller's own company,
                // in case a backup file was moved between companies -
                // never trust a company_id embedded in an uploaded file.
                if (table.scope === 'company_id') {
                    data.company_id = companyId;
                }
                const columns = Object.keys(data);
                if (columns.length === 0) continue;
                const placeholders = columns.map(() => '?').join(', ');
                const values = columns.map(c => data[c]);
                await conn.query(
                    `INSERT INTO ${table.name} (${columns.map(c => `\`${c}\``).join(', ')}) VALUES (${placeholders})`,
                    values
                );
                totalRows++;
            }
        }

        await conn.commit();
        return res.json({ message: 'Restore complete', rows_restored: totalRows });
    } catch (err) {
        await conn.rollback();
        console.error('Restore failed:', err);
        return res.status(500).json({ error: 'Restore failed - no changes were applied (transaction rolled back)', detail: err.message });
    } finally {
        conn.release();
    }
}));

module.exports = router;
