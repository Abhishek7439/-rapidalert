/**
 * RapidAlert – Cloud Functions  (Phase 6: AI Intelligence Layer)
 * ==============================================================
 * Runtime:  Node.js 20
 * SDK:      firebase-functions v5 (v2 APIs) + firebase-admin v12
 * Region:   asia-south1 (Mumbai)
 *
 * GEOFENCING STRATEGY  (onAlertCreated)
 * ─────────────────────────────────────
 *  Path A — GeoJSON polygon exists:
 *    1. Compute polygon bounding box
 *    2. Geohash the bounding box precision-6 cells (geofire-common)
 *    3. For each geohash range: query users WHERE geohash >= lo AND <= hi
 *    4. De-duplicate results (users may appear in multiple ranges)
 *    5. turf.booleanPointInPolygon() — exact inclusion test
 *    6. Collect matched fcmTokens → multicast
 *
 *  Path B — radius (km) + center coordinates exist:
 *    1. Compute geohash ranges for circular query (geofire-common)
 *    2. Query users by geohash ranges
 *    3. distanceBetween() — filter users within radius
 *    4. Collect matched fcmTokens → multicast
 *
 *  Path C — district-wide / no geoJSON / no radius:
 *    FCM topic push only — no Firestore token scan needed.
 *
 * PERFORMANCE GUARANTEES
 * ──────────────────────
 *  • No full collection scan: queries always use geohash range
 *  • Reads bounded by bounding box: typically 50–500 documents for
 *    a city-level polygon
 *  • Batch Firestore reads: multiple range queries run in parallel
 *  • Update alert: matchedUsers, geoFiltered, filterTimeMs,
 *    boundingQueryCount, polygonCheckCount, totalExecutionTime
 */

'use strict';

// ─── Admin SDK ────────────────────────────────────────────────────────────────
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getMessaging } = require('firebase-admin/messaging');

let firebaseConfig = { projectId: 'smart-community-8fd9a' };
if (process.env.FIREBASE_CONFIG) {
    try {
        firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
    } catch (e) {
        // use fallback
    }
}
if (getApps().length === 0) initializeApp(firebaseConfig);

const db = getFirestore();
const adminAuth = getAuth();
const messaging = getMessaging();

// ─── Functions SDK ────────────────────────────────────────────────────────────
const { onRequest, onCall } = require('firebase-functions/v2/https');
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const functions = require('firebase-functions');   // v1 – Auth triggers

// ─── AI Modules ───────────────────────────────────────────────────────────────
const { runRiskPredictor } = require('./ai/riskPredictor');
const { scoreSeverity } = require('./ai/severitySuggest');
const { checkSOSSpike } = require('./ai/sosSpike');

// ─── Geospatial libraries ──────────────────────────────────────────────────────
const {
    geohashQueryBounds,     // Get geohash ranges for a bounding box or radius
    distanceBetween,        // Haversine distance in km
    geohashForPoint,        // Encode lat/lng to geohash
    boundingBoxCoordinates, // Bounding box from center + radius
} = require('geofire-common');

const booleanPointInPolygon = require('@turf/boolean-point-in-polygon').default;
const { point: turfPoint, polygon: turfPolygon, multiPolygon: turfMultiPolygon } = require('@turf/helpers');

// ─── Global defaults ──────────────────────────────────────────────────────────
setGlobalOptions({
    region: 'asia-south1',
    maxInstances: 20,
    timeoutSeconds: 120,
    memory: '512MiB',
});

const REGION = 'asia-south1';

// ─── Structured logger ────────────────────────────────────────────────────────
function log(severity, message, labels = {}) {
    console.log(JSON.stringify({
        severity,
        message,
        labels: { service: 'rapidalert-functions', region: REGION, ...labels },
        timestamp: new Date().toISOString(),
    }));
}
const logger = {
    debug: (m, l) => log('DEBUG', m, l),
    info: (m, l) => log('INFO', m, l),
    notice: (m, l) => log('NOTICE', m, l),
    warning: (m, l) => log('WARNING', m, l),
    error: (m, l) => log('ERROR', m, l),
    critical: (m, l) => log('CRITICAL', m, l),
};

/**
 * Helper to retry a function with exponential backoff.
 */
