// Vendor panel guard + platform admin tests (mocked express Router, pool and firebase-admin;
// no DB, network or node_modules needed). Run: node tests/platform_console.test.js
const assert = require('assert');
const path = require('path');
const Module = require('module');

// ---------- mocks ----------
const TOKENS = {
    tok_super: { uid: 'SUP1', email: 'dev@x.com', name: 'Dev' },
    tok_admin_env: { uid: 'ADM1', email: 'a1@x.com' },
    tok_admin_db: { uid: 'DB1', email: 'db1@x.com' },
    tok_admin_dbdisabled: { uid: 'DB2', email: 'db2@x.com' },
    tok_env_admin_dbdisabled: { uid: 'ADM2', email: 'a2@x.com' },
    tok_unknown: { uid: 'NOPE', email: 'n@x.com' },
};
const fb = { created: [], updates: [], deleted: [], revoked: [], failCreate: null, getUserError: null, noGetUser: false };
const fakeAdmin = {
    auth: () => Object.assign({}, fb.noGetUser ? {} : { getUser: async (uid) => {
            if (fb.getUserError) { const e = new Error('x'); e.code = fb.getUserError; throw e; }
            return { uid, email: uid.toLowerCase() + '@x.com', displayName: 'Name ' + uid, disabled: false };
        } }, {
        verifyIdToken: async (t) => { if (!TOKENS[t]) throw new Error('bad token'); return TOKENS[t]; },
        createUser: async (p) => {
            if (fb.failCreate) { const e = new Error('exists'); e.code = fb.failCreate; throw e; }
            fb.created.push(p); return { uid: 'NEW' + fb.created.length, email: p.email, displayName: p.displayName };
        },
        updateUser: async (uid, p) => { fb.updates.push({ uid, ...p }); return { uid, email: uid + '@x.com', displayName: 'N ' + uid, disabled: !!p.disabled }; },
        deleteUser: async (uid) => { fb.deleted.push(uid); },
        revokeRefreshTokens: async (uid) => { fb.revoked.push(uid); },
    }),
};

