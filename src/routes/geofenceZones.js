const express = require('express');
const pool = require('../db');
const { verifyFirebaseToken, requireAdmin } = require('../middleware/verifyFirebaseToken');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(verifyFirebaseToken);

/**
 * Set Geo Fencing (CONTEXT.md, Attendance #8, migration_015). A zone is
 * a named circle (lat/lng center + radius in meters). The actual
 * enforcement - checking a mobile punch's coordinate against these
 * zones - lives in routes/mobilePunch.js's POST handler, which calls
 * checkAgainstZones() exported below; this file is the zone CRUD only.
 *
 * See migration_015's header comment for how this relates to
 * employees.remote_location_enabled (Device management #6) - a
 * "remote location" employee's punches skip the check this file's
 * zones would otherwise apply.
 */

// Haversine distance in meters between two lat/lng points. Standard
// great-circle formula - no shortcuts taken (e.g. flat-earth
// approximation), since geofence radii here are small enough (50-200m
// typical, see migration_015) that the two approaches would rarely
// visibly disagree, but there is no reason to trade correctness for
// simplicity on a distance check that gates whether someone's
// attendance gets flagged.
const EARTH_RADIUS_METERS = 6371000;
function haversineMeters(lat1, lon1, lat2, lon2) {
    const toRad = deg => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return EARTH_RADIUS_METERS * c;
}

/**
 * Checks a coordinate against every active geofence zone for a
 * company. Returns { inside, nearestZoneName, nearestDistanceMeters,
 * zonesConfigured } - the nearest-zone info is returned even when
 * inside is false, so an approver reviewing a rejected/flagged mobile
 * punch can see *how far* outside the nearest zone it was, not just a
 * bare yes/no.
 */
async function checkAgainstZones(companyId, latitude, longitude) {
    const [zones] = await pool.query(
        'SELECT name, latitude, longitude, radius_meters FROM geofence_zones WHERE company_id = ? AND is_active = 1',
        [companyId]
    );
    if (zones.length === 0) {
        // No zones configured for this company at all - nothing to
        // enforce against, so every punch passes. This is deliberate:
        // geofencing is opt-in by *configuring a zone*, not a feature
        // that starts blocking punches the moment this migration runs.
        return { inside: true, nearestZoneName: null, nearestDistanceMeters: null, zonesConfigured: false };
    }

    let nearest = null;
    for (const zone of zones) {
        const distance = haversineMeters(latitude, longitude, parseFloat(zone.latitude), parseFloat(zone.longitude));
        if (!nearest || distance < nearest.distance) {
            nearest = { name: zone.name, distance };
        }
        if (distance <= zone.radius_meters) {
            return { inside: true, nearestZoneName: zone.name, nearestDistanceMeters: Math.round(distance), zonesConfigured: true };
        }
    }
    return {
        inside: false,
        nearestZoneName: nearest.name,
        nearestDistanceMeters: Math.round(nearest.distance),
        zonesConfigured: true,
    };
}

router.get('/', asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
        'SELECT * FROM geofence_zones WHERE company_id = ? ORDER BY name ASC',
        [req.user.companyId]
    );
    return res.json(rows);
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { name, branch_id, latitude, longitude, radius_meters } = req.body;
    if (!name || latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: 'name, latitude and longitude are required' });
    }
    const [result] = await pool.query(
        `INSERT INTO geofence_zones (company_id, branch_id, name, latitude, longitude, radius_meters)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [req.user.companyId, branch_id || null, name, latitude, longitude, radius_meters || 150]
    );
    return res.status(201).json({ id: result.insertId });
}));

router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
    const fields = ['name', 'branch_id', 'latitude', 'longitude', 'radius_meters', 'is_active'];
    const updates = [];
    const values = [];
    fields.forEach(f => {
        if (req.body[f] !== undefined) {
            updates.push(`${f} = ?`);
            values.push(req.body[f]);
        }
    });
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    values.push(req.params.id, req.user.companyId);
    await pool.query(`UPDATE geofence_zones SET ${updates.join(', ')} WHERE id = ? AND company_id = ?`, values);
    return res.json({ message: 'Updated' });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM geofence_zones WHERE id = ? AND company_id = ?', [req.params.id, req.user.companyId]);
    return res.json({ message: 'Deleted' });
}));

module.exports = { router, checkAgainstZones };