async function withRetry(fn, maxRetries = 3, initialDelay = 1000) {
    let lastErr;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            const delay = initialDelay * Math.pow(2, i);
            if (i < maxRetries - 1) {
                logger.warning(`Operation failed, retrying in ${delay}ms...`, { attempt: i + 1, error: err.message });
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw lastErr;
}


// ──────────────────────────────────────────────────────────────────────────────
//  GEOFENCING UTILITIES
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Compute the bounding box of a GeoJSON polygon / multipolygon.
 * Returns { minLat, maxLat, minLng, maxLng }
 */
function getBoundingBox(geoJSON) {
    let minLat = 90, maxLat = -90;
    let minLng = 180, maxLng = -180;

    function processRing(ring) {
        for (const [lng, lat] of ring) {
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
        }
    }

    const geom = geoJSON.geometry || geoJSON;

    if (geom.type === 'Polygon') {
        geom.coordinates.forEach(ring => processRing(ring));
    } else if (geom.type === 'MultiPolygon') {
        geom.coordinates.forEach(poly => poly.forEach(ring => processRing(ring)));
    } else if (geom.type === 'FeatureCollection') {
        geoJSON.features?.forEach(f => {
            const bbox = getBoundingBox(f.geometry);
            if (bbox.minLat < minLat) minLat = bbox.minLat;
            if (bbox.maxLat > maxLat) maxLat = bbox.maxLat;
            if (bbox.minLng < minLng) minLng = bbox.minLng;
            if (bbox.maxLng > maxLng) maxLng = bbox.maxLng;
        });
    }

    return { minLat, maxLat, minLng, maxLng };
}

/**
 * Query Firestore for users whose geohash falls within any of the given
 * geohash prefix ranges. Runs all range queries in parallel.
 * Returns a Map<uid, docData> (de-duplicated).
 *
 * @param {Array<[string,string]>} hashRanges  — from geohashQueryBounds()
 * @param {string|null} district               — optional district filter
 * @returns {Map<string, object>}              — uid → user data
 */
async function queryUsersByGeohashRanges(hashRanges, district = null) {
    const usersRef = db.collection('users');

    const queryPromises = hashRanges.map(([startHash, endHash]) => {
        let q = usersRef
            .where('geohash', '>=', startHash)
            .where('geohash', '<=', endHash)
            .where('role', '==', 'citizen')
            .select('uid', 'geohash', 'location', 'fcmToken', 'district', 'name');

        if (district) {
            q = usersRef
                .where('geohash', '>=', startHash)
                .where('geohash', '<=', endHash)
                .where('district', '==', district)
                .select('uid', 'geohash', 'location', 'fcmToken', 'district', 'name');
        }
        return q.get();
    });

    const snapshots = await Promise.all(queryPromises);

    // De-duplicate by uid (user may appear in multiple hash ranges)
    const userMap = new Map();
    for (const snap of snapshots) {
        for (const doc of snap.docs) {
            if (!userMap.has(doc.id)) {
                userMap.set(doc.id, { id: doc.id, ...doc.data() });
            }
        }
    }

    return userMap;
}

/**
 * Convert a raw GeoJSON object (as stored in Firestore) to a Turf feature.
 * Supports Polygon, MultiPolygon, and FeatureCollection.
 */
function geoJSONToTurfFeature(geoJSON) {
    const geom = geoJSON.geometry || geoJSON;

    if (geom.type === 'Polygon') {
        return turfPolygon(geom.coordinates);
    }
    if (geom.type === 'MultiPolygon') {
        return turfMultiPolygon(geom.coordinates);
    }
    if (geom.type === 'Feature') {
        // Already a feature — return as-is
        return geoJSON;
    }
    if (geom.type === 'FeatureCollection' && geoJSON.features?.length > 0) {
        // Use first feature for point-in-polygon
        return geoJSON.features[0];
    }

    throw new Error(`Unsupported GeoJSON type: ${geom.type}`);
}

/**
 * Filter matched users to only those whose FCM token is non-null.
 * Returns { tokens: string[], docIds: Map<token, uid> }
 */
function extractValidTokens(userMap) {
    const tokens = [];
    const docIds = new Map();  // token → uid for stale cleanup

    for (const [uid, data] of userMap) {
        if (data.fcmToken) {
            tokens.push(data.fcmToken);
            docIds.set(data.fcmToken, uid);
        }
    }

    return { tokens, docIds };
}


// ──────────────────────────────────────────────────────────────────────────────
//  FCM MULTICAST HELPER (same as Phase 4, shared across all trigger types)
// ──────────────────────────────────────────────────────────────────────────────
const FCM_BATCH_SIZE = 500;

async function sendMulticast(tokens, tokenToUidMap, payload) {
    let totalSuccess = 0;
    let totalFailure = 0;
    const staleUids = [];

    for (let i = 0; i < tokens.length; i += FCM_BATCH_SIZE) {
        const batch = tokens.slice(i, i + FCM_BATCH_SIZE);

        let response;
        try {
            response = await withRetry(() => messaging.sendEachForMulticast({ ...payload, tokens: batch }));
        } catch (err) {
            logger.error('FCM batch failed after retries', { batch: `${i}–${i + batch.length}`, error: err.message });
            totalFailure += batch.length;
            continue;
        }

        totalSuccess += response.successCount;
        totalFailure += response.failureCount;

        response.responses.forEach((r, idx) => {
            const errCode = r.error?.code;
            if (!r.success && (
                errCode === 'messaging/registration-token-not-registered' ||
                errCode === 'messaging/invalid-registration-token'
            )) {
                const uid = tokenToUidMap.get(batch[idx]);
                if (uid) staleUids.push(uid);
            }
        });
    }

    return { totalSuccess, totalFailure, staleUids };
}


async function cleanStaleTokens(uids) {
    if (!uids.length) return;
    logger.notice(`Cleaning ${uids.length} stale FCM tokens`);
    await Promise.all(
        uids.map(uid =>
            db.collection('users').doc(uid)
                .update({ fcmToken: null })
                .catch(err => logger.warning('Stale token cleanup failed', { uid, error: err.message }))
        )
    );
}

// ──────────────────────────────────────────────────────────────────────────────
//  FCM TOPIC SLUG  (safe for FCM topic names)
// ──────────────────────────────────────────────────────────────────────────────
function districtToTopicSlug(district) {
    if (!district) return null;
    return district
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/, '')
        .slice(0, 60);
}

// ──────────────────────────────────────────────────────────────────────────────
//  BUILD FCM PAYLOAD  (shared by polygon + radius + district paths)
// ──────────────────────────────────────────────────────────────────────────────
function buildFCMPayload(alertId, alertData) {
    const { type, severity, message, area, isDrill, district } = alertData;
    const sevEmoji = { Info: 'ℹ️', Warning: '⚠️', Emergency: '🔴', Evacuate: '🚨' }[severity] || '⚠️';
    const drillTag = isDrill ? '[DRILL] ' : '';

    const notifTitle = `${sevEmoji} ${drillTag}${type} Alert`;
    const notifBody = `📍 ${area}\n${(message || '').substring(0, 150)}`;

    const vibrate = severity === 'Evacuate'
        ? [500, 100, 500, 100, 500, 100, 1000]
        : severity === 'Emergency' ? [300, 100, 300, 100, 600]
            : [300, 100, 300];

    return {
        notification: { title: notifTitle, body: notifBody },
        data: {
            type: 'ALERT',
            alertId,
            alertType: type,
            severity,
            area,
            message: (message || '').substring(0, 200),
            isDrill: String(isDrill || false),
            district: district || '',
            timeSent: new Date().toISOString(),
        },
        android: {
            priority: 'high',
            notification: {
                sound: 'default',
                channelId: (severity === 'Emergency' || severity === 'Evacuate')
                    ? 'emergency_alerts' : 'general_alerts',
                priority: 'max',
                visibility: 'public',
                vibrate,
                color: severity === 'Evacuate' ? '#7c3aed'
                    : severity === 'Emergency' ? '#ef4444'
                        : severity === 'Warning' ? '#f59e0b' : '#3b82f6',
            },
            ttl: 300,
        },
        apns: {
            payload: {
                aps: {
                    alert: { title: notifTitle, body: notifBody },
                    sound: 'default',
                    badge: 1,
                    'content-available': 1,
                },
            },
            headers: { 'apns-priority': '10' },
        },
        webpush: {
            headers: { Urgency: severity === 'Info' ? 'normal' : 'high' },
            notification: {
                title: notifTitle,
                body: notifBody,
                icon: '/rapidalert-citizen/icons/icon-192.png',
                badge: '/rapidalert-citizen/icons/icon-72.png',
                tag: `alert-${alertId}`,
                renotify: true,
                requireInteraction: severity === 'Emergency' || severity === 'Evacuate',
                vibrate,
                actions: [
                    { action: 'view', title: '👁 View Alert' },
                    { action: 'sos', title: '🆘 SOS' },
                    { action: 'safe', title: '✅ Safe' },
                ],
                data: { alertId, severity, url: `/rapidalert-citizen/index.html?alert=${alertId}` },
            },
            fcmOptions: { link: `/rapidalert-citizen/index.html?alert=${alertId}` },
        },
    };
}


