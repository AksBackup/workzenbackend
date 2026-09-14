const express = require('express');
const nodemailer = require('nodemailer');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');
const { encrypt, decrypt } = require('../utils/emailCrypto');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Communications > Email (migration_019). New module - nothing in this
 * codebase sent email in any form before. A company configures exactly
 * one of two providers, switchable any time without losing the other's
 * settings (see migration_019's header comment):
 *   - SMTP: sent server-side, right here, via nodemailer.
 *   - EmailJS: sent client-side, directly from the Flutter app to
 *     EmailJS's own API - this backend only stores the config
 *     (service/template/public key, all meant to be client-embeddable
 *     by EmailJS's own design) and accepts a post-hoc log entry so both
 *     providers show up in one unified "Sent Mail" history.
 */

/**
 * BUG FIX (pass 3, "that email screen error about SMTP" - continued):
 * pass 2 only hardened the SEND path (sendViaStoredSmtp/logSend). But
 * GET /settings, PUT /settings, and GET /log below had the exact same
 * unguarded-query problem - if migration_019 hasn't run, just opening
 * the Communications > Email > Settings tab (not even sending
 * anything) would 500 the same bare way. Centralizing the missing-
 * table detection here so every route below returns the same
 * actionable message instead of a generic crash.
 */
function isMissingEmailTables(err) {
    return err && err.code === 'ER_NO_SUCH_TABLE';
}
const MISSING_EMAIL_TABLES_MESSAGE =
    'Email tables are missing from the database - migration_019_communications_email.sql ' +
    'has not been run against this database yet. Run it, then try again.';

// GET /communications/email/settings - current config, SMTP password
// never returned (not even encrypted) - the Settings screen shows
// "•••• (set)" instead of round-tripping it back for editing. To
// change the password, the admin retypes it; PUT below only touches
// smtp_password_encrypted when a new plaintext password is actually
// included in the request body.
router.get('/settings', requireAdmin, asyncHandler(async (req, res) => {
    let rows;
    try {
        [rows] = await pool.query('SELECT * FROM email_settings WHERE company_id = ?', [req.user.companyId]);
    } catch (err) {
        if (isMissingEmailTables(err)) return res.status(503).json({ error: MISSING_EMAIL_TABLES_MESSAGE });
        throw err;
    }
    if (rows.length === 0) {
        return res.json({
            provider: 'smtp',
            smtp_host: null, smtp_port: null, smtp_secure: false, smtp_username: null,
            smtp_has_password: false, smtp_from_email: null, smtp_from_name: null,
            emailjs_service_id: null, emailjs_template_id: null, emailjs_public_key: null,
        });
    }
    const row = rows[0];
    return res.json({
        provider: row.provider,
        smtp_host: row.smtp_host,
        smtp_port: row.smtp_port,
        smtp_secure: !!row.smtp_secure,
        smtp_username: row.smtp_username,
        smtp_has_password: !!row.smtp_password_encrypted,
        smtp_from_email: row.smtp_from_email,
        smtp_from_name: row.smtp_from_name,
        emailjs_service_id: row.emailjs_service_id,
        emailjs_template_id: row.emailjs_template_id,
        emailjs_public_key: row.emailjs_public_key,
    });
}));

// PUT /communications/email/settings - upsert. Body carries whichever
// provider's fields are relevant; `provider` itself is what this
// route's own POST /send below keys off to decide SMTP-vs-EmailJS
// behavior.
router.put('/settings', requireAdmin, asyncHandler(async (req, res) => {
    const {
        provider, smtp_host, smtp_port, smtp_secure, smtp_username, smtp_password,
        smtp_from_email, smtp_from_name, emailjs_service_id, emailjs_template_id, emailjs_public_key,
    } = req.body;
    if (!provider || !['smtp', 'emailjs'].includes(provider)) {
        return res.status(400).json({ error: "provider must be 'smtp' or 'emailjs'" });
    }

    let existing;
    try {
        [existing] = await pool.query('SELECT smtp_password_encrypted FROM email_settings WHERE company_id = ?', [req.user.companyId]);
    } catch (err) {
        if (isMissingEmailTables(err)) return res.status(503).json({ error: MISSING_EMAIL_TABLES_MESSAGE });
        throw err;
    }
    // Only re-encrypt and overwrite if a new password was actually sent
    // this call - omitting it (e.g. editing only the from-name) keeps
    // whatever's already stored, matching GET's "•••• (set)" convention
    // above of never sending the real value back to be silently
    // round-tripped into a no-op overwrite.
    const passwordBlob = smtp_password
        ? encrypt(smtp_password)
        : (existing.length ? existing[0].smtp_password_encrypted : null);

    try {
        await pool.query(
            `INSERT INTO email_settings
               (company_id, provider, smtp_host, smtp_port, smtp_secure, smtp_username, smtp_password_encrypted,
                smtp_from_email, smtp_from_name, emailjs_service_id, emailjs_template_id, emailjs_public_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               provider = VALUES(provider),
               smtp_host = VALUES(smtp_host),
               smtp_port = VALUES(smtp_port),
               smtp_secure = VALUES(smtp_secure),
               smtp_username = VALUES(smtp_username),
               smtp_password_encrypted = VALUES(smtp_password_encrypted),
               smtp_from_email = VALUES(smtp_from_email),
               smtp_from_name = VALUES(smtp_from_name),
               emailjs_service_id = VALUES(emailjs_service_id),
               emailjs_template_id = VALUES(emailjs_template_id),
               emailjs_public_key = VALUES(emailjs_public_key)`,
            [
                req.user.companyId, provider, smtp_host || null, smtp_port || null, smtp_secure ? 1 : 0,
                smtp_username || null, passwordBlob, smtp_from_email || null, smtp_from_name || null,
                emailjs_service_id || null, emailjs_template_id || null, emailjs_public_key || null,
            ]
        );
    } catch (err) {
        if (isMissingEmailTables(err)) return res.status(503).json({ error: MISSING_EMAIL_TABLES_MESSAGE });
        throw err;
    }
    return res.json({ message: 'Email settings saved' });
}));

// POST /communications/email/settings/test - sends a one-off test
// message to the signed-in admin's own address using whatever SMTP
// settings are CURRENTLY SAVED (not whatever's in this request body) -
// the whole point is confirming the saved config actually works
// end-to-end before anyone relies on it for a real send. EmailJS has no
// server-side test path here since this backend never holds an EmailJS
// send credential to test with - see the EmailJS provider note in PUT
// above.
router.post('/settings/test', requireAdmin, asyncHandler(async (req, res) => {
    const { to } = req.body;
    if (!to) return res.status(400).json({ error: 'to (email address) is required' });
    const result = await sendViaStoredSmtp(req.user.companyId, {
        to,
        subject: 'Test email from your HR system',
        html: '<p>If you\'re reading this, your SMTP settings are working correctly.</p>',
    });
    await logSend(req.user, 'smtp', to, 'Test email from your HR system', result);
    if (!result.ok) return res.status(502).json({ error: result.error });
    return res.json({ message: 'Test email sent' });
}));

// POST /communications/email/send - the actual Communications > Email
// compose screen's send action, SMTP path only. `to` accepts a single
// address or an array (form submits either). EmailJS sends never hit
// this route at all - the Flutter client calls EmailJS's API directly
// and then POSTs to /log below instead.
router.post('/send', requireAdmin, asyncHandler(async (req, res) => {
    const { to, subject, body, cc, bcc } = req.body;
    if (!to || !subject || !body) {
        return res.status(400).json({ error: 'to, subject, and body are required' });
    }
    const toList = Array.isArray(to) ? to : [to];
    const result = await sendViaStoredSmtp(req.user.companyId, { to: toList.join(','), cc, bcc, subject, html: body });
    await logSend(req.user, 'smtp', toList.join(','), subject, result);
    if (!result.ok) return res.status(502).json({ error: result.error });
    return res.json({ message: 'Email sent' });
}));

// POST /communications/email/log - see migration_019's header comment:
// the EmailJS path sends client-side and has no other way to land in
// the shared history, so the Flutter app calls this itself right after
// EmailJS's API responds (success or failure either way - a failed
// EmailJS send is still worth showing in history, same as a failed SMTP
// one).
router.post('/log', requireAdmin, asyncHandler(async (req, res) => {
    const { to, subject, status, error_message } = req.body;
    if (!to || !subject || !status) {
        return res.status(400).json({ error: 'to, subject, and status are required' });
    }
    if (!['sent', 'failed'].includes(status)) {
        return res.status(400).json({ error: "status must be 'sent' or 'failed'" });
    }
    const [adminRows] = await pool.query('SELECT id FROM admins WHERE firebase_uid = ?', [req.user.uid]);
    await pool.query(
        `INSERT INTO email_log (company_id, sent_by_admin_id, provider, to_email, subject, status, error_message)
         VALUES (?, ?, 'emailjs', ?, ?, ?, ?)`,
        [req.user.companyId, adminRows[0] ? adminRows[0].id : null, to, subject, status, error_message || null]
    );
    return res.status(201).json({ message: 'Logged' });
}));

// GET /communications/email/log?limit=50 - unified send history, both
// providers together, newest first.
router.get('/log', requireAdmin, asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    try {
        const [rows] = await pool.query(
            `SELECT l.*, a.name AS sent_by_name
             FROM email_log l
             LEFT JOIN admins a ON a.id = l.sent_by_admin_id
             WHERE l.company_id = ?
             ORDER BY l.sent_at DESC
             LIMIT ?`,
            [req.user.companyId, limit]
        );
        return res.json(rows);
    } catch (err) {
        if (isMissingEmailTables(err)) return res.status(503).json({ error: MISSING_EMAIL_TABLES_MESSAGE });
        throw err;
    }
}));

