// generateCompanyCode.js
//
// The old scheme (CO0001, CO0002, ...) was sequential and trivially
// guessable - anyone could enumerate real company codes just by trying
// small integers. This replaces it with: first 3 letters of the
// company's own name (uppercased, non-letters stripped, padded with X
// if the name is short/has fewer than 3 letters) + a 3-character random
// alphanumeric suffix, e.g. "Acme Textiles" -> "ACM4K9".
//
// This is no longer guaranteed collision-free by construction (unlike
// the old id-derived scheme), so callers MUST retry on a duplicate-key
// error against companies.company_code's UNIQUE constraint. With a
// 3-character base36 suffix (36^3 = 46,656 combinations) per name
// prefix, collisions are rare and a handful of retries is enough.

const SUFFIX_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomSuffix(length = 3) {
    let out = '';
    for (let i = 0; i < length; i++) {
        out += SUFFIX_CHARS[Math.floor(Math.random() * SUFFIX_CHARS.length)];
    }
    return out;
}

function namePrefix(companyName) {
    const lettersOnly = String(companyName || '').toUpperCase().replace(/[^A-Z]/g, '');
    const prefix = lettersOnly.slice(0, 3);
    return prefix.padEnd(3, 'X');
}

/** Generates one candidate code. Does not check the database. */
function generateCompanyCode(companyName) {
    return `${namePrefix(companyName)}${randomSuffix(3)}`;
}

/**
 * Generates a company code and retries against the DB until a free one
 * is found. `conn` is any object with a `.query(sql, params)` method
 * (a pool or a transaction connection).
 */
async function generateUniqueCompanyCode(conn, companyName, maxAttempts = 20) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const candidate = generateCompanyCode(companyName);
        const [rows] = await conn.query(
            'SELECT id FROM companies WHERE company_code = ?',
            [candidate]
        );
        if (rows.length === 0) {
            return candidate;
        }
    }
    // Astronomically unlikely with 46,656 suffixes per prefix, but fall
    // back to a longer random suffix rather than looping forever.
    return `${namePrefix(companyName)}${randomSuffix(6)}`;
}

module.exports = { generateCompanyCode, generateUniqueCompanyCode, namePrefix };