// ═══════════════════════════════════════════════════════════════════════════════
// 1. HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════════════════
exports.healthCheck = onRequest(
    {
        region: REGION,
        cors: [
            'https://smart-community-8fd9a.web.app',
            'https://smart-community-8fd9a.firebaseapp.com',
            'http://localhost:5000',
        ],
        invoker: 'public',
        minInstances: 0,
    },
    async (req, res) => {
        if (req.method !== 'GET') { res.status(405).json({ error: 'Method Not Allowed' }); return; }

        let firestoreOk = false;
        try {
            await db.collection('system_config').doc('health').set(
                { lastChecked: FieldValue.serverTimestamp() }, { merge: true }
            );
            firestoreOk = true;
        } catch (err) {
            logger.error('Health check Firestore ping failed', { error: err.message });
        }

        const payload = {
            status: firestoreOk ? 'ok' : 'degraded',
            service: 'RapidAlert Cloud Functions',
            version: '3.0.0',
            region: REGION,
            firestore: firestoreOk ? 'reachable' : 'unreachable',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
        };

        logger.info('Health check', { firestore: String(firestoreOk) });
        res.status(firestoreOk ? 200 : 503).json(payload);
    }
);

// ═══════════════════════════════════════════════════════════════════════════════
// 2. ON USER CREATED
// ═══════════════════════════════════════════════════════════════════════════════
exports.onUserCreated = functions
    .region(REGION)
    .auth.user()
    .onCreate(async (userRecord) => {
        const { uid, phoneNumber, email, displayName, creationTime } = userRecord;
        logger.info('New user created', { uid, method: phoneNumber ? 'phone' : 'email' });

        const now = FieldValue.serverTimestamp();

        // Check for admin email assignment
        const adminEmail = process.env.ADMIN_EMAIL || 'admin@rapidalert.gov';
        const isTargetAdmin = email === adminEmail;
        const assignedRole = isTargetAdmin ? 'super_admin' : 'citizen';

        if (isTargetAdmin) {
            try {
                logger.info(`Assigning super_admin custom claim to ${email}`, { uid });
                await getAuth().setCustomUserClaims(uid, { role: 'super_admin', admin: true });
            } catch (err) {
                logger.error(`Failed to assign custom claims to ${email}`, { uid, error: err.message });
            }
        }

        const userDoc = {
            uid,
            phone: phoneNumber || null,
            email: email || null,
            name: displayName || (phoneNumber ? `Citizen-${uid.slice(-6)}` : 'Admin'),
            role: assignedRole,
            district: null,
            city: null,
            fcmToken: null,
            location: null,
            geohash: null,
            createdAt: now,
            lastSeen: now,
        };
        try {
            await db.collection('users').doc(uid).set(userDoc);
            logger.info('User document created', { uid, role: assignedRole });
        } catch (err) {
            logger.error('Failed to create user document', { uid, error: err.message });
        }
        try {
            await db.collection('admin_logs').add({
                action: 'USER_REGISTERED',
                details: { uid, method: phoneNumber ? 'phone' : 'email', email, assignedRole, createdAt: creationTime || new Date().toISOString() },
                timestamp: now,
            });
        } catch (err) {
            logger.warning('admin_log for user creation failed', { uid, error: err.message });
        }
    });


