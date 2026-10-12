// Yearly pool (Leave Balance Entry "Yearly total", migration_053): leaveQuota precedence + bulk storage.
const Module = require('module'); const orig = Module._load;
let state = { pool: 0, monthlyRow: null, typeMonthly: 3, paidByRange: () => 0 };
const fakeDb = {
  query: async (sql, params) => {
    if (sql.includes('FROM leave_yearly_pools')) return [state.pool ? [{ allocated: String(state.pool) }] : []];
    if (sql.includes('FROM leave_balances')) return [state.monthlyRow === null ? [] : [{ allocated: String(state.monthlyRow) }]];
    if (sql.includes('FROM leave_types')) return [[{ monthly_quota: state.typeMonthly }]];
    if (sql.includes('SELECT a.days_count')) return [[]];
    if (sql.includes('FROM leave_application_days')) return [[{ used: state.paidByRange(params[3], params[4]) }]];
    if (sql.includes('FROM leave_applications')) return [[]];
    throw new Error('unexpected sql ' + sql);
  },
};
Module._load = function (req, parent, ...a) { return req === '../db' ? fakeDb : orig.call(this, req, parent, ...a); };
const root = require('path').join(__dirname, '..', 'src', 'utils');
const { computeMonthlyPaidUsage } = require(root + '/leaveQuota.js');
const { runBulkBalance } = require(root + '/leaveBalanceBulk.js');
let fails = 0;
const check = (n, c, x = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + ' ' + x); if (!c) fails++; };
(async () => {
  // Pool of 3 days; 2 paid days used in January (leave_date range check by from-date).
  state = { pool: 3, monthlyRow: 5, typeMonthly: 3, paidByRange: (from) => (from === '2026-01-01' ? 2 : 0) };
  let r = await computeMonthlyPaidUsage(1, 7, 10, 2026, 1);
  check('Jan: full pool available, monthly quota ignored', r.quota === 3 && r.used === 2 && r.yearly === true, JSON.stringify(r));
  r = await computeMonthlyPaidUsage(1, 7, 10, 2026, 2);
  check('Feb: pool reduced by January usage', r.quota === 1 && r.used === 0, JSON.stringify(r));
  state.paidByRange = (from) => (from === '2026-01-01' ? 3 : 0);
  r = await computeMonthlyPaidUsage(1, 7, 10, 2026, 3);
  check('Mar: pool exhausted -> quota 0 (rest unpaid)', r.quota === 0, JSON.stringify(r));
  // No pool -> monthly behaviour unchanged
  state = { pool: 0, monthlyRow: 5, typeMonthly: 3, paidByRange: () => 0 };
  r = await computeMonthlyPaidUsage(1, 7, 10, 2026, 2);
  check('no pool: monthly row used', r.quota === 5 && !r.yearly, JSON.stringify(r));
  state.monthlyRow = null;
  r = await computeMonthlyPaidUsage(1, 7, 10, 2026, 2);
  check('no pool, no row: type default', r.quota === 3, JSON.stringify(r));

  // Bulk yearly writes to leave_yearly_pools, tags the audit row, and Deletion clamps at 0.
  const log = { sql: [] };
  const conn = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
    query: async (sql, params) => {
      if (sql.includes('FROM employees e')) return [[{ id: 1 }]];
      if (sql.includes('FROM leave_types')) return [[{ id: 10, name: 'AL' }]];
      if (sql.includes('FOR UPDATE')) { log.sql.push(sql); return [[{ employee_id: 1, leave_type_id: 10, allocated: '2.0' }]]; }
      if (sql.includes('INSERT INTO leave_yearly_pools')) { log.pool = params[0]; log.sql.push(sql); return [{}]; }
      if (sql.includes('INSERT INTO leave_adjustments')) { log.audit = params[0]; return [{}]; }
      throw new Error('unexpected sql ' + sql);
    },
  };
  const pool = { getConnection: async () => conn };
  const base = { companyId: 1, adminId: 1, year: 2026, period: 'yearly', balances: [{ leaveTypeId: 10, tenths: 100 }], filter: {}, dryRun: false };
  let s = await runBulkBalance(pool, { ...base, mode: 'delete' });
  check('yearly delete clamps to 0 and uses pool table', log.pool[0][3] === 0 && log.sql.every(q => q.includes('leave_yearly_pools')) && s.period === 'yearly', JSON.stringify(log.pool));
  check('yearly audit tagged [Yearly], -2', log.audit[0][6].startsWith('[Yearly]') && log.audit[0][5] === -2, JSON.stringify(log.audit));
  s = await runBulkBalance(pool, { ...base, mode: 'add', balances: [{ leaveTypeId: 10, tenths: 25 }] });
  check('yearly add: 2 + 2.5 = 4.5', log.pool[0][3] === 4.5, JSON.stringify(log.pool));
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
