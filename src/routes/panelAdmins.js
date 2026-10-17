const express = require('express');
const admin = require('firebase-admin');
const pool = require('../db');
const adminPanelAuth = require('../middleware/adminPanelAuth');
const { requireSuperAdmin } = adminPanelAuth;
const { configuredPlatformAdmins } = require('../middleware/platformAuth');
const asyncHandler = require('../utils/asyncHandler');
const { logPanelAction, isMissingMigration, MIGRATION_MESSAGE } = require('../utils/panelAudit');
const { LOCK_KEY } = require('../middleware/screenLock');
const { markCompanyRemoved } = require('../middleware/verifyFirebaseToken');

const router = express.Router();

/*
 * Vendor panel API for the /admin and /254 consoles. Authentication is
 * Firebase only (see middleware/adminPanelAuth.js): every route needs a
 * platform admin token, and the routes marked "super" additionally need
 * role super_admin (SUPER_ADMIN_UIDS). The legacy POST /panel/login,
 * /panel/logout and the panel_sessions table are no longer used.
 *
 *   GET  /panel/me                              any platform admin
 *   GET  /panel/companies                       any platform admin
 *   GET  /panel/admins                          super
 *   POST /panel/admins                          super (adds a Firebase UID as role 'admin' only)
 *   PUT  /panel/admins/:uid/status              super (DB-added admins)
 *   DELETE /panel/admins/:uid                   super (DB-added admins; env admins cannot be removed)
 *   POST /panel/companies/:id/delete-data       super (typed confirmation; dry_run supported;
 *                                               `release: true` also frees the PC(s) - see below)
 *   POST /panel/companies/:id/release-pc        super (frees the PC(s)/key(s) of a company whose data
 *                                               was ALREADY deleted without `release`)
 *   GET  /panel/audit-log                       super
 * No passwords are handled here: admins are Firebase UIDs, created in Firebase by the owner.
 */
router.use(adminPanelAuth);

function sendMissingMigration(res) {
    return res.status(503).json({ error: MIGRATION_MESSAGE, code_hint: 'migration_052_missing' });
}

router.get('/me', (req, res) => {
    const p = req.platform;
    return res.json({
        admin: { uid: p.uid, name: p.name || null, email: p.email || null },
        role: p.role,
        via: 'firebase',
    });
});

// GET /panel/audit-log - super only. Newest first, capped. `panel_admin_name`
// is kept for rows written by the legacy panel; new rows carry the Firebase
// actor in actor_name / actor_email / firebase_uid.
router.get('/audit-log', requireSuperAdmin, asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    try {
        const [rows] = await pool.query(
            `SELECT l.id, l.action, l.target_type, l.target_id, l.detail, l.created_at,
                    l.firebase_uid, l.actor_email, l.actor_name,
                    a.name AS panel_admin_name, a.email AS panel_admin_email
             FROM panel_audit_log l
             LEFT JOIN panel_admins a ON a.id = l.panel_admin_id
             ORDER BY l.created_at DESC
             LIMIT ?`,
            [limit]
        );
        return res.json(rows);
    } catch (err) {
        if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
        // Actor columns not there yet: still show the log, without who.
        const [rows] = await pool.query(
            `SELECT l.id, l.action, l.target_type, l.target_id, l.detail, l.created_at,
                    a.name AS panel_admin_name, a.email AS panel_admin_email
             FROM panel_audit_log l
             LEFT JOIN panel_admins a ON a.id = l.panel_admin_id
             ORDER BY l.created_at DESC
             LIMIT ?`,
            [limit]
        );
        res.set('X-Migration-Warning', 'migration_052 not applied');
        return res.json(rows);
    }
}));

