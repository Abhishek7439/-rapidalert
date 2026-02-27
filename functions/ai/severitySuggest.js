/**
 * functions/ai/severitySuggest.js – AI Severity Suggestion Engine
 * ================================================================
 * HTTPS Callable function — runs server-side, no LLM/paid API.
 * Uses keyword + pattern scoring to suggest a severity level
 * from free-text alert message input.
 *
 * SCORING PIPELINE:
 *   1. Lowercase + normalize input text
 *   2. Apply tiered keyword patterns per severity level
 *   3. Pattern matches add to severity bucket scores
 *   4. Highest score wins; confidence = winner/total
 *   5. Fallback to "Warning" if no keywords matched
 *
 * Returns: { suggested: string, confidence: number, matchedKeywords: string[] }
 */

'use strict';

// ── Keyword patterns ──────────────────────────────────────────────────────────
// Each entry: { pattern: RegExp, weight: number, severity: string }
// Higher weight = stronger signal for that severity.
const PATTERNS = [

    // ── EVACUATE ────────────────────────────────────────────────
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
    { pattern: /\bescalating\b/i, weight: 4, severity: 'Evacuate' },

    // ── EMERGENCY ───────────────────────────────────────────────
    { pattern: /\bemergency\b/i, weight: 8, severity: 'Emergency' },
    { pattern: /\bearthquake\b/i, weight: 7, severity: 'Emergency' },
    { pattern: /\bmagnitude\s*[5-9]\b/i, weight: 9, severity: 'Emergency' },
    { pattern: /\bmagnitude\s*[1-9]\d/i, weight: 10, severity: 'Emergency' },   // M10+
    { pattern: /\bfire\s+spread/i, weight: 7, severity: 'Emergency' },
    { pattern: /\bbuilding\s+collaps/i, weight: 8, severity: 'Emergency' },
    { pattern: /\bsearch\s+and\s+rescue\b/i, weight: 8, severity: 'Emergency' },
    { pattern: /\bcasualt/i, weight: 9, severity: 'Emergency' },
    { pattern: /\binjur(y|ies|ed)\b/i, weight: 6, severity: 'Emergency' },
    { pattern: /\bdisaster\b/i, weight: 5, severity: 'Emergency' },
    { pattern: /\bcritical\b/i, weight: 5, severity: 'Emergency' },
    { pattern: /\bsevere\s+flooding\b/i, weight: 7, severity: 'Emergency' },
    { pattern: /\bcyclone\b/i, weight: 6, severity: 'Emergency' },
    { pattern: /\bhurricane\b/i, weight: 6, severity: 'Emergency' },
    { pattern: /\btyphoon\b/i, weight: 6, severity: 'Emergency' },
    { pattern: /\blandslide\b/i, weight: 6, severity: 'Emergency' },
    { pattern: /\bdam\s+break\b/i, weight: 9, severity: 'Emergency' },
    { pattern: /\bgas\s+leak\b/i, weight: 6, severity: 'Emergency' },
    { pattern: /\bchemical\b/i, weight: 5, severity: 'Emergency' },
    { pattern: /\bexplosion\b/i, weight: 7, severity: 'Emergency' },
    { pattern: /\bstructural\s+damage\b/i, weight: 6, severity: 'Emergency' },

    // ── WARNING ─────────────────────────────────────────────────
    { pattern: /\bheavy\s+rain\b/i, weight: 5, severity: 'Warning' },
    { pattern: /\bhigh\s+tide\b/i, weight: 5, severity: 'Warning' },
    { pattern: /\bstorm\s+watch\b/i, weight: 6, severity: 'Warning' },
    { pattern: /\bstorm\s+warning\b/i, weight: 7, severity: 'Warning' },
    { pattern: /\bflood\s+(alert|watch)\b/i, weight: 6, severity: 'Warning' },
    { pattern: /\bwind\s+gusts?\b/i, weight: 4, severity: 'Warning' },
    { pattern: /\bthunderstorm\b/i, weight: 5, severity: 'Warning' },
    { pattern: /\bhailstorm\b/i, weight: 4, severity: 'Warning' },
    { pattern: /\bmonsoon\b/i, weight: 3, severity: 'Warning' },
    { pattern: /\bwarning\b/i, weight: 4, severity: 'Warning' },
    { pattern: /\bcaution\b/i, weight: 3, severity: 'Warning' },
    { pattern: /\bstay\s+indoors\b/i, weight: 4, severity: 'Warning' },
    { pattern: /\bavoid\s+(travel|roads)\b/i, weight: 5, severity: 'Warning' },
    { pattern: /\belevated\s+risk\b/i, weight: 4, severity: 'Warning' },
    { pattern: /\bheat\s+wave\b/i, weight: 5, severity: 'Warning' },
    { pattern: /\bextreme\s+heat\b/i, weight: 6, severity: 'Warning' },
    { pattern: /\bcold\s+wave\b/i, weight: 5, severity: 'Warning' },
    { pattern: /\bsmog\b/i, weight: 3, severity: 'Warning' },
    { pattern: /\bair\s+(quality|pollution)\b/i, weight: 3, severity: 'Warning' },
    { pattern: /\bforest\s+fire\s+(watch|risk)\b/i, weight: 5, severity: 'Warning' },
    { pattern: /\blocalized\b/i, weight: -2, severity: 'Emergency' }, // downscale

    // ── INFO ─────────────────────────────────────────────────────
    { pattern: /\bupdate\b/i, weight: 3, severity: 'Info' },
    { pattern: /\bminor\b/i, weight: 4, severity: 'Info' },
    { pattern: /\bno\s+immediate\s+threat\b/i, weight: 6, severity: 'Info' },
    { pattern: /\bresolved\b/i, weight: 5, severity: 'Info' },
    { pattern: /\bsituation\s+(improving|normal)\b/i, weight: 5, severity: 'Info' },
    { pattern: /\bprecautionary\b/i, weight: 3, severity: 'Info' },
    { pattern: /\bdrizzle\b/i, weight: 4, severity: 'Info' },
    { pattern: /\blocalized\s+flooding\b/i, weight: 2, severity: 'Info' },
    { pattern: /\blow\s+risk\b/i, weight: 5, severity: 'Info' },
];

