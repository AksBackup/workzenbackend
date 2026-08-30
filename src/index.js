require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// Two ways to supply the Firebase service account:
//   - FIREBASE_SERVICE_ACCOUNT_JSON: the whole JSON pasted as one env var
//     value. Use this on Render - there's no convenient way to upload a
//     standalone file there, and you never want this secret committed to git.
//   - FIREBASE_SERVICE_ACCOUNT_PATH: a path to the JSON file on disk. Use
//     this for local dev, where dropping the downloaded file in the project
//     root (and .gitignore-ing it) is simplest.
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} else {
    serviceAccount = require(path.resolve(
        process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './firebase-service-account.json'
    ));
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const licenseRoutes = require('./routes/license');
const employeeRoutes = require('./routes/employees');
const attendanceRoutes = require('./routes/attendance');
const leaveRoutes = require('./routes/leaves');
const taskRoutes = require('./routes/tasks');
const holidayRoutes = require('./routes/holidays');
const departmentRoutes = require('./routes/departments');
const designationRoutes = require('./routes/designations');
const officeTimePolicyRoutes = require('./routes/officeTimePolicy');
const overtimeRoutes = require('./routes/overtime');
const weeklyOffRoutes = require('./routes/weeklyOff');
const payrollRoutes = require('./routes/payroll');

// --- Phase 5 parallel build pass (see docs/FROZEN_CONTRACT_V2.md) ---

// Agent A scope (AGENT_A_MASTERS_DEVICES.md).
const deviceRoutes = require('./routes/devices');
const branchRoutes = require('./routes/branches');
const shiftRoutes = require('./routes/shifts');
const workCodeRoutes = require('./routes/workCodes');
const companyRoutes = require('./routes/companies');

// Agent B scope (AGENT_B_ATTENDANCE_LEAVE_OPS.md).
// NOTE (merge): both Agent A and Agent B independently built
// routes/leaveTypes.js - a genuine collision (Define Leave, 3.8, sits
// on the boundary between "masters" and "leave ops"). The merged
// leaveTypes.js combines both (A's PUT support + B's duplicate-name
// guard on POST) and is required/mounted exactly once, here.
const leaveTypeRoutes = require('./routes/leaveTypes');
const leaveOpeningRoutes = require('./routes/leaveOpening');
const shiftAssignmentRoutes = require('./routes/shiftAssignments');
const manualPunchRoutes = require('./routes/manualPunch');
const visitorRoutes = require('./routes/visitors');
const canteenRoutes = require('./routes/canteen');

// Agent C scope (AGENT_C_PAYROLL_REPORTS_ADMIN.md).
const loanRoutes = require('./routes/loans');
const bonusRoutes = require('./routes/bonuses');
const conveyanceRoutes = require('./routes/conveyance');
const reportRoutes = require('./routes/reports');
const errorLogRoutes = require('./routes/errorLogs');
const backupRoutes = require('./routes/backup');
const adminRoutes = require('./routes/admins');

// Dashboard redesign scope - calendar widget + notes widget, both new
// (see migration_006_dashboard_widgets.sql).
const calendarEventRoutes = require('./routes/calendarEvents');
const dashboardNotesRoutes = require('./routes/dashboardNotes');

const pool = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

// Internal license admin panel (public/index.html) - protected route-by-route
// inside routes/license.js via adminPanelAuth, not by this static mount.
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/license', licenseRoutes);
app.use('/employees', employeeRoutes);
app.use('/attendance', attendanceRoutes);
app.use('/leave-applications', leaveRoutes);
app.use('/tasks', taskRoutes);
app.use('/holidays', holidayRoutes);
app.use('/departments', departmentRoutes);
app.use('/designations', designationRoutes);
app.use('/office-time-policy', officeTimePolicyRoutes);
app.use('/overtime', overtimeRoutes);
app.use('/weekly-off', weeklyOffRoutes);
app.use('/payroll', payrollRoutes);

// Agent A scope.
app.use('/devices', deviceRoutes);
app.use('/branches', branchRoutes);
app.use('/shifts', shiftRoutes);
app.use('/leave-types', leaveTypeRoutes);
app.use('/work-codes', workCodeRoutes);
app.use('/companies', companyRoutes);

// Agent B scope - appended, existing lines above are untouched per
// FROZEN_CONTRACT_V2.md. '/leave-types' is NOT re-mounted here (see the
// merged leaveTypeRoutes require above) - mounting the same path twice
// would silently shadow one implementation with the other.
app.use('/leave-balances', leaveOpeningRoutes);
app.use('/shift-assignments', shiftAssignmentRoutes);
app.use('/manual-punches', manualPunchRoutes);
app.use('/visitors', visitorRoutes);
app.use('/canteen', canteenRoutes);

// Agent C scope (Phase 5) - appended, existing app.use(...) lines above untouched.
app.use('/loans', loanRoutes);
app.use('/bonuses', bonusRoutes);
app.use('/conveyance', conveyanceRoutes);
app.use('/reports', reportRoutes);
app.use('/error-logs', errorLogRoutes);
app.use('/backup', backupRoutes);
app.use('/admins', adminRoutes);

// Dashboard redesign scope.
app.use('/calendar-events', calendarEventRoutes);
app.use('/dashboard-notes', dashboardNotesRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// 404 for anything unmatched (after the static/panel mount and all routes above)
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// Last-resort error handler. Every route is wrapped in asyncHandler, which
// forwards rejected promises here via next(err) instead of throwing - this
// is what turns "one bad query" into a clean 500 response instead of a
// crashed process that takes every company on this server offline.
//
// Agent C addition (View Error Logs, SCREENS.md 10.3): every 500 caught
// here now also gets INSERTed into error_logs, in addition to the
// existing console.error. This insert is deliberately best-effort and
// wrapped in its own try/catch - if the DB itself is what's down (the
// exact scenario CONTEXT.md's crash-safety fix was written for), a
// failed logging attempt must never throw again and re-trigger this same
// handler. req.user may not be set (e.g. the error happened before
// verifyFirebaseToken ran, or on a route with no auth at all) - those
// rows are written with company_id = NULL for the vendor's own
// debugging, and are intentionally excluded from any customer's own
// Error Logs screen (see errorLogs.js) and from Backup export/restore
// (see backup.js).
app.use(async (err, req, res, next) => {
    console.error('Unhandled error:', err);
    try {
        await pool.query(
            'INSERT INTO error_logs (company_id, route, message, stack) VALUES (?, ?, ?, ?)',
            [req.user?.companyId || null, req.originalUrl || null, err.message || String(err), err.stack || null]
        );
    } catch (logErr) {
        console.error('Failed to write to error_logs (DB may be unreachable):', logErr);
    }
    res.status(500).json({ error: 'Internal server error' });
});

// Belt-and-braces: catch anything that still somehow slips through
// (e.g. an error thrown outside of any Express request cycle) so the
// process logs it and can be restarted by Render instead of failing silently.
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    process.exit(1); // let Render's process manager restart cleanly
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`HRMS API listening on port ${PORT}`));