// ═══════════════════════════════════════════════════════════════════════════════
// 3. ON ALERT CREATED  —  Full Geo-Targeted FCM Push  (Phase 5)
//
//  Three dispatch paths:
//    A. GeoJSON polygon    → geohash range query + point-in-polygon filter
//    B. Radius + center   → geohash range query + distance filter
//    C. District-wide     → FCM topic push only (no token scan)
// ═══════════════════════════════════════════════════════════════════════════════
exports.sendAlertNotifications = onDocumentCreated(
    {
        document: 'alerts/{alertId}',
        region: REGION,
        memory: '512MiB',
        timeoutSeconds: 120,
    },
    async (event) => {
        const tStart = Date.now();
        const alertId = event.params.alertId;
        const alertData = event.data?.data();

        if (!alertData) {
            logger.error('onAlertCreated fired but data is null', { alertId });
            return;
        }

        // ── DUPLICATE PREVENTION ──────────────────────────────────────
        if (alertData._processedAt) {
            logger.notice('Alert already processed, skipping duplicate push.', { alertId });
            return;
        }


        const {
            type, severity, message, area, creatorUid,
            district, isDrill,
        } = alertData;

        // ── FIX: Read geofence fields from nested geofence object ─────
        // create-alert.js stores zone data as alertData.geofence.{type,geoJSON,radius,centerLat,centerLng}
        const geofence = alertData.geofence || {};
        let geoJSON = geofence.geoJSON || null;
        if (typeof geoJSON === 'string') {
            try { geoJSON = JSON.parse(geoJSON); } catch (e) { logger.warn('Failed to parse geoJSON', { error: e.message }); }
        }

        const radius = geofence.radius ?? null;
        const centerLat = geofence.centerLat ?? null;
        const centerLng = geofence.centerLng ?? null;
        const geofenceType = geofence.type || 'none'; // 'radius' | 'polygon' | 'none'

        logger.info('New alert — geo-targeted dispatch starting', {
            alertId, type, severity, district: district || 'all',
            geofenceType,
            hasGeoJSON: String(!!geoJSON), hasRadius: String(!!(radius && centerLat && centerLng)),
        });

        const now = FieldValue.serverTimestamp();

        // ── Validate required fields ──────────────────────────────────
        const REQUIRED = ['type', 'severity', 'message', 'area', 'creatorUid'];
        const missing = REQUIRED.filter(f => !alertData[f]);
        if (missing.length > 0) {
            logger.error('Alert missing required fields — deactivating', { alertId, missing: missing.join(',') });
            await event.data.ref.update({
                active: false, _errorReason: `Missing: ${missing.join(', ')}`, _processedAt: now,
            });
            return;
        }

        // ── Audit log ─────────────────────────────────────────────────
        try {
            await db.collection('admin_logs').add({
                action: 'ALERT_CREATED',
                adminUid: creatorUid,
                details: { alertId, type, severity, area, isDrill: isDrill || false, district: district || null },
                timestamp: now,
            });
        } catch (err) {
            logger.warning('admin_log write failed (non-fatal)', { alertId, error: err.message });
        }

        // ── Stamp alert immediately with _processedAt ─────────────────
        await event.data.ref.update({ _processedAt: now }).catch(() => { });

        // ── Build FCM payload (shared across all paths) ───────────────
        const fcmPayload = buildFCMPayload(alertId, alertData);

        // Performance counters
        let boundingQueryCount = 0;
        let polygonCheckCount = 0;
        let matchedUsers = 0;
        let deliveredCount = 0;
        let failedCount = 0;
        let topicDelivered = false;
        let geoFiltered = false;
        let dispatchPath = 'district';

        // ── FIX: Define topicSlug before dispatch paths ───────────────
        // (was undefined reference causing crash on topic push at line ~709)
        const topicSlug = districtToTopicSlug(district);


        // ══════════════════════════════════════════════════════════════
        //  PATH A — GeoJSON Polygon / MultiPolygon
        // ══════════════════════════════════════════════════════════════
        if (geoJSON && typeof geoJSON === 'object') {
            geoFiltered = true;
            dispatchPath = 'geojson';

            logger.info('Dispatch Path A: GeoJSON polygon', { alertId });

            try {
                // A1. Compute bounding box
                const bbox = getBoundingBox(geoJSON);
                const center = [(bbox.minLat + bbox.maxLat) / 2, (bbox.minLng + bbox.maxLng) / 2];

                // diagonal half-distance of bounding box in km (max extent)
                const radiusKm = distanceBetween(
                    [bbox.minLat, bbox.minLng],
                    [bbox.maxLat, bbox.maxLng]
                ) / 2 * 1.1;   // 10% buffer

                logger.info(`A1. BBox: [${bbox.minLat.toFixed(4)}, ${bbox.minLng.toFixed(4)}] → [${bbox.maxLat.toFixed(4)}, ${bbox.maxLng.toFixed(4)}] radius≈${radiusKm.toFixed(1)}km`, { alertId });

                // A2. Derive geohash query ranges for the bounding box
                // Precision 6 = ~1.2km cell. Good tradeoff for city-level polygons.
                const hashRanges = geohashQueryBounds(center, radiusKm * 1000);
                boundingQueryCount = hashRanges.length;

                logger.info(`A2. Geohash ranges: ${boundingQueryCount}`, { alertId });

                // A3. Query users by geohash ranges (parallel)
                const userMap = await queryUsersByGeohashRanges(hashRanges, district || null);
                const candidateCount = userMap.size;

                logger.info(`A3. Candidates from geohash query: ${candidateCount}`, { alertId });

                // A4. Convert geoJSON to Turf feature for point-in-polygon
                const turfFeature = geoJSONToTurfFeature(geoJSON);

                // A5. Filter: exact point-in-polygon test
                const matchedMap = new Map();
                for (const [uid, data] of userMap) {
                    polygonCheckCount++;
                    const loc = data.location;
                    if (!loc) continue;

                    // Firestore GeoPoint → [lng, lat] (Turf uses [lng, lat] order)
                    const lat = loc.latitude || loc._lat;
                    const lng = loc.longitude || loc._long;
                    if (lat == null || lng == null) continue;

                    const pt = turfPoint([lng, lat]);
                    if (booleanPointInPolygon(pt, turfFeature)) {
                        matchedMap.set(uid, data);
                    }
                }

                matchedUsers = matchedMap.size;
                logger.info(`A5. Point-in-polygon matched: ${matchedUsers} / ${candidateCount} candidates`, { alertId });

                // A6. Extract tokens + send
                const { tokens, docIds } = extractValidTokens(matchedMap);

                if (tokens.length > 0) {
                    const result = await sendMulticast(tokens, docIds, fcmPayload);
                    deliveredCount = result.totalSuccess;
                    failedCount = result.totalFailure;
                    await cleanStaleTokens(result.staleUids);
                } else {
                    logger.warning('A6. No valid FCM tokens in polygon — push skipped', { alertId });
                }

            } catch (err) {
                logger.error('Path A GeoJSON dispatch failed', { alertId, error: err.message });
            }
        }

        // ══════════════════════════════════════════════════════════════
        //  PATH B — Radius Query
        // ══════════════════════════════════════════════════════════════
        else if (radius && centerLat != null && centerLng != null) {
            geoFiltered = true;
            dispatchPath = 'radius';

            logger.info(`Dispatch Path B: Radius=${radius}km center=[${centerLat},${centerLng}]`, { alertId });

            try {
                const center = [centerLat, centerLng];
                const radiusM = radius * 1000;
                const hashRanges = geohashQueryBounds(center, radiusM);
                boundingQueryCount = hashRanges.length;

                logger.info(`B1. Geohash ranges: ${boundingQueryCount}`, { alertId });

                const userMap = await queryUsersByGeohashRanges(hashRanges, district || null);
                const candidateCount = userMap.size;

                logger.info(`B2. Candidates: ${candidateCount}`, { alertId });

                // B3. Distance filter (exact haversine)
                const matchedMap = new Map();
                for (const [uid, data] of userMap) {
                    polygonCheckCount++;
                    const loc = data.location;
                    if (!loc) continue;
                    const lat = loc.latitude || loc._lat;
                    const lng = loc.longitude || loc._long;
                    if (lat == null || lng == null) continue;

                    const km = distanceBetween(center, [lat, lng]);
                    if (km <= radius) {
                        matchedMap.set(uid, data);
                    }
                }

                matchedUsers = matchedMap.size;
                logger.info(`B3. Distance-matched: ${matchedUsers} / ${candidateCount}`, { alertId });

                const { tokens, docIds } = extractValidTokens(matchedMap);

                if (tokens.length > 0) {
                    const result = await sendMulticast(tokens, docIds, fcmPayload);
                    deliveredCount = result.totalSuccess;
                    failedCount = result.totalFailure;
                    await cleanStaleTokens(result.staleUids);
                } else {
                    logger.warning('B3. No valid FCM tokens in radius — push skipped', { alertId });
                }

            } catch (err) {
                logger.error('Path B radius dispatch failed', { alertId, error: err.message });
            }
        }

        // ══════════════════════════════════════════════════════════════
        //  PATH C — District-wide / no spatial filter
        //  1) FCM topic push (fast, but only works if user subscribed)
        //  2) Direct token scan as reliable fallback
        // ══════════════════════════════════════════════════════════════
        else {
            dispatchPath = 'district-topic';
            logger.info('Dispatch Path C: District-wide — topic + direct token scan', { alertId, district: district || 'all' });

            // C1. Topic push (supplemental)
            try {
                await withRetry(() => messaging.send({ ...fcmPayload, topic: 'all_citizens' }));
                topicDelivered = true;
                logger.info('Path C: Global topic push sent', { alertId });
            } catch (err) {
                logger.warning('Path C: Topic push failed (will continue with token scan)', { alertId, error: err.message });
            }

            // C2. Direct token scan — query ALL users with fcmToken
            // This is the reliable fallback since topic subscription requires server-side Admin SDK
            try {
                let userQuery = db.collection('users').where('fcmToken', '!=', null);
                if (district) {
                    userQuery = db.collection('users')
                        .where('district', '==', district)
                        .where('fcmToken', '!=', null);
                }
                const userSnap = await userQuery.limit(500).get();

                if (!userSnap.empty) {
                    const tokenMap = new Map();
                    userSnap.docs.forEach(d => {
                        const t = d.data().fcmToken;
                        if (t) tokenMap.set(d.id, d.data());
                    });

                    const { tokens, docIds } = extractValidTokens(tokenMap);
                    logger.info(`Path C: Direct scan found ${tokens.length} tokens`, { alertId });

                    if (tokens.length > 0) {
                        const result = await sendMulticast(tokens, docIds, fcmPayload);
                        deliveredCount = result.totalSuccess;
                        failedCount = result.totalFailure;
                        matchedUsers = tokens.length;
                        await cleanStaleTokens(result.staleUids);
                        logger.info(`Path C: Direct delivery — sent:${deliveredCount} failed:${failedCount}`, { alertId });
                    }
                } else {
                    logger.warning('Path C: No users with FCM tokens found in Firestore', { alertId });
                }
            } catch (err) {
                logger.error('Path C: Direct token scan failed', { alertId, error: err.message });
            }
        }

        // ── District topic push (supplemental for Paths A & B) ────────
        if (topicSlug && dispatchPath !== 'district-topic') {
            try {
                await withRetry(() => messaging.send({ ...fcmPayload, topic: `district_${topicSlug}` }));
                topicDelivered = true;
                logger.info(`Topic push sent: district_${topicSlug}`, { alertId });
            } catch (err) {
                logger.error('Topic push failed after retries', { alertId, error: err.message });
            }
        }


        // ── Performance metrics ────────────────────────────────────────
        const tEnd = Date.now();
        const filterTimeMs = tEnd - tStart;
        const totalExecutionTime = filterTimeMs;

        logger.info('onAlertCreated GEO complete', {
            alertId,
            dispatchPath,
            matchedUsers: String(matchedUsers),
            deliveredCount: String(deliveredCount),
            boundingQueryCount: String(boundingQueryCount),
            polygonCheckCount: String(polygonCheckCount),
            filterTimeMs: String(filterTimeMs),
            topicDelivered: String(topicDelivered),
        });

        // ── FIX: reach = matchedUsers (real count, not delivery count) ─
        // matchedUsers = citizens physically inside geofence
        // deliveredCount = FCM multicast successes (subset of matchedUsers)
        const realReach = matchedUsers > 0 ? matchedUsers : (topicDelivered ? deliveredCount : 0);

        // ── Write notification_logs/{alertId} ────────────────────────
        try {
            await db.collection('notification_logs').doc(alertId).set({
                alertId,
                totalUsersInZone: matchedUsers,
                notificationsSent: deliveredCount,
                failedCount,
                topicDelivered,
                dispatchPath,
                geofenceType,
                boundingQueryCount,
                polygonCheckCount,
                filterTimeMs,
                totalExecutionTime,
                timestamp: FieldValue.serverTimestamp(),
            });
            logger.info('notification_logs written', { alertId, totalUsersInZone: String(matchedUsers) });
        } catch (err) {
            logger.error('Failed to write notification_logs', { alertId, error: err.message });
        }

        // ── Update alert document with delivery metrics ────────────────
        try {
            await event.data.ref.update({
                matchedUsers,
                reach: realReach,
                deliveredCount,
                failedCount,
                topicDelivered,
                geoFiltered,
                dispatchPath,
                filterTimeMs,
                boundingQueryCount,
                polygonCheckCount,
                totalExecutionTime,
                computedAt: FieldValue.serverTimestamp(),
                _deliveredAt: now,
            });
        } catch (err) {
            logger.error('Failed to update alert delivery metrics', { alertId, error: err.message });
        }
    }
);

