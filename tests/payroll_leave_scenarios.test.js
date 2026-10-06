const Module = require('module'); const orig = Module._load;
const P = '' + require('path').join(__dirname, '..', 'src') + '/';
const holidays = new Set(['2026-09-03']);
const att = (d, a, b) => ({ employee_id: 1, date: d, check_in: `${d}T${a}`, check_out: `${d}T${b}` });
const sql = (q, params) => {
  if (q.includes('FROM employees e')) return [{ id: 1, name: 'Test', emp_code: 'T1', salary: 30000, doj: null, department: null, shift_id: null, default_salary: null, statutory_override_active: 0 }];
  if (q.includes('FROM salary_heads')) return [];
  if (q.includes('FROM office_time_policy')) return [{ full_day_hours: 8, half_day_min_hours: 4 }];
  if (q.includes('FROM attendance')) return [att('2026-09-04', '09:00:00', '13:00:00'), att('2026-09-07', '09:00:00', '13:00:00')];
  if (q.includes('FROM shifts')) return [];
  if (q.includes('FROM payroll_records')) return [];
  if (q.includes('FROM bonuses')) return [];
  if (q.includes('FROM loans')) return [];
  if (q.includes('FROM conveyance_claims')) return [{ id: 9, employee_id: 1, amount: 400, reason: 'visit', date: '2026-09-10' }];
  if (q.includes('FROM overtime_records')) return [];
  if (q.includes('FROM statutory_settings')) return [{ pf_enabled: 0, esi_enabled: 0, pt_enabled: 0 }];
  if (q.includes('FROM pt_slabs')) return [];
  return [];
};
const leaveRows = {
  '1|2026-09-01': { fraction: 1, paidFraction: 1, kind: 'working' },
  '1|2026-09-02': { fraction: 1, paidFraction: 0, kind: 'working' },
  '1|2026-09-03': { fraction: 1, paidFraction: 0, kind: 'holiday' },     // sandwiched holiday that is LOP
  '1|2026-09-04': { fraction: 0.5, paidFraction: 0.5, kind: 'working' }, // half day paid + worked 4h
  '1|2026-09-07': { fraction: 0.5, paidFraction: 0, kind: 'working' },   // half day unpaid + worked 4h
};
Module._load = function (req, parent, ...a) {
  if (req === '../db') return { query: async (q, p) => [sql(q, p)] };
  if (req === 'express') return { Router: () => ({ use() {}, get() {}, post() {}, put() {}, delete() {} }) };
  if (req === '../middleware/verifyFirebaseToken') return { verifyFirebaseToken() {}, requireAdmin() {} };
  if (req === '../utils/asyncHandler') return (f) => f;
  if (req === '../utils/attendanceRules' || req === './attendanceRules') return {
    loadHolidayIndex: async () => ({ isHoliday: (d) => holidays.has(d) }), loadEmployeeHolidayGroups: async () => new Map(),
    loadWeeklyOffIndex: async () => ({}), loadShiftOffIndex: async () => ({ byId: new Map() }),
    loadPunchEventsIndex: async () => ({ forEmployeeDate: () => [] }),
    loadShiftPolicyIndex: async () => ({ has: () => false, deductBreaksFor: () => false, graceFor: () => null, rulesFor: () => null, prefixSuffixFor: () => null }),
    loadShiftPolicyOffIndex: async () => ({ has: () => false }),
    derivePunchSpan: () => null, applyPrefixSuffixAbsent: () => {}, isAltSaturdayOff: () => false, effectiveOffDaysBitmask: () => 0 };
  if (req === '../utils/punchPairing') return { windowForShift: () => null };
  if (req === '../utils/paymentWindow') return { resolvePaymentWindow: async () => ({ open: true }) };
  if (req === '../utils/leaveIndex') return { loadLeaveIndex: async () => ({ get: (e, d) => leaveRows[`${e}|${d}`] || null }) };
  return orig.call(this, req, parent, ...a);
};
const { computeMonthlyPayroll } = require(P + 'routes/payroll.js');
(async () => {
  const [r] = await computeMonthlyPayroll(1, 2026, 9);
  console.log('day_counts', JSON.stringify(r.day_counts));
  console.log('units', r.payable_day_units, 'earned', r.earned_amount, 'conveyance', r.conveyance_total, 'total2', r.total_2, 'gross', r.gross_total);
  const c = r.day_counts;
  // expected: Sep1 paid leave 1; Sep2 unpaid 1; Sep3 holiday LOP (unpaid 1, NOT a holiday);
  // Sep4 half-day paid leave + 4h worked = 1 day; Sep7 half-day unpaid leave + 4h worked = 0.5; 23 other days absent
  const ok = r.payable_day_units === 2.5 && r.earned_amount === 2500
    && c.paid_leave === 1.5 && c.unpaid_leave === 2.5 && c.present === 1 && c.holiday === 0
    && r.conveyance_total === 400 && r.gross_total === 2900;
  console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
