/**
 * Bulk Leave Balance Entry (Addition / Deletion over many employees at once).
 *
 * Storage is the SAME as the single-employee screens, so every reader
 * (leaveQuota.computeMonthlyPaidUsage -> Apply Leave, leave remaining,
 * payroll, reports) sees the same numbers:
 *   - leave_balances.allocated for (employee, leave_type, year) is the value
 *     computeMonthlyPaidUsage reads as the employee's quota.
 *   - every change also writes one leave_adjustments row (the audit trail the
 *     Earn Leave screen already shows), so a change can be voided there.
 *
 * Filter semantics (per dimension: company, branch, department, designation,
 * employee):
 *   - key missing / null / "all"  -> "All": no restriction on that dimension
 *   - array of ids                -> "Few": only those ids (an EMPTY array matches
 *                                    nothing, so a "Few" with nothing ticked is a no-op)
 * Dimensions combine as an intersection. Only ACTIVE employees of the caller's
 * company are ever matched.
 *
 * Period (balance type): 'monthly' (default) edits the per-month quota
 * (leave_balances.allocated); 'yearly' edits an annual pool (leave_yearly_pools,
 * migration_051). A pool > 0 governs that employee/type/year and the monthly quota is
 * ignored (utils/leaveQuota.js). Yearly audit rows start with '[Yearly]'.
 *
 * Modes:
 *   - 'add':    allocated = allocated + amount (a missing row starts from 0, the
 *               same base Earn Leave already uses). Audit row type 'earn', amount +.
 *   - 'delete': allocated = max(0, allocated - amount). Only the amount actually
 *               removed is recorded, as an 'adjust' audit row with a negative amount.
 */
const bad = (message) => Object.assign(new Error(message), { status: 400 });

const YEARLY_MARKER = '[Yearly]';
const MAX_BALANCE = 9999.9;   // leave_balances.allocated is DECIMAL(5,1)
const MAX_TENTHS = 99999;
const CHUNK = 500;

function parseIdList(value, name) {
    if (value === undefined || value === null || value === 'all') return null;
    if (!Array.isArray(value)) throw bad(`filter.${name} must be a list of ids, or left out for "All".`);
    const ids = value.map(Number);
    if (ids.some(n => !Number.isInteger(n) || n <= 0)) throw bad(`filter.${name} contains an invalid id.`);
    return [...new Set(ids)];
}

const FILTER_KEYS = ['companyIds', 'branchIds', 'departmentIds', 'designationIds', 'employeeIds'];

function normalizeFilter(filter) {
    // A malformed or misspelled filter must fail loudly: silently treating it as
    // "All" would apply a Deletion to every employee.
    if (filter === undefined || filter === null) filter = {};
    if (typeof filter !== 'object' || Array.isArray(filter)) throw bad('filter must be an object.');
    const unknown = Object.keys(filter).filter(k => !FILTER_KEYS.includes(k));
    if (unknown.length) throw bad(`Unknown filter key: ${unknown[0]}.`);
    const f = filter;
    return {
        companyIds: parseIdList(f.companyIds, 'companyIds'),
        branchIds: parseIdList(f.branchIds, 'branchIds'),
        departmentIds: parseIdList(f.departmentIds, 'departmentIds'),
        designationIds: parseIdList(f.designationIds, 'designationIds'),
        employeeIds: parseIdList(f.employeeIds, 'employeeIds'),
    };
}

/** Parses `{ "<leave_type_id>": days }` into [{ leaveTypeId, tenths }], dropping zeros. */
function parseBalances(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw bad('balances must be an object of { leave_type_id: days }.');
    }
    const out = [];
    for (const [k, v] of Object.entries(raw)) {
        const id = Number(k);
        if (!Number.isInteger(id) || id <= 0) throw bad(`Invalid leave type id "${k}".`);
        if (v === null || v === undefined || v === '') continue;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) throw bad('Balances must be zero or a positive number of days.');
        if (n > MAX_BALANCE) throw bad(`A balance cannot exceed ${MAX_BALANCE} days.`);
        const tenths = Math.round(n * 10);
        if (Math.abs(n * 10 - tenths) > 1e-9) throw bad('Balances can have at most one decimal place (e.g. 1.5).');
        if (tenths > 0) out.push({ leaveTypeId: id, tenths });
    }
    if (out.length === 0) throw bad('Enter a balance greater than zero for at least one leave type.');
    return out;
}

/**
 * Resolves the employees matched by a filter. `db` is the pool or a
 * transaction connection (both expose query()).
 */
async function resolveEmployees(db, companyId, filter) {
    const f = normalizeFilter(filter);
    const cid = Number(companyId);
    if (f.companyIds !== null && !f.companyIds.includes(cid)) return [];

    const where = ['e.company_id = ?', "LOWER(e.status) = 'active'"];
    const params = [cid];
    const addIn = (column, ids) => {
        if (ids === null) return true;
        if (ids.length === 0) return false;
        where.push(`${column} IN (?)`);
        params.push(ids);
        return true;
    };
    if (!addIn('e.branch_id', f.branchIds)) return [];
    if (!addIn('e.department_id', f.departmentIds)) return [];
    if (!addIn('e.designation_id', f.designationIds)) return [];
    if (!addIn('e.id', f.employeeIds)) return [];

    const [rows] = await db.query(
        `SELECT e.id, e.emp_code, e.name, e.branch_id, e.department_id, e.designation_id, e.status
         FROM employees e WHERE ${where.join(' AND ')} ORDER BY e.name ASC`,
        params
    );
    return rows;
}

