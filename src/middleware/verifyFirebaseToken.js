const admin = require('firebase-admin');

/**
 * Verifies the Firebase ID token on every protected route and attaches
 * { uid, companyId, role, email } to req.user.
 *
 * This is the ONLY tenant isolation this schema has (MySQL has no RLS).
 * Every route handler MUST filter its queries by req.user.companyId -
 * never by a company_id supplied in the request body/query string.
 */
async function verifyFirebaseToken(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
        return res.status(401).json({ error: 'Missing bearer token' });
    }

    try {
        const decoded = await admin.auth().verifyIdToken(token);
        const companyId = decoded.company_id;
        const role = decoded.role;

        if (!companyId || !role) {
            return res.status(403).json({ error: 'Account has no company_id/role claim set' });
        }

        req.user = {
            uid: decoded.uid,
            companyId,
            role,
            email: decoded.email
        };
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

module.exports = { verifyFirebaseToken, requireAdmin };
