const Module = require('module'); const orig = Module._load;
let holidays = new Set(['2026-10-06','2026-10-07','2026-10-08']); let offBitmask = 0;
let quota = { quota: 4, used: 0 };
Module._load = function (req, parent, ...a) {
  if (req === '../db') return { query: async (sql) => [[{ full_day_hours: 8 }]] };
  if (req === './attendanceRules') return {
    loadHolidayIndex: async () => ({ isHoliday: (d) => holidays.has(d) }),
    loadEmployeeHolidayGroups: async () => new Map(), loadWeeklyOffIndex: async () => ({}),
    loadShiftOffIndex: async () => ({ byId: new Map() }), loadShiftPolicyOffIndex: async () => ({}),
    isAltSaturdayOff: () => false };
  if (req === './dayClassifier') return { resolveEmployeeOffDays: () => ({ offDaysBitmask: offBitmask, altSaturdays: null, isWeeklyOff2: () => false }) };
  if (req === './leaveQuota') return { computeMonthlyPaidUsage: async () => ({ ...quota }) };
  if (req === './leaveIndex') return { addDays: orig.call(this, '' + require('path').join(__dirname, '..', 'src') + '/utils/leaveIndex.js', parent).addDays, loadLeaveIndex: async () => ({ get: () => null }) };
  return orig.call(this, req, parent, ...a);
};
// leaveIndex requires ../db too; load addDays separately via same hook
const { planLeave } = require('' + require('path').join(__dirname, '..', 'src') + '/utils/leaveDays.js');
const emp = { id: 1, shift_id: null, department: null };
const T = (o) => ({ id: 1, is_paid: 1, count_holidays: 'no', count_weekly_offs: 'no', ...o });
let fails = 0;
const check = (name, cond, extra='') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + ' ' + extra); if (!cond) fails++; };
(async () => {
  // user's example: 9 days, 3 holidays inside
  let p = await planLeave({ companyId: 1, employee: emp, leaveType: T({}), from: '2026-10-05', to: '2026-10-13' });
  check('9 days with 3 holidays, mode no -> 6 leave days', p.daysCount === 6 && p.excluded.length === 3, JSON.stringify([p.daysCount, p.excluded.length]));
  check('paid 4 (quota) / unpaid 2', p.paidDays === 4 && p.unpaidDays === 2, JSON.stringify([p.paidDays, p.unpaidDays]));
  p = await planLeave({ companyId: 1, employee: emp, leaveType: T({ count_holidays: 'yes' }), from: '2026-10-05', to: '2026-10-13' });
  check('mode yes -> 9 leave days', p.daysCount === 9);
  p = await planLeave({ companyId: 1, employee: emp, leaveType: T({ count_holidays: 'between' }), from: '2026-10-05', to: '2026-10-13' });
  check('mode between, holidays between working days -> 9', p.daysCount === 9);
  p = await planLeave({ companyId: 1, employee: emp, leaveType: T({ count_holidays: 'between' }), from: '2026-10-06', to: '2026-10-13' });
  check('mode between, holidays at start edge -> not counted (5)', p.daysCount === 5, String(p.daysCount));
  p = await planLeave({ companyId: 1, employee: emp, leaveType: T({ is_paid: 0 }), from: '2026-10-05', to: '2026-10-13' });
  check('unpaid type -> all unpaid', p.paidDays === 0 && p.unpaidDays === 6);
  p = await planLeave({ companyId: 1, employee: emp, leaveType: T({ count_holidays: 'yes', is_paid: 0 }), from: '2026-10-05', to: '2026-10-13' });
  check('unpaid + sandwiched holidays counted -> 9 unpaid (holidays are LOP too)', p.unpaidDays === 9 && p.days.filter(d=>d.kind==='holiday'&&d.paidFraction===0).length === 3);
  p = await planLeave({ companyId: 1, employee: emp, leaveType: T({}), durationType: 'half', session: 'second', from: '2026-10-09' });
  check('half day = 0.5, session second', p.daysCount === 0.5 && p.session === 'second' && p.paidDays === 0.5);
  p = await planLeave({ companyId: 1, employee: emp, leaveType: T({}), durationType: 'quarter', from: '2026-10-09' });
  check('quarter = 0.25', p.daysCount === 0.25);
  p = await planLeave({ companyId: 1, employee: emp, leaveType: T({}), durationType: 'hours', from: '2026-10-09', fromTime: '10:00', toTime: '12:00' });
  check('2 hours of 8h day = 0.25', p.daysCount === 0.25 && p.hours === 2, JSON.stringify([p.daysCount, p.hours]));
  p = await planLeave({ companyId: 1, employee: emp, leaveType: T({}), durationType: 'hours', from: '2026-10-09', fromTime: '10:00', toTime: '11:30' });
  check('1.5 hours = 0.19', p.daysCount === 0.19, String(p.daysCount));
  quota = { quota: 0.25, used: 0 };
  p = await planLeave({ companyId: 1, employee: emp, leaveType: T({}), durationType: 'half', from: '2026-10-09' });
  check('half day with only 0.25 quota left -> 0.25 paid + 0.25 unpaid', p.paidDays === 0.25 && p.unpaidDays === 0.25);
  quota = { quota: 4, used: 0 };
  for (const [name, input, re] of [
    ['half day on a holiday rejected', { durationType: 'half', from: '2026-10-07' }, /holiday/],
    ['half day over 2 dates rejected', { durationType: 'half', from: '2026-10-09', to: '2026-10-10' }, /single date/],
    ['hours >= full day rejected', { durationType: 'hours', from: '2026-10-09', fromTime: '09:00', toTime: '18:00' }, /full day/],
    ['bad time rejected', { durationType: 'hours', from: '2026-10-09', fromTime: 'abc', toTime: '18:00' }, /HH:MM/],
    ['end before start rejected', { from: '2026-10-09', to: '2026-10-08' }, /cannot be before/],
    ['only holidays rejected', { from: '2026-10-06', to: '2026-10-08' }, /holidays or weekly offs/],
  ]) {
    try { await planLeave({ companyId: 1, employee: emp, leaveType: T({}), ...input }); check(name, false, 'no error'); }
    catch (e) { check(name, re.test(e.message) && e.status === 400, e.message); }
  }
  console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
})();
