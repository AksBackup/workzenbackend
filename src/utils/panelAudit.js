const pool = require('../db');

/**
 * Writes one row to panel_audit_log. Called from every mutating route
 * under adminPanelAuth (routes/panelAdmins.js, routes/license.js's
 * /admin/* routes) so a super_admin's "what has this admin been doing"
 * view (GET /panel/audit-log) has something real to show.
 *
 * Deliberately swallows its own errors rather than letting a failed
 * audit-log INSERT fail the actual action it's logging (e.g. a license
 * still gets revoked even if, for some reason, the audit row can't be
 * written) - logged to the server console instead so it's not silently
 * lost either.
 */
async function logPanelAction(req, action, targetType, targetId, detail) {
    try {
        await pool.query(
            'INSERT INTO panel_audit_log (panel_admin_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?)',
            [req.panelAdmin ? req.panelAdmin.id : null, action, targetType, targetId ?? null, JSON.stringify(detail ?? {})]
        );
    } catch (err) {
        console.error('Failed to write panel_audit_log row:', err.message);
    }
}

module.exports = { logPanelAction };