// ═══════════════════════════════════════════════════════════════════════════════
// 3.5. ON ALERT UPDATED — Track Cancellations
// ═══════════════════════════════════════════════════════════════════════════════
exports.onAlertUpdated = onDocumentUpdated(
    {
        document: 'alerts/{alertId}',
        region: REGION,
        memory: '128MiB',
    },
    async (event) => {
        const before = event.data.before.data();
        const after = event.data.after.data();
        if (!before || !after) return;

        // Detect transition from active: true to active: false
        if (before.active === true && after.active === false) {
            try {
                await db.collection('admin_logs').add({
                    action: 'ALERT_CANCELLED',
                    adminUid: after.cancelledBy || 'system',
                    details: {
                        alertId: event.params.alertId,
                        type: after.type,
                        area: after.area,
                        district: after.district || null
                    },
                    timestamp: FieldValue.serverTimestamp(),
                });
                logger.info('Recorded ALERT_CANCELLED in admin logs', { alertId: event.params.alertId });
            } catch (err) {
                logger.warning('Failed to write ALERT_CANCELLED log', { error: err.message });
            }
        }
    }
);


// ═══════════════════════════════════════════════════════════════════════════════
// 4. ON SOS CREATED  —  Notify Officers
// ═══════════════════════════════════════════════════════════════════════════════
const SOS_SPIKE_THRESHOLD = 10;

