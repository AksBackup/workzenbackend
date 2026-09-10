# WorkZen / Sarvottam — Continuation Context

Read this whole file before touching anything. It exists so a new AI
agent (or a different session of the same one) doesn't have to
rediscover what's already been decided, built, fixed, or deliberately
left alone.

---

## 1. What this app is

A Flutter Windows desktop HRMS (`workzen`, branded "Sarvottam") talking to
ZKTeco biometric terminals (F22 and other models) on the local network,
with a hosted MySQL backend for everything else (employees, attendance,
payroll, leave, etc.).

The client gave a PDF spec of desired features (device management,
master data, attendance, leave, reports, admin). Most of it was already
built before this pass. This doc picks up from a gap analysis against
that PDF.

## 2. Built and working, confirmed on real hardware

- Master data: Company, Branch, Department, Designation, Holidays,
  Employees — full CRUD.
- Shifts, weekly-offs, half/full-day thresholds.
- Attendance: Manual Punch, Bulk Manual Punch, manual-punch Approval,
  Real-Time Logs (polling), Shift Roster/Change/Generate.
- Leave: Leave Types, Opening Balance entry, Application + Approve.
- Reports: Daily, Monthly, Yearly, Missed Punch, Salary.
- Admin: License activate/verify/deactivate, Backup/Restore, Error Logs.
- Device: Add/Edit Machine, Device Health (heartbeat), Download Logs,
  push a numeric ID+name pre-enrollment (existing `zk_write_service.dart`
  raw TCP client, hand-rolled, pre-dates this pass), delete a device-side
  user slot (same file).
- Extras beyond the PDF: Payroll, Loans, Conveyance, Visitor Management,
  Canteen Management, Realtime Event Monitor.

## 3. Built THIS pass — the ZKEMKEEPER bridge

**Why**: the PDF's Device Management items 4/5/7 (enable/disable+face/
card/finger management, admin add/remove, device date/time) needed
ZKTeco's *official* SDK (`zkemkeeper.dll`, a Windows COM/ActiveX
control), not the hand-rolled TCP client, since those specific
operations aren't implemented in the hand-rolled client and weren't
worth re-reverse-engineering when an official, tested implementation
exists.

**Architecture**: a second local process (`zk_bridge.exe`, C#) hosts the
COM control and exposes plain HTTP on `127.0.0.1:8787`. The Flutter app
spawns it silently on launch, health-checks it, and talks to it like a
second small backend. See `AGENT_SPLIT_ZKEMKEEPER_BRIDGE.md` for the full
original architecture writeup and `MERGE_REPORT_ZKEMKEEPER_BRIDGE.md` for
how three parallel agent outputs were merged.

**Two new screens**, both under Device Management:
- **Device Users** — per-device-user enable/disable ("freeze"), card
  number assign, face template push/pull (only shown when
  `DeviceModel.supportsFace` is true for that device), **and, added after
  the initial merge: edit name and delete from device.**
- **Device Admin** — device date/time get/set, grant admin, "Clear All
  Admins" (explicitly labeled as clearing every admin at once, not one —
  this is a real `ClearAdministrators()` SDK call, not app-side).

**Confirmed working on real hardware as of this doc**: fetching device
users, setting device time, granting admin. Freeze/enable-disable had a
bug (see section 5) that's now fixed but not yet re-tested on hardware.
Edit-name and delete are brand new, untested on hardware.

## 4. Non-obvious things a new agent needs to know before touching this area

- **Three separate device-communication code paths coexist**:
  `flutter_zkteco` (read-only pub package), `zk_write_service.dart`
  (hand-rolled TCP, pre-dates this pass, used for push/delete), and the
  new bridge (COM SDK, used for enable/disable/admin/time/face/card/
  rename). This was flagged as worth consolidating eventually, not done
  yet — don't assume there's one obvious place to add a new device
  operation, check which of the three already does something similar
  first.
- **The admin privilege value question is genuinely unresolved.** The
  bridge's `SetAdmin`/`SetName` use `AdminPrivilege = 2` (documented in
  the SDK's own manual as "administrator"). But the *pre-existing*
  `zk_write_service.dart` (raw protocol, not this SDK) has a comment
  reading "Never 14 (USER_ADMIN) for employees" — implying `14` is this
  app's own established convention for admin via the *other* code path.
  These may be two different, both-correct encodings for two genuinely
  different wire protocols (raw `CMD_USER_WRQ` vs. this SDK's
  `SSR_SetUserInfo`), or one of them may just be wrong. **Nobody has
  tested either on a real device's own keypad admin menu to confirm which
  actually grants rights.** Don't change this value without a hardware
  test, and don't assume the other code path's constant is wrong just
  because it's a different number for a similar-sounding concept.
