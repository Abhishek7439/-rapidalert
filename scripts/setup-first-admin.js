/**
 * scripts/setup-first-admin.js
 * ============================
 * One-time script to bootstrap your first super_admin user.
 *
 * USAGE (run from D:\Antigravity Workspace):
 *   node scripts/setup-first-admin.js --email admin@yourdomain.com --password "YourSecurePass123!" --name "Your Name"
 *
 * PREREQUISITES:
 *   1. Firebase project set up with Email/Password Auth enabled
 *   2. A service account key file downloaded from:
 *      Firebase Console → Project Settings → Service Accounts → Generate new private key
 *      Save as: D:\Antigravity Workspace\service-account-key.json
 *   3. Node.js installed: https://nodejs.org (LTS v20)
 *   4. Run: npm install firebase-admin in D:\Antigravity Workspace
 *
 * WHAT IT DOES:
 *   1. Creates a Firebase Auth user (email + password)
 *   2. Sets custom claim: { role: 'super_admin' }
 *   3. Writes users/{uid} document to Firestore
 *   4. Prints the UID and login credentials
 */

'use strict';

const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// ── Parse CLI args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

const email = get('--email');
const password = get('--password');
const name = get('--name') || 'Super Admin';
const district = get('--district') || null;

if (!email || !password) {
    console.error('Usage: node scripts/setup-first-admin.js --email <email> --password <pass> [--name <name>] [--district <district>]');
    process.exit(1);
}

// ── Init Firebase Admin ───────────────────────────────────────────────────────
const keyPath = path.join(__dirname, '..', 'service-account-key.json');
if (!fs.existsSync(keyPath)) {
    console.error(`\n❌ Service account key not found at:\n   ${keyPath}\n\nDownload from Firebase Console → Project Settings → Service Accounts → Generate new private key\n`);
    process.exit(1);
}

const serviceAccount = require(keyPath);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const auth = admin.auth();
const db = admin.firestore();

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log(`\n🚀 RapidAlert First Admin Setup`);
    console.log(`   Creating super_admin: ${email}\n`);

    let uid;

    // 1. Create Auth user (or get existing)
    try {
        const userRecord = await auth.createUser({ email, password, displayName: name });
        uid = userRecord.uid;
        console.log(`✅ Firebase Auth user created: ${uid}`);
    } catch (err) {
        if (err.code === 'auth/email-already-exists') {
            const existing = await auth.getUserByEmail(email);
            uid = existing.uid;
            console.log(`ℹ️  User already exists: ${uid} — updating role.`);
        } else {
            console.error('❌ Auth creation failed:', err.message);
            process.exit(1);
        }
    }

    // 2. Set custom claim
    const claim = { role: 'super_admin' };
    if (district) claim.district = district;
    await auth.setCustomUserClaims(uid, claim);
    console.log(`✅ Custom claim set: role=super_admin${district ? ` district=${district}` : ''}`);

    // 3. Write Firestore profile
    await db.collection('users').doc(uid).set({
        uid,
        email,
        name,
        role: 'super_admin',
        district: district || null,
        fcmToken: null,
        location: null,
        geohash: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastSeen: admin.firestore.FieldValue.serverTimestamp(),
        roleUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        roleUpdatedBy: 'setup-script',
    }, { merge: true });
    console.log(`✅ Firestore users/${uid} document written`);

    // 4. Write setup audit log
    await db.collection('admin_logs').add({
        action: 'FIRST_ADMIN_SETUP',
        adminUid: uid,
        details: { email, name, role: 'super_admin', district },
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`✅ Admin log written`);

    console.log(`
╔══════════════════════════════════════════════════════════╗
║          ✅  Super Admin Created Successfully            ║
╠══════════════════════════════════════════════════════════╣
║  UID:      ${uid.padEnd(44)} ║
║  Email:    ${email.padEnd(44)} ║
║  Role:     super_admin                                   ║
║  District: ${(district || 'all (global)').padEnd(44)} ║
╠══════════════════════════════════════════════════════════╣
║  Next Steps:                                             ║
║  1. Open:  D:\\Antigravity Workspace\\rapidalert\\index.html ║
║  2. Log in with ${email}                   ║
║  3. Use setUserRole callable to assign district_officer  ║
╚══════════════════════════════════════════════════════════╝
`);

    process.exit(0);
}

main().catch(err => {
    console.error('❌ Setup failed:', err.message);
    process.exit(1);
});
