const express = require('express');
const pool = require('../db');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

// Deliberately NOT router.use(verifyFirebaseToken) - there is no token
// yet at this point, that's the entire reason this route exists. Same
// "public by omission" pattern as routes/license.js's POST /activate.
//
// This is a Firebase Web API Key (not the service-account secret used
// everywhere else in this backend via firebase-admin) - per Google's
// own docs it doesn't grant access by itself, so it isn't a secret in
// the way a database password or the service-account key is; it's
// already shipped inside the compiled desktop app's binary
// (env.dart), same value.
//
// It is deliberately NOT hardcoded here even so - hardcoding it as a
// literal string is exactly what triggered a GitHub secret-scanning
// alert on this repo (Google API Key patterns are flagged regardless
// of that context, since a plain string match can't tell "safe Firebase
// key" apart from "unrestricted key with access to billable APIs").
// Set FIREBASE_WEB_API_KEY in your deployment platform's environment
// variables (e.g. Render's dashboard) - Firebase Console -> Project
// Settings -> General -> Web API Key.
//
// Read lazily inside the route (not thrown here at module-load time) -
// a missing env var should only break employee mobile login, not crash
// the entire server on startup and take payroll/attendance/everything
// else down with it.
function getFirebaseWebApiKey() {
    if (!process.env.FIREBASE_WEB_API_KEY) {
        throw new Error('FIREBASE_WEB_API_KEY is not set in this server\'s environment.');
    }
    return process.env.FIREBASE_WEB_API_KEY;
}

/**
 * POST /auth/employee-login
 *
 * The Android app's login screen only ever asks for Company Code,
 * Employee ID (emp_code), and Password - it never sees or handles an
 * email address. Firebase Auth requires an email-shaped identifier
 * internally, so employees.email (migration_018) holds an
 * auto-generated one (see routes/employees.js's POST /:id/login) that
 * only this route and the admin desktop's provisioning flow ever touch.
 *
 * Signing in HERE (server-side) rather than having the phone call
 * Firebase directly (the way the desktop app does in
 * firebase_auth_service.dart) is what makes that possible: the phone
 * sends emp_code, this route resolves it to the hidden email and
 * forwards the password to Firebase on the phone's behalf. The desktop
 * app can't use this same trick for admins since an admin's login *is*
 * a real email the admin already knows - there's nothing to hide there,
 * so it keeps calling Firebase directly.
 *
 * migration_020: this used to look employees up by matching the
 * COMPANY NAME. Real bug - see that migration's header comment - two
 * companies with the same (or differently-cased/spaced) name made an
 * employee's login ambiguous, and the name was never actually
 * guaranteed unique at the database level. Now uses `company_code`, a
 * short value with a real UNIQUE constraint, shown to the admin on the
 * desktop's Company Details screen specifically so they can hand it to
 * employees.
 *
 * body: { company_code, emp_code, password }
 * response: { idToken, refreshToken, employee: {...}, company_name }
 * - idToken/refreshToken are real Firebase tokens, used exactly like
 *   the desktop app uses its own (Authorization: Bearer <idToken> on
 *   every subsequent request; refresh via
 *   securetoken.googleapis.com/v1/token the same way, no backend
 *   involvement needed for that step or for a later password change -
 *   see ANDROID_APP_SPEC.md).
 */