const db = { admins: [], audit: [], missingPlatformTable: false, auditColumnsMissing: false, licenses: [], deletions: [], stmts: [] };
function missing(code) { const e = new Error(code); e.code = code; return e; }
const fakePool = {
    query: async (sql, params = []) => {
        if (sql.includes('platform_admins')) {
            if (db.missingPlatformTable) throw missing('ER_NO_SUCH_TABLE');
            if (sql.startsWith('SELECT') && sql.includes('WHERE firebase_uid')) return [db.admins.filter((r) => r.firebase_uid === params[0])];
            if (sql.startsWith('SELECT')) return [db.admins.slice()];
            if (sql.includes('ON DUPLICATE KEY')) {
                const [uid, email, name, status, by] = params;
                const row = db.admins.find((r) => r.firebase_uid === uid);
                if (row) row.status = status; else db.admins.push({ firebase_uid: uid, email, name, role: 'admin', status, created_by_uid: by });
                return [{}];
            }
            if (sql.startsWith('UPDATE')) {
                const row = db.admins.find((r) => r.firebase_uid === params[1]); if (row) row.status = params[0]; return [{}];
            }
            if (sql.startsWith('DELETE')) { db.admins = db.admins.filter((r) => r.firebase_uid !== params[0]); return [{}]; }
            if (sql.startsWith('INSERT')) {
                const [uid, email, name, by] = params;
                if (db.admins.find((r) => r.firebase_uid === uid)) throw missing('ER_DUP_ENTRY');
                db.admins.push({ firebase_uid: uid, email, name, role: 'admin', status: 'active', created_by_uid: by });
                return [{}];
            }
        }
        if (sql.includes('INSERT INTO panel_audit_log')) {
            if (sql.includes('firebase_uid') && db.auditColumnsMissing) throw missing('ER_BAD_FIELD_ERROR');
            db.audit.push({ sql, params });
            return [{}];
        }
        if (sql.includes('INSERT INTO licenses')) { db.licenses.push(params); return [{ insertId: 77 }]; }
        if (sql.includes('FROM company_deletions')) return [db.deletions.map((d) => ({ company_id: d, deleted_at: 'x' }))].map((x) => (sql.includes('LIMIT 1') ? x.filter((r) => r.company_id === params[0]) : x));
        if (sql.includes('FROM companies WHERE id')) return [params[0] === 3 ? [{ id: 3, name: 'Acme Ltd', company_code: 'ACM123' }] : []];
        if (sql.includes('FROM licenses l') && !sql.includes('FROM companies c')) return [[{ id: 1, license_key: 'AAAA-BBBB-CCCC-DDDD', status: 'active', max_employees: 5 }]];
        if (sql.includes('FROM panel_audit_log')) return [[{ id: 1, action: 'revoke', actor_email: 'dev@x.com' }]];
        if (sql.includes('FROM companies c')) return [[{ id: 3, name: 'Acme', feature_flags: '{"geofence":false}', screens_locked: 1, active_employee_count: 2, license_count: 1, active_license_count: 1 }]];
        throw new Error('unexpected sql: ' + sql.slice(0, 80));
    },
    getConnection: async () => {
        const stmts = db.stmts;
        const snapshot = { count: 0 };
        return {
            beginTransaction: async () => stmts.push({ sql: 'BEGIN' }),
            commit: async () => stmts.push({ sql: 'COMMIT' }),
            rollback: async () => stmts.push({ sql: 'ROLLBACK' }),
            release: () => stmts.push({ sql: 'RELEASE' }),
            query: async (sql, params = []) => {
                stmts.push({ sql, params });
                if (sql.includes('information_schema.COLUMNS')) return [[
                    { t: 'employees', col: 'company_id' }, { t: 'employees', col: 'firebase_uid' },
                    { t: 'attendance', col: 'company_id' }, { t: 'admins', col: 'company_id' }, { t: 'admins', col: 'firebase_uid' },
                    { t: 'licenses', col: 'company_id' }, { t: 'screen_locks', col: 'company_id' }, { t: 'panel_audit_log', col: 'company_id' },
                    { t: 'platform_admins', col: 'firebase_uid' },
                ]];
                if (sql.includes('information_schema.KEY_COLUMN_USAGE')) return [[{ t: 'attendance_notes', cn: 'fk1', col: 'attendance_id', pt: 'attendance', pcol: 'id' }]];
                if (sql.startsWith('SELECT COUNT')) return [[{ n: sql.includes('`employees`') ? 4 : 0 }]];
                if (sql.startsWith('SELECT firebase_uid')) return [sql.includes('`admins`') ? [{ firebase_uid: 'CU1' }] : [{ firebase_uid: 'CU2' }, { firebase_uid: 'ADM1' }]];
                if (sql.startsWith('DELETE')) {
                    // attendance is "referenced" by attendance_notes until the child delete has run
                    if (db.failDelete && sql.includes(db.failDelete)) { const e = new Error('fk'); e.code = 'ER_ROW_IS_REFERENCED_2'; e.errno = 1451; throw e; }
                    return [{ affectedRows: 1 }];
                }
                if (sql.startsWith('UPDATE licenses')) return [{ affectedRows: 2 }];
                return [{}];
            },
        };
    },
};

function makeRouter() {
    const r = { uses: [], routes: [] };
    r.use = (...a) => { const p = typeof a[0] === 'string' ? a.shift() : ''; r.uses.push({ p, h: a }); };
    ['get', 'post', 'put', 'delete'].forEach((m) => { r[m] = (p, ...h) => r.routes.push({ m: m.toUpperCase(), p, h }); });
    return r;
}
const fakeExpress = () => ({});
fakeExpress.Router = makeRouter;

const orig = Module._load;
Module._load = function (req, ...a) {
    if (req === 'express') return fakeExpress;
    if (req === 'firebase-admin') return fakeAdmin;
    if (req === '../db') return fakePool;
    return orig.call(this, req, ...a);
};
process.env.SUPER_ADMIN_UIDS = 'SUP1';
process.env.ADMIN_UIDS = 'ADM1, ADM2';
process.env.PANEL_SECRET = 'legacy-secret';

