'use strict';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';

const admin = require('firebase-admin');

admin.initializeApp({
    projectId: 'demo-rapidalert',
});

async function check() {
    const email = 'admin@rapidalert.gov';
    try {
        const user = await admin.auth().getUserByEmail(email);
        console.log('User found:', user.uid);
        console.log('Custom claims:', JSON.stringify(user.customClaims));

        const doc = await admin.firestore().collection('users').doc(user.uid).get();
        if (doc.exists) {
            console.log('Firestore data:', JSON.stringify(doc.data()));
        } else {
            console.log('Firestore doc NOT found for UID:', user.uid);
        }
    } catch (err) {
        console.error('Error:', err.message);
    }
    process.exit(0);
}

check();
