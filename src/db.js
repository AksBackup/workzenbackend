const mysql = require('mysql2/promise');
const fs = require('fs');

// Providers like Aiven require SSL and give you a CA certificate to verify
// against. Two ways to supply it, same pattern as the Firebase credentials:
//   - DB_SSL_CA: the whole certificate content pasted as one env var value.
//     Use this on Render - paste the contents of aiven-ca.pem directly into
//     the environment variable's value field in Render's dashboard.
//   - DB_SSL_CA_PATH: a path to the .pem file on disk. Use this for local
//     dev, where the file just sits in the project root (gitignored).
// Oracle MySQL HeatWave (the eventual target) has its own equivalent CA -
// when you migrate, just swap the value, no code changes needed.
function buildSslConfig() {
    if (process.env.DB_SSL !== 'true') return undefined;

    if (process.env.DB_SSL_CA) {
        return { ca: process.env.DB_SSL_CA, rejectUnauthorized: true };
    }

    if (process.env.DB_SSL_CA_PATH) {
        return {
            ca: fs.readFileSync(process.env.DB_SSL_CA_PATH),
            rejectUnauthorized: true
        };
    }

    // Fallback: encrypts the connection but does not verify the server
    // certificate. Fine for a quick local test, not for anything real -
    // set DB_SSL_CA or DB_SSL_CA_PATH as soon as you have the provider's CA file.
    console.warn('DB_SSL is true but no CA certificate was provided (DB_SSL_CA / DB_SSL_CA_PATH) - connection will be encrypted but NOT certificate-verified.');
    return { rejectUnauthorized: false };
}

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ssl: buildSslConfig()
});

module.exports = pool;