const src = path.join(__dirname, '..', 'src');
const licenseRouter = require(src + '/routes/license.js');
const panelRouter = require(src + '/routes/panelAdmins.js');

// ---------- tiny dispatcher ----------
function match(pattern, url) {
    const pp = pattern.split('/'), uu = url.split('/');
    if (pp.length !== uu.length) return null;
    const params = {};
    for (let i = 0; i < pp.length; i++) {
        if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(uu[i]);
        else if (pp[i] !== uu[i]) return null;
    }
    return params;
}
async function call(router, method, url, { token, body, headers } = {}) {
    const [pathOnly, qs] = url.split('?');
    const route = router.routes.find((r) => r.m === method && match(r.p, pathOnly));
    const out = { status: 200, body: undefined, headers: {} };
    let done = () => {};
    const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; done(); return res; }, set(k, v) { out.headers[k] = v; return res; } };
    if (!route) { out.status = 404; return out; }
    const req = {
        headers: Object.assign(token ? { authorization: 'Bearer ' + token } : {}, headers || {}),
        body: body || {}, params: match(route.p, pathOnly), query: Object.fromEntries(new URLSearchParams(qs || '')),
    };
    const chain = [...router.uses.filter((u) => u.p === '' || pathOnly.startsWith(u.p)).flatMap((u) => u.h), ...route.h];
    let err = null;
    for (const fn of chain) {
        let nexted = false;
        // asyncHandler does not return its promise, so wait for next() / res.json() instead.
        await new Promise((resolve) => {
            done = resolve;
            const next = (e) => { nexted = true; err = e || null; resolve(); };
            try { Promise.resolve(fn(req, res, next)).catch((e) => { err = e; nexted = true; resolve(); }); } catch (e) { err = e; nexted = true; resolve(); }
        });
        if (!nexted || err) break;
    }
    if (err) throw err;
    out.req = req;
    return out;
}
function reset() {
    db.admins = []; db.audit = []; db.licenses = []; db.missingPlatformTable = false; db.auditColumnsMissing = false;
    fb.created = []; fb.updates = []; fb.deleted = []; fb.revoked = []; fb.failCreate = null; fb.getUserError = null; fb.noGetUser = false; db.deletions = []; db.stmts = []; delete db.failDelete;
}

const tests = [];
const test = (n, f) => tests.push([n, f]);

// ---------- tests ----------
test('legacy login/logout routes are gone', async () => {
    assert.ok(!panelRouter.routes.some((r) => /login|logout/.test(r.p)));
});

test('no token -> 401 on license and panel routes', async () => {
    for (const [r, m, u] of [[licenseRouter, 'GET', '/admin/list'], [panelRouter, 'GET', '/admins'], [panelRouter, 'GET', '/audit-log']]) {
        const x = await call(r, m, u);
        assert.strictEqual(x.status, 401, u);
    }
});

test('legacy PANEL_SECRET / x-panel-key no longer works', async () => {
    const x = await call(licenseRouter, 'GET', '/admin/list', { headers: { 'x-panel-key': 'legacy-secret' } });
    assert.strictEqual(x.status, 401);
    const y = await call(licenseRouter, 'GET', '/admin/list', { token: 'legacy-secret' });
    assert.strictEqual(y.status, 401);
});

test('unknown uid -> 403', async () => {
    reset();
    assert.strictEqual((await call(licenseRouter, 'GET', '/admin/list', { token: 'tok_unknown' })).status, 403);
    assert.strictEqual((await call(panelRouter, 'GET', '/audit-log', { token: 'tok_unknown' })).status, 403);
});