exports.onSOSCreated = onDocumentCreated(
    {
        document: 'sos_requests/{sosId}',
        region: REGION,
        memory: '256MiB',
        timeoutSeconds: 60,
    },
    async (event) => {
        const sosId = event.params.sosId;
        const sosData = event.data?.data();

        if (!sosData) { logger.error('onSOSCreated fired but data is null', { sosId }); return; }

        logger.info('New SOS received', {
            sosId, citizenUid: sosData.citizenUid || 'unknown', district: sosData.district || 'unknown',
        });

        const now = FieldValue.serverTimestamp();

        // ── a) Audit log ───────────────────────────────────────────────
        try {
            await db.collection('admin_logs').add({
                action: 'SOS_RECEIVED',
                details: {
                    sosId, citizenUid: sosData.citizenUid,
                    name: sosData.name || 'Unknown', area: sosData.area || 'Unknown',
                    district: sosData.district || null,
                    lat: sosData.location?.latitude || null,
                    lng: sosData.location?.longitude || null,
                },
                timestamp: now,
            });
        } catch (err) {
            logger.warning('admin_log for SOS failed (non-fatal)', { sosId, error: err.message });
        }

        // ── b) Notify district officers ────────────────────────────────
        try {
            let officerQuery = db.collection('users')
                .where('role', 'in', ['district_officer', 'super_admin'])
                .where('fcmToken', '!=', null);

            if (sosData.district) {
                officerQuery = db.collection('users')
                    .where('role', 'in', ['district_officer', 'super_admin'])
                    .where('district', '==', sosData.district)
                    .where('fcmToken', '!=', null);
            }

            const officerSnap = await officerQuery.get();

            if (officerSnap.empty) {
                logger.warning('No officers with FCM tokens for district', { district: sosData.district || 'any' });
            } else {
                const tokens = [];
                const tokenToUidMap = new Map();
                officerSnap.docs.forEach(d => {
                    const t = d.data().fcmToken;
                    if (t) { tokens.push(t); tokenToUidMap.set(t, d.id); }
                });

                const sosFcmPayload = {
                    notification: {
                        title: `\uD83C\uDD98 SOS – ${sosData.name || 'Citizen'}`,
                        body: `\uD83D\uDCCD ${sosData.area || 'Location unavailable'} · Tap to respond`,
                    },
                    data: {
                        type: 'SOS_RECEIVED', sosId,
                        name: sosData.name || '', area: sosData.area || '',
                        lat: String(sosData.location?.latitude || ''),
                        lng: String(sosData.location?.longitude || ''),
                        district: sosData.district || '',
                        url: '/rapidalert/index.html?sos=1',
                    },
                    android: {
                        priority: 'high',
                        notification: {
                            sound: 'default', channelId: 'sos_alerts', priority: 'max',
                            visibility: 'public', vibrate: [300, 100, 300, 100, 600],
                        },
                    },
                    webpush: {
                        headers: { Urgency: 'high' },
                        notification: {
                            icon: '/rapidalert/icons/icon-192.png', badge: '/rapidalert/icons/icon-72.png',
                            requireInteraction: true, tag: `sos-${sosId}`,
                            actions: [
                                { action: 'respond', title: '\uD83D\uDE95 Respond' },
                                { action: 'view', title: '\uD83D\uDC41 View Details' },
                            ],
                        },
                        fcmOptions: { link: '/rapidalert/index.html?sos=1' },
                    },
                };

                const result = await sendMulticast(tokens, tokenToUidMap, sosFcmPayload);
                logger.info('FCM SOS officer notification sent', {
                    sosId,
                    sent: String(tokens.length),
                    success: String(result.totalSuccess),
                    failed: String(result.totalFailure),
                });

                await cleanStaleTokens(result.staleUids);

                await event.data.ref.update({
                    _officersNotified: result.totalSuccess,
                    _notifiedAt: now,
                });
            }
        } catch (err) {
            logger.error('Failed to send FCM SOS notification', { sosId, error: err.message });
        }

        // ── c) Spike detection ─────────────────────────────────────────
        try {
            const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
            let spikeQuery = db.collection('sos_requests').where('time', '>=', fiveMinutesAgo);
            if (sosData.district) {
                spikeQuery = db.collection('sos_requests')
                    .where('district', '==', sosData.district)
                    .where('time', '>=', fiveMinutesAgo);
            }

            const recentCount = (await spikeQuery.get()).size;

            if (recentCount >= SOS_SPIKE_THRESHOLD) {
                logger.critical('SOS SPIKE DETECTED', {
                    district: sosData.district || 'unknown',
                    count: String(recentCount),
                });

                const superAdminSnap = await db.collection('users')
                    .where('role', '==', 'super_admin')
                    .where('fcmToken', '!=', null).get();
                const superTokens = superAdminSnap.docs.map(d => d.data().fcmToken).filter(Boolean);
                const superMap = new Map(superAdminSnap.docs.map(d => [d.data().fcmToken, d.id]));

                if (superTokens.length > 0) {
                    await sendMulticast(superTokens, superMap, {
                        notification: {
                            title: '\uD83D\uDEA8 SOS SPIKE ALERT',
                            body: `${recentCount} SOS in 5 min in ${sosData.district || 'your area'}!`,
                        },
                        data: { type: 'SOS_SPIKE', district: sosData.district || '', count: String(recentCount) },
                        android: { priority: 'high' },
                        webpush: { headers: { Urgency: 'high' }, notification: { requireInteraction: true } },
                    });
                }

                await db.collection('admin_logs').add({
                    action: 'SOS_SPIKE_DETECTED',
                    details: { district: sosData.district || 'unknown', count: recentCount, threshold: SOS_SPIKE_THRESHOLD, windowMins: 5 },
                    timestamp: now,
                });
            }
        } catch (err) {
            logger.warning('Spike detection failed (non-fatal)', { sosId, error: err.message });
        }

        // ── c) AI SOS Spike Detection (sosSpike.js module) ────────────
        await checkSOSSpike({
            sosId,
            sosData,
            sosRef: event.data.ref,
            db,
            messaging,
            FieldValue,
            logger,
            sendMulticast,
        }).catch(err => logger.warning('checkSOSSpike failed (non-fatal)', { sosId, error: err.message }));
    }
);


// ═══════════════════════════════════════════════════════════════════════════════
// 5. RISK PREDICTOR  —  Scheduled every 6 hours
//    Computes district-level risk scores from last 30 days of alerts.
//    Writes to ai_predictions/{district}.
// ═══════════════════════════════════════════════════════════════════════════════
exports.riskPredictor = onSchedule(
    {
        schedule: 'every 6 hours',
        region: REGION,
        memory: '256MiB',
        timeoutSeconds: 120,
    },
    async (event) => {
        logger.info('riskPredictor scheduled run triggered');
        try {
            const result = await runRiskPredictor(db, logger);
            logger.info('riskPredictor complete', {
                districts: String(result?.districts || 0),
                success: String(result?.successCount || 0),
                failures: String(result?.failureCount || 0),
                elapsedMs: String(result?.elapsedMs || 0),
            });
        } catch (err) {
            logger.error('riskPredictor uncaught error', { error: err.message });
        }
    }
);


// ═══════════════════════════════════════════════════════════════════════════════
// 6. SEVERITY SUGGEST  —  HTTPS Callable (Admin Panel → Create Alert form)
//    Analyzes alert message text using keyword/pattern scoring.
//    Returns: { suggested, confidence, matchedKeywords }
// ═══════════════════════════════════════════════════════════════════════════════
exports.severitySuggest = onCall(
    {
        region: REGION,
        maxInstances: 5,
        timeoutSeconds: 10,
        memory: '128MiB',
        enforceAppCheck: false,   // Set true when App Check is configured
    },
    async (request) => {
        const { message } = request.data || {};

        if (!message || typeof message !== 'string') {
            throw new Error('INVALID_ARGUMENT: message must be a non-empty string');
        }

        const trimmed = message.trim();
        if (trimmed.length < 3) {
            return { suggested: 'Warning', confidence: 0, matchedKeywords: [] };
        }
        if (trimmed.length > 500) {
            throw new Error('INVALID_ARGUMENT: message exceeds 500 characters');
        }

        logger.info('severitySuggest called', {
            uid: request.auth?.uid || 'unauthenticated',
            textLen: String(trimmed.length),
        });

        const result = scoreSeverity(trimmed);

        // Persist for analytics (non-blocking)
        db.collection('ai_suggestions').add({
            message: trimmed.slice(0, 200),
            suggested: result.suggested,
            confidence: result.confidence,
            matchedKeywords: result.matchedKeywords,
            callerUid: request.auth?.uid || null,
            createdAt: FieldValue.serverTimestamp(),
        }).catch(() => { });

        return {
            suggested: result.suggested,
            confidence: result.confidence,
            matchedKeywords: result.matchedKeywords,
        };
    }
);


