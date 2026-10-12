/*
 * Shared script for the platform admin pages (/admin and /254).
 * Signs in with the Firebase JS SDK (compat build, loaded by the page), then
 * calls this same backend with the ID token as a Bearer header.
 *
 * Usage (in the page, after the Firebase scripts):
 *   ConsolePage.start({ requireSuperAdmin: false });
 * The Firebase web config is NOT in the page: start() fetches it from the
 * public GET /platform/firebase-config endpoint (server env vars).
 */
(function () {
    'use strict';

    var API = window.location.origin;
    var currentUser = null;
    var options = {};

    function el(id) { return document.getElementById(id); }

    function setMsg(text, kind) {
        var m = el('msg');
        if (!m) return;
        m.textContent = text || '';
        m.className = kind || '';
    }

    function showView(name) {
        var login = el('login-view');
        var app = el('app-view');
        if (login) login.hidden = name !== 'login';
        if (app) app.hidden = name !== 'app';
    }

    function fmtDate(v) {
        if (!v) return '';
        var d = new Date(v);
        return isNaN(d.getTime()) ? String(v) : d.toLocaleString();
    }

    async function api(path, method, body) {
        if (!currentUser) throw new Error('Not signed in');
        var token = await currentUser.getIdToken();
        var res = await fetch(API + path, {
            method: method || 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token,
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) {
            var err = new Error(data.error || ('Request failed (' + res.status + ')'));
            err.status = res.status;
            throw err;
        }
        return data;
    }

    function renderCompanies(rows) {
        var body = el('companies-body');
        if (!body) return;
        body.textContent = '';
        if (!rows.length) {
            var empty = document.createElement('tr');
            var td0 = document.createElement('td');
            td0.colSpan = 4;
            td0.textContent = 'No companies yet.';
            empty.appendChild(td0);
            body.appendChild(empty);
            return;
        }
        rows.forEach(function (c) {
            var tr = document.createElement('tr');

            var tdName = document.createElement('td');
            tdName.textContent = c.company_name || ('Company #' + c.company_id);
            tr.appendChild(tdName);

            var tdState = document.createElement('td');
            var badge = document.createElement('span');
            badge.className = 'badge ' + (c.locked ? 'locked' : 'unlocked');
            badge.textContent = c.locked ? 'Locked' : 'Unlocked';
            tdState.appendChild(badge);
            tr.appendChild(tdState);

            var tdBy = document.createElement('td');
            tdBy.className = 'muted';
            tdBy.textContent = c.updated_by_email
                ? (c.updated_by_email + ' · ' + fmtDate(c.updated_at))
                : 'Default (never changed)';
            tr.appendChild(tdBy);

            var tdAct = document.createElement('td');
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = c.locked ? 'Unlock' : 'Lock';
            btn.className = c.locked ? 'primary' : 'danger';
            btn.addEventListener('click', function () { toggleLock(c, btn); });
            tdAct.appendChild(btn);
            tr.appendChild(tdAct);

            body.appendChild(tr);
        });
    }

    async function loadCompanies() {
        setMsg('Loading companies...');
        try {
            var rows = await api('/platform/companies');
            renderCompanies(rows);
            setMsg('');
        } catch (err) {
            setMsg(err.message, 'error');
        }
    }

    async function toggleLock(company, btn) {
        var unlocking = company.locked;
        var name = company.company_name || ('company #' + company.company_id);
        var question = unlocking
            ? 'Unlock payroll and geofence for ' + name + '? Every user of this company will get access.'
            : 'Lock payroll and geofence for ' + name + '? Users of this company will be blocked.';
        if (!window.confirm(question)) return;
        btn.disabled = true;
        try {
            await api('/lock-status', 'POST', { company_id: company.company_id, locked: !unlocking });
            setMsg((unlocking ? 'Unlocked ' : 'Locked ') + name + '.', 'ok');
            await loadCompanies();
        } catch (err) {
            setMsg(err.message, 'error');
            btn.disabled = false;
        }
    }

    async function loadAdmins() {
        var section = el('admins-section');
        var body = el('admins-body');
        if (!section || !body) return;
        try {
            var data = await api('/platform/admins');
            body.textContent = '';
            (data.admins || []).forEach(function (a) {
                var tr = document.createElement('tr');
                var tdUid = document.createElement('td');
                tdUid.textContent = a.uid;
                tdUid.className = 'mono';
                var tdRole = document.createElement('td');
                tdRole.textContent = a.role === 'super_admin' ? 'Super admin' : 'Admin';
                tr.appendChild(tdUid);
                tr.appendChild(tdRole);
                body.appendChild(tr);
            });
            section.hidden = false;
        } catch (err) {
            setMsg(err.message, 'error');
        }
    }

    async function enterApp(user) {
        currentUser = user;
        setMsg('');
        var me;
        try {
            me = await api('/platform/me');
        } catch (err) {
            setMsg(err.status === 403
                ? 'This account is not a platform admin.'
                : err.message, 'error');
            await firebase.auth().signOut();
            return;
        }
        if (options.requireSuperAdmin && me.role !== 'super_admin') {
            setMsg('Super admin access required.', 'error');
            await firebase.auth().signOut();
            return;
        }
        var who = el('who');
        if (who) who.textContent = (me.email || user.email || '') + ' · ' + (me.role === 'super_admin' ? 'Super admin' : 'Admin');
        showView('app');
        await loadCompanies();
        if (me.role === 'super_admin') await loadAdmins();
    }

    async function loadFirebaseConfig() {
        var res;
        try {
            res = await fetch(API + '/platform/firebase-config', { cache: 'no-store' });
        } catch (e) {
            throw new Error('Could not reach the server to load the Firebase configuration.');
        }
        var body = null;
        try { body = await res.json(); } catch (e) { /* non-JSON */ }
        if (!res.ok || !body || !body.apiKey) {
            throw new Error((body && (body.message || body.error)) || ('Firebase configuration unavailable (HTTP ' + res.status + ').'));
        }
        return body;
    }

    async function start(opts) {
        options = opts || {};
        var cfg;
        try {
            cfg = await loadFirebaseConfig();
        } catch (e) {
            setMsg(e.message, 'error');
            return;
        }
        if (!firebase.apps.length) firebase.initializeApp(cfg);
        var auth = firebase.auth();

        var form = el('login-form');
        if (form) {
            form.addEventListener('submit', async function (ev) {
                ev.preventDefault();
                var btn = el('login-btn');
                if (btn) btn.disabled = true;
                setMsg('Signing in...');
                try {
                    await auth.signInWithEmailAndPassword(el('login-email').value.trim(), el('login-password').value);
                    // onAuthStateChanged takes over from here.
                } catch (err) {
                    setMsg('Sign-in failed: ' + (err.message || err.code), 'error');
                } finally {
                    if (btn) btn.disabled = false;
                }
            });
        }

        var signout = el('signout-btn');
        if (signout) signout.addEventListener('click', function () { auth.signOut(); });
        var refresh = el('refresh-btn');
        if (refresh) refresh.addEventListener('click', loadCompanies);

        auth.onAuthStateChanged(function (user) {
            if (!user) {
                currentUser = null;
                showView('login');
                return;
            }
            enterApp(user);
        });
    }

    window.ConsolePage = { start: start };
})();
