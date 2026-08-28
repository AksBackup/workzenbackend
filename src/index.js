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

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// 404 for anything unmatched (after the static/panel mount and all routes above)
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// Last-resort error handler. Every route is wrapped in asyncHandler, which
// forwards rejected promises here via next(err) instead of throwing - this
// is what turns "one bad query" into a clean 500 response instead of a
// crashed process that takes every company on this server offline.
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
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
