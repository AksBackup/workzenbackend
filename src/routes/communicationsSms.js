const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');
const { encrypt, decrypt } = require('../utils/emailCrypto'); // shared crypto util, not email-specific despite the file name

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Communications > SMS (migration_022). See that migration's header
 * comment for the full "why a generic HTTP template instead of a named
 * provider SDK" reasoning. Each company points this at whatever SMS
 * gateway they've signed up with by filling in that gateway's exact
 * URL and parameter names - this file never talks to a specific named
 * provider, it just builds and fires one HTTP request per send using
 * whatever's saved in sms_settings.
 */
function isMissingSmsTables(err) {
    return err && err.code === 'ER_NO_SUCH_TABLE';
}
const MISSING_SMS_TABLES_MESSAGE =
    'SMS tables are missing from the database - migration_022_communications_sms.sql ' +
    'has not been run against this database yet. Run it, then try again.';

// GET /communications/sms/settings - api key never returned, same
// "•••• (set)" convention as email's SMTP password.
router.get('/settings', requireAdmin, asyncHandler(async (req, res) => {
    let rows;
    try {
        [rows] = await pool.query('SELECT * FROM sms_settings WHERE company_id = ?', [req.user.companyId]);
    } catch (err) {
        if (isMissingSmsTables(err)) return res.status(503).json({ error: MISSING_SMS_TABLES_MESSAGE });
        throw err;
    }
    if (rows.length === 0) {
        return res.json({
            provider_label: null, api_url: '', http_method: 'GET', body_format: 'form',
            to_param: 'to', message_param: 'message', sender_id: null, sender_id_param: null,
            api_key_param: null, has_api_key: false, extra_params: {},
        });
    }
    const row = rows[0];
    let extraParams = {};
    try {
        extraParams = row.extra_params_json ? JSON.parse(row.extra_params_json) : {};
    } catch (e) {
        extraParams = {};
    }
    return res.json({
        provider_label: row.provider_label,
        api_url: row.api_url,
        http_method: row.http_method,
        body_format: row.body_format,
        to_param: row.to_param,
        message_param: row.message_param,
        sender_id: row.sender_id,
        sender_id_param: row.sender_id_param,
        api_key_param: row.api_key_param,
        has_api_key: !!row.api_key_encrypted,
        extra_params: extraParams,
    });
}));

// PUT /communications/sms/settings - upsert. api_key only overwrites
// the stored value if a new one is actually sent this call, same
// convention as email's PUT /settings.
router.put('/settings', requireAdmin, asyncHandler(async (req, res) => {
    const {
        provider_label, api_url, http_method, body_format,
        to_param, message_param, sender_id, sender_id_param,
        api_key_param, api_key, extra_params,
    } = req.body;

    if (!api_url || !/^https?:\/\//i.test(api_url)) {
        return res.status(400).json({ error: 'api_url must be a valid http(s) URL' });
    }
    if (!['GET', 'POST'].includes(http_method)) {
        return res.status(400).json({ error: "http_method must be 'GET' or 'POST'" });
    }
    if (body_format && !['form', 'json'].includes(body_format)) {
        return res.status(400).json({ error: "body_format must be 'form' or 'json'" });
    }
    let extraParamsJson = '{}';
    if (extra_params !== undefined && extra_params !== null) {
        if (typeof extra_params !== 'object' || Array.isArray(extra_params)) {
            return res.status(400).json({ error: 'extra_params must be a flat object of key/value pairs' });
        }
        extraParamsJson = JSON.stringify(extra_params);
    }

    let existing;
    try {
        [existing] = await pool.query('SELECT api_key_encrypted FROM sms_settings WHERE company_id = ?', [req.user.companyId]);
    } catch (err) {
        if (isMissingSmsTables(err)) return res.status(503).json({ error: MISSING_SMS_TABLES_MESSAGE });
        throw err;
    }
    const apiKeyBlob = api_key
        ? encrypt(api_key)
        : (existing.length ? existing[0].api_key_encrypted : null);

    try {
        await pool.query(
            `INSERT INTO sms_settings
               (company_id, provider_label, api_url, http_method, body_format, to_param, message_param,
                sender_id, sender_id_param, api_key_param, api_key_encrypted, extra_params_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               provider_label = VALUES(provider_label),
               api_url = VALUES(api_url),
               http_method = VALUES(http_method),
               body_format = VALUES(body_format),
               to_param = VALUES(to_param),
               message_param = VALUES(message_param),
               sender_id = VALUES(sender_id),
               sender_id_param = VALUES(sender_id_param),
               api_key_param = VALUES(api_key_param),
               api_key_encrypted = VALUES(api_key_encrypted),
               extra_params_json = VALUES(extra_params_json)`,
            [
                req.user.companyId, provider_label || null, api_url, http_method,
                body_format || 'form', to_param || 'to', message_param || 'message',
                sender_id || null, sender_id_param || null, api_key_param || null,
                apiKeyBlob, extraParamsJson,
            ]
        );
    } catch (err) {
        if (isMissingSmsTables(err)) return res.status(503).json({ error: MISSING_SMS_TABLES_MESSAGE });
        throw err;
    }
    return res.json({ message: 'SMS settings saved' });
}));

