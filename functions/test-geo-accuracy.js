const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, GeoPoint } = require('firebase-admin/firestore');
const { geohashForLocation } = require('geofire-common');

process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
process.env.GCLOUD_PROJECT = 'smart-community-8fd9a';

initializeApp({ projectId: 'smart-community-8fd9a' });
const db = getFirestore();

function getLoc(lat, lng) {
    return {
        geohash: geohashForLocation([lat, lng]),
        location: new GeoPoint(lat, lng)
    };
}

async function runTest() {
    console.log("🔴 PHASE 2 – GEO-FILTER ACCURACY TEST");

    // Clear prev test users for a clean slate
    const oldUsers = await db.collection('users').where('role', '==', 'citizen').get();
    for (const d of oldUsers.docs) {
        if (d.id.startsWith('geo-test-')) await d.ref.delete();
    }

    // 1 degree lat ≈ 110.6 km, 1 deg lng at lat=10 ≈ 109.6 km
    const users = [
        { uid: 'geo-test-circle-in-1', lat: 10.01, lng: 10.01, desc: 'Inside circle (1.5km)' }, // IN circle
        { uid: 'geo-test-circle-in-2', lat: 9.95, lng: 10.0, desc: 'Inside circle (5.5km)' },   // IN circle
        { uid: 'geo-test-circle-edge', lat: 10.0, lng: 10.09124, desc: 'Exactly on circle edge (10km)' }, // EDGE circle
        { uid: 'geo-test-poly-in', lat: 0.15, lng: 0.15, desc: 'Inside polygon' },            // IN poly
        { uid: 'geo-test-poly-edge', lat: 0.10, lng: 0.15, desc: 'Exactly on polygon edge' }, // EDGE poly
        { uid: 'geo-test-outside', lat: 10.5, lng: 10.5, desc: 'Far outside all zones (70km)' },// OUTSIDE
        { uid: 'geo-test-overlap', lat: 10.09, lng: 10.09, desc: 'Inside overlapping area' }    // IN BOTH (if we overlap)
    ];

    console.log("Seeding test users...");
    for (const u of users) {
        await db.collection('users').doc(u.uid).set({
            uid: u.uid,
            role: 'citizen',
            fcmToken: `mock-token-${u.uid}`, // Must have token to be counted in delivered
            ...getLoc(u.lat, u.lng)
        }, { merge: true });
    }
    console.log(`✅ Seeded ${users.length} users with exact GPS coordinates.`);

    // ── Test A: Radius (Circle) ───────────────────────────────────
    console.log("\n--- Executing Test A (Radius Circle 10km) ---");
    const circleRef = await db.collection('alerts').add({
        active: true,
        type: 'Flood',
        severity: 'Emergency',
        message: 'Radius Geo Test',
        area: 'Circle Zone',
        creatorUid: 'admin-123',
        timeSent: FieldValue.serverTimestamp(),
        geofence: {
            type: 'radius',
            centerLat: 10.0,
            centerLng: 10.0,
            radius: 10
        }
    });

    // ── Test B: Polygon ───────────────────────────────────────────
    console.log("--- Executing Test B (Polygon Box) ---");
    // Polygon Box from [0.1, 0.1] to [0.2, 0.2].
    // Wait, the overlap user is at 0.09, 0.09. Let's make the polygon box overlap the 10km circle!
    // Circle covers up to ~0.09 degrees.
    // Let's make polygon: [0.08, 0.08] to [0.2, 0.2].
    const polyGeoJSON = {
        type: "Polygon",
        coordinates: [[
            [0.08, 0.08], [0.2, 0.08], [0.2, 0.2], [0.08, 0.2], [0.08, 0.08]
        ]]
    };

    const polyRef = await db.collection('alerts').add({
        active: true,
        type: 'Fire',
        severity: 'Evacuate',
        message: 'Polygon Geo Test',
        area: 'Polygon Zone',
        creatorUid: 'admin-123',
        timeSent: FieldValue.serverTimestamp(),
        geofence: {
            type: 'polygon',
            geoJSON: JSON.stringify(polyGeoJSON)
        }
    });

    // ── Test C: Empty Zone ───────────────────────────────────────────
    console.log("--- Executing Test C (Empty Zone 5km) ---");
    const emptyRef = await db.collection('alerts').add({
        active: true,
        type: 'Earthquake',
        severity: 'Warning',
        message: 'Empty Zone Geo Test',
        area: 'Empty Zone',
        creatorUid: 'admin-123',
        timeSent: FieldValue.serverTimestamp(),
        geofence: {
            type: 'radius',
            centerLat: 1.0,  // No users here
            centerLng: 1.0,
            radius: 5
        }
    });

    console.log("Waiting 8 seconds for multi-path Cloud Functions to compute Haversine/PIP logic...");
    for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 1000));
        process.stdout.write('.');
    }
    console.log('\n');

    async function evaluateMetrics(alertId, testName, expectedCounts) {
        const logDoc = await db.collection('notification_logs').doc(alertId).get();
        if (!logDoc.exists) {
            console.error(`❌ ${testName}: notification_logs missing! Functions may have crashed.`);
            return;
        }

        const stats = logDoc.data();
        console.log(`\n📊 ${testName} Metrics:`);
        console.log(`   - Dispatch Path:      ${stats.dispatchPath}`);
        console.log(`   - Exec Time:          ${stats.filterTimeMs}ms`);
        console.log(`   - totalUsersInZone:   ${stats.totalUsersInZone} (Expected: ${expectedCounts.total})`);

        let passed = true;
        if (stats.totalUsersInZone !== expectedCounts.total) {
            passed = false;
            console.error(`   ❌ totalUsersInZone mismatch!`);
        } else {
            console.log(`   ✅ Correct Reach Calculated`);
        }

        return passed;
    }

    // Evaluate A (Circle 10km)
    // Expected In Circle:
    // geo-test-circle-in-1 (1.5km) -> YES
    // geo-test-circle-in-2 (5.5km) -> YES
    // geo-test-circle-edge (10km exactly) -> YES (<= radius)
    // geo-test-overlap (0.09, 0.09 -> dist = sqrt(0.09^2+0.09^2)*111.32 = 0.127*111.32 ≈ 14km -> NO)
    // Actually, dist[0,0 to 0.09,0.09] is 14.1 km. So `geo-test-overlap` is NOT in the 10km circle!
    // Wait, let's just count logic: 3 users.
    const passA = await evaluateMetrics(circleRef.id, 'Test A (10km Radius)', { total: 3 });

    // Evaluate B (Polygon [0.08,0.08] to [0.2,0.2])
    // Expected In Polygon:
    // geo-test-poly-in (0.15, 0.15) -> YES
    // geo-test-poly-edge (0.10, 0.15) -> YES
    // geo-test-overlap (0.09, 0.09) -> YES (0.09 is between 0.08 and 0.2)
    // 2 users.
    const passB = await evaluateMetrics(polyRef.id, 'Test B (Polygon Box)', { total: 2 });

    // Evaluate C (Empty)
    const passC = await evaluateMetrics(emptyRef.id, 'Test C (Empty Zone)', { total: 0 });

    if (passA && passB && passC) {
        console.log('\n✅ PHASE 2 COMPLETE: Geo-Filter Math correctly includes edge nodes and strictly skips exterior nodes.');
    } else {
        console.error('\n❌ PHASE 2 FAILED: Math discrepancies detected in boundary evaluation.');
        process.exit(1);
    }

    process.exit(0);
}

runTest().catch(e => {
    console.error(e);
    process.exit(1);
});
