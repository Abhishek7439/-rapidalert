/**
 * RapidAlert – Client-Side AI Engine  (ai-engine.js)
 * =====================================================
 * Runs entirely in the browser — no Cloud Functions or billing needed.
 * Powers:
 *   1. AI Severity Suggester — analyzes alert message text → suggests severity
 *   2. AI Risk Scorer      — real-time district risk score from Firestore data
 *   3. AI SOS Spike Detector — flags unusual emergency concentration
 *
 * Ported from functions/ai/severitySuggest.js + riskPredictor.js
 */

window.RapidAlertAI = (() => {

    // ── 1. Severity Prediction Engine ──────────────────────────────────────────
    const PATTERNS = [
        // EVACUATE
        { pattern: /\bevacuat[ei]/i, weight: 10, severity: 'Evacuate' },
        { pattern: /\bimmediately\b/i, weight: 4, severity: 'Evacuate' },
        { pattern: /\bleave\s+now\b/i, weight: 8, severity: 'Evacuate' },
        { pattern: /\babandon\b/i, weight: 7, severity: 'Evacuate' },
        { pattern: /\bdo not (stay|remain)\b/i, weight: 6, severity: 'Evacuate' },
        { pattern: /\blife[- ]?threatening\b/i, weight: 8, severity: 'Evacuate' },
        { pattern: /\bdanger\s*zone\b/i, weight: 8, severity: 'Evacuate' },
        { pattern: /\btsunami\b/i, weight: 9, severity: 'Evacuate' },
        { pattern: /\brapidly\s+rising\b/i, weight: 5, severity: 'Evacuate' },
        { pattern: /\bcatastrophic\b/i, weight: 7, severity: 'Evacuate' },
        // EMERGENCY
        { pattern: /\bemergency\b/i, weight: 8, severity: 'Emergency' },
        { pattern: /\bearthquake\b/i, weight: 7, severity: 'Emergency' },
        { pattern: /\bmagnitude\s*[5-9]\b/i, weight: 9, severity: 'Emergency' },
        { pattern: /\bfire\s+spread/i, weight: 7, severity: 'Emergency' },
        { pattern: /\bbuilding\s+collaps/i, weight: 8, severity: 'Emergency' },
        { pattern: /\bcasualt/i, weight: 9, severity: 'Emergency' },
        { pattern: /\binjur(y|ies|ed)\b/i, weight: 6, severity: 'Emergency' },
        { pattern: /\bdisaster\b/i, weight: 5, severity: 'Emergency' },
        { pattern: /\bcritical\b/i, weight: 5, severity: 'Emergency' },
        { pattern: /\bsevere\s+flooding\b/i, weight: 7, severity: 'Emergency' },
        { pattern: /\bcyclone\b/i, weight: 6, severity: 'Emergency' },
        { pattern: /\blandslide\b/i, weight: 6, severity: 'Emergency' },
        { pattern: /\bdam\s+break\b/i, weight: 9, severity: 'Emergency' },
        { pattern: /\bgas\s+leak\b/i, weight: 6, severity: 'Emergency' },
        { pattern: /\bexplosion\b/i, weight: 7, severity: 'Emergency' },
        { pattern: /\bflood/i, weight: 5, severity: 'Emergency' },
        { pattern: /\bfire\b/i, weight: 4, severity: 'Emergency' },
        // WARNING
        { pattern: /\bheavy\s+rain\b/i, weight: 5, severity: 'Warning' },
        { pattern: /\bstorm\s+(watch|warning)\b/i, weight: 6, severity: 'Warning' },
        { pattern: /\bflood\s+(alert|watch)\b/i, weight: 6, severity: 'Warning' },
        { pattern: /\bthunderstorm\b/i, weight: 5, severity: 'Warning' },
        { pattern: /\bwarning\b/i, weight: 4, severity: 'Warning' },
        { pattern: /\bcaution\b/i, weight: 3, severity: 'Warning' },
        { pattern: /\bstay\s+indoors\b/i, weight: 4, severity: 'Warning' },
        { pattern: /\bheat\s+wave\b/i, weight: 5, severity: 'Warning' },
        { pattern: /\bcold\s+wave\b/i, weight: 5, severity: 'Warning' },
        { pattern: /\bmonsoon\b/i, weight: 3, severity: 'Warning' },
        { pattern: /\bsevere\b/i, weight: 3, severity: 'Warning' },
        // INFO
        { pattern: /\bminor\b/i, weight: 4, severity: 'Info' },
        { pattern: /\bno\s+immediate\s+threat\b/i, weight: 6, severity: 'Info' },
        { pattern: /\bresolved\b/i, weight: 5, severity: 'Info' },
        { pattern: /\bprecautionary\b/i, weight: 3, severity: 'Info' },
        { pattern: /\bupdate\b/i, weight: 3, severity: 'Info' },
        { pattern: /\blow\s+risk\b/i, weight: 5, severity: 'Info' },
    ];

    const SEV_ORDER = ['Evacuate', 'Emergency', 'Warning', 'Info'];

    function scoreSeverity(text) {
        if (!text || text.length < 3) return null;
        const norm = text.toLowerCase().trim();
        const scores = { Evacuate: 0, Emergency: 0, Warning: 0, Info: 0 };
        const matched = [];

        for (const { pattern, weight, severity } of PATTERNS) {
            if (pattern.test(norm)) {
                scores[severity] = (scores[severity] || 0) + weight;
                const kw = pattern.source
                    .replace(/\\b|\\s\+?|\(|\)|\?|\\|\/i|\^|\$/g, ' ')
                    .replace(/\s+/g, ' ').trim().split(/[|/]/)[0].slice(0, 20).trim();
                if (kw) matched.push(kw);
            }
        }

        const totalScore = Object.values(scores).reduce((a, b) => a + Math.max(b, 0), 0);
        if (totalScore === 0) return null;

        let suggested = 'Warning', maxScore = -Infinity;
        for (const sev of SEV_ORDER) {
            if (scores[sev] > maxScore) { maxScore = scores[sev]; suggested = sev; }
        }

        const confidence = Math.min(1.0, +(Math.max(maxScore, 0) / totalScore).toFixed(2));
        return {
            suggested,
            confidence,
            matchedKeywords: [...new Set(matched)].filter(Boolean).slice(0, 6),
            scores,
        };
    }

    // ── 2. Real-time Risk Scoring from Firestore ────────────────────────────────
    // Scans last 30 days of alerts + SOS per district → computes risk score 0–100
    async function computeRiskScores(activeAlerts, sosRequests) {
        const districtMap = {};

        const addEvent = (district, type, severity, weight) => {
            if (!district) district = 'Unknown';
            if (!districtMap[district]) {
                districtMap[district] = { alertScore: 0, sosScore: 0, count: 0, types: new Set(), spike: false };
            }
            const d = districtMap[district];
            d.count++;
            d.types.add(type || 'Other');
            d.alertScore += weight;
        };

        const SEV_WEIGHT = { Evacuate: 30, Emergency: 20, Warning: 10, Info: 3 };

        for (const a of activeAlerts) {
            addEvent(a.district || 'Nagpur', a.type, a.severity, SEV_WEIGHT[a.severity] || 5);
        }
        for (const s of sosRequests) {
            const dist = s.district || 'Nagpur';
            if (!districtMap[dist]) districtMap[dist] = { alertScore: 0, sosScore: 0, count: 0, types: new Set(), spike: false };
            districtMap[dist].sosScore += (s.status === 'Pending' ? 15 : 5);
            districtMap[dist].count++;
            if (districtMap[dist].sosScore > 30) districtMap[dist].spike = true;
        }

        // Build results array
        const results = Object.entries(districtMap).map(([district, d]) => {
            const raw = Math.min(100, d.alertScore + d.sosScore);
            const riskLevel = raw >= 60 ? 'High' : raw >= 30 ? 'Medium' : 'Low';
            const trend = d.alertScore > 20 ? 'Rising' : d.sosScore > 15 ? 'Elevated' : 'Stable';
            const confidence = Math.min(0.97, 0.5 + d.count * 0.08);
            return {
                district,
                riskScore: raw,
                riskLevel,
                trend,
                confidence,
                alertCount: d.count,
                predictedType: [...d.types][0] || 'General',
                spikeDetected: d.spike,
            };
        });

        results.sort((a, b) => b.riskScore - a.riskScore);
        return results;
    }

    // ── 3. SOS Spike Detector ──────────────────────────────────────────────────
    function detectSOSSpike(sosRequests) {
        const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
        const SPIKE_THRESHOLD = 3;
        const now = Date.now();

        const districtCounts = {};
        for (const s of sosRequests) {
            const ts = s.time ? new Date(s.time).getTime() : 0;
            if (now - ts < WINDOW_MS) {
                const dist = s.district || 'Unknown';
                districtCounts[dist] = (districtCounts[dist] || 0) + 1;
            }
        }

        const spikes = Object.entries(districtCounts)
            .filter(([, count]) => count >= SPIKE_THRESHOLD)
            .map(([district, count]) => ({ district, count, level: count >= 6 ? 'Critical' : 'High' }));

        return spikes;
    }

    return { scoreSeverity, computeRiskScores, detectSOSSpike };
})();
