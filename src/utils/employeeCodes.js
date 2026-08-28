const crypto = require('crypto');

// emp_code is now plain sequential digits ("1", "2", "3", ...), unique per
// company (enforced by the employees table's UNIQUE(company_id, emp_code)
// constraint). Confirmed against the physical F22: its own User ID field
// on the device keypad is an INTEGER, not text - a prefixed code like
// "ACME-0007" literally cannot be typed into that field, and more
// importantly can't be pushed via CMD_USER_WRQ either, since that command
// requires a numeric uid. This was previously company-slug-prefixed
// ("ACME-0007") purely for human readability, which broke device
// compatibility - readability lost, but correctness restored.
function generateTempPassword() {
    return crypto.randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);
}

module.exports = { generateTempPassword };