test('admin: licenses + companies ok, super-only routes 403', async () => {
    reset();
    const t = 'tok_admin_env';
    assert.strictEqual((await call(licenseRouter, 'GET', '/admin/list', { token: t })).status, 200);
    const c = await call(panelRouter, 'GET', '/companies', { token: t });
    assert.strictEqual(c.status, 200);
    assert.strictEqual(c.body[0].screens_locked, true);
    assert.deepStrictEqual(c.body[0].feature_flags, { geofence: false });
    const me = await call(panelRouter, 'GET', '/me', { token: t });
    assert.strictEqual(me.body.role, 'admin');
    for (const [m, u] of [['GET', '/admins'], ['POST', '/admins'], ['PUT', '/admins/DB1/status'], ['DELETE', '/admins/DB1'], ['POST', '/companies/3/delete-data'], ['GET', '/audit-log']]) {
        const x = await call(panelRouter, m, u, { token: t, body: { firebase_uid: 'e1', confirm: 'Acme Ltd', status: 'disabled' } });
        assert.strictEqual(x.status, 403, m + ' ' + u);
    }
    assert.strictEqual(db.admins.length, 0);
    assert.strictEqual(db.stmts.length, 0, 'admin must not reach the delete flow');
});

test('super admin: audit log + admin list work, role from env', async () => {
    reset();
    const a = await call(panelRouter, 'GET', '/audit-log', { token: 'tok_super' });
    assert.strictEqual(a.status, 200);
    const l = await call(panelRouter, 'GET', '/admins', { token: 'tok_super' });
    assert.strictEqual(l.status, 200);
    const byUid = Object.fromEntries(l.body.admins.map((x) => [x.firebase_uid, x]));
    assert.strictEqual(byUid.SUP1.role, 'super_admin');
    assert.strictEqual(byUid.ADM1.role, 'admin');
    assert.strictEqual(byUid.ADM1.source, 'env');
});

test('license generate: happy path writes audit row attributed to the Firebase actor', async () => {
    reset();
    const x = await call(licenseRouter, 'POST', '/admin/generate', { token: 'tok_admin_env', body: { max_employees: 10, expires_in_days: 30 } });
    assert.strictEqual(x.status, 201);
    assert.ok(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(x.body.license_key));
    assert.strictEqual(db.audit.length, 1);
    const p = db.audit[0].params; // firebase_uid, email, name, action, type, id, detail
    assert.deepStrictEqual(p.slice(0, 5), ['ADM1', 'a1@x.com', null, 'generate_single', 'license']);
    assert.ok(db.audit[0].sql.includes('VALUES (NULL,'), 'panel_admin_id must be NULL for Firebase actors');
});

test('every license write route is audited (revoke, renew)', async () => {
    reset();
    db.audit = [];
    const orig = fakePool.query;
    // revoke only needs UPDATE; renew needs a SELECT/UPDATE on licenses
    fakePool.query = async (sql, params) => {
        if (sql.startsWith('UPDATE licenses')) return [{}];
        if (sql.startsWith('SELECT status, expires_at')) return [[{ status: 'active', expires_at: null }]];
        return orig(sql, params);
    };
    try {
        assert.strictEqual((await call(licenseRouter, 'POST', '/admin/revoke/5', { token: 'tok_admin_env' })).status, 200);
        assert.strictEqual((await call(licenseRouter, 'POST', '/admin/renew/5', { token: 'tok_admin_env', body: { extend_days: 10 } })).status, 200);
    } finally { fakePool.query = orig; }
    assert.deepStrictEqual(db.audit.map((a) => a.params[3]), ['revoke', 'renew']);
});

