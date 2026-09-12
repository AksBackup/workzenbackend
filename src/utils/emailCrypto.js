const crypto = require('crypto');

/**
 * Minimal at-rest encryption for email_settings.smtp_password_encrypted
 * (migration_019). AES-256-GCM: `encrypt` returns iv (12 bytes) + authTag
 * (16 bytes) + ciphertext concatenated into one Buffer, exactly what
 * `decrypt` expects back - a self-contained blob, no separate columns
 * needed for iv/authTag.
 *
 * Honest limitation: the key comes from this same server's environment
 * (EMAIL_ENCRYPTION_KEY), not a separate KMS/secrets manager. This
 * protects the password if the DATABASE alone is compromised or dumped
 * (a much more common real-world scenario - backups, read replicas,
 * accidental exposure), but not if the application server's own
 * environment is compromised too. That's a real gap for a production
 * secrets story, just not one this schema/deployment currently has the
 * infrastructure to close - flagged rather than silently pretending
 * this is bank-grade.
 *
 * EMAIL_ENCRYPTION_KEY must be a 32-byte value. Accepts either a
 * 64-char hex string or falls back to hashing whatever string is given
 * (via SHA-256) so a plain human-typed env value still works, with a
 * loud warning either way if left on the default.
 */
function resolveKey() {
    const raw = process.env.EMAIL_ENCRYPTION_KEY;
    if (!raw) {
        // eslint-disable-next-line no-console
        console.warn(
            '[email] EMAIL_ENCRYPTION_KEY is not set - using a hardcoded ' +
            'fallback key. SMTP passwords stored while this is unset are ' +
            'NOT meaningfully protected at rest. Set EMAIL_ENCRYPTION_KEY ' +
            'to a random 32-byte value before storing real SMTP credentials.'
        );
        return crypto.createHash('sha256').update('CHANGE_ME_INSECURE_DEFAULT_KEY').digest();
    }
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
        return Buffer.from(raw, 'hex');
    }
    return crypto.createHash('sha256').update(raw).digest();
}

function encrypt(plaintext) {
    if (plaintext === null || plaintext === undefined || plaintext === '') return null;
    const key = resolveKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, encrypted]);
}

function decrypt(blob) {
    if (!blob) return null;
    const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
    const iv = buf.subarray(0, 12);
    const authTag = buf.subarray(12, 28);
    const encrypted = buf.subarray(28);
    const key = resolveKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
