/**
 * geo.js – Citizen PWA Geolocation  (Phase 5 Final)
 * ====================================================
 * Responsibilities:
 *   1. Request geolocation permission (with graceful denial handling)
 *   2. Encode lat/lng to geohash (GeoFire-compatible, precision 9)
 *   3. Save GeoPoint + geohash to users/{uid} in Firestore
 *   4. Refresh location on:
 *       a. Login (App.init)
 *       b. App comes to foreground (visibilitychange)
 *       c. Every 30 minutes (setInterval)
 *   5. SAFETY: location writes use ONLY the 4 safe fields
 *      (location, geohash, locationUpdatedAt, locationAccuracy).
 *      Role, district, and admin fields are NEVER written.
 *
 * Requires: window.FB set by firebase-init.js
 * Exposes:  window.Geo
 */

import {
    doc,
    updateDoc,
    GeoPoint,
} from 'https://www.gstatic.com/firebasejs/10.12.1/firebase-firestore.js';
import {
    getAuth,
} from 'https://www.gstatic.com/firebasejs/10.12.1/firebase-auth.js';

const { db } = window.FB;
const auth = getAuth();

// ── Constants ─────────────────────────────────────────────────────────────────
const GEO_REFRESH_INTERVAL_MS = 30 * 60 * 1000;   // 30 minutes
const GEO_CACHE_MAX_AGE_MS = 5 * 60 * 1000;   // Don't re-query GPS within 5 min
const GEO_TIMEOUT_MS = 12000;             // 12s GPS timeout
const GEO_GEOHASH_PRECISION = 9;                 // ~4.8m cell, required for Point-in-Poly accuracy

// SAFE FIELDS: ONLY these can be written by geo.js.
// Role, district, name, fcmToken, email, phone are NEVER touched.
const SAFE_UPDATE_FIELDS = ['location', 'geohash', 'locationUpdatedAt', 'locationAccuracy'];

// ── Internal state ────────────────────────────────────────────────────────────
let _lastSaveTime = 0;               // Epoch ms of last Firestore write
let _lastPosition = null;            // Last { lat, lng, geohash, accuracy }
let _intervalId = null;            // setInterval handle
let _listenerBound = false;           // visibilitychange registered?
let _permissionDenied = false;        // Avoid re-asking after denial


// ── GeoHash encoder (standard base32, GeoFire-compatible) ────────────────────
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

function encodeGeohash(lat, lng, precision = GEO_GEOHASH_PRECISION) {
    let idx = 0, bit = 0, even = true, geohash = '';
    let minLat = -90, maxLat = 90, minLng = -180, maxLng = 180;

    while (geohash.length < precision) {
        if (even) {
            const mid = (minLng + maxLng) / 2;
            if (lng > mid) { idx = (idx << 1) | 1; minLng = mid; }
            else { idx = idx << 1; maxLng = mid; }
        } else {
            const mid = (minLat + maxLat) / 2;
            if (lat > mid) { idx = (idx << 1) | 1; minLat = mid; }
            else { idx = idx << 1; maxLat = mid; }
        }
        even = !even;
        if (++bit === 5) { geohash += BASE32[idx]; idx = 0; bit = 0; }
    }
    return geohash;
}


// ── Get current GPS position ──────────────────────────────────────────────────
function getCurrentPosition(options = {}) {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            reject(Object.assign(new Error('Geolocation not supported.'), { code: 0 }));
            return;
        }
        navigator.geolocation.getCurrentPosition(
            resolve,
            reject,
            {
                enableHighAccuracy: true,
                timeout: GEO_TIMEOUT_MS,
                maximumAge: GEO_CACHE_MAX_AGE_MS,
                ...options,
            }
        );
    });
}


// ── Save location to Firestore ────────────────────────────────────────────────
// ONLY writes the 4 safe location fields.
// Role, district, fcmToken, name etc. are never modified here.
async function saveLocation(lat, lng, accuracy = null) {
    const user = auth.currentUser;
    if (!user) {
        console.warn('[Geo] No authenticated user — location not saved.');
        return null;
    }

    // Debounce: skip if we saved within the last 5 minutes
    const now = Date.now();
    if (now - _lastSaveTime < GEO_CACHE_MAX_AGE_MS) {
        console.info('[Geo] Location cache fresh — skipping Firestore write.');
        return _lastPosition;
    }

    const geohash = encodeGeohash(lat, lng, GEO_GEOHASH_PRECISION);
    const geoPoint = new GeoPoint(lat, lng);

    // ⚠️ STRICT: only update location fields — never role, district, fcmToken etc.
    const locationUpdate = {
        location: geoPoint,
        geohash,
        locationUpdatedAt: new Date(),
        ...(accuracy != null && { locationAccuracy: accuracy }),
    };

    // Verify we only write safe fields (defence-in-depth)
    for (const key of Object.keys(locationUpdate)) {
        if (!SAFE_UPDATE_FIELDS.includes(key)) {
            console.error(`[Geo] Attempt to write restricted field "${key}" blocked.`);
            delete locationUpdate[key];
        }
    }

    try {
        await updateDoc(doc(db, 'users', user.uid), locationUpdate);
        _lastSaveTime = now;
        _lastPosition = { lat, lng, geohash, accuracy };
        // Cache globally for geofence alarm check (app.js isUserInAlertZone)
        window._lastGeoLat = lat;
        window._lastGeoLng = lng;
        console.info(`[Geo] Saved: ${lat.toFixed(5)},${lng.toFixed(5)} gh=${geohash} acc=${accuracy?.toFixed(0)}m`);
        return _lastPosition;

    } catch (err) {
        console.error('[Geo] Firestore write error:', err.code, err.message);
        return null;
    }
}