test('add admin by UID: super only, validated, no passwords, audited', async () => {
    reset();
    const body = { firebase_uid: 'uid_New-1', name: ' Helper ', email: 'H@X.com' };
    for (const t of ['tok_admin_env']) assert.strictEqual((await call(panelRouter, 'POST', '/admins', { token: t, body })).status, 403);
    const r = await call(panelRouter, 'POST', '/admins', { token: 'tok_super', body });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(db.admins[0].firebase_uid, 'uid_New-1');
    assert.strictEqual(db.admins[0].role, 'admin');
    assert.strictEqual(db.admins[0].email, 'h@x.com');
    assert.strictEqual(db.admins[0].created_by_uid, 'SUP1');
    assert.strictEqual(db.audit[0].params[3], 'add_platform_admin');
    assert.strictEqual(fb.created.length, 0, 'no createUser');
    assert.ok(!panelRouter.routes.some((x) => /reset-password/.test(x.p)));
    // validation
    for (const bad of ['', 'has space', 'a'.repeat(129), 'bad/uid', 'dot.uid']) {
        assert.strictEqual((await call(panelRouter, 'POST', '/admins', { token: 'tok_super', body: { firebase_uid: bad } })).status, 400, JSON.stringify(bad));
    }
    // never super_admin via UI
    assert.strictEqual((await call(panelRouter, 'POST', '/admins', { token: 'tok_super', body: { firebase_uid: 'x1', role: 'super_admin' } })).status, 403);
    // env uids and duplicates
    assert.strictEqual((await call(panelRouter, 'POST', '/admins', { token: 'tok_super', body: { firebase_uid: 'ADM1' } })).status, 409);
    assert.strictEqual((await call(panelRouter, 'POST', '/admins', { token: 'tok_super', body: { firebase_uid: 'SUP1' } })).status, 409);
    assert.strictEqual((await call(panelRouter, 'POST', '/admins', { token: 'tok_super', body })).status, 409);
    // Firebase: user-not-found refuses, other failures / unavailable skip the check
    fb.getUserError = 'auth/user-not-found';
    assert.strictEqual((await call(panelRouter, 'POST', '/admins', { token: 'tok_super', body: { firebase_uid: 'ghost' } })).status, 404);
    fb.getUserError = 'app/network-error';
    assert.strictEqual((await call(panelRouter, 'POST', '/admins', { token: 'tok_super', body: { firebase_uid: 'offline1' } })).status, 201);
    fb.getUserError = null; fb.noGetUser = true;
    assert.strictEqual((await call(panelRouter, 'POST', '/admins', { token: 'tok_super', body: { firebase_uid: 'nogetuser' } })).status, 201);
    // the added admin can sign in as admin only, and cannot use panel admin endpoints
    TOKENS.tok_new = { uid: 'uid_New-1', email: 'h@x.com' };
    assert.strictEqual((await call(panelRouter, 'GET', '/me', { token: 'tok_new' })).body.role, 'admin');
    assert.strictEqual((await call(panelRouter, 'GET', '/admins', { token: 'tok_new' })).status, 403);
    assert.strictEqual((await call(panelRouter, 'DELETE', '/admins/ADM1', { token: 'tok_new' })).status, 403);
});

test('disable / enable / remove DB admins; env admins untouchable', async () => {
    reset();
    db.admins.push({ firebase_uid: 'DB1', email: 'db1@x.com', name: 'D1', role: 'admin', status: 'active' });
    assert.strictEqual((await call(licenseRouter, 'GET', '/admin/list', { token: 'tok_admin_db' })).status, 200);

    assert.strictEqual((await call(panelRouter, 'PUT', '/admins/DB1/status', { token: 'tok_super', body: { status: 'disabled' } })).status, 200);
    assert.strictEqual(db.admins[0].status, 'disabled');
    assert.strictEqual((await call(licenseRouter, 'GET', '/admin/list', { token: 'tok_admin_db' })).status, 403);
    assert.strictEqual((await call(panelRouter, 'PUT', '/admins/DB1/status', { token: 'tok_super', body: { status: 'active' } })).status, 200);
    assert.strictEqual((await call(licenseRouter, 'GET', '/admin/list', { token: 'tok_admin_db' })).status, 200);
    assert.strictEqual(fb.updates.length, 0, 'Firebase accounts are never modified');

    // env admins: cannot change or remove; super admin cannot be touched
    for (const [m, u, b] of [['PUT', '/admins/ADM1/status', { status: 'disabled' }], ['DELETE', '/admins/ADM1'], ['DELETE', '/admins/SUP1'], ['PUT', '/admins/SUP1/status', { status: 'disabled' }]]) {
        assert.strictEqual((await call(panelRouter, m, u, { token: 'tok_super', body: b })).status, 400, m + u);
    }
    assert.strictEqual((await call(panelRouter, 'DELETE', '/admins/ZZZ', { token: 'tok_super' })).status, 404);
    assert.strictEqual((await call(panelRouter, 'PUT', '/admins/DB1/status', { token: 'tok_super', body: { status: 'weird' } })).status, 400);

    const l = await call(panelRouter, 'GET', '/admins', { token: 'tok_super' });
    assert.strictEqual(l.body.admins.find((x) => x.firebase_uid === 'ADM1').source, 'env');
    assert.strictEqual(l.body.admins.find((x) => x.firebase_uid === 'DB1').source, 'db');

    assert.strictEqual((await call(panelRouter, 'DELETE', '/admins/DB1', { token: 'tok_super' })).status, 200);
    assert.strictEqual(db.admins.length, 0);
    assert.strictEqual((await call(licenseRouter, 'GET', '/admin/list', { token: 'tok_admin_db' })).status, 403);
    const actions = db.audit.map((a) => a.params[3]);
    assert.deepStrictEqual(actions, ['set_platform_admin_status', 'set_platform_admin_status', 'remove_platform_admin']);
});

