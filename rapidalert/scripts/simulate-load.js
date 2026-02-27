'use strict';

/**
 * RapidAlert – simulate-load.js
 * Stress tests the system by creating concurrent SOS requests.
 * Triggers the AI Spike detection logic (threshold: 10 SOS in 5 min).
 */

process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';

const admin = require('firebase-admin');

if (!admin.apps.length) {
    admin.initializeApp({
        projectId: 'rapidalert-prod'
    });
}

const db = admin.firestore();

async function simulateSOSLoad(count = 12, district = 'Downtown') {
    console.log(`\n🚀 STRESS TEST: Simulating ${count} SOS requests in ${district}...`);

    const startTime = Date.now();
    const promises = [];

    for (let i = 1; i <= count; i++) {
        const sosId = `sim-sos-${Date.now()}-${i}`;
        const p = db.collection('sos_requests').doc(sosId).set({
            citizenUid: `sim-user-${i}`,
            name: `Simulated Citizen ${i}`,
            phone: `+123456780${i}`,
            message: `SIMULATED LOAD TEST: Rapid SOS burst ${i}`,
            area: `${district} Sector ${Math.floor(Math.random() * 10) + 1}`,
            district: district,
            location: new admin.firestore.GeoPoint(19.0760 + (Math.random() - 0.5) * 0.01, 72.8777 + (Math.random() - 0.5) * 0.01),
            status: 'Pending',
            time: admin.firestore.FieldValue.serverTimestamp(),
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            isSimulated: true
        });
        promises.push(p);
    }

    try {
        await Promise.all(promises);
        const duration = Date.now() - startTime;
        console.log(`✅ SUCCESS: ${count} SOS requests injected in ${duration}ms`);
        console.log(`🚨 Spike detection threshold (10) exceeded. Check Dashboard for AI Spike Alert.`);
    } catch (err) {
        console.error('❌ FAILED:', err.message);
    }
}

// Run Simulation
simulateSOSLoad(12, 'Downtown').then(() => {
    console.log('\nSimulation complete. Waiting 2s for Cloud Functions to trigger...');
    setTimeout(() => process.exit(0), 2000);
}).catch(err => {
    console.error(err);
    process.exit(1);
});