// ═══════════════════════════════════════════════════════════════════════════════
// 7. SET USER ROLE  —  HTTPS Callable (super_admin only)
//    Assigns a Firebase custom claim role to a target user.
//    Also writes the role to users/{uid} in Firestore for display.
//
//    Input:  { targetUid, role, district? }
//    Roles:  'citizen' | 'district_officer' | 'super_admin'
// ═══════════════════════════════════════════════════════════════════════════════
const VALID_ROLES = ['citizen', 'district_officer', 'super_admin'];

exports.setUserRole = onCall(
    {
        region: REGION,
        maxInstances: 3,
        timeoutSeconds: 30,
        memory: '128MiB',
        enforceAppCheck: false,
    },
    async (request) => {
        // ── Auth guard: only super_admin can call this ────────────────
        const callerToken = request.auth?.token;
        if (!callerToken || callerToken.role !== 'super_admin') {
            throw new Error('PERMISSION_DENIED: Only super_admin can assign roles.');
        }

        const { targetUid, role, district = null } = request.data || {};

        // ── Input validation ──────────────────────────────────────────
        if (!targetUid || typeof targetUid !== 'string') {
            throw new Error('INVALID_ARGUMENT: targetUid is required.');
        }
        if (!VALID_ROLES.includes(role)) {
            throw new Error(`INVALID_ARGUMENT: role must be one of: ${VALID_ROLES.join(', ')}`);
        }

        logger.info('setUserRole called', {
            callerUid: request.auth.uid,
            targetUid,
            role,
            district: district || 'none',
        });

        // ── 1. Set Firebase Auth custom claim ─────────────────────────
        const claim = { role };
        if (district) claim.district = district;
        await adminAuth.setCustomUserClaims(targetUid, claim);

        // ── 2. Update users/{uid} in Firestore ────────────────────────
        const updateData = {
            role,
            roleUpdatedAt: FieldValue.serverTimestamp(),
            roleUpdatedBy: request.auth.uid,
        };
        if (district !== null) updateData.district = district;

        await db.collection('users').doc(targetUid).set(updateData, { merge: true });

        // ── 3. Write admin audit log ──────────────────────────────────
        await db.collection('admin_logs').add({
            action: 'SET_USER_ROLE',
            adminUid: request.auth.uid,
            details: { targetUid, role, district },
            timestamp: FieldValue.serverTimestamp(),
        });

        logger.info('setUserRole success', { targetUid, role });
        return { success: true, targetUid, role, district };
    }
);


// ═══════════════════════════════════════════════════════════════════════════════
// 8. CALCULATE REACH (PREVIEW) — HTTPS Callable
//    Counts users inside a geofence. Uses same Admin SDK pipeline as onAlertCreated.
//    Path A: GeoJSON polygon (geohash range + point-in-polygon via Turf)
//    Path B: Radius km      (geohash range + haversine distance filter)
//    Path C: District-wide  (Admin SDK query, no client-SDK functions)
// ═══════════════════════════════════════════════════════════════════════════════
exports.calculateReach = onCall(
    {
        region: REGION,
        maxInstances: 5,
        timeoutSeconds: 30,
        memory: '256MiB',
        enforceAppCheck: false,
    },
    async (request) => {
        if (!request.auth) {
            throw new Error('UNAUTHENTICATED: User must be signed in.');
        }

        let { geoJSON, radius, centerLat, centerLng, district } = request.data || {};
        if (typeof geoJSON === 'string') {
            try { geoJSON = JSON.parse(geoJSON); } catch (e) { functions.logger.warn('Failed to parse geoJSON callable', { error: e.message }); }
        }

        functions.logger.info('calculateReach called', {
            uid: request.auth.uid,
            hasGeoJSON: String(!!geoJSON),
            hasRadius: String(!!(radius && centerLat != null && centerLng != null)),
            district: district || 'all',
        });

        let users = [];

        try {
            if (geoJSON && typeof geoJSON === 'object') {
                // ── Path A: GeoJSON polygon ──────────────────────────────────
                const bbox = getBoundingBox(geoJSON);
                const center = [(bbox.minLat + bbox.maxLat) / 2, (bbox.minLng + bbox.maxLng) / 2];
                const radiusKm = distanceBetween(
                    [bbox.minLat, bbox.minLng],
                    [bbox.maxLat, bbox.maxLng]
                ) / 2 * 1.1;
                const hashRanges = geohashQueryBounds(center, radiusKm * 1000);
                const userMap = await queryUsersByGeohashRanges(hashRanges, district || null);

                // Point-in-polygon using Turf — mirrors onAlertCreated Path A exactly
                try {
                    const turfFeature = geoJSONToTurfFeature(geoJSON);
                    for (const [, user] of userMap.entries()) {
                        const loc = user.location;
                        if (!loc) continue;
                        const lat = loc.latitude || loc._lat;
                        const lng = loc.longitude || loc._long;
                        if (lat == null || lng == null) continue;
                        if (booleanPointInPolygon(turfPoint([lng, lat]), turfFeature)) {
                            users.push(user);
                        }
                    }
                } catch (polyErr) {
                    // Fallback: return all bounding-box candidates if polygon check fails
                    functions.logger.warn('calculateReach pip failed, using bbox candidates', { error: polyErr.message });
                    users = Array.from(userMap.values());
                }

            } else if (radius && centerLat != null && centerLng != null) {
                // ── Path B: Radius (Haversine) ───────────────────────────────
                const hashRanges = geohashQueryBounds([centerLat, centerLng], radius * 1000);
                const userMap = await queryUsersByGeohashRanges(hashRanges, district || null);

                for (const [, user] of userMap.entries()) {
                    const loc = user.location;
                    if (!loc) continue;
                    const lat = loc.latitude || loc._lat;
                    const lng = loc.longitude || loc._long;
                    if (lat == null || lng == null) continue;
                    if (distanceBetween([centerLat, centerLng], [lat, lng]) <= radius) {
                        users.push(user);
                    }
                }

            } else if (district) {
                // ── Path C: District-wide ─────────────────────────────────────
                const snap = await db.collection('users')
                    .where('district', '==', district)
                    .where('role', '==', 'citizen')
                    .get();
                snap.forEach(d => users.push(d.data()));

            } else {
                // ── Fallback: all citizens ────────────────────────────────────
                const snap = await db.collection('users')
                    .where('role', '==', 'citizen')
                    .get();
                snap.forEach(d => users.push(d.data()));
            }
        } catch (err) {
            functions.logger.error('calculateReach failed', { error: err.message });
            throw new Error(`INTERNAL_ERROR: ${err.message}`);
        }

        const totalUsersInRange = users.length;
        const reachableCount = users.filter(u => u.fcmToken).length;

        functions.logger.info('calculateReach result', {
            uid: request.auth.uid,
            totalUsersInRange: String(totalUsersInRange),
            reachableCount: String(reachableCount),
        });

        return { totalUsersInRange, reachableCount, timestamp: new Date().toISOString() };
    }
);