// POST /communications/sms/settings/test - one-off test send to a
// number the admin provides, using whatever's CURRENTLY SAVED (not
// this request's body) - same "prove the saved config actually works"
// reasoning as email's test endpoint.
router.post('/settings/test', requireAdmin, asyncHandler(async (req, res) => {
    const { to } = req.body;
    if (!to) return res.status(400).json({ error: 'to (phone number) is required' });
    const result = await sendViaGateway(req.user.companyId, to, 'Test SMS from your HR system - if you got this, your SMS settings are working.');
    await logSend(req.user, to, 'Test SMS from your HR system - if you got this, your SMS settings are working.', result);
    if (!result.ok) return res.status(502).json({ error: result.error });
    return res.json({ message: 'Test SMS sent' });
}));

// POST /communications/sms/send - the actual Compose SMS screen's send
// action. `to` accepts a single number or an array; each number is
// sent as its own request (most gateways' bulk-recipient formats are
// too provider-specific to genuinely generalize here - one request per
// recipient is slower for a big broadcast but works identically
// against every gateway).
router.post('/send', requireAdmin, asyncHandler(async (req, res) => {
    const { to, message } = req.body;
    if (!to || !message) {
        return res.status(400).json({ error: 'to and message are required' });
    }
    const toList = Array.isArray(to) ? to : [to];
    const results = [];
    for (const number of toList) {
        const result = await sendViaGateway(req.user.companyId, number, message);
        await logSend(req.user, number, message, result);
        results.push({ to: number, ok: result.ok, error: result.ok ? null : result.error });
    }
    const anyFailed = results.some(r => !r.ok);
    const allFailed = results.every(r => !r.ok);
    if (allFailed) return res.status(502).json({ error: 'All sends failed', results });
    return res.status(anyFailed ? 207 : 200).json({ message: anyFailed ? 'Some sends failed' : 'SMS sent', results });
}));

// GET /communications/sms/log?limit=50
router.get('/log', requireAdmin, asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    try {
        const [rows] = await pool.query(
            `SELECT l.*, a.name AS sent_by_name
             FROM sms_log l
             LEFT JOIN admins a ON a.id = l.sent_by_admin_id
             WHERE l.company_id = ?
             ORDER BY l.sent_at DESC
             LIMIT ?`,
            [req.user.companyId, limit]
        );
        return res.json(rows);
    } catch (err) {
        if (isMissingSmsTables(err)) return res.status(503).json({ error: MISSING_SMS_TABLES_MESSAGE });
        throw err;
    }
}));