/**
 * Shared by POST /test and POST /send - builds a nodemailer transporter
 * fresh from whatever's currently saved for this company and sends one
 * message. Not cached/reused across requests: SMTP settings can change
 * between sends and a stale cached transporter with an old
 * host/port/password would fail confusingly, whereas the connection
 * overhead of building fresh each time is trivial for an admin-driven
 * (not high-volume/transactional) send flow like this one.
 */
async function sendViaStoredSmtp(companyId, { to, cc, bcc, subject, html }) {
    // BUG FIX (pass 2): this whole function used to assume the very
    // first query below could never fail. In practice it throws - with
    // no try/catch around it - whenever migration_019 hasn't actually
    // been applied against this company's database yet (email_settings/
    // email_log don't exist: MySQL error code ER_NO_SUCH_TABLE, errno
    // 1146), or on any other unexpected DB hiccup. That uncaught
    // rejection propagated straight past this route's asyncHandler to
    // Express's global error handler, which only ever returns a bare
    // "HTTP 500: Internal server error" - exactly the unhelpful message
    // reported from the Compose Email screen. Wrapping it here turns
    // that into an actionable message instead, and (just as
    // importantly) stops it from masquerading as a generic crash - the
    // real detail is now also visible in Settings > View Error Logs
    // either way, since the outer handler still logs the original error
    // regardless of which branch below returns.
    let rows;
    try {
        [rows] = await pool.query('SELECT * FROM email_settings WHERE company_id = ? AND provider = "smtp"', [companyId]);
    } catch (err) {
        if (isMissingEmailTables(err)) {
            return { ok: false, error: MISSING_EMAIL_TABLES_MESSAGE };
        }
        return { ok: false, error: `Could not read email settings: ${err.message}` };
    }
    if (rows.length === 0 || !rows[0].smtp_host || !rows[0].smtp_password_encrypted) {
        return { ok: false, error: 'SMTP is not configured yet - set it up in Communications > Email > Settings first.' };
    }
    const settings = rows[0];
    let password;
    try {
        password = decrypt(settings.smtp_password_encrypted);
    } catch (err) {
        return { ok: false, error: 'Stored SMTP password could not be decrypted - re-enter it in Settings (this usually means EMAIL_ENCRYPTION_KEY changed since it was saved).' };
    }

    let transporter;
    try {
        transporter = nodemailer.createTransport({
            host: settings.smtp_host,
            port: settings.smtp_port || (settings.smtp_secure ? 465 : 587),
            secure: !!settings.smtp_secure,
            auth: { user: settings.smtp_username, pass: password },
        });

        await transporter.sendMail({
            from: settings.smtp_from_name
                ? `"${settings.smtp_from_name}" <${settings.smtp_from_email || settings.smtp_username}>`
                : (settings.smtp_from_email || settings.smtp_username),
            to, cc, bcc, subject, html,
        });
        return { ok: true };
    } catch (err) {
        // Was previously assumed to only ever be an SMTP-provider
        // rejection (bad creds, unreachable host, etc, all legitimately
        // 502s) - now also catches a bad host/port/config throwing
        // synchronously from createTransport itself, for the same
        // "never let this become an unhandled 500" reason as above.
        return { ok: false, error: err.message };
    }
}

// BUG FIX (pass 2): logging the send is secondary to actually telling
// the admin whether their email went out. Previously an un-caught
// failure here (most commonly the same missing-migration_019 case as
// sendViaStoredSmtp above, but could be any transient DB error) threw
// past the route handler and overwrote a perfectly good, already-
// computed result (including sendViaStoredSmtp's own actionable error
// message) with a bare "Internal server error" - the send may have
// actually SUCCEEDED and the admin would never know, only ever seeing
// a failure. Logging is now best-effort: a logging failure is printed
// server-side but never prevents the real send result from reaching
// the response.
async function logSend(user, provider, toEmail, subject, result) {
    try {
        const [adminRows] = await pool.query('SELECT id FROM admins WHERE firebase_uid = ?', [user.uid]);
        await pool.query(
            `INSERT INTO email_log (company_id, sent_by_admin_id, provider, to_email, subject, status, error_message)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [user.companyId, adminRows[0] ? adminRows[0].id : null, provider, toEmail, subject, result.ok ? 'sent' : 'failed', result.ok ? null : result.error]
        );
    } catch (err) {
        console.error('[email] logSend failed (send result itself is unaffected):', err.message);
    }
}

module.exports = router;
