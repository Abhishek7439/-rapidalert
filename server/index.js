/**
 * RapidAlert OTP Server (Twilio Verify API)
 * ==========================================
 * Standalone Express server that handles SMS OTP verification via Twilio Verify.
 * No phone number needed — Twilio Verify uses its own shared sender pool.
 *
 * Flow:
 *   1. Client → POST /api/send-otp {phone}   → Twilio Verify sends SMS
 *   2. Client → POST /api/verify-otp {phone, code} → Twilio verifies & server returns Firebase custom token
 *   3. Client → signInWithCustomToken(token)  → User is authenticated in Firebase
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// ── Configuration ────────────────────────────────────────────────────────────
const CONFIG = {
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || '',
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || '',
    TWILIO_VERIFY_SID: process.env.TWILIO_VERIFY_SID || '',
    PORT: process.env.PORT || 3001,
};

// ── Firebase Admin SDK Init ──────────────────────────────────────────────────
if (!admin.apps.length) {
    try {
        const serviceAccount = require('./serviceAccountKey.json');
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            projectId: 'smart-community-8fd9a',
        });
        console.log('✅ Firebase Admin initialized with service account key.');
    } catch (err) {
        admin.initializeApp({ projectId: 'smart-community-8fd9a' });
        console.warn('⚠️  Firebase Admin initialized WITHOUT service account.');
        console.warn('   Download serviceAccountKey.json from Firebase Console → Project Settings → Service Accounts');
    }
}

// ── Twilio Client Init ───────────────────────────────────────────────────────
let twilioClient = null;
try {
    const twilio = require('twilio');
    twilioClient = twilio(CONFIG.TWILIO_ACCOUNT_SID, CONFIG.TWILIO_AUTH_TOKEN);
    console.log('✅ Twilio client initialized (Verify SID:', CONFIG.TWILIO_VERIFY_SID + ')');
} catch (err) {
    console.error('❌ Failed to initialize Twilio:', err.message);
}

// ── Express App ──────────────────────────────────────────────────────────────
const app = express();

app.use(cors({
    origin: true,
    methods: ['POST', 'GET', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
}));

app.use(express.json());

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        twilio: !!twilioClient,
        firebase: admin.apps.length > 0,
        timestamp: new Date().toISOString(),
    });
});

// ── POST /api/send-otp ──────────────────────────────────────────────────────
app.post('/api/send-otp', async (req, res) => {
    try {
        let { phone } = req.body;
        if (!phone) return res.status(400).json({ error: 'Phone number is required.' });

        // Normalize: add +91 if not present
        phone = phone.replace(/\s/g, '');
        if (!phone.startsWith('+')) phone = '+91' + phone.replace(/^0+/, '');

        // Validate Indian number
        if (!/^\+91[6-9]\d{9}$/.test(phone)) {
            return res.status(400).json({ error: 'Enter a valid 10-digit Indian mobile number.' });
        }

        if (!twilioClient) {
            // Fallback mode if Twilio client not initialized
            await admin.firestore().collection('_temp_otp').doc(phone).set({
                code: '123456',
                expiresAt: Date.now() + 10 * 60 * 1000,
            });
            return res.json({
                success: true,
                message: 'OTP generated (Fallback mode active - Twilio offline).',
                status: 'pending',
                devCode: '123456',
            });
        }

        let status = 'pending';
        let isFallback = false;

        try {
            // Send OTP via Twilio Verify API
            const verification = await twilioClient.verify.v2
                .services(CONFIG.TWILIO_VERIFY_SID)
                .verifications
                .create({ to: phone, channel: 'sms' });
            status = verification.status;
            console.log(`📱 OTP sent to ${phone} — Status: ${status}`);
        } catch (twilioErr) {
            console.warn(`⚠️ Twilio send error, enabling fallback: ${twilioErr.message}`);
            isFallback = true;
            await admin.firestore().collection('_temp_otp').doc(phone).set({
                code: '123456',
                expiresAt: Date.now() + 10 * 60 * 1000,
            });
        }

        res.json({
            success: true,
            message: isFallback ? 'OTP generated (Fallback mode active for trial user)' : 'OTP sent successfully.',
            status: status,
            devCode: isFallback ? '123456' : undefined,
        });

    } catch (err) {
        console.error('❌ send-otp error:', err.message);
        res.status(500).json({ error: err.message || 'Failed to send OTP. Please try again.' });
    }
});

// ── POST /api/verify-otp ────────────────────────────────────────────────────
app.post('/api/verify-otp', async (req, res) => {
    try {
        let { phone, code } = req.body;
        if (!phone || !code) return res.status(400).json({ error: 'Phone and code are required.' });

        // Normalize
        phone = phone.replace(/\s/g, '');
        if (!phone.startsWith('+')) phone = '+91' + phone.replace(/^0+/, '');
        code = code.trim();

        let verified = false;

        // Check temp fallback OTP in Firestore first
        const fallbackDoc = await admin.firestore().collection('_temp_otp').doc(phone).get();
        if (fallbackDoc.exists) {
            const data = fallbackDoc.data();
            if (data.code === code && data.expiresAt > Date.now()) {
                verified = true;
                await admin.firestore().collection('_temp_otp').doc(phone).delete().catch(() => {});
            }
        }

        if (!verified && twilioClient) {
            try {
                // Verify OTP via Twilio Verify API
                const verificationCheck = await twilioClient.verify.v2
                    .services(CONFIG.TWILIO_VERIFY_SID)
                    .verificationChecks
                    .create({ to: phone, code: code });

                if (verificationCheck.status === 'approved') {
                    verified = true;
                }
            } catch (err) {
                console.warn(`⚠️ Twilio verification check failed: ${err.message}`);
            }
        }

        if (!verified) {
            return res.status(400).json({
                error: 'Incorrect or expired OTP. Please check and try again.',
            });
        }

        // ✅ OTP Verified — Create or get Firebase user
        let uid;
        try {
            const userRecord = await admin.auth().getUserByPhoneNumber(phone);
            uid = userRecord.uid;
        } catch (_) {
            const newUser = await admin.auth().createUser({
                phoneNumber: phone,
                displayName: `Citizen-${phone.slice(-6)}`,
            });
            uid = newUser.uid;
        }

        // Ensure user doc in Firestore
        const userDocRef = admin.firestore().collection('users').doc(uid);
        const userSnap = await userDocRef.get();
        if (!userSnap.exists) {
            await userDocRef.set({
                uid,
                phone,
                name: `Citizen-${phone.slice(-6)}`,
                role: 'citizen',
                district: null,
                city: null,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                lastSeen: admin.firestore.FieldValue.serverTimestamp(),
            });
        }

        // Generate Firebase custom auth token
        const customToken = await admin.auth().createCustomToken(uid, {
            phone: phone,
            provider: 'twilio-verify',
        });

        console.log(`✅ OTP verified for ${phone} → UID: ${uid}`);

        res.json({
            success: true,
            token: customToken,
            uid: uid,
        });

    } catch (err) {
        console.error('❌ verify-otp error:', err.message);
        res.status(500).json({ error: err.message || 'Verification failed. Please try again.' });
    }
});

// ── Start Server ─────────────────────────────────────────────────────────────
app.listen(CONFIG.PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║   🚨 RapidAlert OTP Server (Twilio Verify)                ║
║   Running on http://localhost:${CONFIG.PORT}                     ║
║                                                           ║
║   Endpoints:                                              ║
║     POST /api/send-otp    → Send SMS verification code    ║
║     POST /api/verify-otp  → Verify code & get auth token  ║
║     GET  /api/health      → Server health check           ║
╚═══════════════════════════════════════════════════════════╝
    `);
});
