/**
 * functions/ai/riskPredictor.js – District Risk Prediction Engine
 * ================================================================
 * Scheduled every 6 hours via Cloud Scheduler (exported in index.js).
 * No external AI API — purely statistical analysis of Firestore data.
 *
 * Algorithm:
 *   1. For each district, fetch last 30 days of alerts
 *   2. Compute frequencyScore = alertCount / 30
 *   3. weightedScore = sum(severityWeight[sev]) / alertCount (avg severity)
 *   4. riskScore = normalize(frequencyScore * weightedScore) → 0–100
 *   5. predictedType = most frequent high-severity alert type
 *   6. confidence = min(1.0, alertCount / 20)  (needs 20 alerts for full confidence)
 *   7. Write to ai_predictions/{district}
 *
 * Firestore write: ai_predictions/{districtSlug}
 */

'use strict';

const SEV_WEIGHT = { Info: 1, Warning: 2, Emergency: 4, Evacuate: 5 };
const LOOKBACK_DAYS = 30;
const MAX_RISK_NORMALIZER = 10; // frequencyScore * avgWeight capped at this = score 100

/**
 * Compute risk metrics for a district from its last-30-day alerts.
 * @param {string} district
 * @param {FirebaseFirestore.QueryDocumentSnapshot[]} docs
 * @returns {object} prediction record
 */
function computeDistrictRisk(district, docs) {
    const alertCount = docs.length;

    if (alertCount === 0) {
        return {
            district,
            riskScore: 0,
            riskLevel: 'Low',
            frequencyScore: 0,
            avgSeverityWeight: 0,
            predictedType: null,
            topTypes: [],
            confidence: 0,
            alertCount: 0,
            computedAt: new Date(),
        };
    }

    // Frequency: alerts per day over 30 days
    const frequencyScore = alertCount / LOOKBACK_DAYS;

    // Average severity weight across all alerts
    let totalWeight = 0;
    const typeCounts = {};

    for (const doc of docs) {
        const { severity, type } = doc.data();
        const weight = SEV_WEIGHT[severity] || 1;
        totalWeight += weight;

        // Count by type, weighted by severity (Emergency/Evacuate matter more)
        if (!typeCounts[type]) typeCounts[type] = 0;
        typeCounts[type] += weight;
    }

    const avgSeverityWeight = totalWeight / alertCount;

    // Raw score = frequencyPerDay * avgWeight
    const rawScore = frequencyScore * avgSeverityWeight;

    // Normalize to 0–100. Raw score of MAX_RISK_NORMALIZER = 100
    const riskScore = Math.min(100, Math.round((rawScore / MAX_RISK_NORMALIZER) * 100));

    // Risk level classification
    const riskLevel = riskScore >= 60 ? 'High'
        : riskScore >= 30 ? 'Medium'
            : 'Low';

    // Predicted type = highest weighted type
    const sortedTypes = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
    const predictedType = sortedTypes[0]?.[0] || null;
    const topTypes = sortedTypes.slice(0, 3).map(([t]) => t);

    // Confidence: needs ≥20 alerts for full confidence (1.0)
    const confidence = Math.min(1.0, parseFloat((alertCount / 20).toFixed(2)));

    // Trend: compare last 15 days vs previous 15 days
    const midpoint = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    const recentDocs = docs.filter(d => (d.data().timeSent?.toDate?.() || new Date(0)) >= midpoint);
    const olderDocs = docs.filter(d => (d.data().timeSent?.toDate?.() || new Date(0)) < midpoint);
    const trend = recentDocs.length > olderDocs.length ? 'Rising'
        : recentDocs.length < olderDocs.length ? 'Falling'
            : 'Stable';

    return {
        district,
        riskScore,
        riskLevel,
        trend,
        frequencyScore: parseFloat(frequencyScore.toFixed(3)),
        avgSeverityWeight: parseFloat(avgSeverityWeight.toFixed(2)),
        predictedType,
        topTypes,
        confidence,
        alertCount,
        recentCount: recentDocs.length,
        olderCount: olderDocs.length,
        computedAt: new Date(),
    };
}


/**
 * Main scheduler handler — called every 6 hours from index.js.
 * @param {FirebaseFirestore.Firestore} db
 * @param {function} logger
 */
async function runRiskPredictor(db, logger) {
    const tStart = Date.now();
    logger.info('RiskPredictor: starting 6-hour prediction cycle');

    const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

    // Fetch all alerts from the last 30 days (up to 5,000 docs)
    let alertSnap;
    try {
        alertSnap = await db.collection('alerts')
            .where('timeSent', '>=', cutoff)
            .select('type', 'severity', 'district', 'timeSent', 'isDrill')
            .get();
    } catch (err) {
        logger.error('RiskPredictor: failed to fetch alerts', { error: err.message });
        return;
    }

    // Group alerts by district
    const byDistrict = {};
    for (const doc of alertSnap.docs) {
        const { district, isDrill } = doc.data();
        // Skip drills from risk calculation
        if (isDrill) continue;
        const key = district || '__unknown__';
        if (!byDistrict[key]) byDistrict[key] = [];
        byDistrict[key].push(doc);
    }

    const districts = Object.keys(byDistrict);
    logger.info(`RiskPredictor: ${alertSnap.size} alerts across ${districts.length} districts`, {});

    // Compute + write predictions in parallel (batch up to 10 at a time)
    const PARALLEL_BATCH = 10;
    let successCount = 0;
    let failureCount = 0;

    for (let i = 0; i < districts.length; i += PARALLEL_BATCH) {
        const batch = districts.slice(i, i + PARALLEL_BATCH);
        await Promise.all(batch.map(async (district) => {
            const docs = byDistrict[district];
            const prediction = computeDistrictRisk(district, docs);

            const docId = district.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 60);

            try {
                await db.collection('ai_predictions').doc(docId).set(prediction, { merge: true });
                successCount++;
                logger.debug(`RiskPredictor: ${district} → riskScore=${prediction.riskScore} (${prediction.riskLevel})`, {});
            } catch (err) {
                failureCount++;
                logger.error(`RiskPredictor: write failed for district ${district}`, { error: err.message });
            }
        }));
    }

    const elapsed = Date.now() - tStart;
    logger.info('RiskPredictor: cycle complete', {
        districts: String(districts.length),
        success: String(successCount),
        failures: String(failureCount),
        elapsedMs: String(elapsed),
    });

    return { districts: districts.length, successCount, failureCount, elapsedMs: elapsed };
}

module.exports = { runRiskPredictor, computeDistrictRisk };