router.post('/employee-login', asyncHandler(async (req, res) => {
    const { company_code, emp_code, password } = req.body;
    if (!company_code || !emp_code || !password) {
        return res.status(400).json({ error: 'company_code, emp_code, and password are required' });
    }

    // Uppercased/trimmed - company_code is always stored normalized
    // this same way (see routes/companies.js's PUT), so "acme2026"
    // typed on a phone still matches "ACME2026" as saved/displayed.
    const [companyRows] = await pool.query(
        'SELECT id, name FROM companies WHERE company_code = ?',
        [String(company_code).trim().toUpperCase()]
    );
    if (companyRows.length === 0) {
        return res.status(404).json({ error: 'Company code not found. Check it with your admin.' });
    }
    const company = companyRows[0];

    const [empRows] = await pool.query(
        `SELECT id, name, emp_code, department, designation, email, firebase_uid
         FROM employees WHERE company_id = ? AND emp_code = ? AND status = 'active'`,
        [company.id, emp_code]
    );
    if (empRows.length === 0 || !empRows[0].firebase_uid || !empRows[0].email) {
        // Same message whether the emp_code doesn't exist at all or it
        // exists but has no mobile login yet - distinguishing the two
        // would let someone probe which emp_codes are valid.
        return res.status(404).json({ error: 'Employee ID not found, or mobile login has not been set up yet - contact your admin.' });
    }
    const employee = empRows[0];

    let webApiKey;
    try {
        webApiKey = getFirebaseWebApiKey();
    } catch (err) {
        return res.status(500).json({ error: 'Mobile login is not fully configured on the server yet - contact your admin.' });
    }

    let firebaseResult;
    try {
        const resp = await fetch(
            `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${webApiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: employee.email, password, returnSecureToken: true }),
            }
        );
        firebaseResult = await resp.json();
        if (!resp.ok) {
            const code = firebaseResult.error?.message || 'UNKNOWN_ERROR';
            let friendly = 'Login failed. Please try again.';
            if (['INVALID_PASSWORD', 'INVALID_LOGIN_CREDENTIALS', 'EMAIL_NOT_FOUND'].includes(code)) {
                friendly = 'Incorrect Employee ID or password.';
            } else if (code === 'USER_DISABLED') {
                friendly = 'This mobile login has been disabled. Contact your admin.';
            } else if (code === 'TOO_MANY_ATTEMPTS_TRY_LATER') {
                friendly = 'Too many failed attempts. Try again later.';
            }
            return res.status(401).json({ error: friendly });
        }
    } catch (err) {
        return res.status(502).json({ error: 'Could not reach the authentication service. Please try again.' });
    }

    return res.json({
        idToken: firebaseResult.idToken,
        refreshToken: firebaseResult.refreshToken,
        employee: {
            id: employee.id,
            name: employee.name,
            emp_code: employee.emp_code,
            department: employee.department,
            designation: employee.designation,
        },
        company_name: company.name,
    });
}));

/**
 * POST /auth/app-user-login (migration_031)
 *
 * Mirrors POST /employee-login above exactly - same reasoning, same
 * server-side "resolve id -> hidden email, forward password to
 * Firebase" trick, just resolving against app_users+employees instead
 * of employees.email directly. See appUsers.js's header comment for
 * what this closes (and what it still doesn't - most other routes
 * don't yet accept role 'app_user').
 *
 * body: { company_code, emp_code, password }
 * response: { idToken, refreshToken, app_user: {...}, company_name }
 */
router.post('/app-user-login', asyncHandler(async (req, res) => {
    const { company_code, emp_code, password } = req.body;
    if (!company_code || !emp_code || !password) {
        return res.status(400).json({ error: 'company_code, emp_code, and password are required' });
    }

    const [companyRows] = await pool.query(
        'SELECT id, name FROM companies WHERE company_code = ?',
        [String(company_code).trim().toUpperCase()]
    );
    if (companyRows.length === 0) {
        return res.status(404).json({ error: 'Company code not found. Check it with your admin.' });
    }
    const company = companyRows[0];

    const [rows] = await pool.query(
        `SELECT u.id, u.firebase_uid, u.status, e.name, e.emp_code
         FROM app_users u
         JOIN employees e ON e.id = u.employee_id
         WHERE u.company_id = ? AND e.emp_code = ?`,
        [company.id, emp_code]
    );
    if (rows.length === 0 || !rows[0].firebase_uid) {
        return res.status(404).json({ error: 'Employee ID not found, or an app login has not been set up for it yet - contact your admin.' });
    }
    const appUser = rows[0];
    if (appUser.status !== 'active') {
        return res.status(403).json({ error: 'This login has been disabled. Contact your admin.' });
    }

    let webApiKey;
    try {
        webApiKey = getFirebaseWebApiKey();
    } catch (err) {
        return res.status(500).json({ error: 'Login is not fully configured on the server yet - contact your admin.' });
    }

    const generatedEmail = `au${appUser.id}@appuser.internal`;
    let firebaseResult;
    try {
        const resp = await fetch(
            `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${webApiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: generatedEmail, password, returnSecureToken: true }),
            }
        );
        firebaseResult = await resp.json();
        if (!resp.ok) {
            const code = firebaseResult.error?.message || 'UNKNOWN_ERROR';
            let friendly = 'Login failed. Please try again.';
            if (['INVALID_PASSWORD', 'INVALID_LOGIN_CREDENTIALS', 'EMAIL_NOT_FOUND'].includes(code)) {
                friendly = 'Incorrect Employee ID or password.';
            } else if (code === 'USER_DISABLED') {
                friendly = 'This login has been disabled. Contact your admin.';
            } else if (code === 'TOO_MANY_ATTEMPTS_TRY_LATER') {
                friendly = 'Too many failed attempts. Try again later.';
            }
            return res.status(401).json({ error: friendly });
        }
    } catch (err) {
        return res.status(502).json({ error: 'Could not reach the authentication service. Please try again.' });
    }

    return res.json({
        idToken: firebaseResult.idToken,
        refreshToken: firebaseResult.refreshToken,
        app_user: { id: appUser.id, name: appUser.name, emp_code: appUser.emp_code },
        company_name: company.name,
    });
}));

module.exports = router;
