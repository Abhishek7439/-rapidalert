const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// Initialize admin against local emulator project
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
process.env.GCLOUD_PROJECT = 'rapidalert';

initializeApp({ projectId: 'rapidalert' });
const db = getFirestore();

async function runTest() {
    console.log('Testing calculateReach logic against emulator...');

    // Target: Wainganga College of Engineering & Management, Nagpur
    const centerLat = 20.9903;
    const centerLng = 79.0240;
    const radiusKm = 5; // 5km radius

    // Logic from index.js
    const geofire = require('geofire-common');
    const hashRanges = geofire.geohashQueryBounds([centerLat, centerLng], radiusKm * 1000);
    console.log(`Geohash ranges generated: ${hashRanges.length}`);

    let users = [];
    const promises = hashRanges.map(b => {
        return db.collection('users')
            .where('geohash', '>=', b[0])
            .where('geohash', '<=', b[1])
            .get()
            .then(snap => {
                // Filter role client-side since we can't do multiple inequality fields easily
                return snap.docs.filter(d => d.data().role === 'citizen');
            });
    });

    const snaps = await Promise.all(promises);
    const userMap = new Map();
    snaps.forEach(docs => docs.forEach(doc => userMap.set(doc.id, doc.data())));
    console.log(`Users matching bounding box: ${userMap.size}`);

    for (const [, user] of userMap.entries()) {
        const loc = user.location;
        if (!loc) continue;
        const lat = loc.latitude || loc._lat;
        const lng = loc.longitude || loc._long;
        if (lat == null || lng == null) continue;

        const dist = geofire.distanceBetween([centerLat, centerLng], [lat, lng]);
        if (dist <= radiusKm) {
            users.push(user);
        }
    }

    const reachableCount = users.filter(u => u.fcmToken).length;
    console.log('--- REACH CALCULATION RESULTS ---');
    console.log(`Total users in ${radiusKm}km radius: ${users.length}`);
    console.log(`Reachable via Push/SMS: ${reachableCount}`);
    console.log('---------------------------------');
}

runTest().catch(console.error);
