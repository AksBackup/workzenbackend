const pool = require('../db');

/**
 * Per-day shift resolution shared by payroll (and mirrored in reports.js):
 *   1) a Shift Roster row (shift_assignments) covering that date wins,
 *   2) else, if the employee works in several shifts (employee_shifts, migration_044),
 *      the one whose start time is closest to their FIRST punch of the day,
 *   3) else the employee's primary shift (employees.shift_id).
 * Returns null when nothing applies (caller falls back to its default shift).
 */
const toMin = (t) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const dKey = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

function pickClosestShift(shifts, firstPunch) {
    if (!shifts.length) return null;
    if (shifts.length === 1 || !firstPunch) return shifts[0];
    const p = firstPunch instanceof Date ? firstPunch.getUTCHours() * 60 + firstPunch.getUTCMinutes() : toMin(String(firstPunch).slice(11, 16));
    if (p == null) return shifts[0];
    let best = shifts[0], bestDiff = Infinity;
    for (const s of shifts) {
        const st = toMin(s.start_time);
        if (st == null) continue;
        let diff = Math.abs(p - st);
        diff = Math.min(diff, 1440 - diff); // wrap around midnight (night shifts)
        if (diff < bestDiff) { bestDiff = diff; best = s; }
    }
    return best;
}

async function loadDayShiftResolver(companyId, fromStr, toStr, shiftsById) {
    let links = [];
    try {
        [links] = await pool.query('SELECT employee_id, shift_id FROM employee_shifts WHERE company_id = ? ORDER BY sort_order, shift_id', [companyId]);
    } catch (err) { if (err.code !== 'ER_NO_SUCH_TABLE') throw err; }
    const multi = new Map();
    for (const l of links) { if (!multi.has(l.employee_id)) multi.set(l.employee_id, []); multi.get(l.employee_id).push(l.shift_id); }
    const [rosterRows] = await pool.query(
        `SELECT employee_id, shift_id, effective_from, effective_to FROM shift_assignments
         WHERE company_id = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
         ORDER BY effective_from DESC, id DESC`, [companyId, toStr, fromStr]);
    const rosterByEmp = new Map();
    for (const r of rosterRows) { if (!rosterByEmp.has(r.employee_id)) rosterByEmp.set(r.employee_id, []); rosterByEmp.get(r.employee_id).push(r); }

    return {
        /** @returns shift row or null.  firstPunch: Date | 'YYYY-MM-DD HH:mm:ss' | null */
        resolve(emp, dateStr, firstPunch) {
            for (const r of rosterByEmp.get(emp.id) || []) {
                if (dKey(r.effective_from) <= dateStr && (!r.effective_to || dKey(r.effective_to) >= dateStr)) {
                    const s = shiftsById.get(r.shift_id);
                    if (s) return s;
                }
            }
            const ids = multi.get(emp.id);
            if (ids && ids.length > 1) {
                const list = ids.map((id) => shiftsById.get(id)).filter(Boolean);
                const s = pickClosestShift(list, firstPunch);
                if (s) return s;
            }
            return emp.shift_id != null ? (shiftsById.get(emp.shift_id) || null) : null;
        },
    };
}

/** A roster entry whose shift is named OFF (any case) means Week Off / Holiday for that day. */
const isOffShiftName = (name) => String(name || '').trim().toUpperCase() === 'OFF';

/** In-memory index: is this employee on a roster "OFF" on this date? One query per report run. */
async function loadRosterOffIndex(companyId, fromStr, toStr) {
    let rows = [];
    try {
        [rows] = await pool.query(
            `SELECT sa.employee_id, sa.effective_from, sa.effective_to, sa.id, s.name
             FROM shift_assignments sa JOIN shifts s ON s.id = sa.shift_id
             WHERE sa.company_id = ? AND sa.effective_from <= ? AND (sa.effective_to IS NULL OR sa.effective_to >= ?)
             ORDER BY sa.effective_from ASC, sa.id ASC`, [companyId, toStr, fromStr]);
    } catch (err) { if (err.code !== 'ER_NO_SUCH_TABLE') throw err; }
    const byEmp = new Map();
    for (const r of rows) { if (!byEmp.has(r.employee_id)) byEmp.set(r.employee_id, []); byEmp.get(r.employee_id).push(r); }
    return {
        isOff(employeeId, dateStr) {
            const list = byEmp.get(employeeId);
            if (!list) return false;
            let hit = null; // latest-starting applicable row wins (same rule as the report shift lookup)
            for (const r of list) {
                if (dKey(r.effective_from) <= dateStr && (!r.effective_to || dKey(r.effective_to) >= dateStr)) hit = r;
            }
            return !!hit && isOffShiftName(hit.name);
        },
    };
}

module.exports = { loadDayShiftResolver, pickClosestShift, isOffShiftName, loadRosterOffIndex };
