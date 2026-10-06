// Minimal fake pool so require() works without a DB, then fake conn for revertLoanDeductions
const Module = require('module');
const orig = Module._load;
Module._load = function (req, ...a) {
  if (req === '../db') return { query: async () => [[]], getConnection: async () => ({}) };
  if (req === '../middleware/verifyFirebaseToken') return { verifyFirebaseToken: (q,r,n)=>n(), requireAdmin: (q,r,n)=>n() };
  if (req === 'express') { const r = () => ({ use(){}, get(){}, post(){}, put(){}, delete(){} }); const e = () => ({}); e.Router = r; return e; }
  try { return orig.call(this, req, ...a); }
  catch (err) { if (err.code === 'MODULE_NOT_FOUND') return new Proxy(function(){}, { get: () => () => ({}) }); throw err; }
};
const { revertLoanDeductions } = require('' + require('path').join(__dirname, '..', 'src') + '/routes/payroll.js');

const state = {
  loans: [{ id: 1, employee_id: 7, company_id: 1, principal_amount: 3000, status: 'closed' },   // fully repaid by the Sep auto deduction
          { id: 2, employee_id: 7, company_id: 1, principal_amount: 6000, status: 'active' }],
  pays: [
    { id: 10, company_id: 1, loan_id: 1, amount: 2000, source: 'manual', payroll_year: null, payroll_month: null },
    { id: 11, company_id: 1, loan_id: 1, amount: 1000, source: 'payroll_auto', payroll_year: 2026, payroll_month: 9 },
    { id: 12, company_id: 1, loan_id: 2, amount: 500, source: 'payroll_auto', payroll_year: 2026, payroll_month: 9 },
    { id: 13, company_id: 1, loan_id: 2, amount: 500, source: 'payroll_auto', payroll_year: 2026, payroll_month: 8 }, // other month: must stay
  ]};
const conn = { async query(sql, p) {
  if (sql.includes('FROM loan_payments lp')) {
    const [c,,emp,y,m] = p;
    return [state.pays.filter(x => x.company_id===c && x.source==='payroll_auto' && x.payroll_year===y && x.payroll_month===m && state.loans.find(l=>l.id===x.loan_id&&l.employee_id===emp))];
  }
  if (sql.includes('AS paid FROM loan_payments')) return [[{ paid: state.pays.filter(x=>x.loan_id===p[0]).reduce((a,b)=>a+b.amount,0) }]];
  if (sql.includes('SELECT principal_amount')) { const l = state.loans.find(x=>x.id===p[0]); return [[l]]; }
  if (sql.startsWith('DELETE FROM loan_payments')) { const ids=p[0]; state.pays = state.pays.filter(x=>!ids.includes(x.id)); return [{}]; }
  if (sql.includes("SET status = 'active'")) { state.loans.find(x=>x.id===p[0]).status='active'; return [{}]; }
  throw new Error('unexpected '+sql);
}};
(async () => {
  const n = await revertLoanDeductions(conn, 1, 7, 2026, 9);
  const paid = id => state.pays.filter(x=>x.loan_id===id).reduce((a,b)=>a+b.amount,0);
  console.log('rows removed', n);
  console.log('loan1 paid', paid(1), 'status', state.loans[0].status, '(expect 2000, active)');
  console.log('loan2 paid', paid(2), 'status', state.loans[1].status, '(expect 500, active; Aug row kept)');
  const ok = n===2 && paid(1)===2000 && state.loans[0].status==='active' && paid(2)===500 && state.pays.some(x=>x.id===13);
  console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok?0:1);
})();
