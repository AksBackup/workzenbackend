# WorkZen error codes

Generated from `src/utils/errorCatalog.js` - do not edit by hand (run `npm run error-codes`).

Users see a friendly sentence ending in `(Code: WZ-...)`. The ORIGINAL technical error (SQL message, stack trace) is in the server console and the Error Logs table, prefixed with the same code.

## 1. Duplicate value (HTTP 409)
Triggered by MySQL `ER_DUP_ENTRY`; the unique-index name decides the code.

| Code | Index/key name contains | User message |
|---|---|---|
| `WZ-DUP-SERIAL` | `serial` | This serial number is already used by another device. |
| `WZ-DUP-DEVCODE` | `device_?code` | This device code is already used by another device. |
| `WZ-DUP-EMPCODE` | `emp_?code or empcode` | This Employee ID is already used by another employee. |
| `WZ-DUP-LOGIN` | `firebase_?uid` | A login already exists for this person. |
| `WZ-DUP-EMAIL` | `email` | This email address is already in use. |
| `WZ-DUP-PHONE` | `phone or mobile` | This phone number is already in use. |
| `WZ-DUP-LICENSE` | `license` | This license key is already in use. |
| `WZ-DUP-ATTDAY` | `uq_employee_date or employee_date` | Attendance for this employee on this date already exists. |
| `WZ-DUP-LEAVEBAL` | `emp_type_year` | A leave balance for this employee, leave type and year already exists. |
| `WZ-DUP-HOLIDAY` | `company_date_name` | A holiday with this name already exists on this date. |
| `WZ-DUP-PAYWINDOW` | `payment_window` | A payment window for this month already exists. |
| `WZ-DUP-NAME` | `name` | An entry with this name already exists. |
| `WZ-DUP-CODE` | `code` | This code is already in use. |
| `WZ-DB-DUP` | (anything else) | This value already exists. Please use a different one. |

## 2. Database / request / system errors
| Code | HTTP | Raised when | User message |
|---|---|---|---|
| `WZ-DB-FK-MISSING` | 400 | ER_NO_REFERENCED_ROW(_2): a foreign key points at a row that does not exist | The selected item no longer exists. Please refresh and try again. |
| `WZ-DB-FK-INUSE` | 409 | ER_ROW_IS_REFERENCED(_2): deleting/changing a row other rows depend on | This item is being used elsewhere, so it cannot be deleted or changed. |
| `WZ-DB-REQUIRED` | 400 | ER_BAD_NULL_ERROR / ER_NO_DEFAULT_FOR_FIELD: NOT NULL column got no value | A required field is missing. Please fill in all required fields. |
| `WZ-DB-TOOLONG` | 400 | ER_DATA_TOO_LONG: value longer than the column | One of the values you entered is too long. |
| `WZ-DB-BADVALUE` | 400 | ER_TRUNCATED_WRONG_VALUE*, ER_WRONG_VALUE_FOR_TYPE, ER_WARN_DATA_OUT_OF_RANGE, ER_INVALID_JSON_TEXT | One of the values you entered is not valid (check dates and numbers). |
| `WZ-DB-SCHEMA` | 500 | ER_BAD_FIELD_ERROR / ER_NO_SUCH_TABLE / ER_PARSE_ERROR: a migration was not applied or SQL is wrong | The server database is out of date. Please contact support. |
| `WZ-DB-DOWN` | 503 | ECONNREFUSED / ETIMEDOUT / PROTOCOL_CONNECTION_LOST / ER_CON_COUNT_ERROR / ER_ACCESS_DENIED_ERROR | The server cannot reach its database right now. Please try again in a minute. |
| `WZ-DB-BUSY` | 503 | ER_LOCK_DEADLOCK / ER_LOCK_WAIT_TIMEOUT | The server is busy. Please try again. |
| `WZ-REQ-BADJSON` | 400 | Request body is not valid JSON | The request could not be read. Please update the app and try again. |
| `WZ-REQ-TOOBIG` | 413 | Request body over the size limit | The data you sent is too large. |
| `WZ-SYS-UNKNOWN` | 500 | Any error not listed above (check the Error Logs / console for the real cause) | Something went wrong on our side. Please try again; if it keeps happening contact support with this code. |

## 3. Explicit route errors: `WZ-<AREA>-<HTTP>`
Errors a route returns on purpose (validation, not found, forbidden...). The message is the route's own sentence; the code = area of the API route + HTTP status. Example: `WZ-DEV-404` = Devices route returned 404.

| Area tag | API route prefix |
|---|---|
| `LIC` | `/license` |
| `PNL` | `/panel` |
| `ADM` | `/iclock` |
| `AUTH` | `/auth` |
| `COM` | `/communications` |
| `EMP` | `/employees` |
| `ATT` | `/attendance` |
| `LVE` | `/leave-applications` |
| `TSK` | `/tasks` |
| `HOL` | `/holidays` |
| `DEP` | `/departments` |
| `DSG` | `/designations` |
| `OTP` | `/office-time-policy` |
| `OT` | `/overtime` |
| `WOF` | `/weekly-off` |
| `PAY` | `/payroll` |
| `STAT` | `/statutory-settings` |
| `PAYWIN` | `/payroll-payment-window` |
| `DEV` | `/devices` |
| `BRN` | `/branches` |
| `SHF` | `/shifts` |
| `LVT` | `/leave-types` |
| `WRK` | `/work-codes` |
| `CMP` | `/companies` |
| `LVB` | `/leave-balances` |
| `LVA` | `/leave-adjustments` |
| `SHA` | `/shift-assignments` |
| `MPN` | `/manual-punches` |
| `MOB` | `/mobile-punches` |
| `VIS` | `/visitors` |
| `CAN` | `/canteen` |
| `LON` | `/loans` |
| `ADH` | `/ad-hoc-payments` |
| `SAL` | `/salary-structures` |
| `USR` | `/app-users` |
| `IMP` | `/import` |
| `BON` | `/bonuses` |
| `CNV` | `/conveyance` |
| `RPT` | `/reports` |
| `LOG` | `/error-logs` |
| `BKP` | `/backup` |
| `ADM2` | `/admins` |
| `CAL` | `/calendar-events` |
| `NOT` | `/dashboard-notes` |
| `HGR` | `/holiday-groups` |
| `ECT` | `/employee-categories` |
| `GEO` | `/geofence-zones` |
| `FLD` | `/field-tracking` |
| `RAW` | `/raw-punches` |
| `DSH` | `/dashboard` |
| `GEN` / 3-letter | any route not listed |

| HTTP | Default message (used only if the route gave none) |
|---|---|
| 400 | The request was not valid. Please check what you entered. |
| 401 | Your session has expired. Please sign in again. |
| 403 | You do not have permission to do this. |
| 404 | The item you are looking for was not found. |
| 409 | This conflicts with existing data. |
| 413 | The data you sent is too large. |
| 422 | Some of the information you entered is not valid. |
| 429 | Too many attempts. Please wait a moment and try again. |
| 500 | Something went wrong on our side. Please try again; if it keeps happening contact support with this code. |
| 502 | The server is temporarily unavailable. Please try again. |
| 503 | The server is temporarily unavailable. Please try again. |

## 4. Flutter-side codes (no server involved)
See `lib/utils/app_error.dart` - codes starting `APP-`.