/**
 * Builds and fires one HTTP request against this company's configured
 * SMS gateway. Never throws an unhandled rejection past the route
 * (same "always resolve to {ok, error}" discipline as email's
 * sendViaStoredSmtp, for the same reason - pass 2/3's email bug was
 * exactly this class of mistake).
 */
async function sendViaGateway(companyId, to, message) {
    let rows;
    try {
        [rows] = await pool.query('SELECT * FROM sms_settings WHERE company_id = ?', [companyId]);
    } catch (err) {
        if (isMissingSmsTables(err)) return { ok: false, error: MISSING_SMS_TABLES_MESSAGE };
        return { ok: false, error: `Could not read SMS settings: ${err.message}` };
    }
    if (rows.length === 0 || !rows[0].api_url) {
        return { ok: false, error: 'SMS is not configured yet - set it up in Communications > SMS > Settings first.' };
    }
    const settings = rows[0];

    let apiKey = null;
    if (settings.api_key_encrypted) {
        try {
            apiKey = decrypt(settings.api_key_encrypted);
        } catch (err) {
            return { ok: false, error: 'Stored SMS API key could not be decrypted - re-enter it in Settings (this usually means EMAIL_ENCRYPTION_KEY changed since it was saved).' };
        }
    }

    let extraParams = {};
    try {
        extraParams = settings.extra_params_json ? JSON.parse(settings.extra_params_json) : {};
    } catch (e) {
        extraParams = {};
    }

    // Light normalization only - strip spaces/hyphens/parens a human
    // might have typed. Country-code handling is left to each
    // company's own gateway config (extra_params/country param) since
    // conventions differ by provider.
    const cleanTo = String(to).replace(/[\s()-]/g, '');

    const params = { ...extraParams };
    params[settings.to_param || 'to'] = cleanTo;
    params[settings.message_param || 'message'] = message;
    if (settings.sender_id && settings.sender_id_param) {
        params[settings.sender_id_param] = settings.sender_id;
    }
    if (apiKey && settings.api_key_param) {
        params[settings.api_key_param] = apiKey;
    }

    try {
        let response;
        if (settings.http_method === 'POST') {
            if (settings.body_format === 'json') {
                response = await fetch(settings.api_url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(params),
                });
            } else {
                response = await fetch(settings.api_url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams(params).toString(),
                });
            }
        } else {
            const url = new URL(settings.api_url);
            for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
            response = await fetch(url.toString(), { method: 'GET' });
        }

        const bodyText = await response.text();
        if (!response.ok) {
            return { ok: false, error: `Gateway returned HTTP ${response.status}: ${bodyText.slice(0, 300)}`, responseSnippet: bodyText.slice(0, 500) };
        }
        // Can't reliably parse "success" out of an arbitrary provider's
        // response body - a 2xx HTTP status is the only universal
        // signal available. If a provider reports errors as 200 OK with
        // an error JSON body (a few do), the response snippet stored in
        // sms_log is how an admin would notice; flag it back if you hit
        // one of these and it can be special-cased.
        return { ok: true, responseSnippet: bodyText.slice(0, 500) };
    } catch (err) {
        return { ok: false, error: `Could not reach SMS gateway: ${err.message}` };
    }
}

async function logSend(user, toNumber, message, result) {
    try {
        const [adminRows] = await pool.query('SELECT id FROM admins WHERE firebase_uid = ?', [user.uid]);
        await pool.query(
            `INSERT INTO sms_log (company_id, sent_by_admin_id, to_number, message, status, response_snippet, error_message)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                user.companyId, adminRows[0] ? adminRows[0].id : null, toNumber, message,
                result.ok ? 'sent' : 'failed', result.responseSnippet || null, result.ok ? null : result.error,
            ]
        );
    } catch (err) {
        console.error('[sms] logSend failed (send result itself is unaffected):', err.message);
    }
}

module.exports = router;
