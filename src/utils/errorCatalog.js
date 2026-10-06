/**
 * ERROR CATALOG - the single place that turns technical failures into
 *   (a) a short, user-friendly message and
 *   (b) a stable CODE the developer can search for.
 *
 * The user sees:   "This serial number is already used by another device. (Code: WZ-DUP-SERIAL)"
 * The developer:   searches the code in ERROR_CODES.md (generated from this file:
 *                  `npm run error-codes`) and in the Error Logs screen / server console, where the
 *                  ORIGINAL technical error (SQL message, stack) is stored next to the code.
 *
 * Code format
 *   WZ-DUP-<FIELD>      duplicate value in a unique field        (409)
 *   WZ-DB-<KIND>        other database problems                  (see CATALOG)
 *   WZ-REQ-<KIND>       malformed request                        (400/413)
 *   WZ-SYS-<KIND>       unexpected server failure                (500)
 *   WZ-<AREA>-<HTTP>    explicit errors raised by a route, e.g. WZ-DEV-404 = device route, not found
 */

// ---- 1) specific, hand-written errors -------------------------------------------------------
const CATALOG = {
    'WZ-DB-DUP':        { status: 409, message: 'This value already exists. Please use a different one.' },
    'WZ-DB-FK-MISSING': { status: 400, message: 'The selected item no longer exists. Please refresh and try again.' },
    'WZ-DB-FK-INUSE':   { status: 409, message: 'This item is being used elsewhere, so it cannot be deleted or changed.' },
    'WZ-DB-REQUIRED':   { status: 400, message: 'A required field is missing. Please fill in all required fields.' },
    'WZ-DB-TOOLONG':    { status: 400, message: 'One of the values you entered is too long.' },
    'WZ-DB-BADVALUE':   { status: 400, message: 'One of the values you entered is not valid (check dates and numbers).' },
    'WZ-DB-SCHEMA':     { status: 500, message: 'The server database is out of date. Please contact support.' },
    'WZ-DB-DOWN':       { status: 503, message: 'The server cannot reach its database right now. Please try again in a minute.' },
    'WZ-DB-BUSY':       { status: 503, message: 'The server is busy. Please try again.' },
    'WZ-REQ-BADJSON':   { status: 400, message: 'The request could not be read. Please update the app and try again.' },
    'WZ-REQ-TOOBIG':    { status: 413, message: 'The data you sent is too large.' },
    'WZ-SYS-UNKNOWN':   { status: 500, message: 'Something went wrong on our side. Please try again; if it keeps happening contact support with this code.' },
};

// ---- 2) duplicate-key field names: which unique index/column => which friendly label ---------
// Matched (case-insensitive, first hit wins) against the index/key name MySQL reports
// ("Duplicate entry 'X' for key 'devices.uq_devices_serial'") and, as a fallback, the table name.
const DUP_FIELDS = [
    { match: /serial/,                code: 'WZ-DUP-SERIAL',    message: 'This serial number is already used by another device.' },
    { match: /device_?code/,          code: 'WZ-DUP-DEVCODE',   message: 'This device code is already used by another device.' },
    { match: /emp_?code|empcode/,     code: 'WZ-DUP-EMPCODE',   message: 'This Employee ID is already used by another employee.' },
    { match: /firebase_?uid/,         code: 'WZ-DUP-LOGIN',     message: 'A login already exists for this person.' },
    { match: /email/,                 code: 'WZ-DUP-EMAIL',     message: 'This email address is already in use.' },
    { match: /phone|mobile/,          code: 'WZ-DUP-PHONE',     message: 'This phone number is already in use.' },
    { match: /license/,               code: 'WZ-DUP-LICENSE',   message: 'This license key is already in use.' },
    { match: /uq_employee_date|employee_date/, code: 'WZ-DUP-ATTDAY', message: 'Attendance for this employee on this date already exists.' },
    { match: /emp_type_year/,         code: 'WZ-DUP-LEAVEBAL',  message: 'A leave balance for this employee, leave type and year already exists.' },
    { match: /company_date_name/,     code: 'WZ-DUP-HOLIDAY',   message: 'A holiday with this name already exists on this date.' },
    { match: /payment_window/,        code: 'WZ-DUP-PAYWINDOW', message: 'A payment window for this month already exists.' },
    { match: /name/,                  code: 'WZ-DUP-NAME',      message: 'An entry with this name already exists.' },
    { match: /code/,                  code: 'WZ-DUP-CODE',      message: 'This code is already in use.' },
];