/**
 * Applies (or, with dryRun, only counts) an Addition or Deletion for every
 * employee matched by `filter`, in one transaction. Returns a summary.
 */
async function runBulkBalance(pool, { companyId, adminId, year, mode, period = 'monthly', balances, filter, reason, dryRun }) {
    if (!['add', 'delete'].includes(mode)) throw bad("mode must be 'add' or 'delete'.");
    if (!['monthly', 'yearly'].includes(period)) throw bad("period must be 'monthly' or 'yearly'.");
    // monthly -> leave_balances.allocated (per-month quota); yearly -> leave_yearly_pools.allocated (annual pool)
    const table = period === 'yearly' ? 'leave_yearly_pools' : 'leave_balances';
    const y = Number(year);
    if (!Number.isInteger(y) || y < 2000 || y > 2100) throw bad('year must be a valid year.');
    const baseReason = (reason && String(reason).trim()) || (mode === 'add' ? 'Leave balance entry: addition' : 'Leave balance entry: deletion');
    // The marker lets DELETE /leave-adjustments/:id reverse the right store.
    const reasonText = period === 'yearly' ? `${YEARLY_MARKER} ${baseReason}` : baseReason;

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const employees = await resolveEmployees(conn, companyId, filter);
        const empIds = employees.map(e => Number(e.id));
        const typeIds = balances.map(b => b.leaveTypeId);

        const [typeRows] = await conn.query(
            'SELECT id, name FROM leave_types WHERE company_id = ? AND id IN (?)',
            [companyId, typeIds]
        );
        if (typeRows.length !== new Set(typeIds).size) throw bad('One or more leave types were not found for this company.');
        const typeName = new Map(typeRows.map(r => [Number(r.id), r.name]));

        const summary = {
            mode, period, year: y, dry_run: !!dryRun,
            employees_matched: employees.length,
            affected_employees: 0,
            affected_balances: 0,
            total_days: 0,
            by_leave_type: [],
        };
        if (empIds.length === 0) {
            await conn.rollback();
            return summary;
        }

        // Lock the rows that will change so two concurrent bulk runs cannot both
        // read the same starting value and lose one of the additions.
        const [existingRows] = await conn.query(
            `SELECT employee_id, leave_type_id, allocated FROM ${table} WHERE year = ? AND employee_id IN (?) AND leave_type_id IN (?) FOR UPDATE`,
            [y, empIds, typeIds]
        );
        const current = new Map(existingRows.map(r => [`${r.employee_id}|${r.leave_type_id}`, Math.round(Number(r.allocated) * 10)]));

        const upserts = [];  // [employee_id, leave_type_id, year, new allocated]
        const audits = [];   // leave_adjustments rows
        const touched = new Set();
        const perType = new Map();
        let totalTenths = 0;

        for (const emp of empIds) {
            for (const b of balances) {
                const curT = current.get(`${emp}|${b.leaveTypeId}`) ?? 0;
                let deltaT;
                if (mode === 'add') {
                    deltaT = b.tenths;
                } else {
                    deltaT = -Math.min(b.tenths, curT);
                    if (deltaT === 0) continue;
                }
                const nextT = curT + deltaT;
                if (nextT > MAX_TENTHS) throw bad(`A resulting balance would exceed ${MAX_BALANCE} days. Check the amounts.`);

                upserts.push([emp, b.leaveTypeId, y, nextT / 10]);
                audits.push([companyId, emp, b.leaveTypeId, y, deltaT > 0 ? 'earn' : 'adjust', deltaT / 10, reasonText, adminId ?? null]);
                touched.add(emp);
                totalTenths += deltaT;
                const t = perType.get(b.leaveTypeId) ?? { leave_type_id: b.leaveTypeId, leave_type_name: typeName.get(b.leaveTypeId), employees: 0, days: 0 };
                t.employees += 1;
                t.days = Math.round((t.days + deltaT / 10) * 10) / 10;
                perType.set(b.leaveTypeId, t);
            }
        }

        summary.affected_employees = touched.size;
        summary.affected_balances = upserts.length;
        summary.total_days = Math.round(totalTenths) / 10;
        summary.by_leave_type = [...perType.values()];

        if (dryRun || upserts.length === 0) {
            await conn.rollback();
            return summary;
        }

        for (let i = 0; i < upserts.length; i += CHUNK) {
            await conn.query(
                `INSERT INTO ${table} (employee_id, leave_type_id, year, allocated) VALUES ?
                 ON DUPLICATE KEY UPDATE allocated = VALUES(allocated)`,
                [upserts.slice(i, i + CHUNK)]
            );
        }
        for (let i = 0; i < audits.length; i += CHUNK) {
            await conn.query(
                `INSERT INTO leave_adjustments (company_id, employee_id, leave_type_id, year, type, amount, reason, created_by) VALUES ?`,
                [audits.slice(i, i + CHUNK)]
            );
        }

        await conn.commit();
        return summary;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

module.exports = { YEARLY_MARKER, normalizeFilter, parseBalances, resolveEmployees, runBulkBalance };
