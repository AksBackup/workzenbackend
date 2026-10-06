/**
 * Single source of truth for turning a day's raw punch times into IN/OUT pairs.
 *
 *  - Punches are sorted by time; two scans < 1 minute apart are a double-tap
 *    (the later one is ignored).
 *  - Punches INSIDE the office window alternate IN, OUT, IN, OUT ... regardless of
 *    whatever punch_type the device / older code stored (older code labelled
 *    the 1st punch "in" and EVERY later one "out").
 *  - Punches OUTSIDE the window are kept (never deleted - audit trail) but marked
 *    'ignored' and do not affect pairing or worked hours.
 *  - Window = shift start - 2h  ..  shift end + 2h (or + max OT when the shift allows
 *    overtime). The 2h grace on both sides keeps normal early arrivals / slightly late
 *    leavers counted. No shift -> no window (every punch counts).
 */
function buildPunchWindow(dateStr, shift, { otAllowed = false, maxOtMinutes = null, earlyAllowanceMinutes = 120, lateAllowanceMinutes = 120 } = {}) {
    if (!shift || !shift.start_time || !shift.end_time) return null;
    const start = new Date(`${dateStr}T${shift.start_time}`);
    const winStart = new Date(start.getTime() - earlyAllowanceMinutes * 60000);
    const end = new Date(`${dateStr}T${shift.end_time}`);
    if (end <= start) end.setDate(end.getDate() + 1); // overnight shift
    const winEnd = new Date(end.getTime() + (otAllowed ? (Number(maxOtMinutes) > 0 ? Number(maxOtMinutes) : 12 * 60) : lateAllowanceMinutes) * 60000);
    return { start: winStart, end: winEnd };
}

/** times: array of Date | 'YYYY-MM-DD HH:mm:ss' | ISO string. */
function pairPunches(times, window = null) {
    const toDate = (t) => (t instanceof Date ? t : new Date(String(t).replace(' ', 'T')));
    const sorted = times.map((t) => ({ raw: t, dt: toDate(t) })).sort((a, b) => a.dt - b.dt);
    const punches = [];
    let lastCounted = null;
    for (const p of sorted) {
        const inWindow = !window || (p.dt >= window.start && p.dt <= window.end);
        if (inWindow && lastCounted && p.dt - lastCounted < 60 * 1000) continue; // double-tap
        punches.push({ raw: p.raw, dt: p.dt, inWindow });
        if (inWindow) lastCounted = p.dt;
    }
    const counted = punches.filter((p) => p.inWindow);
    counted.forEach((p, i) => { p.type = i % 2 === 0 ? 'in' : 'out'; });
    punches.filter((p) => !p.inWindow).forEach((p) => { p.type = 'ignored'; });

    const pairs = [];
    let totalMinutes = 0;
    for (let i = 0; i + 1 < counted.length; i += 2) {
        const mins = Math.round((counted[i + 1].dt - counted[i].dt) / 60000);
        pairs.push({ in: counted[i], out: counted[i + 1], minutes: mins });
        totalMinutes += mins;
    }
    return { punches, counted, pairs, totalMinutes, missingOut: counted.length % 2 === 1 };
}

/** Convenience: window straight from a shifts row (uses its ot_allowed flag). */
function windowForShift(dateStr, shift) {
    return buildPunchWindow(dateStr, shift, { otAllowed: !!(shift && shift.ot_allowed) });
}

module.exports = { buildPunchWindow, pairPunches, windowForShift };