// ---- 3) route prefix -> area tag for generic "WZ-<AREA>-<HTTP>" codes ------------------------
const AREAS = {
    license: 'LIC', panel: 'PNL', iclock: 'ADM', auth: 'AUTH', communications: 'COM', employees: 'EMP',
    attendance: 'ATT', 'leave-applications': 'LVE', tasks: 'TSK', holidays: 'HOL', departments: 'DEP',
    designations: 'DSG', 'office-time-policy': 'OTP', overtime: 'OT', 'weekly-off': 'WOF', payroll: 'PAY',
    'statutory-settings': 'STAT', 'payroll-payment-window': 'PAYWIN', devices: 'DEV', branches: 'BRN',
    shifts: 'SHF', 'leave-types': 'LVT', 'work-codes': 'WRK', companies: 'CMP', 'leave-balances': 'LVB',
    'leave-adjustments': 'LVA', 'shift-assignments': 'SHA', 'manual-punches': 'MPN', 'mobile-punches': 'MOB',
    visitors: 'VIS', canteen: 'CAN', loans: 'LON', 'ad-hoc-payments': 'ADH', 'salary-structures': 'SAL',
    'app-users': 'USR', import: 'IMP', bonuses: 'BON', conveyance: 'CNV', reports: 'RPT', 'error-logs': 'LOG',
    backup: 'BKP', admins: 'ADM2', 'calendar-events': 'CAL', 'dashboard-notes': 'NOT', 'holiday-groups': 'HGR',
    'employee-categories': 'ECT', 'geofence-zones': 'GEO', 'field-tracking': 'FLD', 'raw-punches': 'RAW',
    dashboard: 'DSH',
};

// ---- 4) plain-language defaults when a route gave NO message of its own ----------------------
const STATUS_MESSAGES = {
    400: 'The request was not valid. Please check what you entered.',
    401: 'Your session has expired. Please sign in again.',
    403: 'You do not have permission to do this.',
    404: 'The item you are looking for was not found.',
    409: 'This conflicts with existing data.',
    413: 'The data you sent is too large.',
    422: 'Some of the information you entered is not valid.',
    429: 'Too many attempts. Please wait a moment and try again.',
    500: CATALOG['WZ-SYS-UNKNOWN'].message,
    502: 'The server is temporarily unavailable. Please try again.',
    503: 'The server is temporarily unavailable. Please try again.',
};

function areaFor(originalUrl) {
    const seg = String(originalUrl || '').split('?')[0].split('/').filter(Boolean)[0] || '';
    return AREAS[seg] || (seg ? seg.replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase() : 'GEN');
}

/** Classify any thrown error -> { status, code, message } (message = friendly, no code suffix). */
function classifyError(err) {
    const code = err && err.code;
    const sqlMsg = String((err && (err.sqlMessage || err.message)) || '');

    if (err && err.appCode && CATALOG[err.appCode]) { // explicit: throw Object.assign(new Error(), { appCode: 'WZ-...' })
        return { code: err.appCode, ...CATALOG[err.appCode] };
    }
    if (err && err.type === 'entity.parse.failed') return { code: 'WZ-REQ-BADJSON', ...CATALOG['WZ-REQ-BADJSON'] };
    if (err && err.type === 'entity.too.large') return { code: 'WZ-REQ-TOOBIG', ...CATALOG['WZ-REQ-TOOBIG'] };

    if (code === 'ER_DUP_ENTRY') {
        const key = (sqlMsg.match(/for key '([^']+)'/) || [])[1] || '';
        const hit = DUP_FIELDS.find(f => f.match.test(key.toLowerCase()));
        if (hit) return { code: hit.code, status: 409, message: hit.message };
        return { code: 'WZ-DB-DUP', ...CATALOG['WZ-DB-DUP'] };
    }
    if (code === 'ER_NO_REFERENCED_ROW' || code === 'ER_NO_REFERENCED_ROW_2') return { code: 'WZ-DB-FK-MISSING', ...CATALOG['WZ-DB-FK-MISSING'] };
    if (code === 'ER_ROW_IS_REFERENCED' || code === 'ER_ROW_IS_REFERENCED_2') return { code: 'WZ-DB-FK-INUSE', ...CATALOG['WZ-DB-FK-INUSE'] };
    if (code === 'ER_BAD_NULL_ERROR' || code === 'ER_NO_DEFAULT_FOR_FIELD') return { code: 'WZ-DB-REQUIRED', ...CATALOG['WZ-DB-REQUIRED'] };
    if (code === 'ER_DATA_TOO_LONG') return { code: 'WZ-DB-TOOLONG', ...CATALOG['WZ-DB-TOOLONG'] };
    if (['ER_TRUNCATED_WRONG_VALUE', 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD', 'ER_WRONG_VALUE_FOR_TYPE',
         'ER_WARN_DATA_OUT_OF_RANGE', 'ER_DATA_OUT_OF_RANGE', 'ER_INVALID_JSON_TEXT'].includes(code)) {
        return { code: 'WZ-DB-BADVALUE', ...CATALOG['WZ-DB-BADVALUE'] };
    }
    if (code === 'ER_BAD_FIELD_ERROR' || code === 'ER_NO_SUCH_TABLE' || code === 'ER_PARSE_ERROR') return { code: 'WZ-DB-SCHEMA', ...CATALOG['WZ-DB-SCHEMA'] };
    if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST', 'ER_CON_COUNT_ERROR', 'ER_ACCESS_DENIED_ERROR'].includes(code)) {
        return { code: 'WZ-DB-DOWN', ...CATALOG['WZ-DB-DOWN'] };
    }
    if (code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT') return { code: 'WZ-DB-BUSY', ...CATALOG['WZ-DB-BUSY'] };
    return { code: 'WZ-SYS-UNKNOWN', ...CATALOG['WZ-SYS-UNKNOWN'] };
}

const withCode = (message, code) => `${message} (Code: ${code})`;

module.exports = { CATALOG, DUP_FIELDS, AREAS, STATUS_MESSAGES, areaFor, classifyError, withCode };
