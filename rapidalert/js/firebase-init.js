/**
 * firebase-init.js – Admin Panel  (ES Module)
 * ============================================
 * Loaded as <script type="module"> — executes after DOM is parsed.
 * Initializes the Firebase Modular SDK (v10+) and exposes window.FB
 * so that subsequent module scripts can use Firebase services without
 * re-importing or re-initializing.
 *
 * SETUP: Fill in firebase-env.js with your Firebase Console values first.
 */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.1/firebase-app.js';
import {
    getAuth,
    connectAuthEmulator,
    setPersistence,
    browserLocalPersistence,
} from 'https://www.gstatic.com/firebasejs/10.12.1/firebase-auth.js';
import {
    getFirestore,
    connectFirestoreEmulator,
    serverTimestamp,
    increment,
    arrayUnion,
    arrayRemove,
    GeoPoint,
    Timestamp,
    collection,
    doc,
    addDoc,
    setDoc,
    getDoc,
    getDocs,
    updateDoc,
    deleteDoc,
    query,
    where,
    orderBy,
    limit,
    onSnapshot,
    writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.12.1/firebase-firestore.js';
import {
    getFunctions,
    connectFunctionsEmulator,
    httpsCallable,
} from 'https://www.gstatic.com/firebasejs/10.12.1/firebase-functions.js';
import {
    getAnalytics,
    logEvent,
} from 'https://www.gstatic.com/firebasejs/10.12.1/firebase-analytics.js';

if (!window.RAPIDALERT_CONFIG) {
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    window.RAPIDALERT_CONFIG = {
        firebase: {
            apiKey: "AIzaSyAnG1USSC94DNxlnzeufs3PpTNzXhcoqHM",
            authDomain: "smart-community-8fd9a.firebaseapp.com",
            projectId: "smart-community-8fd9a",
            storageBucket: "smart-community-8fd9a.firebasestorage.app",
            messagingSenderId: "864478830317",
            appId: "1:864478830317:web:f6eb2213f8c222363b36e4",
        },
        vapidKey: "YOUR_VAPID_KEY",
        otpServerUrl: isLocal ? "http://localhost:3001" : "https://rapidalert-otp.onrender.com",
        authMode: "twilio",
        env: isLocal ? "development" : "production"
    };
}

const cfg = window.RAPIDALERT_CONFIG;
if (!cfg || !cfg.firebase || !cfg.firebase.apiKey) {
    const errEl = document.getElementById('login-error');
    if (errEl) {
        errEl.textContent = '⚠️ Firebase not configured. Open firebase-env.js and fill in your project credentials.';
        errEl.style.display = 'block';
    }
    console.error('[RapidAlert Admin] firebase-env.js not configured. Stopping.');
} else {

    // ── Initialize app ────────────────────────────────────────────────────────
    const app = initializeApp(cfg.firebase);
    const auth = getAuth(app);
    const db = getFirestore(app);
    const functions = getFunctions(app, 'asia-south1');
    // Analytics only works with a real Firebase project (not emulators)
    let analytics = null;
    if (cfg.env !== 'development') {
        try { analytics = getAnalytics(app); } catch (e) { console.warn('[Admin] Analytics unavailable:', e.message); }
    }

    // ── Use emulators in development ─────────────────────────────────────────
    if (cfg.env === 'development') {
        connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
        connectFirestoreEmulator(db, '127.0.0.1', 8080);
        connectFunctionsEmulator(functions, '127.0.0.1', 5001);
        console.info('[Firebase Admin] Using local emulators.');
    }

    // ── Set session persistence ───────────────────────────────────────────────
    setPersistence(auth, browserLocalPersistence).catch(console.error);

    // ── Expose everything on window.FB ────────────────────────────────────────
    // All subsequent module scripts access Firebase SDK via window.FB —
    // this avoids re-importing from CDN in every file.
    window.FB = {
        // Service instances
        app,
        auth,
        db,
        functions,
        analytics,

        // Firestore field values
        serverTimestamp,
        increment,
        arrayUnion,
        arrayRemove,
        GeoPoint,
        Timestamp,

        // Firestore operations
        collection,
        doc,
        addDoc,
        setDoc,
        getDoc,
        getDocs,
        updateDoc,
        deleteDoc,
        query,
        where,
        orderBy,
        limit,
        onSnapshot,
        writeBatch,

        // Functions helpers
        httpsCallable,

        // Analytics helper (no-op in development/emulator mode)
        logEvent: (name, params) => { if (analytics) try { logEvent(analytics, name, params); } catch (e) { } },
    };

    console.info('[Firebase Admin] Initialized. Project:', cfg.firebase.projectId, '| Mode:', cfg.env);
}
