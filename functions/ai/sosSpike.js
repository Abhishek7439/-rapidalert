/**
 * functions/ai/sosSpike.js – SOS Spike Detection
 * ================================================
 * Integrated into onSOSCreated. Detects abnormal bursts of SOS
 * requests in a district within a rolling 5-minute window.
 *
 * Algorithm:
 *   1. Query sos_requests WHERE district == sosData.district AND time >= now-5min
 *   2. If count >= threshold (10):
 *      a. Write admin_logs entry (action: SOS_SPIKE_DETECTED)
 *      b. Notify super_admin via FCM
 *      c. Update sos_requests/{sosId} with spikeDetected: true
 *      d. Write ai_predictions/{districtSlug} spike marker
 *
 * ESCALATION LEVELS:
 *   ≥ 10 SOSes in 5 min → Spike (CRITICAL)
 *   ≥ 20 SOSes in 5 min → Mass casualty event (EMERGENCY_MASS)
 */

'use strict';

const SOS_SPIKE_THRESHOLD = 10;
const SOS_MASS_CASUALTY_THRESHOLD = 20;
const WINDOW_MINUTES = 5;

/**
 * @param {object} params
 * @param {string} params.sosId
 * @param {object} params.sosData
 * @param {FirebaseFirestore.DocumentReference} params.sosRef
 * @param {FirebaseFirestore.Firestore} params.db
 * @param {FirebaseAdminMessaging.Messaging} params.messaging
 * @param {FirebaseFirestore.FieldValue} params.FieldValue
 * @param {function} params.logger
 * @param {function} params.sendMulticast
 */
async function checkSOSSpike({
    sosId, sosData, sosRef, db, messaging, FieldValue, logger, sendMulticast,
}) {
    const now = FieldValue.serverTimestamp();
    const windowStart = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000);
    const district = sosData.district || null;

    // ── Query recent SOS in same window ──────────────────────────
    let recentQuery = db.collection('sos_requests').where('time', '>=', windowStart);
    if (district) {
        recentQuery = db.collection('sos_requests')
            .where('district', '==', district)
            .where('time', '>=', windowStart);
    }

    let recentCount = 0;
    let isMassCasualty = false;

    try {
        const snap = await recentQuery.get();
        recentCount = snap.size;
        isMassCasualty = recentCount >= SOS_MASS_CASUALTY_THRESHOLD;

        logger.debug(`SOS spike check: ${recentCount} SOS in last ${WINDOW_MINUTES}min for district ${district || 'all'}`, {});

        if (recentCount < SOS_SPIKE_THRESHOLD) return;   // No spike — exit early
    } catch (err) {
        logger.warning('SOS spike query failed (non-fatal)', { sosId, error: err.message });
        return;
    }

    // ── Spike detected ───────────────────────────────────────────
    const escalation = isMassCasualty ? 'MASS_CASUALTY' : 'SPIKE';
    logger.critical(`SOS ${escalation} DETECTED`, {
        district: district || 'unknown',
        count: String(recentCount),
        threshold: String(SOS_SPIKE_THRESHOLD),
    });

    // ── a) Write admin_log ────────────────────────────────────────
    try {
        await db.collection('admin_logs').add({
            action: `SOS_${escalation}_DETECTED`,
            severity: isMassCasualty ? 'CRITICAL' : 'WARNING',
            details: {
                sosId,
                district: district || 'unknown',
                count: recentCount,
                threshold: SOS_SPIKE_THRESHOLD,
                windowMins: WINDOW_MINUTES,
                isMassCasualty,
            },
            timestamp: now,
        });
    } catch (err) {
        logger.warning('SOS spike admin_log write failed', { sosId, error: err.message });
    }

    // ── b) Update sos_requests document with spike flag ───────────
    try {
        await sosRef.update({
            spikeDetected: true,
            spikeCount: recentCount,
            spikeWindow: WINDOW_MINUTES,
            spikeEscalation: escalation,
            spikeDetectedAt: now,
        });
    } catch (err) {
        logger.warning('SOS spike flag write failed', { sosId, error: err.message });
    }

    // ── c) Write ai_predictions spike marker ──────────────────────
    if (district) {
        const docId = district.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 60);
        try {
            await db.collection('ai_predictions').doc(docId).set({
                district,
                spikeDetected: true,
                spikeCount: recentCount,
                spikeAt: now,
                isMassCasualty,
                escalation,
            }, { merge: true });
        } catch (err) {
            logger.warning('SOS spike ai_predictions write failed', { district, error: err.message });
        }
    }

    // ── d) Notify super_admins via FCM ────────────────────────────
    try {
        const superAdminSnap = await db.collection('users')
            .where('role', '==', 'super_admin')
            .where('fcmToken', '!=', null)
            .get();

        const tokens = [];
        const tokenToUidMap = new Map();

        superAdminSnap.docs.forEach(d => {
            const t = d.data().fcmToken;
            if (t) { tokens.push(t); tokenToUidMap.set(t, d.id); }
        });

        if (tokens.length === 0) {
            logger.warning('SOS spike: no super_admin FCM tokens found', {});
            return;
        }

        const title = isMassCasualty
            ? `🚨 MASS CASUALTY — ${recentCount} SOS in ${WINDOW_MINUTES}min`
            : `⚠️ SOS SPIKE — ${recentCount} SOS in ${WINDOW_MINUTES}min`;

        const body = district
            ? `District: ${district}. Immediate response required.`
            : `Multiple districts affected. Immediate response required.`;

        const spikeFCMPayload = {
            notification: { title, body },
            data: {
                type: 'SOS_SPIKE',
                district: district || '',
                count: String(recentCount),
                escalation,
                isMassCasualty: String(isMassCasualty),
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
                    requireInteraction: true,
                    tag: `sos-spike-${district || 'global'}-${Date.now()}`,
                    icon: '/rapidalert/icons/icon-192.png',
                    badge: '/rapidalert/icons/icon-72.png',
                    actions: [
                        { action: 'respond', title: '🆘 View SOS Requests' },
                    ],
                },
                fcmOptions: { link: '/rapidalert/index.html?sos=1' },
            },
        };

        const result = await sendMulticast(tokens, tokenToUidMap, spikeFCMPayload);
        logger.info('SOS spike FCM sent to super_admins', {
            sent: String(tokens.length),
            success: String(result.totalSuccess),
        });
    } catch (err) {
        logger.error('SOS spike FCM notify failed', { sosId, error: err.message });
    }

    return { escalation, recentCount, isMassCasualty };
}

module.exports = { checkSOSSpike, SOS_SPIKE_THRESHOLD, SOS_MASS_CASUALTY_THRESHOLD, WINDOW_MINUTES };
