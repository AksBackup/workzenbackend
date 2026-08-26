/**
 * Guards the internal license-generation panel (public/index.html and its
 * /license/admin/* routes). Deliberately separate from verifyFirebaseToken -
 * this is YOUR tool as the vendor, it must never be reachable using a
 * customer's admin login.
 */
function adminPanelAuth(req, res, next) {
    if (!process.env.PANEL_SECRET) {
        return res.status(500).json({ error: 'PANEL_SECRET is not configured on the server' });
    }
    const key = req.headers['x-panel-key'];
    if (key !== process.env.PANEL_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

module.exports = adminPanelAuth;
