const pool = require('../db');
const cache = new Map();

/** Does `table`.`column` exist? Cached; lets new code run safely before its migration has been applied. */
async function hasColumn(table, column) {
    const key = `${table}.${column}`;
    if (cache.get(key) === true) return true; // a column never disappears; re-check while it is missing
    const [rows] = await pool.query(
        'SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1',
        [table, column]);
    const ok = rows.length > 0;
    if (ok) cache.set(key, true);
    return ok;
}

module.exports = { hasColumn };