// ── Single refresh cycle ──────────────────────────────────────────────────────
async function refreshLocation({ force = false } = {}) {
    if (_permissionDenied) return null;
    if (!auth.currentUser) return null;

    // Skip if cache still fresh and not forced
    if (!force && (Date.now() - _lastSaveTime) < GEO_CACHE_MAX_AGE_MS) {
        return _lastPosition;
    }

    try {
        const pos = await getCurrentPosition();
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        return await saveLocation(lat, lng, accuracy);
    } catch (err) {
        handleGeoError(err);
        return null;
    }
}


// ── Geolocation error handler ─────────────────────────────────────────────────
function handleGeoError(err) {
    const MESSAGES = {
        0: '[Geo] Geolocation not supported by this browser.',
        1: '[Geo] Permission denied — user blocked location. Geo-targeting disabled.',
        2: '[Geo] Position unavailable — check device GPS.',
        3: '[Geo] GPS request timed out — will retry later.',
    };
    const code = err.code ?? 0;
    console.warn(MESSAGES[code] || `[Geo] Unknown error: ${err.message}`);

    if (code === 1) {
        _permissionDenied = true;
        // Surface a non-blocking in-app notification if toast is available
        if (window.App?.showToast) {
            App.showToast(
                '📍 Location disabled. Alerts may not reach you. Enable in browser Settings → Site permissions.',
                'warning',
                8000
            );
        }
    }
}


// ── Full init (called on login) ───────────────────────────────────────────────
async function initGeo() {
    _permissionDenied = false;
    _lastSaveTime = 0;   // Force first write

    // a) Attempt initial location grab
    let initialPosition = null;
    try {
        const pos = await getCurrentPosition();
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        initialPosition = await saveLocation(lat, lng, accuracy);
    } catch (err) {
        handleGeoError(err);
        // Graceful degradation: geo denied → alert delivery falls back to district topic
    }

    // b) Visibilitychange: refresh when app comes back to foreground
    if (!_listenerBound) {
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                refreshLocation().catch(() => { });
            }
        });
        _listenerBound = true;
        console.info('[Geo] Foreground refresh listener attached.');
    }

    // c) Periodic 30-minute refresh
    if (_intervalId) clearInterval(_intervalId);
    _intervalId = setInterval(() => {
        refreshLocation().catch(() => { });
    }, GEO_REFRESH_INTERVAL_MS);

    console.info(`[Geo] Initialized. 30-min interval active. Permission denied: ${_permissionDenied}`);
    return initialPosition;
}


// ── Emergency Mode ────────────────────────────────────────────────────────────
let _emergencyIntervalId = null;
const EMERGENCY_REFRESH_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Toggle emergency tracking:
 * - On: Polls every 2 minutes.
 * - Off: Reverts to 30-minute polling.
 */
function setEmergencyMode(enable) {
    if (enable) {
        if (_emergencyIntervalId) return; // already active
        console.info('[Geo] Entering Emergency Mode (High-frequency tracking).');
        refreshLocation({ force: true }).catch(() => { });
        _emergencyIntervalId = setInterval(() => {
            refreshLocation().catch(() => { });
        }, EMERGENCY_REFRESH_MS);
    } else {
        if (!_emergencyIntervalId) return;
        console.info('[Geo] Exiting Emergency Mode.');
        clearInterval(_emergencyIntervalId);
        _emergencyIntervalId = null;
    }
}


// ── Stop all refresh activity (call on logout) ────────────────────────────────
function stopGeo() {
    if (_intervalId) { clearInterval(_intervalId); _intervalId = null; }
    if (_emergencyIntervalId) { clearInterval(_emergencyIntervalId); _emergencyIntervalId = null; }
    _lastPosition = null;
    _lastSaveTime = 0;
    _permissionDenied = false;
    console.info('[Geo] Stopped and reset.');
}


// ── Expose ────────────────────────────────────────────────────────────────────
window.Geo = {
    initGeo,
    stopGeo,
    saveLocation,
    refreshLocation,
    encodeGeohash,
    setEmergencyMode,
    getLastPosition: () => _lastPosition,
    isPermissionDenied: () => _permissionDenied,
};

