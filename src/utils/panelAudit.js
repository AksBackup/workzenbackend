const pool = require('../db');

const MIGRATION_FILE = 'migration_052_platform_admins.sql';
const MIGRATION_MESSAGE = `The database is missing ${MIGRATION_FILE}. Apply it (migrations/${MIGRATION_FILE}) and retry.`;

/** True when a MySQL error means "migration_052 has not been applied yet". */
function isMissingMigration(err) {
    return !!err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR');
}

/**
 * Writes one row to panel_audit_log for a vendor-panel write action,
 * attributed to the Firebase platform account in req.platform
 * ({ uid, email, name, role }, set by middleware/adminPanelAuth.js).
 *
 * Firebase actors are written with panel_admin_id NULL (that column has an
 * FK to the legacy panel_admins table) plus firebase_uid / actor_email /
 * actor_name (migration_052). If those columns do not exist yet, the row is
 * still written without them and the actor is kept inside `detail._actor`,
 * so nothing is lost before the migration is applied.
 *
 * Deliberately swallows its own errors rather than failing the action it
 * is logging; the failure is logged to the server console instead.
 */
async function logPanelAction(req, action, targetType, targetId, detail) {
    const actor = req.platform || {};
    const detailObj = detail ?? {};
    try {
        await pool.query(
            `INSERT INTO panel_audit_log
               (panel_admin_id, firebase_uid, actor_email, actor_name, action, target_type, target_id, detail)
             VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)`,
            [actor.uid || null, actor.email || null, actor.name || null, action, targetType, targetId ?? null, JSON.stringify(detailObj)]
        );
    } catch (err) {
        if (err.code === 'ER_BAD_FIELD_ERROR') {
            console.error(`panel_audit_log is missing the actor columns; apply ${MIGRATION_FILE}. Writing a reduced row.`);
            try {
                await pool.query(
                    'INSERT INTO panel_audit_log (panel_admin_id, action, target_type, target_id, detail) VALUES (NULL, ?, ?, ?, ?)',
                    [action, targetType, targetId ?? null,
                        JSON.stringify({ ...detailObj, _actor: { uid: actor.uid || null, email: actor.email || null } })]
                );
                return;
            } catch (err2) {
                console.error('Failed to write panel_audit_log row:', err2.message);
                return;
            }
        }
        console.error('Failed to write panel_audit_log row:', err.message);
    }
}

module.exports = { logPanelAction, isMissingMigration, MIGRATION_MESSAGE, MIGRATION_FILE };
