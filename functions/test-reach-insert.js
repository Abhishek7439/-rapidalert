const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const geofire = require('geofire-common');

process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
process.env.GCLOUD_PROJECT = 'rapidalert';

initializeApp({ projectId: 'rapidalert' });
const db = getFirestore();

async function runTest() {
    const centerLat = 20.9903;
    const centerLng = 79.0240;

    await db.collection('users').add({
        role: 'citizen',
        location: {
            latitude: centerLat,
            longitude: centerLng
        },
        geohash: geofire.geohashForLocation([centerLat, centerLng]),
        fcmToken: 'test-token',
        district: 'Nagpur',
        name: 'WCEM Test User'
    });
    console.log('Test user inserted at WCEM Nagpur.');

    console.log('Testing calculateReach logic...');
    const radiusKm = 5;
    const hashRanges = geofire.geohashQueryBounds([centerLat, centerLng], radiusKm * 1000);

    const promises = hashRanges.map(b => {
        return db.collection('users')
            .where('geohash', '>=', b[0])
            .where('geohash', '<=', b[1])
            .get()
            .then(snap => snap.docs.filter(d => d.data().role === 'citizen'));
    });

    const snaps = await Promise.all(promises);
    const userMap = new Map();
    snaps.forEach(docs => docs.forEach(doc => userMap.set(doc.id, doc.data())));

    let users = [];
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