const SEVERITY_ORDER = ['Evacuate', 'Emergency', 'Warning', 'Info'];

/**
 * Score a message text and return severity suggestion.
 * @param {string} text
 * @returns {{ suggested: string, confidence: number, matchedKeywords: string[], scores: object }}
 */
function scoreSeverity(text) {
    if (!text || typeof text !== 'string') {
        return { suggested: 'Warning', confidence: 0, matchedKeywords: [], scores: {} };
    }

    const normalized = text.toLowerCase().trim();
    const scores = { Evacuate: 0, Emergency: 0, Warning: 0, Info: 0 };
    const matched = [];

    for (const { pattern, weight, severity } of PATTERNS) {
        if (pattern.test(normalized)) {
            scores[severity] = (scores[severity] || 0) + weight;
            // Collect readable keyword (first word of pattern source)
            const kw = pattern.source.replace(/\\b|\\s\+|\\|\/i|\^|\$|\(|\)|\?|i$/g, '')
                .replace(/\s+/g, ' ').trim().split(/[\|\/]/)[0].slice(0, 20);
            if (kw) matched.push(kw);
        }
    }

    const totalScore = Object.values(scores).reduce((a, b) => a + Math.max(b, 0), 0);

    // Winner = highest scoring severity (priority ordered on tie)
    let suggested = 'Warning';  // safe default
    let maxScore = -Infinity;

    for (const sev of SEVERITY_ORDER) {
        if (scores[sev] > maxScore) {
            maxScore = scores[sev];
            suggested = sev;
        }
    }

    // Confidence = winner score / total score (0 when no keywords matched)
    const confidence = totalScore > 0
        ? Math.min(1.0, parseFloat((Math.max(maxScore, 0) / totalScore).toFixed(2)))
        : 0;

    return {
        suggested,
        confidence,
        matchedKeywords: [...new Set(matched)].slice(0, 8),
        scores,
    };
}

module.exports = { scoreSeverity, PATTERNS };
