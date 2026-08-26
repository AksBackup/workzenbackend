const crypto = require('crypto');

// Company name -> short code, e.g. "Acme Industries Pvt Ltd" -> "ACMEIN"
// Not stored anywhere - derived on the fly so schema.sql needed no slug column.
function slugify(name) {
    return (name || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'CO';
}

function generateTempPassword() {
    return crypto.randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);
}

module.exports = { slugify, generateTempPassword };
