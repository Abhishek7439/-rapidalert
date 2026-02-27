'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';

const admin = require('firebase-admin');

admin.initializeApp({
    projectId: 'rapidalert-prod',
});

const db = admin.firestore();

async function seed() {
    const users = [
        {
            uid: 'test-citizen-1',
            email: 'citizen1@test.com',
            name: 'John Doe',
            role: 'citizen',
            district: 'Delhi',
            fcmToken: 'mock-token-1',
            location: new admin.firestore.GeoPoint(28.6139, 77.2090), // New Delhi
            geohash: 'ttnfv2u',
        },
        {
            uid: 'test-citizen-2',
            email: 'citizen2@test.com',
            name: 'Jane Smith',
            role: 'citizen',
            district: 'Delhi',
            fcmToken: 'mock-token-2',
            location: new admin.firestore.GeoPoint(28.6140, 77.2100), // Nearby
            geohash: 'ttnfv2v',
        },
        {
            uid: 'test-citizen-3',
            email: 'citizen3@test.com',
            name: 'Away User',
            role: 'citizen',
            district: 'Mumbai',
            fcmToken: 'mock-token-3',
            location: new admin.firestore.GeoPoint(19.0760, 72.8777), // Mumbai
            geohash: 'te7ufq',
        }
    ];

    for (const u of users) {
        await db.collection('users').doc(u.uid).set(u);
        console.log('Seeded user:', u.uid);
    }
    console.log('Done seeding.');
    process.exit(0);
}

seed();
