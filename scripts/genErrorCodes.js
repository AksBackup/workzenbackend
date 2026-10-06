// npm run error-codes  ->  writes ERROR_CODES.md (the developer's code -> meaning list)
const fs = require('fs');
const path = require('path');
const { CATALOG, DUP_FIELDS, AREAS, STATUS_MESSAGES } = require('../src/utils/errorCatalog');
let md = `# WorkZen error codes\n\nGenerated from \`src/utils/errorCatalog.js\` - do not edit by hand (run \`npm run error-codes\`).\n\n`;
md += `Users see a friendly sentence ending in \`(Code: WZ-...)\`. The ORIGINAL technical error (SQL message, stack trace) is in the server console and the Error Logs table, prefixed with the same code.\n\n`;
md += `## 1. Duplicate value (HTTP 409)\nTriggered by MySQL \`ER_DUP_ENTRY\`; the unique-index name decides the code.\n\n| Code | Index/key name contains | User message |\n|---|---|---|\n`;
for (const f of DUP_FIELDS) md += `| \`${f.code}\` | \`${f.match.source.split('|').join(' or ')}\` | ${f.message} |\n`;
md += `| \`WZ-DB-DUP\` | (anything else) | ${CATALOG['WZ-DB-DUP'].message} |\n\n`;
md += `## 2. Database / request / system errors\n| Code | HTTP | Raised when | User message |\n|---|---|---|---|\n`;
const when = {
  'WZ-DB-FK-MISSING': 'ER_NO_REFERENCED_ROW(_2): a foreign key points at a row that does not exist',
  'WZ-DB-FK-INUSE': 'ER_ROW_IS_REFERENCED(_2): deleting/changing a row other rows depend on',
  'WZ-DB-REQUIRED': 'ER_BAD_NULL_ERROR / ER_NO_DEFAULT_FOR_FIELD: NOT NULL column got no value',
  'WZ-DB-TOOLONG': 'ER_DATA_TOO_LONG: value longer than the column',
  'WZ-DB-BADVALUE': 'ER_TRUNCATED_WRONG_VALUE*, ER_WRONG_VALUE_FOR_TYPE, ER_WARN_DATA_OUT_OF_RANGE, ER_INVALID_JSON_TEXT',
  'WZ-DB-SCHEMA': 'ER_BAD_FIELD_ERROR / ER_NO_SUCH_TABLE / ER_PARSE_ERROR: a migration was not applied or SQL is wrong',
  'WZ-DB-DOWN': 'ECONNREFUSED / ETIMEDOUT / PROTOCOL_CONNECTION_LOST / ER_CON_COUNT_ERROR / ER_ACCESS_DENIED_ERROR',
  'WZ-DB-BUSY': 'ER_LOCK_DEADLOCK / ER_LOCK_WAIT_TIMEOUT',
  'WZ-REQ-BADJSON': 'Request body is not valid JSON',
  'WZ-REQ-TOOBIG': 'Request body over the size limit',
  'WZ-SYS-UNKNOWN': 'Any error not listed above (check the Error Logs / console for the real cause)',
  'WZ-DB-DUP': 'ER_DUP_ENTRY on an index not matched in section 1',
};
for (const [c, v] of Object.entries(CATALOG)) if (c !== 'WZ-DB-DUP') md += `| \`${c}\` | ${v.status} | ${when[c] || ''} | ${v.message} |\n`;
md += `\n## 3. Explicit route errors: \`WZ-<AREA>-<HTTP>\`\nErrors a route returns on purpose (validation, not found, forbidden...). The message is the route's own sentence; the code = area of the API route + HTTP status. Example: \`WZ-DEV-404\` = Devices route returned 404.\n\n| Area tag | API route prefix |\n|---|---|\n`;
for (const [r, a] of Object.entries(AREAS)) md += `| \`${a}\` | \`/${r}\` |\n`;
md += `| \`GEN\` / 3-letter | any route not listed |\n\n| HTTP | Default message (used only if the route gave none) |\n|---|---|\n`;
for (const [s, m] of Object.entries(STATUS_MESSAGES)) md += `| ${s} | ${m} |\n`;
md += `\n## 4. Flutter-side codes (no server involved)\nSee \`lib/utils/app_error.dart\` - codes starting \`APP-\`.\n`;
fs.writeFileSync(path.join(__dirname, '..', 'ERROR_CODES.md'), md);
console.log('ERROR_CODES.md written');