test('DB-disabled uid is rejected even though it is not in env; DB row never grants super_admin', async () => {
    reset();
    db.admins.push({ firebase_uid: 'DB2', email: 'db2@x.com', role: 'super_admin', status: 'disabled' });
    assert.strictEqual((await call(licenseRouter, 'GET', '/admin/list', { token: 'tok_admin_dbdisabled' })).status, 403);
    db.admins[0].status = 'active'; // even a tampered 'super_admin' row only yields admin
    const me = await call(panelRouter, 'GET', '/me', { token: 'tok_admin_dbdisabled' });
    assert.strictEqual(me.body.role, 'admin');
});

test('missing migration_052: clear message, env admins still work', async () => {
    reset();
    db.missingPlatformTable = true;
    assert.strictEqual((await call(licenseRouter, 'GET', '/admin/list', { token: 'tok_admin_env' })).status, 200);
    const c = await call(panelRouter, 'POST', '/admins', { token: 'tok_super', body: { firebase_uid: 'someuid' } });
    assert.strictEqual(c.status, 503);
    assert.ok(c.body.error.includes('migration_052_platform_admins.sql'));
    const l = await call(panelRouter, 'GET', '/admins', { token: 'tok_super' });
    assert.strictEqual(l.status, 200);
    assert.ok(l.body.warning.includes('migration_052'));
    // a DB-only admin cannot sign in while the table is missing
    assert.strictEqual((await call(licenseRouter, 'GET', '/admin/list', { token: 'tok_admin_db' })).status, 403);
});

test('missing audit columns: action still audited with actor kept in detail', async () => {
    reset();
    db.auditColumnsMissing = true;
    const x = await call(licenseRouter, 'POST', '/admin/generate', { token: 'tok_super', body: {} });
    assert.strictEqual(x.status, 201);
    assert.strictEqual(db.audit.length, 1);
    assert.ok(JSON.parse(db.audit[0].params[3])._actor.email === 'dev@x.com');
});

const DEL = '/companies/3/delete-data';
const deletes = () => db.stmts.filter((x) => /^DELETE/.test(x.sql));

test('delete company data: wrong confirmation refused, nothing deleted', async () => {
    reset();
    for (const confirm of [undefined, '', 'acme ltd', 'Acme', 'ACM12']) {
        const r = await call(panelRouter, 'POST', DEL, { token: 'tok_super', body: { confirm } });
        assert.strictEqual(r.status, 400, String(confirm));
    }
    assert.strictEqual(db.stmts.length, 0, 'no connection opened');
    assert.strictEqual((await call(panelRouter, 'POST', '/companies/99/delete-data', { token: 'tok_super', body: { confirm: 'x' } })).status, 404);
});