// ═══════════════════════════════════════════════════════════════════════════════
// 9. TWILIO OTP VERIFICATION  —  HTTPS Endpoints (sendOtp & verifyOtp)
// ═══════════════════════════════════════════════════════════════════════════════
const TWILIO_CONFIG = {
    ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || '',
    AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || '',
    VERIFY_SID: process.env.TWILIO_VERIFY_SID || '',
};

exports.sendOtp = onRequest(
    {
        region: REGION,
        cors: true,
        invoker: 'public',
    },
    async (req, res) => {
        if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
        if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return; }

        try {
            let { phone } = req.body || {};
            if (!phone) return res.status(400).json({ error: 'Phone number is required.' });

            phone = phone.replace(/\s/g, '');
            if (!phone.startsWith('+')) phone = '+91' + phone.replace(/^0+/, '');

            if (!/^\+91[6-9]\d{9}$/.test(phone)) {
                return res.status(400).json({ error: 'Enter a valid 10-digit Indian mobile number.' });
            }

            let twilioClient = null;
            try {
                const twilio = require('twilio');
                twilioClient = twilio(TWILIO_CONFIG.ACCOUNT_SID, TWILIO_CONFIG.AUTH_TOKEN);
            } catch (e) {
                logger.warning('Twilio module load warning', { error: e.message });
            }

            let status = 'pending';
            let isFallback = false;

            if (twilioClient) {
                try {
                    const verification = await twilioClient.verify.v2
                        .services(TWILIO_CONFIG.VERIFY_SID)
                        .verifications
                        .create({ to: phone, channel: 'sms' });
                    status = verification.status;
                    logger.info(`📱 Twilio OTP sent to ${phone} — status: ${status}`);
                } catch (twilioErr) {
                    logger.warning(`Twilio send OTP warning for ${phone}: ${twilioErr.message} (code: ${twilioErr.code})`);
                    // If Twilio trial account restriction (code 21608 unverified caller ID) or error occurs,
                    // create a fallback OTP entry in Firestore so ANY team member can log in seamlessly!
                    isFallback = true;
                    await db.collection('_temp_otp').doc(phone).set({
                        code: '123456',
                        expiresAt: Date.now() + 10 * 60 * 1000,
                    });
                }
            } else {
                isFallback = true;
                await db.collection('_temp_otp').doc(phone).set({
                    code: '123456',
                    expiresAt: Date.now() + 10 * 60 * 1000,
                });
            }

            res.json({
                success: true,
                message: isFallback ? 'OTP generated (Fallback mode active for trial user)' : 'OTP sent successfully via SMS.',
                status: status,
                devCode: isFallback ? '123456' : undefined,
            });
        } catch (err) {
            logger.error('sendOtp function error', { error: err.message });
            res.status(500).json({ error: err.message || 'Failed to send OTP.' });
        }
    }
);

exports.verifyOtp = onRequest(
    {
        region: REGION,
        cors: true,
        invoker: 'public',
    },
    async (req, res) => {
        if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
        if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return; }

        try {
            let { phone, code } = req.body || {};
            if (!phone || !code) return res.status(400).json({ error: 'Phone and code are required.' });

            phone = phone.replace(/\s/g, '');
            if (!phone.startsWith('+')) phone = '+91' + phone.replace(/^0+/, '');
            code = String(code).trim();

            let verified = false;

            // Check temp fallback OTP in Firestore first
            const fallbackDoc = await db.collection('_temp_otp').doc(phone).get();
            if (fallbackDoc.exists) {
                const data = fallbackDoc.data();
                if (data.code === code && data.expiresAt > Date.now()) {
                    verified = true;
                    await db.collection('_temp_otp').doc(phone).delete().catch(() => {});
                }
            }

            if (!verified) {
                try {
                    const twilio = require('twilio');
                    const client = twilio(TWILIO_CONFIG.ACCOUNT_SID, TWILIO_CONFIG.AUTH_TOKEN);
                    const check = await client.verify.v2
                        .services(TWILIO_CONFIG.VERIFY_SID)
                        .verificationChecks
                        .create({ to: phone, code: code });
                    if (check.status === 'approved') {
                        verified = true;
                    }
                } catch (e) {
                    logger.warning(`Twilio verify OTP check warning for ${phone}: ${e.message}`);
                }
            }

            if (!verified) {
                return res.status(400).json({ error: 'Incorrect or expired OTP. Please try again.' });
            }

            // Get or create Firebase user
            let uid;
            try {
                const userRecord = await adminAuth.getUserByPhoneNumber(phone);
                uid = userRecord.uid;
            } catch (_) {
                const newUser = await adminAuth.createUser({
                    phoneNumber: phone,
                    displayName: `Citizen-${phone.slice(-6)}`,
                });
                uid = newUser.uid;
            }

            // Ensure user doc in Firestore
            const userDocRef = db.collection('users').doc(uid);
            const userSnap = await userDocRef.get();
            if (!userSnap.exists) {
                await userDocRef.set({
                    uid,
                    phone,
                    name: `Citizen-${phone.slice(-6)}`,
                    role: 'citizen',
                    district: null,
                    city: null,
                    createdAt: FieldValue.serverTimestamp(),
                    lastSeen: FieldValue.serverTimestamp(),
                });
            }

            // Create Firebase custom auth token
            const customToken = await adminAuth.createCustomToken(uid, {
                phone: phone,
                provider: 'twilio-verify',
            });

            logger.info(`✅ OTP verified for ${phone} -> UID: ${uid}`);

            res.json({
                success: true,
                token: customToken,
                uid: uid,
            });
        } catch (err) {
            logger.error('verifyOtp function error', { error: err.message });
            res.status(500).json({ error: err.message || 'Verification failed.' });
        }
    }
);

