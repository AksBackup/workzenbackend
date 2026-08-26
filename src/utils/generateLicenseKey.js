const crypto = require('crypto');

function generateLicenseKey() {
    const segment = () => crypto.randomBytes(2).toString('hex').toUpperCase();
    return `${segment()}-${segment()}-${segment()}-${segment()}`;
}

module.exports = generateLicenseKey;