test('delete company data: dry run returns counts and deletes nothing', async () => {
    reset();
    const r = await call(panelRouter, 'POST', DEL, { token: 'tok_super', body: { dry_run: true } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.dry_run, true);
    assert.strictEqual(r.body.tables.employees, 4);
    assert.strictEqual(r.body.total_rows, 4);
    assert.strictEqual(deletes().length, 0);
    assert.ok(!db.stmts.some((x) => /BEGIN|UPDATE|INSERT/.test(x.sql)));
    assert.strictEqual(db.audit.length, 0);
});

test('delete company data: happy path, only that company, vendor tables untouched', async () => {
    reset();
    const r = await call(panelRouter, 'POST', DEL, { token: 'tok_super', body: { confirm: 'ACM123' } }); // company code
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const d = deletes();
    // direct tables + the one FK child; never vendor/license tables
    const tables = d.map((x) => x.sql.match(/`(\w+)`/)[1]).sort();
    assert.deepStrictEqual(tables, ['admins', 'attendance', 'attendance_notes', 'employees']);
    d.forEach((x) => { assert.deepStrictEqual(x.params, [3]); assert.ok(/company_id = \?/.test(x.sql)); });
    assert.ok(!db.stmts.some((x) => /FOREIGN_KEY_CHECKS/i.test(x.sql)), 'FK checks stay on');
    // child (join delete) runs before its parent
    const order = d.map((x) => x.sql.match(/`(\w+)`/)[1]);
    assert.ok(order.indexOf('attendance_notes') < order.indexOf('attendance'));
    // one transaction, committed, then tombstone + revoke + lock
    const seq = db.stmts.map((x) => x.sql.split(' ')[0]);
    assert.ok(seq.indexOf('BEGIN') < seq.indexOf('COMMIT') && !seq.includes('ROLLBACK'));
    assert.ok(db.stmts.some((x) => /UPDATE licenses SET status = 'revoked' WHERE company_id = \?/.test(x.sql) && x.params[0] === 3));
    assert.ok(db.stmts.some((x) => /INSERT INTO screen_locks/.test(x.sql)));
    assert.ok(db.stmts.some((x) => /INSERT INTO company_deletions/.test(x.sql)));
    assert.strictEqual(r.body.licenses_revoked, 2);
    // Firebase users disabled after commit, never platform admins (ADM1 skipped)
    assert.deepStrictEqual(fb.updates.map((u) => u.uid).sort(), ['CU1', 'CU2']);
    assert.strictEqual(r.body.firebase_users_disabled, 2);
    // audit with counts
    const au = db.audit[0].params;
    assert.strictEqual(au[3], 'delete_company_data');
    assert.strictEqual(JSON.parse(au[6]).row_counts.employees, 4);
    // a removed company's tokens are rejected
    const { verifyFirebaseToken } = require(src + '/middleware/verifyFirebaseToken.js');
    TOKENS.tok_company = { uid: 'CU9', company_id: 3, role: 'admin' };
    db.deletions = [3];
    const res = { status(c) { res.code = c; return res; }, json(b) { res.body = b; return res; } };
    let nexted = false;
    await verifyFirebaseToken({ headers: { authorization: 'Bearer tok_company' } }, res, () => { nexted = true; });
    assert.strictEqual(res.code, 403);
    assert.strictEqual(res.body.error, 'This company has been removed. Contact Sarvottam.');
    assert.ok(!nexted);
});

test('delete company data: firebase failure does not fail the delete; stuck FK rolls back', async () => {
    reset();
    const orig = fakeAdmin.auth;
    fakeAdmin.auth = () => Object.assign(orig(), { updateUser: async () => { throw new Error('down'); } });
    let r;
    try { r = await call(panelRouter, 'POST', DEL, { token: 'tok_super', body: { confirm: 'Acme Ltd' } }); } finally { fakeAdmin.auth = orig; }
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.firebase_users_failed, 2);

    reset();
    db.failDelete = 'DELETE FROM `employees`'; // always blocked by an FK
    const x = await call(panelRouter, 'POST', DEL, { token: 'tok_super', body: { confirm: 'Acme Ltd' } });
    assert.strictEqual(x.status, 409);
    assert.ok(/Nothing was deleted/.test(x.body.error));
    assert.ok(db.stmts.some((s) => s.sql === 'ROLLBACK') && !db.stmts.some((s) => s.sql === 'COMMIT'));
    assert.strictEqual(db.audit.length, 0);
});

(async () => {
    let fails = 0;
    for (const [n, f] of tests) {
        try { await f(); console.log('PASS ' + n); } catch (e) { fails++; console.log('FAIL ' + n + '\n  ' + (e && e.stack || e)); }
    }
    console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
    process.exit(fails ? 1 : 0);
})();
