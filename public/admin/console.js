/*
 * Shared script for the platform consoles: /admin (Licenses + Companies) and
 * /254 (adds Panel Admins + Audit Log). These pages replace the old
 * public/index.html panel.
 *
 * Sign-in is Firebase email+password (accounts live in Firebase; this backend never handles passwords) (Firebase JS SDK, compat build, loaded
 * by the page). The Firebase web config is fetched from GET
 * /platform/firebase-config. Every API call sends a fresh ID token as Bearer
 * (getIdToken refreshes it when needed); the server enforces roles.
 *
 * All server data is inserted with textContent (never innerHTML).
 */
(function () {
    'use strict';

    var API = window.location.origin;
    var currentUser = null;
    var ME = null;
    var options = {};
    var root;

    // ---------- tiny DOM helpers (textContent only) ----------
    function h(tag, attrs, children) {
        var e = document.createElement(tag);
        Object.keys(attrs || {}).forEach(function (k) {
            var v = attrs[k];
            if (v === null || v === undefined || v === false) return;
            if (k === 'class') e.className = v;
            else if (k === 'text') e.textContent = v;
            else if (k === 'onclick') e.addEventListener('click', v);
            else e.setAttribute(k, v === true ? '' : v);
        });
        [].concat(children || []).forEach(function (c) {
            if (c === null || c === undefined || c === false) return;
            e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
        });
        return e;
    }
    function $(id) { return document.getElementById(id); }
    function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); }
    function field(label, id, attrs) {
        return h('div', {}, [h('label', { for: id, text: label }), h('input', Object.assign({ id: id }, attrs || {}))]);
    }
    function badge(text, cls) { return h('span', { class: 'badge ' + cls, text: text }); }
    function dash() { return h('span', { class: 'muted', text: '—' }); }
    function fmtDate(v, withTime) {
        if (!v) return '';
        var d = new Date(v);
        if (isNaN(d.getTime())) return String(v);
        return withTime ? d.toLocaleString() : d.toLocaleDateString();
    }
    function out(id, text, kind) {
        var e = $(id);
        if (!e) return;
        clear(e);
        if (text) e.appendChild(h('div', { class: kind || '', text: text }));
    }
    function globalMsg(text, kind) {
        var m = $('globalMsg');
        if (!m) return;
        m.textContent = text || '';
        m.className = kind || '';
    }
    function intOr(id, dflt) { var n = parseInt($(id).value, 10); return isNaN(n) ? dflt : n; }
    function optInt(id) { var v = $(id).value; return v ? parseInt(v, 10) : null; }

    // ---------- API ----------
    async function request(path, method, body, forceRefresh) {
        if (!currentUser) throw new Error('Not signed in');
        var token = await currentUser.getIdToken(!!forceRefresh);
        var res = await fetch(API + path, {
            method: method || 'GET',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: body ? JSON.stringify(body) : undefined,
        });
        return res;
    }

    async function api(path, method, body) {
        var res = await request(path, method, body, false);
        if (res.status === 401) res = await request(path, method, body, true); // token may have just expired
        var data = await res.json().catch(function () { return {}; });
        if (res.status === 401) {
            globalMsg('Session expired. Please sign in again.', 'err');
            firebase.auth().signOut();
            throw new Error('Session expired. Please sign in again.');
        }
        if (!res.ok) {
            var msg = data.error || data.message || ('Request failed (' + res.status + ')');
            if (res.status === 403 && !data.error) msg = 'You do not have permission to do that.';
            var err = new Error(msg);
            err.status = res.status;
            throw err;
        }
        return data;
    }

    // ---------- layout ----------
    function buildGate() {
        var gate = h('div', { id: 'gateScreen' }, [
            h('h1', { text: options.title }),
            h('p', { class: 'subtitle', text: 'Internal tool — sign in with your Firebase admin account' }),
            h('div', { class: 'card' }, [
                h('form', { id: 'login-form' }, [
                    h('label', { for: 'loginEmail', text: 'Email' }),
                    h('input', { type: 'email', id: 'loginEmail', autocomplete: 'username', required: true, style: 'width:100%; margin-bottom:12px;' }),
                    h('label', { for: 'loginPassword', text: 'Password' }),
                    h('input', { type: 'password', id: 'loginPassword', autocomplete: 'current-password', required: true, style: 'width:100%; margin-bottom:12px;' }),
                    h('button', { type: 'submit', id: 'loginBtn', style: 'width:100%;', text: 'Sign in' }),
                ]),
                h('div', { id: 'loginError', class: 'err' }),
            ]),
        ]);
        return gate;
    }

    function tabDefs() {
        var tabs = [['licenses', 'Licenses'], ['companies', 'Companies']];
        if (ME.role === 'super_admin') tabs.push(['admins', 'Panel Admins'], ['audit', 'Audit Log']);
        return tabs;
    }

    function buildMain() {
        var tabs = tabDefs();
        var bar = h('div', { class: 'tabs', id: 'tabBar' }, tabs.map(function (t, i) {
            return h('button', { type: 'button', class: 'tab' + (i === 0 ? ' active' : ''), 'data-tab': t[0], text: t[1], onclick: function () { showTab(t[0]); } });
        }));
        var main = h('div', { id: 'mainScreen' }, [
            h('div', { class: 'topbar' }, [
                h('div', {}, [h('h1', { text: options.title }), h('p', { class: 'subtitle', style: 'margin-bottom:0;', text: 'Generate and manage license keys and companies' })]),
                h('div', { class: 'whoami' }, [
                    h('span', { id: 'whoamiText' }),
                    ' · ',
                    h('button', { type: 'button', class: 'link', id: 'signoutBtn', text: 'Sign out' }),
                ]),
            ]),
            h('div', { id: 'globalMsg' }),
            bar,
            h('div', { class: 'tab-panel active', id: 'tab-licenses' }, licensesPanel()),
            h('div', { class: 'tab-panel', id: 'tab-companies' }, companiesPanel()),
        ]);
        if (ME.role === 'super_admin') {
            main.appendChild(h('div', { class: 'tab-panel', id: 'tab-admins' }, adminsPanel()));
            main.appendChild(h('div', { class: 'tab-panel', id: 'tab-audit' }, auditPanel()));
        }
        return main;
    }

    function tableCard(title, refreshFn, note, headers, bodyId) {
        return h('div', { class: 'card' }, [
            h('div', { class: 'between' }, [h('strong', { text: title }), h('button', { type: 'button', class: 'secondary', text: 'Refresh', onclick: refreshFn })]),
            note ? h('p', { class: 'subtitle', style: 'margin:8px 0 0;', text: note }) : null,
            h('table', {}, [
                h('thead', {}, [h('tr', {}, headers.map(function (x) { return h('th', { text: x }); }))]),
                h('tbody', { id: bodyId }),
            ]),
        ]);
    }

    function licensesPanel() {
        return [
            h('div', { class: 'card' }, [
                h('h2', { text: 'Generate a single license (one company)' }),
                h('div', { class: 'row' }, [
                    field('Max Employees', 'maxEmployees', { type: 'number', value: '50' }),
                    field('Expires In (days, blank = never)', 'expiresDays', { type: 'number', placeholder: '365' }),
                    h('button', { type: 'button', text: 'Generate License Key', onclick: generateKey }),
                ]),
                h('div', { id: 'generateKeyOut' }),
            ]),
            h('div', { class: 'card' }, [
                h('h2', { text: 'Generate a batch (multiple PCs, one company + admin email)' }),
                h('p', { class: 'subtitle', style: 'margin-bottom:12px;', text: 'Every key in a batch shares the same company name and admin email. The first key activated creates the company; every other key in the batch just registers another PC under it.' }),
                h('div', { class: 'row' }, [
                    field('Company Name', 'batchCompanyName', { type: 'text', placeholder: 'Acme Textiles' }),
                    field('Admin Email', 'batchAdminEmail', { type: 'email', placeholder: 'admin@acme.com' }),
                    field('Max Employees', 'batchMaxEmployees', { type: 'number', value: '50' }),
                    field('Number of Keys (PCs)', 'batchCount', { type: 'number', value: '5', min: '1', max: '200' }),
                    field('Expires In (days, blank = never)', 'batchExpiresDays', { type: 'number', placeholder: '365' }),
                    h('button', { type: 'button', text: 'Generate Batch', onclick: generateBatch }),
                ]),
                h('div', { id: 'generateBatchOut' }),
            ]),
            h('div', { class: 'card' }, [
                h('h2', { text: 'Add more keys to an existing batch' }),
                h('div', { class: 'row' }, [
                    field('Batch ID', 'addKeysBatchId', { type: 'number', placeholder: 'see Batch column below' }),
                    field('Additional Keys', 'addKeysCount', { type: 'number', value: '1', min: '1', max: '200' }),
                    h('button', { type: 'button', text: 'Add Keys', onclick: addKeysToBatch }),
                ]),
                h('div', { id: 'addKeysOut' }),
            ]),
            tableCard('All Licenses', loadLicenses, null,
                ['Key', 'Company', 'Batch', 'Status', 'Max Emp.', 'Expires', 'Activated', ''], 'licenseTableBody'),
        ];
    }

    function companiesPanel() {
        return [
            tableCard('All Companies', loadCompanies,
                'Two controls per company. "Screens" is the master lock for the Payroll + Geofence screens (new companies start locked). ' +
                '"Feature enabled (licensed)" is the older per-feature switch. A company can use Payroll/Geofence only when its feature is enabled AND its screens are unlocked. ' +
                'Changes apply to every user of that company on their next screen load.',
                ['Company', 'Code', 'Admin', 'Active Employees', 'Licenses', 'Payroll + Geofence screens', 'Payroll feature', 'Geofence feature'].concat(ME.role === 'super_admin' ? ['Danger'] : []),
                'companyTableBody'),
        ];
    }

    function adminsPanel() {
        return [
            h('div', { class: 'card' }, [
                h('h2', { text: 'Add an app admin by Firebase UID' }),
                h('p', { class: 'subtitle', style: 'margin-bottom:12px;', text: 'Paste the Firebase UID of an existing Firebase user (Firebase Console > Authentication > Users). They get /admin access (Licenses + Companies). Super admins are set only with the SUPER_ADMIN_UIDS server variable.' }),
                h('div', { class: 'row' }, [
                    field('Firebase UID', 'newAdminUid', { type: 'text', maxlength: '128', autocomplete: 'off', style: 'min-width:280px;' }),
                    field('Label (optional)', 'newAdminName', { type: 'text' }),
                    field('Email (optional, display only)', 'newAdminEmail', { type: 'email' }),
                    h('button', { type: 'button', text: 'Add admin', onclick: createAdmin }),
                ]),
                h('div', { id: 'createAdminOut' }),
            ]),
            h('div', { id: 'adminsWarn' }),
            tableCard('Platform Admins', loadAdmins, 'Admins "from environment" (ADMIN_UIDS / SUPER_ADMIN_UIDS) cannot be changed here. Admins added here can be disabled, enabled or removed.',
                ['Label', 'Email / UID', 'Role', 'Status', 'Source', 'Added', ''], 'adminsTableBody'),
        ];
    }

    function auditPanel() {
        return [
            tableCard('Audit Log', loadAudit, 'Every generate / revoke / renew / feature-flag / lock / account-management action, newest first.',
                ['When', 'Who', 'Action', 'Target', 'Detail'], 'auditTableBody'),
        ];
    }

    function showTab(name) {
        [].forEach.call(document.querySelectorAll('.tab'), function (t) { t.classList.toggle('active', t.getAttribute('data-tab') === name); });
        [].forEach.call(document.querySelectorAll('.tab-panel'), function (p) { p.classList.toggle('active', p.id === 'tab-' + name); });
        globalMsg('');
        var loaders = { licenses: loadLicenses, companies: loadCompanies, admins: loadAdmins, audit: loadAudit };
        if (loaders[name]) loaders[name]();
    }

    function guard(fn) {
        return async function () {
            try { await fn.apply(null, arguments); } catch (e) { if (e.message !== 'Session expired. Please sign in again.') globalMsg(e.message, 'err'); }
        };
    }

    // ---------- Licenses ----------
    function keysBlock(keys) { return h('div', { class: 'keys-out', text: keys.join('\n') }); }

    var generateKey = guard(async function () {
        var o = $('generateKeyOut'); clear(o);
        try {
            var data = await api('/license/admin/generate', 'POST', { max_employees: intOr('maxEmployees', 50) || 50, expires_in_days: optInt('expiresDays') });
            o.appendChild(h('div', { class: 'ok' }, ['New license key: ', h('span', { class: 'keyval', text: data.license_key })]));
            loadLicenses();
        } catch (e) { out('generateKeyOut', e.message, 'err'); }
    });

    var generateBatch = guard(async function () {
        var company_name = $('batchCompanyName').value.trim();
        var admin_email = $('batchAdminEmail').value.trim();
        if (!company_name || !admin_email) { out('generateBatchOut', 'Company name and admin email are required.', 'err'); return; }
        try {
            var data = await api('/license/admin/generate-batch', 'POST', {
                company_name: company_name, admin_email: admin_email,
                number_of_employees: intOr('batchMaxEmployees', 50) || 50,
                number_of_license_keys: intOr('batchCount', 1) || 1,
                expires_in_days: optInt('batchExpiresDays'),
            });
            var o = $('generateBatchOut'); clear(o);
            o.appendChild(h('div', { class: 'ok', text: 'Batch #' + data.batch_id + ' created with ' + data.license_keys.length + ' key(s):' }));
            o.appendChild(keysBlock(data.license_keys));
            loadLicenses();
        } catch (e) { out('generateBatchOut', e.message, 'err'); }
    });

    var addKeysToBatch = guard(async function () {
        var batchId = intOr('addKeysBatchId', 0);
        if (!batchId) { out('addKeysOut', 'Enter a batch ID (see the Batch column below).', 'err'); return; }
        try {
            var data = await api('/license/admin/batches/' + batchId + '/add-keys', 'POST', { count: intOr('addKeysCount', 1) || 1 });
            var o = $('addKeysOut'); clear(o);
            o.appendChild(h('div', { class: 'ok', text: data.license_keys.length + ' key(s) added:' }));
            o.appendChild(keysBlock(data.license_keys));
            loadLicenses();
        } catch (e) { out('addKeysOut', e.message, 'err'); }
    });

    var loadLicenses = guard(async function () {
        var rows = await api('/license/admin/list');
        var tbody = $('licenseTableBody'); clear(tbody);
        rows.forEach(function (r) {
            var company;
            if (r.company_name) company = h('span', { text: r.company_name });
            else if (r.batch_company_name) company = h('span', { class: 'muted', text: r.batch_company_name + ' (not yet activated)' });
            else company = h('span', { class: 'muted', text: 'unassigned' });
            var batch = r.license_batch_id
                ? h('span', {}, ['#' + r.license_batch_id, h('br'), h('span', { class: 'muted', text: r.batch_admin_email || '' })])
                : dash();
            var actions = [];
            if (r.status === 'active') actions.push(h('button', { type: 'button', class: 'danger small', text: 'Revoke', onclick: function () { revokeKey(r.id); } }));
            if (r.status !== 'revoked') actions.push(h('button', { type: 'button', class: 'warn small', text: 'Renew', onclick: function () { renewKey(r.id); } }));
            tbody.appendChild(h('tr', {}, [
                h('td', { class: 'keyval', text: r.license_key }),
                h('td', {}, [company]),
                h('td', {}, [batch]),
                h('td', {}, [badge(r.status, r.status)]),
                h('td', { text: String(r.max_employees) }),
                h('td', {}, [r.expires_at ? fmtDate(r.expires_at) : dash()]),
                h('td', {}, [r.activated_at ? fmtDate(r.activated_at) : dash()]),
                h('td', {}, actions),
            ]));
        });
    });

    var revokeKey = guard(async function (id) {
        if (!window.confirm('Revoke this license? That PC will lose access immediately.')) return;
        await api('/license/admin/revoke/' + id, 'POST');
        loadLicenses();
    });

    var renewKey = guard(async function (id) {
        var days = window.prompt('Extend by how many days?', '365');
        if (!days) return;
        var n = parseInt(days, 10);
        if (!n || n < 1) { window.alert('Enter a positive number of days.'); return; }
        await api('/license/admin/renew/' + id, 'POST', { extend_days: n });
        loadLicenses();
    });

    // ---------- Companies ----------
    function lockButton(c) {
        var locked = c.screens_locked;
        return h('button', {
            type: 'button', class: (locked ? 'warn' : 'secondary') + ' small', text: locked ? 'Unlock' : 'Lock',
            onclick: function () { toggleScreens(c); },
        });
    }
    function featureCell(c, flag) {
        var enabled = !(c.feature_flags && c.feature_flags[flag] === false);
        return h('td', {}, [
            badge(enabled ? 'Feature enabled (licensed)' : 'Feature disabled', enabled ? 'enabled' : 'disabled'), ' ',
            h('button', { type: 'button', class: (enabled ? 'secondary' : 'warn') + ' small', text: enabled ? 'Disable' : 'Enable', onclick: function () { toggleFeature(c, flag, enabled); } }),
        ]);
    }

    var loadCompanies = guard(async function () {
        var rows = await api('/panel/companies');
        var tbody = $('companyTableBody'); clear(tbody);
        rows.forEach(function (c) {
            if (c.removed) {
                tbody.appendChild(h('tr', {}, [
                    h('td', { text: c.name }), h('td', { class: 'keyval' }, [c.company_code || dash()]),
                    h('td', { colspan: '6' }, [badge('Removed', 'revoked'), ' ', h('span', { class: 'muted', text: 'Data deleted ' + fmtDate(c.removed_at, true) + '. Licenses revoked.' })]),
                ]));
                return;
            }
            var lastCells = ME.role === 'super_admin'
                ? [h('td', {}, [h('button', { type: 'button', class: 'danger small', text: 'Delete data', onclick: function () { deleteCompanyData(c); } })])]
                : [];
            tbody.appendChild(h('tr', {}, [
                h('td', { text: c.name }),
                h('td', { class: 'keyval' }, [c.company_code || dash()]),
                h('td', {}, [c.admin_name ? c.admin_name : h('span', { class: 'muted', text: 'no admin yet' }), h('br'), h('span', { class: 'muted', text: c.admin_email || '' })]),
                h('td', { text: String(c.active_employee_count) }),
                h('td', { text: c.active_license_count + ' active / ' + c.license_count + ' total' }),
                h('td', {}, [
                    badge(c.screens_locked ? 'Screens locked' : 'Screens unlocked', c.screens_locked ? 'locked' : 'unlocked'), ' ', lockButton(c),
                    c.lock_updated_by_email ? h('div', { class: 'muted', text: c.lock_updated_by_email + ' · ' + fmtDate(c.lock_updated_at, true) }) : null,
                ]),
                featureCell(c, 'payroll'),
                featureCell(c, 'geofence'),
            ].concat(lastCells)));
        });
    });

    var DELETE_WARNING = 'This permanently deletes all data of this company. Take a database backup first.';
    var deleteCompanyData = guard(async function (c) {
        var preview = await api('/panel/companies/' + c.id + '/delete-data', 'POST', { dry_run: true });
        var lines = Object.keys(preview.tables).map(function (t) { return '  ' + t + ': ' + preview.tables[t]; });
        var msg = 'DELETE ALL DATA of ' + c.name + '?\n\n' + DELETE_WARNING +
            '\n\nRows to be deleted (' + preview.total_rows + ' total):\n' + (lines.join('\n') || '  (none)') +
            '\n\nIts licenses will be revoked and its users blocked. This cannot be undone.';
        if (!window.confirm(msg)) return;
        var typed = window.prompt('Type the company code or the exact company name to confirm:\n' + c.name + (c.company_code ? '  /  ' + c.company_code : ''));
        if (typed === null) return;
        try {
            var r = await api('/panel/companies/' + c.id + '/delete-data', 'POST', { confirm: typed });
            globalMsg('Deleted ' + r.total_rows + ' rows of ' + c.name + '; ' + r.licenses_revoked + ' license(s) revoked; ' + r.firebase_users_disabled + ' Firebase user(s) disabled.', 'ok');
        } catch (e) { globalMsg(e.message, 'err'); }
        loadCompanies();
    });

    var toggleScreens = guard(async function (c) {
        var unlocking = c.screens_locked;
        var q = unlocking
            ? 'Unlock the Payroll + Geofence screens for ' + c.name + '? Every user of this company will get access (if the features are enabled).'
            : 'Lock the Payroll + Geofence screens for ' + c.name + '? Users of this company will be blocked.';
        if (!window.confirm(q)) return;
        await api('/lock-status', 'POST', { company_id: c.id, locked: !unlocking });
        loadCompanies();
    });

    var toggleFeature = guard(async function (c, flag, enabled) {
        var body = {}; body[flag] = !enabled;
        await api('/license/admin/companies/' + c.id + '/feature-flags', 'PUT', body);
        loadCompanies();
    });

    // ---------- Panel Admins (super) ----------
    var createAdmin = guard(async function () {
        try {
            await api('/panel/admins', 'POST', {
                firebase_uid: $('newAdminUid').value.trim(),
                name: $('newAdminName').value.trim(),
                email: $('newAdminEmail').value.trim(),
                role: 'admin',
            });
            out('createAdminOut', 'Admin added.', 'ok');
            $('newAdminUid').value = ''; $('newAdminName').value = ''; $('newAdminEmail').value = '';
            loadAdmins();
        } catch (e) { out('createAdminOut', e.message, 'err'); }
    });

    var loadAdmins = guard(async function () {
        var data = await api('/panel/admins');
        out('adminsWarn', data.warning || '', 'err');
        var tbody = $('adminsTableBody'); clear(tbody);
        (data.admins || []).forEach(function (a) {
            var actions = [];
            if (a.source === 'db') {
                var disabled = a.status === 'disabled';
                actions.push(h('button', { type: 'button', class: (disabled ? '' : 'warn') + ' small', text: disabled ? 'Enable' : 'Disable', onclick: function () { toggleAdminStatus(a); } }));
                actions.push(' ', h('button', { type: 'button', class: 'danger small', text: 'Remove', onclick: function () { removeAdmin(a); } }));
            }
            tbody.appendChild(h('tr', {}, [
                h('td', { text: a.name || '' }),
                h('td', {}, [a.email ? h('div', { text: a.email }) : null, h('div', { class: 'muted keyval', text: a.firebase_uid })]),
                h('td', {}, [badge(a.role, a.role)]),
                h('td', {}, [badge(a.status, a.status === 'disabled' ? 'disabled' : 'active')]),
                h('td', { class: 'muted', text: a.source === 'env' ? 'from environment' : 'added here' }),
                h('td', {}, [a.created_at ? fmtDate(a.created_at) : dash()]),
                h('td', {}, actions),
            ]));
        });
    });

    var toggleAdminStatus = guard(async function (a) {
        var next = a.status === 'disabled' ? 'active' : 'disabled';
        if (next === 'disabled' && !window.confirm('Disable this admin? They lose access immediately.')) return;
        await api('/panel/admins/' + encodeURIComponent(a.firebase_uid) + '/status', 'PUT', { status: next });
        loadAdmins();
    });

    var removeAdmin = guard(async function (a) {
        if (!window.confirm('Remove this admin? Their Firebase account is not deleted, they just lose admin access.')) return;
        await api('/panel/admins/' + encodeURIComponent(a.firebase_uid), 'DELETE');
        loadAdmins();
    });

    // ---------- Audit (super) ----------
    var loadAudit = guard(async function () {
        var rows = await api('/panel/audit-log?limit=200');
        var tbody = $('auditTableBody'); clear(tbody);
        rows.forEach(function (r) {
            var who;
            if (r.actor_name || r.actor_email) {
                who = h('span', {}, [r.actor_name || r.actor_email, r.actor_name && r.actor_email ? h('br') : null,
                    r.actor_name && r.actor_email ? h('span', { class: 'muted', text: r.actor_email }) : null]);
            } else if (r.panel_admin_name) who = h('span', { text: r.panel_admin_name });
            else who = h('span', { class: 'muted', text: 'unknown (legacy entry)' });
            var detail = r.detail;
            if (typeof detail === 'string') { try { detail = JSON.parse(detail); } catch (e) { /* keep string */ } }
            tbody.appendChild(h('tr', {}, [
                h('td', { text: fmtDate(r.created_at, true) }),
                h('td', {}, [who]),
                h('td', { text: r.action }),
                h('td', { text: r.target_type + (r.target_id !== null && r.target_id !== undefined ? ' #' + r.target_id : '') }),
                h('td', { class: 'keyval', text: detail ? JSON.stringify(detail) : '' }),
            ]));
        });
    });

    // ---------- auth flow ----------
    var pendingGateMsg = '';
    function setLoginError(t) { pendingGateMsg = t || ''; var e = $('loginError'); if (e) e.textContent = pendingGateMsg; }

    async function enterApp(user) {
        currentUser = user;
        try {
            ME = await api('/platform/me');
        } catch (err) {
            setLoginError(err.status === 403 ? 'This account is not a platform admin (or is disabled).' : err.message);
            await firebase.auth().signOut();
            return;
        }
        if (options.requireSuperAdmin && ME.role !== 'super_admin') {
            setLoginError('Super admin access required. This account is an admin: use /admin instead.');
            await firebase.auth().signOut();
            return;
        }
        clear(root);
        root.appendChild(buildMain());
        $('whoamiText').textContent = (ME.name || ME.email || user.email || '') + ' (' + ME.role + ')';
        $('signoutBtn').addEventListener('click', function () { firebase.auth().signOut(); });
        loadLicenses();
    }

    function showGate() {
        currentUser = null; ME = null;
        clear(root);
        root.appendChild(buildGate());
        $('loginError').textContent = pendingGateMsg; // survives the sign-out rebuild
        $('login-form').addEventListener('submit', async function (ev) {
            ev.preventDefault();
            setLoginError('');
            var btn = $('loginBtn'); btn.disabled = true;
            try {
                await firebase.auth().signInWithEmailAndPassword($('loginEmail').value.trim(), $('loginPassword').value);
            } catch (err) {
                var bad = err && (err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password' || err.code === 'auth/user-not-found');
                setLoginError(err && err.code === 'auth/user-disabled' ? 'This account has been disabled.'
                    : bad ? 'Incorrect email or password.' : 'Sign-in failed: ' + (err.message || err.code));
            } finally { btn.disabled = false; }
        });
    }

    async function loadFirebaseConfig() {
        var res;
        try { res = await fetch(API + '/platform/firebase-config', { cache: 'no-store' }); }
        catch (e) { throw new Error('Could not reach the server to load the Firebase configuration.'); }
        var body = null;
        try { body = await res.json(); } catch (e) { /* non-JSON */ }
        if (!res.ok || !body || !body.apiKey) {
            throw new Error((body && (body.message || body.error)) || ('Firebase configuration unavailable (HTTP ' + res.status + ').'));
        }
        return body;
    }

    async function start(opts) {
        options = opts || {};
        root = $('root');
        showGate();
        var cfg;
        try { cfg = await loadFirebaseConfig(); }
        catch (e) { setLoginError(e.message); return; }
        if (!firebase.apps.length) firebase.initializeApp(cfg);
        firebase.auth().onAuthStateChanged(function (user) {
            if (!user) { showGate(); return; }
            enterApp(user);
        });
    }

    window.ConsolePage = { start: start };
})();
