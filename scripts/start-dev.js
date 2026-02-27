'use strict';
/**
 * start-dev.js — One-command local development startup
 * =====================================================
 * 1. Starts Firebase Emulators (project: rapidalert-prod)
 * 2. Waits for all emulators to be healthy
 * 3. Seeds admin user with correct claims + Firestore profile
 * 4. Registers fixed test phone numbers (no real SMS needed)
 * 5. Prints LAN IP + credentials for mobile testing
 *
 * Usage:  npm start   (or:  node scripts/start-dev.js)
 */

const { spawn } = require('child_process');
const http = require('http');
const os = require('os');

const PROJECT_ID = 'smart-community-8fd9a';
const ADMIN_EMAIL = 'admin@rapidalert.gov';
const ADMIN_PASS = 'Password123!';
const ADMIN_NAME = 'Admin User';

// ── Fixed test phone numbers — pre-registered with static OTPs ────────────────
// Use these on your demo phones. No real SMS is sent.
const TEST_PHONES = [
    { phoneNumber: '+919999999999', code: '123456' },
    { phoneNumber: '+911234567890', code: '000000' },
    { phoneNumber: '+919876543210', code: '123456' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(icon, msg) { console.log(`${icon}  ${msg}`); }

/** Get LAN IP — skip VMware, loopback, APIPA */
function getLanIP() {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        if (/vmware|virtual|loopback/i.test(name)) continue;
        for (const iface of (nets[name] || [])) {
            if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.')) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

/** Poll an HTTP endpoint until it responds or times out */
function waitForEmulator(url, label, maxWaitMs = 60000) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const check = () => {
            const req = http.get(url, (res) => { res.resume(); log('✅', `${label} is ready`); resolve(); });
            req.on('error', () => {
                if (Date.now() - start > maxWaitMs) return reject(new Error(`${label} timed out`));
                setTimeout(check, 600);
            });
            req.setTimeout(2000, () => req.destroy());
        };
        check();
    });
}

/** PATCH Auth Emulator config to add fixed test phone numbers */
function seedTestPhoneNumbers() {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            signIn: { allowDuplicateEmails: false },
            phoneNumbersForTesting: TEST_PHONES,
        });
        const req = http.request({
            hostname: '127.0.0.1', port: 9099,
            path: `/emulator/v1/projects/${PROJECT_ID}/config`,
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => { res.resume(); resolve(); });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

/** Create admin user, set super_admin claims, write Firestore profile */
async function seedAdmin() {
    process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';

    let admin;
    try { admin = require('firebase-admin'); } catch {
        throw new Error('firebase-admin not installed. Run: npm install firebase-admin');
    }
    if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });

    const auth = admin.auth();
    const db = admin.firestore();

    try {
        const existing = await auth.getUserByEmail(ADMIN_EMAIL);
        await auth.deleteUser(existing.uid);
        log('🗑️', 'Old admin deleted');
    } catch (_) { /* no existing — fine */ }

    const user = await auth.createUser({ email: ADMIN_EMAIL, password: ADMIN_PASS, displayName: ADMIN_NAME });
    log('✅', `Auth user created: ${user.uid}`);

    await auth.setCustomUserClaims(user.uid, { role: 'super_admin', admin: true });
    log('✅', 'Custom claims set: role=super_admin');

    await db.collection('users').doc(user.uid).set({
        uid: user.uid, email: ADMIN_EMAIL, name: ADMIN_NAME, role: 'super_admin',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastSeen: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    log('✅', 'Firestore admin profile written');

    const check = await auth.getUserByEmail(ADMIN_EMAIL);
    if (check.customClaims?.role !== 'super_admin') throw new Error('Claims verification failed!');
    log('✅', `Verified: ${JSON.stringify(check.customClaims)}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    const LAN = getLanIP();

    console.log('\n' + '═'.repeat(60));
    console.log('  🚀  RapidAlert Dev Environment — Starting...');
    console.log('═'.repeat(60) + '\n');

    // 1. Start Firebase Emulators
    log('⏳', 'Starting Firebase Emulators...');
    const emulator = spawn('firebase', ['emulators:start', '--project', PROJECT_ID], {
        cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], shell: true, windowsHide: true,
    });

    emulator.stdout.on('data', (d) => {
        const line = d.toString().trim();
        if (line.includes('All emulators ready') || line.includes('Emulator UI')) console.log(`  ${line}`);
    });
    emulator.stderr.on('data', (d) => {
        const line = d.toString().trim();
        if (line && !line.includes('DeprecationWarning') && !line.includes('punycode')) {
            console.error(`  ⚠️  ${line}`);
        }
    });
    emulator.on('exit', (code) => {
        if (code !== null && code !== 0) { log('❌', `Emulators exited with code ${code}`); process.exit(code); }
    });

    // 2. Wait for health
    try {
        await Promise.all([
            waitForEmulator('http://127.0.0.1:9099/', 'Auth Emulator'),
            waitForEmulator('http://127.0.0.1:8080/', 'Firestore Emulator'),
        ]);
        log('⏳', 'Waiting for Hosting...');
        await new Promise(r => setTimeout(r, 3000));
        log('✅', 'Hosting is ready');
    } catch (err) {
        log('❌', err.message); emulator.kill(); process.exit(1);
    }

    // 3. Seed admin
    log('⏳', 'Seeding admin user...');
    try { await seedAdmin(); }
    catch (err) { log('❌', `Admin seed failed: ${err.message}`); emulator.kill(); process.exit(1); }

    // 4. Register test phone numbers
    log('⏳', 'Registering test phone numbers...');
    try {
        await seedTestPhoneNumbers();
        TEST_PHONES.forEach(p => log('✅', `Test: ${p.phoneNumber}  →  OTP: ${p.code}`));
    } catch (err) {
        log('⚠️', `Test phone registration failed (non-fatal): ${err.message}`);
    }

    // 5. Print summary
    console.log('\n' + '═'.repeat(60));
    console.log('  ✅  READY — Everything is running!');
    console.log('═'.repeat(60));
    console.log(`
  💻  LAPTOP (this machine):
      Admin Panel : http://127.0.0.1:5000/rapidalert/index.html
      Citizen PWA : http://127.0.0.1:5000/rapidalert-citizen/
      Emulator UI : http://127.0.0.1:4000

  📱  PHONE (same WiFi — use this URL in phone browser):
      Citizen PWA : http://${LAN}:5000/rapidalert-citizen/
      Admin Panel : http://${LAN}:5000/rapidalert/index.html

  🔑  Admin Login:
      Email    : ${ADMIN_EMAIL}
      Password : ${ADMIN_PASS}

  📲  Test Phone Login (for mobile demo, no SMS needed):
  ┌─────────────────────────┬──────────┐
  │  Phone Number           │   OTP    │
  ├─────────────────────────┼──────────┤
  │  9999999999             │  123456  │
  │  1234567890             │  000000  │
  │  9876543210             │  123456  │
  └─────────────────────────┴──────────┘

  ⚠️  Phone must be on the SAME WiFi as this laptop!
      Use the http://${LAN}:5000 URL, NOT the Cloudflare tunnel.

  Press Ctrl+C to stop.
`);

    process.on('SIGINT', () => {
        log('🛑', 'Shutting down...');
        emulator.kill('SIGINT');
        setTimeout(() => process.exit(0), 2000);
    });
}

main().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
