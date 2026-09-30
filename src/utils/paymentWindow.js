const pool = require('../db');

/**
 * Payment window = the date range in which salary for a given payroll month may
 * actually be PAID (e.g. May salary: 3 Jun - 7 Jun). Configured by the admin in
 * Settings > Payment Day Setup (routes/paymentWindow.js).
 *
 * Resolution order for (year, month):
 *  1. an explicit per-month row in payroll_payment_windows
 *  2. the company default: day X..Y of the FOLLOWING month (payroll_payment_settings)
 *  3. nothing configured -> the window opens the day after the month ends and
 *     never closes (a month still in progress can never be paid).
 * `enforce = false` in settings switches the whole check off.
 *
 * "Today" is computed at PAYROLL_UTC_OFFSET_MIN minutes from UTC (default 330 =
 * IST) because the process runs with TZ=UTC (see index.js).
 */
function todayStr() {
    const offset = Number(process.env.PAYROLL_UTC_OFFSET_MIN ?? 330);
    return new Date(Date.now() + offset * 60000).toISOString().slice(0, 10);
}
const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

async function resolvePaymentWindow(companyId, year, month) {
    const today = todayStr();
    const monthEnd = ymd(year, month, new Date(year, month, 0).getDate());
    let settings = { default_start_day: null, default_end_day: null, enforce: 1 };
    let override = null;
    try {
        const [s] = await pool.query('SELECT default_start_day, default_end_day, enforce FROM payroll_payment_settings WHERE company_id = ?', [companyId]);
        if (s.length) settings = s[0];
        const [o] = await pool.query('SELECT start_date, end_date FROM payroll_payment_windows WHERE company_id = ? AND year = ? AND month = ?', [companyId, year, month]);
        if (o.length) override = o[0];
    } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE') throw err; // migration_042 not applied yet -> behaves as "nothing configured"
    }

    const d = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
    let start = null, end = null, source = 'none';
    if (override) { start = d(override.start_date); end = d(override.end_date); source = 'month'; }
    else if (settings.default_start_day && settings.default_end_day) {
        const ny = month === 12 ? year + 1 : year, nm = month === 12 ? 1 : month + 1;
        const last = new Date(ny, nm, 0).getDate();
        start = ymd(ny, nm, Math.min(Number(settings.default_start_day), last));
        end = ymd(ny, nm, Math.min(Number(settings.default_end_day), last));
        source = 'default';
    }

    const enforce = !!settings.enforce;
    let open, reason = null;
    if (!enforce) open = true;
    else if (start && end) {
        open = today >= start && today <= end;
        if (!open) reason = today < start ? `Payment window opens on ${start}.` : `Payment window closed on ${end}.`;
    } else {
        open = today > monthEnd;
        if (!open) reason = 'This month is not finished yet and no payment window is configured.';
    }
    return { start, end, source, enforce, open, reason, today };
}

module.exports = { resolvePaymentWindow };