// GET /panel/companies - any platform admin. Aggregate view for the
// Companies tab: admin, active employees, license counts, plus BOTH lock
// mechanisms:
//   feature_flags            companies.feature_flags {payroll, geofence}; false = feature not licensed
//   screens_locked           screen_locks master lock (default locked when no row)
router.get('/companies', asyncHandler(async (req, res) => {
    const base = `SELECT c.id, c.name, c.company_code, c.status, c.feature_flags, c.created_at,
                a.name AS admin_name, a.email AS admin_email,
                (SELECT COUNT(*) FROM employees e WHERE e.company_id = c.id AND e.status = 'active') AS active_employee_count,
                (SELECT COUNT(*) FROM licenses l WHERE l.company_id = c.id) AS license_count,
                (SELECT COUNT(*) FROM licenses l WHERE l.company_id = c.id AND l.status = 'active') AS active_license_count`;
    let rows;
    try {
        [rows] = await pool.query(
            `${base}, COALESCE(sl.locked, 1) AS screens_locked, sl.updated_by_email AS lock_updated_by_email, sl.updated_at AS lock_updated_at
             FROM companies c
             LEFT JOIN admins a ON a.company_id = c.id
             LEFT JOIN screen_locks sl ON sl.company_id = c.id AND sl.lock_key = ?
             ORDER BY c.created_at DESC`,
            [LOCK_KEY]
        );
    } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
        // screen_locks (migration_048) missing: no lock rows exist, which the
        // middleware treats as locked.
        [rows] = await pool.query(`${base}, 1 AS screens_locked, NULL AS lock_updated_by_email, NULL AS lock_updated_at
             FROM companies c LEFT JOIN admins a ON a.company_id = c.id ORDER BY c.created_at DESC`);
    }
    let removed = new Map();
    try {
        const [d] = await pool.query('SELECT company_id, deleted_at FROM company_deletions');
        removed = new Map(d.map((x) => [Number(x.company_id), x.deleted_at]));
    } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
    }
    return res.json(rows.map((r) => {
        let flags = r.feature_flags;
        if (typeof flags === 'string') { try { flags = JSON.parse(flags); } catch (_) { flags = {}; } }
        return { ...r, feature_flags: flags || {}, screens_locked: !!Number(r.screens_locked), removed: removed.has(Number(r.id)), removed_at: removed.get(Number(r.id)) || null };
    }));
}));

// ---- Platform admins, UID only (super only) ----

const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;

async function dbRows() {
    try {
        const [rows] = await pool.query(
            'SELECT firebase_uid, email, name, role, status, created_at, created_by_uid FROM platform_admins ORDER BY created_at ASC'
        );
        return { rows, missing: false };
    } catch (err) {
        if (isMissingMigration(err)) return { rows: [], missing: true };
        throw err;
    }
}

// Display info for env-configured UIDs (best effort; Firebase may be unavailable).
async function firebaseInfo(uid) {
    try {
        const u = await admin.auth().getUser(uid);
        return { email: u.email || null, name: u.displayName || null };
    } catch (_) {
        return { email: null, name: null };
    }
}

// Who is this uid? { uid, role, source: 'env'|'db', row } or null.
async function findTarget(uid) {
    const env = configuredPlatformAdmins().find((a) => a.uid === uid);
    const { rows } = await dbRows();
    const row = rows.find((r) => r.firebase_uid === uid) || null;
    if (env && env.role === 'super_admin') return { uid, role: 'super_admin', source: 'env', row };
    if (env) return { uid, role: 'admin', source: 'env', row };
    if (row) return { uid, role: 'admin', source: 'db', row };
    return null;
}

// GET /panel/admins - env accounts ("from environment", read-only) plus DB-added admins.
router.get('/admins', requireSuperAdmin, asyncHandler(async (req, res) => {
    const { rows, missing } = await dbRows();
    const out = [];
    const seen = new Set();
    const envList = configuredPlatformAdmins();
    const infos = await Promise.all(envList.map((a) => firebaseInfo(a.uid)));
    envList.forEach((a, i) => {
        const row = rows.find((r) => r.firebase_uid === a.uid);
        seen.add(a.uid);
        out.push({
            firebase_uid: a.uid,
            name: (row && row.name) || infos[i].name || null,
            email: (row && row.email) || infos[i].email || null,
            role: a.role,
            status: row ? row.status : 'active',
            source: 'env',
            created_at: row ? row.created_at : null,
        });
    });
    rows.filter((r) => !seen.has(r.firebase_uid)).forEach((r) => out.push({
        firebase_uid: r.firebase_uid, name: r.name, email: r.email, role: 'admin',
        status: r.status, source: 'db', created_at: r.created_at,
    }));
    const body = { admins: out };
    if (missing) body.warning = MIGRATION_MESSAGE;
    return res.json(body);
}));

