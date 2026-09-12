const express = require('express');
const pool = require('../db');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

// Deliberately NOT router.use(verifyFirebaseToken) - there is no token
// yet at this point, that's the entire reason this route exists. Same
// "public by omission" pattern as routes/license.js's POST /activate.
//
// This is a public-facing web API key (safe to embed - see
// firebase_auth_service.dart's doc comment on the Flutter side, which
// already ships the same value), not the service-account secret used
// everywhere else in this backend via firebase-admin. Overridable via
// env for a project migration; defaults to the one already live in
// production and already embedded in the desktop app.
const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyBUbKzENsxnaJmReFz7W24DDa71xzDiyus';

/**
 * POST /auth/employee-login
 *
 * The Android app's login screen only ever asks for Organization,
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
 * body: { organization, emp_code, password }
 * response: { idToken, refreshToken, employee: {...}, company_name }
 * - idToken/refreshToken are real Firebase tokens, used exactly like
 *   the desktop app uses its own (Authorization: Bearer <idToken> on
 *   every subsequent request; refresh via
 *   securetoken.googleapis.com/v1/token the same way, no backend
 *   involvement needed for that step or for a later password change -
 *   see ANDROID_APP_SPEC.md).
 */
router.post('/employee-login', asyncHandler(async (req, res) => {
    const { organization, emp_code, password } = req.body;
    if (!organization || !emp_code || !password) {
        return res.status(400).json({ error: 'organization, emp_code, and password are required' });
    }

    // Case/whitespace-insensitive match - same convention routes/license.js
    // already uses to treat company names as effectively unique. Not a
    // new uniqueness rule, just reusing the existing one for lookup
    // instead of only for duplicate-prevention at signup time.
    const [companyRows] = await pool.query(
        'SELECT id, name FROM companies WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))',
        [organization]
    );
    if (companyRows.length === 0) {
        return res.status(404).json({ error: 'Organization not found. Check the name with your admin.' });
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

    let firebaseResult;
    try {
        const resp = await fetch(
            `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`,
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

module.exports = router;