- **`UserInfo.userId` (from the `flutter_zkteco` package) came back
  blank for every pulled user on real hardware.** Root cause not fully
  confirmed — nobody in this whole process has had access to that
  package's actual source (not in this sandbox, not fetchable from the
  allowed network list). Current fix is a defensive fallback
  (`_extractDeviceUserId` in `device_users_screen.dart`) that tries
  `.userId` then falls back through `.uid`/`.id`/`.pin` via `dynamic`
  dispatch. **This is a stopgap.** If a future agent gets access to the
  actual package source (e.g., via the pub cache on a real dev machine,
  usually `%LOCALAPPDATA%\Pub\Cache\hosted\pub.dev\flutter_zkteco-*\`),
  confirm the real field name and simplify this back to a direct
  reference.
- **None of the C# bridge code had ever been compiled until the human
  running this project did it manually.** One real bug was caught that
  way already: `zk_bridge.csproj` had `--` inside literal XML comments,
  which is invalid XML syntax, not just a style nit — MSBuild refused to
  even parse the project file. Fixed. If anything else in that project
  still fails to build, treat it the same way: real bug, not something to
  paper over.
- **`ClearAdministrators()` clears every admin on the device, not one.**
  The UI dialog says this explicitly. Don't build a "remove this one
  admin" feature by wiring it to that call — there's no such SDK call;
  removing one admin selectively isn't currently possible without
  re-writing every other admin's record too (rewrite all of them to
  privilege=0 except the ones staying).

## 5. Bugs found and fixed after initial merge (fixed, but hardware-unverified)

- Bridge exe filename mismatch (`WorkZenBridge.exe` vs actual
  `zk_bridge.exe`) — fixed in `env.dart`.
- Invalid XML (`--` in comments) blocking compilation — fixed in
  `zk_bridge.csproj`.
- Missing `Interop.zkemkeeper.dll` alongside the built exe at runtime —
  this is a deployment step (copy the *entire* `bin\Release\` folder
  contents, not just the exe+config), not a code bug. Worth remembering
  when this eventually goes into an installer (see section 7).
- `UserInfo.userId` blank on real hardware → `_extractDeviceUserId`
  fallback added (see section 4).

## 6. Held aside deliberately — do not build without more client input

**"Enable/Disable User For Remote Location"** (PDF, Device Management
item 6). What's built (`Device Users`' enable/disable toggle) is a
general per-user on/off at one specific device. The PDF's wording
("...For remote location") could mean:
- (a) exactly what's built — enable/disable at one terminal, and
  "remote location" is just describing that the terminal happens to be
  at a branch office, not a distinct feature; or
- (b) something location-aware — e.g. an employee normally punches at
  Branch A but is temporarily allowed to punch at Branch B (a genuinely
  different feature involving cross-device/cross-location punch
  validation, closer to a "roaming" or "temporary transfer" concept).

**Don't guess between these.** Ask the client directly which they meant
before building anything beyond what already exists. If it's (b), it's
likely a backend + attendance-processing feature, not a device-bridge
feature at all, and belongs in a different scope entirely.

## 7. Backend (`server.zip`) — reviewed directly, not inferred

This section replaces guesswork from earlier in the project with what's
actually in the code. Node/Express + MySQL (`mysql2` pool), Firebase
Auth for identity, `company_id`-scoped multi-tenancy enforced per-query
(no DB-level RLS — every query must filter by it manually, per
`schema.sql`'s own header comment).

**Confirmed, not assumed**: `devices` table's `port`/`comm_password`/
`model` columns (referenced throughout section 3's work) are real —
`devices.js`'s own INSERT/UPDATE statements use all three. They're just
not in this zip's `schema.sql`, because that file is the original Phase-1
schema and these columns came from later migration files
(`migration_007`, `migration_012_device_model.sql`) that weren't
included in this particular export. Don't be thrown by their absence
from `schema.sql` — the route code is the source of truth here, and it
confirms them.

**The exact template for mobile-punch approval already exists** —
`manual_punches` + `manualPunch.js`. This is the pattern to copy, almost
line-for-line:
- A queue table with its own `status` (`pending`/`approved`/`rejected`),
  separate from `attendance`.
- `POST /manual-punches/:id/approve` — on approval, upserts into the real
  `attendance` table (`ON DUPLICATE KEY UPDATE` against the
  `(employee_id, date)` unique key), `source='manual'`. Nothing touches
  `attendance` until this fires.
- `POST /manual-punches/:id/reject`.
- Per-record transaction isolation, `FOR UPDATE` locking on approve to
  avoid a race against a second approve/reject of the same row —copy
  this too, not just the table shape.

**Confirmed gap — mobile-punch approval has no backend support at all
today**, despite `attendance.source`'s ENUM already including `'mobile'`
as a value (someone anticipated this at the schema level, nothing built
it). Specifically missing:
1. No `mobile_punches` (or equivalent) queue table. If a phone posted to
   the existing `POST /attendance` or `/attendance/sync` with
   `source: 'mobile'` today, it would write straight into `attendance`
   immediately — **there is no pending/approval step for mobile punches
   at all right now**, which is exactly the gap the client is describing.
2. No GPS columns anywhere — not on `attendance`, not anywhere else.
   Nowhere to even store a coordinate today.
3. No geofencing config anywhere (no radius, no allowed-coordinates, on
   `devices` or any other table) — confirms geofencing (section 8, still
   open) is a ground-up build, not partially there.

**Concrete backend scope for mobile-punch approval** (new agent, doesn't
touch anything in section 3 — fully independent):
- New table `mobile_punches`: same columns as `manual_punches`
  (`company_id`, `employee_id`, `date`, `check_in`, `check_out`,
  `remark`, `status`, `marked_by`/submitted-by, `approved_by`,
  `approved_on`, `created_at`) **plus** `latitude`, `longitude`,
  `accuracy_meters` (from the phone's GPS reading — useful later for
  rejecting an implausibly imprecise reading).
- A migration file for it, matching this repo's existing
  `migration_0XX_*.sql` naming (none of those files were in this
  particular export, but the convention is referenced throughout the
  existing route comments).
- Routes, mirroring `manualPunch.js` exactly: `GET
  /mobile-punches?status=pending`, `POST /mobile-punches` (phone submits
  here — NOT to `/attendance` directly, that's the whole point), `POST
  /mobile-punches/:id/approve`, `POST /mobile-punches/:id/reject`.
- `verify_mode` ENUM likely needs a new `'mobile'` value alongside the
  existing `password/fingerprint/card/face/manual/unknown` (small
  migration, same idea as `migration_011` which added that column).
- Geofencing (section 8, item 2) can most likely piggyback on this same
  table's lat/lng once it exists — probably the next thing to scope once
  this lands, not a separate ground-up effort.

## 8. Not built yet — remaining PDF gaps, roughly in priority order

1. **GPS/mobile-submitted punch approval.** No longer a research
   question — section 7 above has the concrete backend scope, confirmed
   against the actual server code (`mobile_punches` table +
   `manualPunch.js`-style routes). This is the next thing to build,
   backend-first, then a Flutter approval screen mirroring the existing
   manual-punch approval screen once the endpoints exist. Fully
   independent of section 3's device-bridge work.
2. Geo-fencing / Track Field Employee — per section 7, most likely
   piggybacks on the same `mobile_punches` table's lat/lng once it
   exists (radius check against a device's or branch's configured
   location). Scope after item 1 lands, not before — building the
   coordinate storage twice would be wasted work.
3. Earn/Adjust Leave (distinct from the existing Leave Opening Entry).
4. Employee Categories (multiple).
5. SMS Settings / WhatsApp notifications / Mail Settings.
6. Branch/Dept/Designation-wise limited admin access (roles) — currently
   the app allows exactly one admin per company (`admins.company_id` is
   `UNIQUE` in the schema — this is enforced at the database level, not
   just app logic, worth knowing before assuming it's a quick fix), no
   scoped permissions at all. This is a real architecture change (schema
   + auth), not a small addition.
7. "Database Mode SQL/MS Access" — confirmed with the client as leftover
   boilerplate from their old desktop software. **Not a real
   requirement.** Don't build anything for this.

## 9. Where things are, physically

- `lib_final_merged.zip` / the project's actual `lib/` folder — Flutter
  app source, includes everything in section 3 plus the section-5 fixes.
- `zk_bridge_final.zip` — the C# bridge project source (not yet a
  reliably-built exe as of this doc — see section 4's "never compiled
  until now" note; the human running this project is mid-way through
  getting a clean build).
- `server.zip` — the actual backend source (Node/Express + MySQL),
  reviewed directly for section 7 above. Migration files referenced by
  route comments (`migration_007`, `migration_011`,
  `migration_012_device_model.sql`, etc.) were NOT in this particular
  export — only `schema.sql` (the original Phase-1 base) was. Get the
  real migration files before assuming a column doesn't exist just
  because it's missing from `schema.sql`.
- No installer project exists yet (`01_INSTALLER_GAP_AND_RECOMMENDATION.md`
  covers this — Inno Setup recommended, nothing built). Not needed to
  test the feature, only needed before real client-site distribution.
- `AGENT_SPLIT_ZKEMKEEPER_BRIDGE.md`, `AGENT_A/B/C_*.md`,
  `MERGE_REPORT_ZKEMKEEPER_BRIDGE.md` — full history of how section 3 was
  built, for anyone who wants the detailed trail rather than just this
  summary.

## 10a. Built THIS pass — mobile-punch approval backend (section 8 item 1)

Backend half of the top-priority remaining gap is now built, following
section 7's scope exactly, reviewed against the real `server.zip` code
(not guessed):

- **`migrations/migration_013_mobile_punches.sql`** — new `mobile_punches`
  table (same shape as `manual_punches` plus `latitude`/`longitude`/
  `accuracy_meters`, plus a `submitted_by` column mirroring
  `manual_punches.marked_by`'s audit-trail role but pointed at
  `employees.id` instead of `admins.id`, since a mobile punch is
  self-submitted by the employee's own phone rather than typed in by an
  admin). Also `ALTER TABLE attendance MODIFY COLUMN verify_mode ...`
  to add `'mobile'` alongside the existing
  `password/fingerprint/card/face/manual/unknown` set — mirrors what
  `migration_011` did for `'manual'`. **This ALTER assumes
  migration_011 has already been applied** (the verify_mode column has
  to exist first); it will fail on a database that's still on the
  pre-migration_011 shape. Not run against any real database yet — SQL
  only, unverified against MySQL itself.
- **`src/routes/mobilePunch.js`** — new file, deliberately mirrors
  `manualPunch.js`'s approve/reject transaction logic line-for-line
  (`FOR UPDATE` locking, `ON DUPLICATE KEY UPDATE` upsert into
  `attendance` with `COALESCE` on check_in/check_out, same
  pending/approved/rejected states). The one real difference: `POST /`
  is **not** `requireAdmin` — an `'employee'`-role caller's
  `employee_id` is derived from their own Firebase UID (same pattern as
  `POST /leave-applications`), never trusted from the request body, so
  one employee's phone can't submit a punch for someone else. An admin
  caller can still pass `employee_id` explicitly (e.g. a future
  admin-side correction tool), matching the same branch pattern
  `leaves.js` already uses.
- **`src/index.js`** — requires and mounts the new router at
  `/mobile-punches`, appended after the existing `manual-punches` mount,
  no existing lines touched.
- **`src/routes/attendance.js`** — `VALID_VERIFY_MODES` (the
  defense-in-depth Set used by `POST /attendance/sync`) now includes
  `'mobile'`, matching the migration's new ENUM value.
- **`src/routes/backup.js`** — `mobile_punches` added to the `TABLES`
  export/restore list, right after `manual_punches`, same `scope:
  'company_id'` shape. Without this a backup taken after this change
  would silently drop the table, same class of bug the merge-time note
  above this list already warns about for the other 7 tables.

**Verified only by**: `node --check` on every touched/new `.js` file
(syntax only) and reading the SQL by eye against `schema.sql`'s existing
conventions (column ordering, `CONSTRAINT fk_..._... FOREIGN KEY`
naming, `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`). **Not verified**: the
migration has never been run against a real MySQL instance, the routes
have never been hit with a real HTTP request, and there is no automated
test suite in this repo to run instead. Same posture as section 10 below
— flag this plainly, don't imply it's been tested.

**Deliberately not done in this pass** (still open, per section 8):
- The Flutter approval screen (mirror the existing manual-punch approval
  screen once these endpoints are confirmed working against a real DB —
  screen work wasn't started this pass, only the backend).
- The actual mobile app's punch-submission call site (whatever screen
  the field employee uses to hit `POST /mobile-punches` from their
  phone) — out of scope for a Windows desktop HRMS client repo like
  `lib_final_merged.zip`; this likely lives in a separate mobile app
  codebase not included in any of this project's zips.
- Geofencing (section 8 item 2) — deliberately still not started;
  `accuracy_meters` is stored now specifically so that pass doesn't need
  its own migration later, but no radius-check logic exists yet.

## 10b. Built — Mobile Punch Approval screen (Flutter, section 8 item 1)

Second half of item 1 (section 10a was the backend). New desktop-side
approval screen, mirroring `ApprovalManualPunchScreen` exactly per
section 8's own instruction ("a Flutter approval screen mirroring the
existing manual-punch approval screen once the endpoints exist").

- **`lib/models/mobile_punch.dart`** — new model, same shape as
  `ManualPunch` plus `latitude`/`longitude`/`accuracyMeters` and a
  `hasLocation` getter (a phone can submit with location permission
  denied - see migration_013's comment - so the UI needs to tell "no
  reading" apart from "(0, 0)" rather than just checking non-null on a
  default).
- **`lib/services/api_client.dart`** — added `listMobilePunches()`,
  `approveMobilePunch()`, `rejectMobilePunch()`, mirroring the existing
  manual-punch methods exactly. **Deliberately no
  `createMobilePunch()`** - this desktop app is the approver, not the
  submitter; the phone (a separate, not-in-this-repo mobile codebase)
  is what calls `POST /mobile-punches`.
- **`lib/screens/attendance_ops/mobile_punch_approval_screen.dart`** —
  new screen, same pending-list/approve/reject structure as
  `ApprovalManualPunchScreen`, plus a Location column showing the
  captured lat/lng and accuracy radius (or an explicit "No location
  captured" state) since - unlike a manual punch, which an admin
  vouches for by typing it in - nothing corroborates a mobile punch
  except that GPS reading, so it has to actually be visible to the
  person approving, not just stored in the database.
- **`lib/screens/home_shell.dart`** — wired in at all four reference
  points the existing `approval_manual_punch` leaf touches (import, nav
  leaf under the "Transaction" group right after Approval Manual Punch,
  title switch, screen-builder switch). No existing leaf's key or
  position changed.

**Verified only by**: manual brace/paren balance checks on every
touched file (no `dart`/`flutter` toolchain available in this sandbox
to actually analyze or build it - see filesystem/network notes).
**Not verified**: never opened in an IDE, never run, never checked
against the actual `pubspec.yaml` (not present in `lib_final_merged.zip`
- only the `lib/` folder was exported, so package versions/dependencies
like `intl` couldn't be cross-checked here either, though both are
already used identically by the manual-punch screen this mirrors, so
that risk is low). Same posture as everywhere else in this doc: treat
as unverified until the human operator has actually built and clicked
through it.

**Still open after this pass**: the phone-side submission call site
(separate mobile app codebase, not part of any zip in this project) and
geofencing (section 8 item 2) — `accuracy_meters` is captured and shown
now specifically so that pass doesn't need another migration or another
column added to this screen later, just a decision rule built on top of
what's already here.

## 10d. Built THIS pass — Flutter UI for the migration_015 batch, plus two corrections to the record

Finishes what 10c left open. Reviewed against the real `lib_final_merged.zip` source throughout, not guessed - and this pass turned up two things worth flagging plainly rather than quietly working around.

**Correction #1 — "Device Health Report" was already built, contrary to
an earlier gap report.** The client asked for it to be removed based on
a prior pass's gap analysis that said it wasn't built. That analysis
only checked the backend Node routes (which is genuinely true - there's
no server-side health endpoint) and missed that
`screens/devices/device_health_screen.dart` / nav leaf `device_health`
("Device Health Monitoring") already exists and is already wired up -
it does client-side connectivity checks via
`ZkDeviceService.testConnection()` and persists results through
`PATCH /devices/:id/heartbeat` so the Dashboard's Online/Offline stat
cards reflect real data. **Nothing has been deleted.** This needs the
client's explicit confirmation before anyone removes a working, already
-shipped screen based on a corrected misunderstanding - flagged back to
them, not acted on unilaterally.

**Correction #2 — two device-log-pull code paths now overlap.** The
existing `screens/devices/download_logs_screen.dart` ("Download Logs
from Device") already pulled device logs - via the `flutter_zkteco`
package (`ZkDeviceService.pullAttendanceLogsFrom`), straight into the
processed `attendance` table via `AttendanceSyncService`/
`POST /attendance/sync`. This pass's new Raw Punch Log screen pulls via
a *different* path - the new C# `zk_bridge` process's `GET /device/logs`
- into the separate, unprocessed `raw_punches` table (migration_015).
These are NOT simple duplicates (one is deduplicated+processed, the
other is the raw un-deduplicated buffer, specifically what "Show Device
Raw Punch"/"All Raw Punch Report" need), but they are two different
device-communication libraries now doing overlapping jobs. Renamed this
pass's nav leaf to "Raw Punch Log" (distinct from "Download Logs from
Device") specifically so a user doesn't see two same-sounding buttons
and assume a bug. **Worth a reconciliation pass**: `flutter_zkteco`'s
`getAttendanceLogs()`/`pullAttendanceLogsFrom()` may already expose
everything `raw_punches` needs, which would let a future pass drop the
zk_bridge C# `GetLogs`/`PullAttendanceLogs` addition entirely and route
Raw Punch Log through the existing Dart-native path instead - not done
here because it would mean inspecting `flutter_zkteco`'s own
`AttendanceLog` class fields, which aren't visible in this project's
own source (it's an external package) and this sandbox has no pub.dev
access to check them.

**Everything else built, mirroring existing screens' conventions
throughout:**
- **`models/shift.dart`** - six new fields (`weeklyOffBitmask`,
  `otAllowed`, `lateGraceMinutes`, `earlyGraceMinutes`,
  `singlePunchPolicy`, `isHalfDayShift`), all with defaults matching
  the migration's DB defaults so nothing that already constructs a
  `Shift()` (Shift Change/Generate Shift/Shift Roaster) needed to
  change. `screens/settings/shifts_screen.dart`'s form extended with
  matching UI for all six (weekday `FilterChip`s for the weekly-off
  override, two switches, two grace-minute fields, a policy dropdown).
- **New models**: `holiday_group.dart`, `employee_category.dart`,
  `geofence_zone.dart`, `raw_punch.dart`, `field_location_ping.dart`,
  plus `WeeklyReportRow`/`NaShiftReportRow`/`LateEarlyReportRow`/
  `OvertimeReportRow`+`OvertimeReportResult`/`PerformanceReportRow`
  appended to the existing `report_row.dart`.
- **`models/mobile_punch.dart`** - added `remoteLocationEnabled` and a
  new `MobileGeofenceCheck` class reading the `geofence` object
  `GET /mobile-punches` now attaches per row (four distinct states:
  exempt, no reading, no zones configured, inside/outside - see that
  class's comment). `mobile_punch_approval_screen.dart` renders it as a
  colored badge in a new Geofence column; never blocks approve/reject
  automatically - judgement support only, matching
  `geofenceZones.js`'s own "don't hard-block on a bad GPS reading"
  reasoning.
- **`services/api_client.dart`** - full CRUD/list methods added for
  Holiday Groups, Employee Categories, Geofence Zones, Field Tracking
  (trail/latest - deliberately no POST, phones submit pings, not this
  desktop app), Raw Punches (list + bulk upload), and all five new
  report endpoints.
- **`services/zk_bridge_client.dart`** - `deleteUser`,
  `getUserFingerprint`/`setUserFingerprint` (fingerIndex required on
  both, unlike `/face` which never takes one), `getDeviceLogs` -
  matching the three C# bridge routes from 10c.
- **Three new Settings CRUD screens** (`holiday_groups_screen.dart`,
  `employee_categories_screen.dart`, `geofence_zones_screen.dart`) -
  the first two mirror `DepartmentsScreen` line-for-line in structure;
  Geofence Zones has no map picker (no maps package available in this
  project) - lat/lng are plain number fields, same honesty-over-polish
  choice as Field Tracking's trail view below.
- **`field_tracking_screen.dart`** - a "where is everyone right now"
  live panel plus a per-employee/per-date trail, rendered as an ordered
  list of coordinates/times rather than a fake map.
- **`raw_punches_screen.dart`** - browsable raw-log table + the
  "Download Logs" button described in Correction #2 above.
- **Five new report screens** (`weekly_report_screen.dart`,
  `na_shift_report_screen.dart`, `late_early_report_screen.dart`,
  `overtime_report_screen.dart`, `performance_report_screen.dart`) -
  mirror `MonthlyReportScreen`'s `AppCard`+month-navigator structure
  (the Reports-group visual convention, distinct from the
  `SectionCard` convention Settings/Transaction-group screens use -
  both conventions already coexisted in this codebase before this
  pass, per that group's own established split).
- **`home_shell.dart`** - all 8 new leaves wired into all three
  existing switch statements (nav leaf list, title lookup,
  screen-builder) at their natural group (Transaction, Reports,
  Settings) - cross-checked after wiring that every new key appears
  exactly 3 times (leaf + title-case + builder-case), confirming no
  orphaned case with a missing leaf or vice versa.

**Verified only by**: manual brace/paren balance checks on every
touched/new `.dart` file (all pass) plus the 3-occurrence cross-check
above for `home_shell.dart` specifically. No `dart`/`flutter` toolchain
available in this sandbox - never compiled, never run, never checked
against `pubspec.yaml` (still not present in this export). Same
posture as every other Flutter section here: a well-reasoned first
draft, not tested code.

## 10c. Built — migration_015 batch backend (Node routes/schema + zk_bridge C#; Flutter UI is section 10d below)

Client explicitly confirmed **"Device Health Report" is REMOVED from
scope** — not built, won't be, per direct instruction. Everything else
below was requested together as one batch; this pass built the backend
(Node routes + schema + the `zk_bridge` C# additions), Flutter UI for
all of it is the next pass, not yet started.

**`migrations/migration_015_shift_rules_geofence_categories.sql`** —
one big additive migration (every change is a new column with a
backward-compatible default, or a brand-new table — nothing existing
renamed/removed, respecting `shifts.js`'s own "don't rename, other
passes rely on this shape" warning):
- **Shift rules**: `weekly_off_bitmask` (NULL = inherit the company-wide
  config, same bit layout), `ot_allowed` (default TRUE), `late_grace_minutes`/
  `early_grace_minutes` (default 0 = strict), `single_punch_policy`
  (`none`/`absent`/`half_day`/`leave`, default `none` = today's actual
  behaviour), `is_half_day_shift` (a descriptive tag only, no computed
  hours-threshold logic attached — the PDF lists it as its own bullet
  separate from any auto-detection rule, so none was invented).
- **Holiday Groups**: new `holiday_groups` table; `holidays.holiday_group_id`
  and `branches.holiday_group_id` both NULL-able and both default NULL
  = "company-wide/ungrouped", i.e. today's exact behaviour for anyone
  who never touches groups.
- **Employee Categories**: new `employee_categories` table (same
  admin-editable-list pattern as departments/designations), `employees.category_id`.
- **Geofencing + Remote Location** — this resolves the ambiguity
  section 6 flagged and deliberately left unbuilt. Researched how other
  HRMS products define these two terms before building (web search,
  this session): a **geofence** is a named circular zone (center +
  radius, ~50-200m is the commonly recommended range) checked against a
  punch's coordinate; **"remote location enabled"** on an employee is
  what *exempts* that employee from the geofence check entirely (a
  WFH/travelling-permitted employee), as opposed to a field employee
  who's still expected to be inside *some* approved zone, just not
  always the same one. New `geofence_zones` table (company- or
  branch-scoped), `employees.remote_location_enabled` (default FALSE).
  Geofencing is opt-in by *configuring a zone* — a company with zero
  zones blocks nothing.
- **Field Employee Tracking** — deliberately distinct from geofencing
  per that same research: geofencing is a single point-in-time gate at
  punch time; field tracking is a continuous trail of periodic
  background-location pings logged while someone's on duty. New
  `field_location_pings` table.
- **Raw Punches** — backs "Show Device Raw Punch" / "Download Logs from
  Device/USB" / "All Raw Punch Report" together, all three read from
  the same table. New `raw_punches` table: deliberately **no unique
  key** forcing one-row-per-device/user/second — a device can log a
  genuinely repeated real punch, so that's not a duplicate to prevent
  at the schema layer; app-layer dedup instead (`routes/rawPunches.js`
  checks for an identical existing row before inserting, to survive an
  admin clicking "Download Logs" twice before the device buffer clears).

**`zk_bridge` (C#)** — `DeviceOperations.cs`/`Program.cs`:
- `DELETE /device/users/{id}` → `SSR_DeleteEnrollData(..., backupNumber=12)` ("delete everything for this user").
- `GET|POST /device/users/{id}/fingerprint?fingerIndex=N` → `GetUserTmpStr`/`SetUserTmpStr`, mirroring the existing face-template calls' shape. `fingerIndex` (0-9) is required on both verbs, unlike `/face` which never takes an index — a fingerprint template is meaningless without knowing which of ten fingers it's for.
- `GET /device/logs` → `ReadGeneralLogData` + repeated `GetGeneralLogData` (standard ZK AttLog demo pattern) — pulls the device's own raw log buffer over the network. **This is the network-pull path only.** A separate offline workflow exists on some ZK devices (export to USB as a `.dat` file from the device's own menu, then import that file via a local-file-based SDK call) — **not implemented**, would need the actual SDK manual's USB-import section and real hardware to get right rather than guessed at.
- **All three of the above are flagged in-code as NOT cross-checked against an actual demo project source file** — unlike `SetAdmin`/`SetFace`/`SetCard` (built in an earlier pass, verified against real demo files per `PASS_NOTES.md`), this pass had no such file for delete-user/fingerprint/logs. The calls used are the standard, widely-documented zkemkeeper signatures and match this file's existing `SSR_`-prefix convention, but "widely documented" is not the same bar as "checked against this project's own demo source" — flagged explicitly rather than silently presented as equally solid.

**Node routes** — new: `holidayGroups.js`, `employeeCategories.js`,
`geofenceZones.js` (haversine distance check, exports `checkAgainstZones`
for reuse), `fieldTracking.js`, `rawPunches.js`. Extended: `shifts.js`
(new fields on POST/PUT), `holidays.js`/`branches.js` (group filtering/
assignment), `employees.js` (`category_id`/`remote_location_enabled`
on POST/PUT), `mobilePunch.js` (`GET /` now attaches a computed
`geofence: {...}` object per row — computed at *read* time against
current zones, not frozen at submission time, so an admin editing a
zone immediately affects still-pending rows), `overtime.js`
(`computeAndRecordOvertime` now looks up the employee's shift and skips
entirely if `ot_allowed` is FALSE — an employee with no shift keeps the
original "OT for everyone" behaviour).

**`reports.js` additions**:
- `GET /reports/weekly?date=` — Sun-Sat window (matches `offDaysBitmask`'s
  own bit layout), reuses `classifyDay` directly rather than
  `computeMonthlySummary` so a week crossing a month boundary isn't a
  special case.
- `GET /reports/na-shift?date=` — active employees with no resolvable
  shift at all (`resolveEffectiveShift` — checks `shift_assignments`
  roster, then `employees.shift_id`, then the company's default shift;
  returns null only if a company somehow has none of the three).
- `GET /reports/late-early?date=` — a genuinely NEW dedicated report,
  distinct from the existing per-day `isLate` flag buried in
  `GET /employees/:id/monthly-summary` (which compares against one
  company-wide `office_time_policy.check_in_window_end` and has no
  "early" concept). This one uses each employee's own resolved shift
  and that shift's `late_grace_minutes`/`early_grace_minutes` — a shift
  created before this migration has 0/0 grace, i.e. strict-by-default
  until an admin configures real windows.
- `GET /reports/overtime?from=&to=&status=` — list/summary view over
  the already-existing `overtime_records` table; the table was already
  populated, this was purely the missing report view.
- `GET /reports/performance?year=&month=` — built as a **month-level
  scorecard** (attendance %, late/early counts, absent days, OT hours)
  rather than a single-day metric, since the PDF lists it under "Daily"
  alongside Present/Absent/etc. but a single day's late-count isn't a
  meaningful performance signal on its own. Every number in it is
  exactly what its own dedicated report already computes (late-early's
  logic, monthly summary's attendance math, overtime's sum), gathered
  into one row per employee rather than a new invented scoring formula.
- "All Raw Punch Report" needed no new endpoint — `GET /raw-punches`
  (with `from`/`to` filters) already serves both the live browsable
  list and the report/export use case.

**Verified only by**: `node --check` on every touched/new `.js` file
(all pass) and manual brace-balance checks on `DeviceOperations.cs`/
`Program.cs` (no C# compiler available in this sandbox — no
`csc`/`mono`/`dotnet`). **Not verified**: migration_015 has never run
against a real database, none of these routes have been hit with a
real HTTP request, `zk_bridge`'s three new operations have never run
against real hardware or even compiled. Same posture as every other
section here — treat as a well-reasoned first draft, not tested code.

**Explicitly deferred, not forgotten**:
- **Flutter UI for this entire batch** — none of it has a screen yet
  (Shift's new fields on the Shift Change form, Holiday Groups CRUD
  screen, Employee Categories CRUD screen, Geofence Zones CRUD screen +
  the new geofence/remote-location columns on Mobile Punch Approval,
  Field Tracking map/trail view, Raw Punches browsable list, and the
  five new report screens). This is the explicit next step.
- Pure offline USB `.dat`-file log import (see zk_bridge note above).
- Whether "earn/adjust leave" (section 10) should ever feed the live
  monthly-quota calculation is still an open question from that
  section — unrelated to this batch, just noting it's still open.

## 10. Ground rule for whoever picks this up next

Nothing in sections 3–5 has been verified end-to-end against real
hardware by the AI side of this process — every "fix" described here was
made by reading code, not by running it. The human operator has real
Windows + real device access and has been the one actually running each
build/test cycle. Any new agent working on this should default to the
same posture: flag what's unverified plainly, don't imply a test passed
that didn't happen, and prefer asking "what did you actually see when you
ran this" over assuming success.