// POST /panel/admins - add an app admin by Firebase UID. body: { firebase_uid, name?, email? }
router.post('/admins', requireSuperAdmin, asyncHandler(async (req, res) => {
    const { firebase_uid, name, email, role } = req.body || {};
    const uid = String(firebase_uid || '').trim();
    if (!UID_RE.test(uid)) {
        return res.status(400).json({ error: 'firebase_uid is required: up to 128 characters, letters, digits, "_" and "-" only' });
    }
    if (role && role !== 'admin') {
        return res.status(403).json({ error: 'Only app admins can be added here. Super admins are configured with SUPER_ADMIN_UIDS.' });
    }
    const env = configuredPlatformAdmins().find((a) => a.uid === uid);
    if (env) {
        return res.status(409).json({ error: env.role === 'super_admin'
            ? 'That UID is already a super admin (SUPER_ADMIN_UIDS).'
            : 'That UID is already an admin from the environment (ADMIN_UIDS).' });
    }
    const { rows, missing } = await dbRows();
    if (missing) return sendMissingMigration(res);
    if (rows.some((r) => r.firebase_uid === uid)) return res.status(409).json({ error: 'That UID is already a platform admin.' });

    // Optional existence check; skipped when firebase-admin is unavailable.
    let fbUser = null;
    try {
        const a = admin.auth();
        if (a && typeof a.getUser === 'function') fbUser = await a.getUser(uid);
    } catch (err) {
        const code = err && (err.code || (err.errorInfo && err.errorInfo.code));
        if (code === 'auth/user-not-found') return res.status(404).json({ error: 'No Firebase user exists with that UID.' });
        // any other failure (Firebase unavailable): skip the check
    }
    const cleanName = (name && String(name).trim()) || (fbUser && fbUser.displayName) || null;
    const cleanEmail = (email && String(email).trim().toLowerCase()) || (fbUser && fbUser.email) || null;
    try {
        await pool.query(
            `INSERT INTO platform_admins (firebase_uid, email, name, role, status, created_by_uid)
             VALUES (?, ?, ?, 'admin', 'active', ?)`,
            [uid, cleanEmail, cleanName, req.platform.uid]
        );
    } catch (err) {
        if (isMissingMigration(err)) return sendMissingMigration(res);
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That UID is already a platform admin.' });
        throw err;
    }
    await logPanelAction(req, 'add_platform_admin', 'platform_admin', null, { firebase_uid: uid, email: cleanEmail, name: cleanName, role: 'admin' });
    return res.status(201).json({ firebase_uid: uid, email: cleanEmail, name: cleanName, role: 'admin', status: 'active', source: 'db' });
}));

// PUT /panel/admins/:uid/status - disable / re-enable a DB-added admin (effective immediately:
// platformAuth checks the table on every request).
router.put('/admins/:uid/status', requireSuperAdmin, asyncHandler(async (req, res) => {
    const { status } = req.body || {};
    if (!['active', 'disabled'].includes(status)) {
        return res.status(400).json({ error: "status must be 'active' or 'disabled'" });
    }
    const uid = req.params.uid;
    if (uid === req.platform.uid) return res.status(400).json({ error: 'You cannot change your own account status.' });
    const target = await findTarget(uid);
    if (!target) return res.status(404).json({ error: 'Platform admin not found' });
    if (target.source === 'env') {
        return res.status(400).json({ error: 'This admin comes from the environment (ADMIN_UIDS / SUPER_ADMIN_UIDS). Edit the environment variable to change it.' });
    }
    try {
        await pool.query('UPDATE platform_admins SET status = ? WHERE firebase_uid = ?', [status, uid]);
    } catch (err) {
        if (isMissingMigration(err)) return sendMissingMigration(res);
        throw err;
    }
    await logPanelAction(req, 'set_platform_admin_status', 'platform_admin', null, { firebase_uid: uid, status });
    return res.json({ message: 'Updated', status });
}));

// DELETE /panel/admins/:uid - remove a DB-added admin. Env admins cannot be removed here.
router.delete('/admins/:uid', requireSuperAdmin, asyncHandler(async (req, res) => {
    const uid = req.params.uid;
    const target = await findTarget(uid);
    if (!target) return res.status(404).json({ error: 'Platform admin not found' });
    if (target.source === 'env') {
        return res.status(400).json({ error: 'This admin comes from the environment and cannot be removed here. Edit ADMIN_UIDS / SUPER_ADMIN_UIDS instead.' });
    }
    try {
        await pool.query('DELETE FROM platform_admins WHERE firebase_uid = ?', [uid]);
    } catch (err) {
        if (isMissingMigration(err)) return sendMissingMigration(res);
        throw err;
    }
    await logPanelAction(req, 'remove_platform_admin', 'platform_admin', null,
        { firebase_uid: uid, email: target.row && target.row.email });
    return res.json({ message: 'Removed' });
}));

