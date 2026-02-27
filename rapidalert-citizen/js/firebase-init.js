/**
 * firebase-init.js – Citizen PWA  (ES Module)
 * ==============================================
 * Initializes Firebase Modular SDK (v10+, no compat).
 * Exposes window.FB for use by auth.js, app.js, fcm.js, geo.js.
 *
 * SETUP: Fill in firebase-env.js with your Firebase Console values.
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
    GeoPoint,
    Timestamp,
    collection,
    doc,
    addDoc,
    setDoc,
    getDoc,
    updateDoc,
    query,
    where,
    orderBy,
    limit,
    onSnapshot,
} from 'https://www.gstatic.com/firebasejs/10.12.1/firebase-firestore.js';
import {
    getMessaging,
    getToken,
    onMessage,
    isSupported as isMessagingSupported,
} from 'https://www.gstatic.com/firebasejs/10.12.1/firebase-messaging.js';
import {
    getAnalytics,
    logEvent,
} from 'https://www.gstatic.com/firebasejs/10.12.1/firebase-analytics.js';

const cfg = window.RAPIDALERT_CONFIG;
if (!cfg || !cfg.firebase || !cfg.firebase.apiKey) {
    // Show error through the new error boundary element
    const errBoundary = document.getElementById('error-boundary');
    const errMsg = document.getElementById('err-msg');
    const loading = document.getElementById('app-loading');
    if (errMsg) errMsg.textContent = 'Firebase not configured. Open firebase-env.js and fill in your project credentials, then reload.';
    if (errBoundary) errBoundary.classList.add('visible');
    if (loading) { loading.style.opacity = '0'; setTimeout(() => loading.remove(), 400); }
    console.error('[RapidAlert Citizen] firebase-env.js not configured.');
} else {

    // ── Initialize ─────────────────────────────────────────────────────────────
    const app = initializeApp(cfg.firebase);
    const auth = getAuth(app);
    const db = getFirestore(app);

    // Messaging: only available in supporting browsers (not Firefox, Safari < 16)
    let messaging = null;
    isMessagingSupported().then((supported) => {
        if (supported) {
            messaging = getMessaging(app);
            window.FB.messaging = messaging;
            // Expose getToken and onMessage helpers
            window.FB.getToken = (options) => getToken(messaging, options);
            window.FB.onMessage = (handler) => onMessage(messaging, handler);
        } else {
            console.warn('[Firebase Citizen] Cloud Messaging not supported in this browser.');
        }
    });

    // Analytics — only in production (emulators don’t support it)
    let analytics = null;
    if (cfg.env !== 'development') {
        try { analytics = getAnalytics(app); } catch (e) { console.warn('[Citizen] Analytics unavailable:', e.message); }
    }

    // ── Emulators ─────────────────────────────────────────────────────────────────────
    if (cfg.env === 'development') {
        // Dynamic host: whatever hostname the browser used to load this page
        // is also where the emulators live (same machine, same IP).
        // - Laptop browser: hostname = 127.0.0.1 → emulators on 127.0.0.1 ✅
        // - Phone on WiFi: hostname = 192.168.31.171 → emulators on 192.168.31.171 ✅
        const emulatorHost = window.location.hostname;

        connectAuthEmulator(auth, `http://${emulatorHost}:9099`, { disableWarnings: true });
        connectFirestoreEmulator(db, emulatorHost, 8080);
        auth.settings.appVerificationDisabledForTesting = true;
        window._devEmulatorHost = emulatorHost;
        console.info(`[Firebase Citizen] Dev mode — emulators on ${emulatorHost}`);
    }

    // ── Session persistence ────────────────────────────────────────────────────
    setPersistence(auth, browserLocalPersistence).catch(console.error);

    // ── Expose on window.FB ────────────────────────────────────────────────────
    window.FB = {
        app,
        auth,
        db,
        messaging,          // may be updated async above
        analytics,
        vapidKey: cfg.vapidKey,

        // Firestore field values
        serverTimestamp,
        GeoPoint,
        Timestamp,

        // Firestore operations
        collection,
        doc,
        addDoc,
        setDoc,
        getDoc,
        updateDoc,
        query,
        where,
        orderBy,
        limit,
        onSnapshot,

        // Analytics helper (no-op in dev/emulator mode)
        logEvent: (name, params) => { if (analytics) try { logEvent(analytics, name, params); } catch (e) { } },

        // Messaging stubs overwritten above when supported
        getToken: null,
        onMessage: null,
    };

    console.info('[Firebase Citizen] Initialized. Project:', cfg.firebase.projectId, '| Mode:', cfg.env);

    // ── Send Firebase config to Service Worker ─────────────────────────────────
    // The SW loads firebase-messaging-compat.js but cannot import firebase-env.js.
    // We post the config from here so sw.js can initialize FCM without hardcoded creds.
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.ready.then((reg) => {
            if (reg.active) {
                reg.active.postMessage({
                    type: 'SET_FIREBASE_CONFIG',
                    config: cfg.firebase,
                });
                console.info('[Firebase Citizen] Config sent to Service Worker.');
            }
        }).catch(() => { });
    }
}
