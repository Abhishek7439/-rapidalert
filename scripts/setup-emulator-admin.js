'use strict';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';

const admin = require('firebase-admin');

const email = 'admin@rapidalert.gov';
const password = 'Password123!';
const name = 'Admin User';

admin.initializeApp({
    projectId: 'rapidalert-prod',
});

const auth = admin.auth();
const db = admin.firestore();

async function main() {
    console.log(`\n🚀 RapidAlert Emulator Admin RESET`);

    // 1. Delete existing user if any
    try {
        const existing = await auth.getUserByEmail(email);
        await auth.deleteUser(existing.uid);
        console.log(`🗑️ Existing user deleted: ${existing.uid}`);
    } catch (e) {
        console.log(`ℹ️ No existing user to delete.`);
    }

    // 2. Create fresh user
    const userRecord = await auth.createUser({ email, password, displayName: name });
    const uid = userRecord.uid;
    console.log(`✅ Auth user created: ${uid}`);

    // 3. Set custom claims (both role and admin: true just in case)
    await auth.setCustomUserClaims(uid, { role: 'super_admin', admin: true });
    console.log(`✅ Custom claims set: role=super_admin, admin=true`);

    // 4. Write Firestore profile
    await db.collection('users').doc(uid).set({
        uid,
        email,
        name,
        role: 'super_admin',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastSeen: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    console.log(`✅ Firestore record written`);

    console.log(`\nDONE. UID is ${uid}`);
    process.exit(0);
}

main().catch(err => {
    console.error('❌ Failed:', err);
    process.exit(1);
});