// ---- Delete company data (super only) ----

const q = (name) => '`' + String(name).replace(/`/g, '``') + '`';
// Vendor / bookkeeping tables are never touched by a company data delete. The
// licenses are revoked (not deleted) and screen_locks is forced to locked.
const PROTECTED_TABLES = new Set([
    'panel_admins', 'panel_sessions', 'panel_audit_log', 'platform_admins',
    'licenses', 'license_batches', 'screen_locks', 'company_deletions', 'companies',
]);
const MAX_PASSES = 12;
const FK_ERRNOS = new Set([1451, 1217, 3730]);
const isFkError = (e) => !!e && (e.code === 'ER_ROW_IS_REFERENCED_2' || e.code === 'ER_ROW_IS_REFERENCED' || FK_ERRNOS.has(e.errno));

/**
 * Builds the delete plan from information_schema for the current database:
 *  - direct: every base table with a company_id column (minus protected ones)
 *  - children: tables WITHOUT company_id that have a single-column FK into a direct
 *    table; deleted through a join on that parent (covers RESTRICT children that
 *    would otherwise block the parent delete; CASCADE children are harmless).
 *  - uidSources: tables holding firebase_uid next to a company_id (for the best-effort Firebase disable).
 */
async function buildPlan(conn) {
    const [colRows] = await conn.query(
        `SELECT c.TABLE_NAME AS t, c.COLUMN_NAME AS col
         FROM information_schema.COLUMNS c
         JOIN information_schema.TABLES tb ON tb.TABLE_SCHEMA = c.TABLE_SCHEMA AND tb.TABLE_NAME = c.TABLE_NAME
         WHERE c.TABLE_SCHEMA = DATABASE() AND tb.TABLE_TYPE = 'BASE TABLE'
           AND c.COLUMN_NAME IN ('company_id', 'firebase_uid')`
    );
    const hasCompany = new Set(colRows.filter((r) => r.col === 'company_id').map((r) => r.t));
    const direct = [...hasCompany].filter((t) => !PROTECTED_TABLES.has(t)).sort();
    const uidSources = colRows.filter((r) => r.col === 'firebase_uid' && hasCompany.has(r.t) && !PROTECTED_TABLES.has(r.t)).map((r) => r.t);

    const [fkRows] = await conn.query(
        `SELECT TABLE_NAME AS t, CONSTRAINT_NAME AS cn, COLUMN_NAME AS col,
                REFERENCED_TABLE_NAME AS pt, REFERENCED_COLUMN_NAME AS pcol
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`
    );
    const grouped = new Map();
    fkRows.forEach((r) => {
        const k = r.t + '|' + r.cn;
        if (!grouped.has(k)) grouped.set(k, []);
        grouped.get(k).push(r);
    });
    const directSet = new Set(direct);
    const children = [];
    grouped.forEach((cols) => {
        const f = cols[0];
        if (cols.length === 1 && directSet.has(f.pt) && !hasCompany.has(f.t) && !PROTECTED_TABLES.has(f.t)) {
            children.push({ table: f.t, col: f.col, parent: f.pt, pcol: f.pcol });
        }
    });
    return { direct, children, uidSources };
}

function targetsFor(plan) {
    // children first (they depend on parents), then the company_id tables.
    return [
        ...plan.children.map((c) => ({
            label: c.table, kind: 'child',
            countSql: `SELECT COUNT(*) AS n FROM ${q(c.table)} c JOIN ${q(c.parent)} p ON c.${q(c.col)} = p.${q(c.pcol)} WHERE p.company_id = ?`,
            deleteSql: `DELETE c FROM ${q(c.table)} c JOIN ${q(c.parent)} p ON c.${q(c.col)} = p.${q(c.pcol)} WHERE p.company_id = ?`,
        })),
        ...plan.direct.map((t) => ({
            label: t, kind: 'direct',
            countSql: `SELECT COUNT(*) AS n FROM ${q(t)} WHERE company_id = ?`,
            deleteSql: `DELETE FROM ${q(t)} WHERE company_id = ?`,
        })),
    ];
}

async function countRows(conn, targets, companyId) {
    const counts = {};
    for (const t of targets) {
        const [[row]] = await conn.query(t.countSql, [companyId]);
        const n = Number(row.n) || 0;
        if (n > 0) counts[t.label] = n;
    }
    return counts;
}

async function deletedAlready(companyId) {
    try {
        const [r] = await pool.query('SELECT 1 FROM company_deletions WHERE company_id = ? LIMIT 1', [companyId]);
        return r.length > 0;
    } catch (err) {
        if (err.code === 'ER_NO_SUCH_TABLE') return null; // migration_053 missing
        throw err;
    }
}

/**
 * "Free the PC": make the license key(s) of a removed company activatable again.
 *   - licenses: status 'unused', company_id / device_fingerprint / activated_at cleared, so
 *     POST /license/activate accepts the key again (it requires status 'unused') and the
 *     fingerprint binding to the old PC is gone (a PC is "new" again).
 *   - the removed company's row is renamed "<name> [removed #id]". /license/activate refuses a
 *     company name that already exists (even for a removed company), so without this the same
 *     company name could never be registered again. The row itself stays (licenses.company_id
 *     and companies.license_id are foreign keys, company_deletions keeps the tombstone).
 * Runs inside the caller's transaction. `statuses` limits which licenses are released: a key the
 * vendor revoked for cause is only un-revoked by the explicit release-pc action, never silently.
 */
async function releaseCompanyIdentity(conn, companyId, { statuses, licenseIds }) {
    let sql = `UPDATE licenses SET status = 'unused', company_id = NULL, device_fingerprint = NULL, activated_at = NULL
               WHERE company_id = ? AND status IN (${statuses.map(() => '?').join(', ')})`;
    const params = [companyId, ...statuses];
    if (Array.isArray(licenseIds) && licenseIds.length) { sql += ' AND id IN (?)'; params.push(licenseIds); }
    const [rl] = await conn.query(sql, params);
    await conn.query(
        `UPDATE companies SET name = LEFT(CONCAT(LEFT(name, 110), ' [removed #', id, ']'), 150)
         WHERE id = ? AND LOCATE(' [removed #', name) = 0`,
        [companyId]
    );
    return rl && rl.affectedRows ? rl.affectedRows : 0;
}

/**
 * After the DB commit (best effort, never fails the request). mode 'disable' blocks the Firebase
 * accounts; mode 'remove' deletes them so the same e-mail can register again (createUser fails
 * with "email already exists" for a merely disabled account). Platform admins are never touched.
 */
async function retireFirebaseUsers(uids, mode) {
    const protectedUids = new Set(configuredPlatformAdmins().map((a) => a.uid));
    let ok = 0;
    let failed = 0;
    for (const uid of uids) {
        if (protectedUids.has(uid)) continue;
        try {
            if (mode === 'remove') {
                await admin.auth().deleteUser(uid);
            } else {
                await admin.auth().updateUser(uid, { disabled: true });
                try { await admin.auth().revokeRefreshTokens(uid); } catch (_) { /* best effort */ }
            }
            ok++;
        } catch (err) {
            if (mode === 'remove' && err && err.code === 'auth/user-not-found') ok++; else failed++;
        }
    }
    return { ok, failed };
}

const MIGRATION_053 = 'The database is missing migration_053_company_deletions.sql. Apply it (migrations/migration_053_company_deletions.sql) and retry.';

// POST /panel/companies/:id/delete-data
// body: { confirm: <exact company code or name>, dry_run?: true }
router.post('/companies/:id/delete-data', requireSuperAdmin, asyncHandler(async (req, res) => {
    const companyId = Number(req.params.id);
    if (!Number.isInteger(companyId) || companyId < 1) return res.status(400).json({ error: 'Invalid company id' });
    const body = req.body || {};
    const dryRun = body.dry_run === true;
    const release = body.release === true; // also free the PC(s): keys become 'unused' again

    const [cRows] = await pool.query('SELECT id, name, company_code FROM companies WHERE id = ?', [companyId]);
    if (cRows.length === 0) return res.status(404).json({ error: 'Company not found' });
    const company = cRows[0];

    const done = await deletedAlready(companyId);
    if (done === null) return res.status(503).json({ error: MIGRATION_053 });
    if (done) return res.status(409).json({ error: 'This company has already been removed.' });

    if (!dryRun) {
        const typed = String(body.confirm === undefined ? '' : body.confirm);
        if (!typed || (typed !== String(company.name) && typed !== String(company.company_code || ''))) {
            return res.status(400).json({ error: 'Confirmation text does not match. Type the exact company code or name.' });
        }
    }

    const conn = await pool.getConnection();
    let counts;
    let uids = [];
    let revoked = 0;
    let released = 0;
    try {
        const plan = await buildPlan(conn);
        const targets = targetsFor(plan);
        if (dryRun) {
            counts = await countRows(conn, targets, companyId);
            const total = Object.values(counts).reduce((a, b) => a + b, 0);
            return res.json({ dry_run: true, company: { id: company.id, name: company.name, company_code: company.company_code }, tables: counts, total_rows: total });
        }

        await conn.beginTransaction();
        try {
            counts = await countRows(conn, targets, companyId);
            for (const src of plan.uidSources) {
                const [r] = await conn.query(`SELECT firebase_uid FROM ${q(src)} WHERE company_id = ? AND firebase_uid IS NOT NULL`, [companyId]);
                r.forEach((x) => uids.push(x.firebase_uid));
            }
            uids = [...new Set(uids)];

            let pending = targets.slice();
            let lastErr = null;
            for (let pass = 0; pass < MAX_PASSES && pending.length; pass++) {
                const next = [];
                for (const t of pending) {
                    try {
                        await conn.query(t.deleteSql, [companyId]);
                    } catch (err) {
                        if (!isFkError(err)) throw err;
                        lastErr = err; next.push(t);
                    }
                }
                const progressed = next.length < pending.length;
                pending = next;
                if (!progressed) break; // a whole pass made no progress: retrying cannot help
            }
            if (pending.length) {
                const e = new Error('Could not delete in a safe order: ' + pending.map((t) => t.label).join(', ') +
                    (lastErr ? ' (' + (lastErr.sqlMessage || lastErr.message) + ')' : '') + '. Nothing was deleted.');
                e.rollbackMessage = true;
                throw e;
            }

            if (release) {
                // Active keys go back to 'unused' (PC freed). Keys already revoked/expired stay as they are.
                released = await releaseCompanyIdentity(conn, companyId, { statuses: ['active'] });
            } else {
                const [rv] = await conn.query("UPDATE licenses SET status = 'revoked' WHERE company_id = ?", [companyId]);
                revoked = rv && rv.affectedRows ? rv.affectedRows : 0;
            }
            await conn.query(
                `INSERT INTO screen_locks (company_id, lock_key, locked, updated_by_uid, updated_by_email)
                 VALUES (?, ?, 1, ?, ?)
                 ON DUPLICATE KEY UPDATE locked = 1, updated_by_uid = VALUES(updated_by_uid), updated_by_email = VALUES(updated_by_email)`,
                [companyId, LOCK_KEY, req.platform.uid, req.platform.email || null]
            );
            await conn.query(
                `INSERT INTO company_deletions (company_id, company_name, company_code, deleted_by_uid, deleted_by_email, row_counts_json)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [companyId, company.name, company.company_code || null, req.platform.uid, req.platform.email || null,
                    JSON.stringify({ tables: counts, licenses_revoked: revoked, licenses_released: released, firebase_uids: uids })]
            );
            await conn.commit();
        } catch (err) {
            try { await conn.rollback(); } catch (_) { /* connection may be gone */ }
            if (err.code === 'ER_NO_SUCH_TABLE' && /company_deletions/.test(err.message || err.sqlMessage || '')) {
                return res.status(503).json({ error: MIGRATION_053 });
            }
            if (err.rollbackMessage) return res.status(409).json({ error: err.message });
            throw err;
        }
    } finally {
        conn.release();
    }

    markCompanyRemoved(companyId);

    // Best effort, AFTER the commit: disable (or, when freeing the PC, delete) the company's Firebase accounts.
    const fbResult = await retireFirebaseUsers(uids, release ? 'remove' : 'disable');
    const disabled = fbResult.ok;
    const failed = fbResult.failed;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    await logPanelAction(req, 'delete_company_data', 'company', companyId, {
        company_name: company.name, company_code: company.company_code || null,
        row_counts: counts, total_rows: total, licenses_revoked: revoked, licenses_released: released,
        released_pc: release, firebase_users_disabled: disabled, firebase_users_failed: failed,
    });
    return res.json({
        message: 'Company data deleted.', company_id: companyId, tables: counts, total_rows: total,
        licenses_revoked: revoked, licenses_released: released, released_pc: release,
        firebase_users_disabled: disabled, firebase_users_failed: failed,
    });
}));

// POST /panel/companies/:id/release-pc
// body: { confirm: <company code or ORIGINAL company name>, license_ids?: [id...], admin_email?: string }
// For a company whose data was already deleted (tombstone exists): turns its license key(s) back into
// 'unused' (fingerprint cleared), frees the company name, and deletes the company's Firebase accounts
// so the same admin e-mail can register again. Idempotent. NOTE: this also un-revokes keys that were
// revoked by the delete itself - do not use it for a key you revoked for cause (pass license_ids to
// release only specific keys).
router.post('/companies/:id/release-pc', requireSuperAdmin, asyncHandler(async (req, res) => {
    const companyId = Number(req.params.id);
    if (!Number.isInteger(companyId) || companyId < 1) return res.status(400).json({ error: 'Invalid company id' });
    const body = req.body || {};

    let tomb;
    try {
        const [t] = await pool.query(
            'SELECT company_name, company_code, row_counts_json FROM company_deletions WHERE company_id = ? LIMIT 1', [companyId]);
        tomb = t[0];
    } catch (err) {
        if (err.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: MIGRATION_053 });
        throw err;
    }
    if (!tomb) return res.status(409).json({ error: 'This company has not been deleted. Use "Delete data" first.' });

    const typed = String(body.confirm === undefined ? '' : body.confirm);
    if (!typed || (typed !== String(tomb.company_name) && typed !== String(tomb.company_code || ''))) {
        return res.status(400).json({ error: 'Confirmation text does not match. Type the exact company code or the original company name.' });
    }
    let licenseIds = null;
    if (body.license_ids !== undefined) {
        if (!Array.isArray(body.license_ids) || !body.license_ids.length || !body.license_ids.every((i) => Number.isInteger(i) && i > 0)) {
            return res.status(400).json({ error: 'license_ids must be a non-empty array of license ids' });
        }
        licenseIds = body.license_ids;
    }

    const conn = await pool.getConnection();
    let released = 0;
    try {
        await conn.beginTransaction();
        try {
            released = await releaseCompanyIdentity(conn, companyId, { statuses: ['revoked', 'active'], licenseIds });
            await conn.commit();
        } catch (err) {
            try { await conn.rollback(); } catch (_) { /* connection may be gone */ }
            throw err;
        }
    } finally {
        conn.release();
    }

    // Firebase accounts: the uids recorded at deletion time, plus (for deletions made before uids were
    // recorded) an optional admin e-mail - only removed if its custom claim says it belonged to THIS company.
    let uids = [];
    try {
        const rc = typeof tomb.row_counts_json === 'string' ? JSON.parse(tomb.row_counts_json) : tomb.row_counts_json;
        if (rc && Array.isArray(rc.firebase_uids)) uids = rc.firebase_uids.slice();
    } catch (_) { /* unreadable json: fall through to the e-mail path */ }
    let emailStatus = null;
    if (body.admin_email) {
        const email = String(body.admin_email).trim();
        try {
            const u = await admin.auth().getUserByEmail(email);
            const claimCompany = u.customClaims && u.customClaims.company_id;
            if (Number(claimCompany) === companyId) { uids.push(u.uid); emailStatus = 'removed'; }
            else emailStatus = 'skipped: that account does not belong to this company';
        } catch (err) {
            emailStatus = err && err.code === 'auth/user-not-found' ? 'not found in Firebase (already free)' : 'lookup failed';
        }
    }
    uids = [...new Set(uids)];
    const fbResult = await retireFirebaseUsers(uids, 'remove');

    await logPanelAction(req, 'release_pc', 'company', companyId, {
        company_name: tomb.company_name, licenses_released: released, license_ids: licenseIds,
        firebase_users_removed: fbResult.ok, firebase_users_failed: fbResult.failed, admin_email_status: emailStatus,
    });
    return res.json({
        message: released ? 'PC released. The license key(s) can be activated again.' : 'No license of this company needed releasing.',
        company_id: companyId, licenses_released: released,
        firebase_users_removed: fbResult.ok, firebase_users_failed: fbResult.failed, admin_email_status: emailStatus,
    });
}));

module.exports = router;
