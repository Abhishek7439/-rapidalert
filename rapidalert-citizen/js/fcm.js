/**
 * fcm.js – Citizen PWA Firebase Cloud Messaging  (Phase 4 Final)
 * ==================================================================
 * Handles full FCM lifecycle:
 *   1. requestPermission()       – ask browser for notification permission
 *   2. registerFCMToken()        – get VAPID token, save to users/{uid}
 *   3. refreshTokenOnChange()    – detect token rotation, re-save
 *   4. subscribeToDistrictTopic()– subscribe to FCM topic for district-wide alerts
 *   5. setupForegroundHandler()  – process foreground push (app is open)
 *   6. initFCM()                 – full init sequence on login
 *
 * Requires: window.FB (firebase-init.js) which sets:
 *   window.FB.getToken, window.FB.onMessage, window.FB.messaging
 *   window.FB.vapidKey, window.FB.db, window.FB.GeoPoint
 * Exposes:  window.FCM
 */

import {
    doc,
    updateDoc,
    setDoc,
} from 'https://www.gstatic.com/firebasejs/10.12.1/firebase-firestore.js';
import {
    getAuth,
} from 'https://www.gstatic.com/firebasejs/10.12.1/firebase-auth.js';

const { db, vapidKey } = window.FB;
const auth = getAuth();

// ── In-memory state ───────────────────────────────────────────────────────────
let _currentToken = null;   // Last known FCM token
let _tokenRefreshInitialized = false;

// ── 1. Request notification permission ───────────────────────────────────────
async function requestPermission() {
    if (!('Notification' in window)) {
        console.warn('[FCM] Notifications API not supported.');
        return 'denied';
    }
    if (Notification.permission === 'granted') return 'granted';

    try {
        const permission = await Notification.requestPermission();
        console.info('[FCM] Notification permission:', permission);
        return permission;
    } catch (err) {
        console.error('[FCM] requestPermission error:', err);
        return 'denied';
    }
}


// ── 2. Register / get FCM token ───────────────────────────────────────────────
// Determines registration token from Firebase, saves it to Firestore.
// Returns the token string or null on failure.
async function registerFCMToken() {
    const user = auth.currentUser;
    if (!user) {
        console.warn('[FCM] No authenticated user — skipping token registration.');
        return null;
    }

    const getTokenFn = window.FB.getToken;
    if (!getTokenFn) {
        console.warn('[FCM] Messaging not supported on this browser (Firefox private mode / Safari without HTTPS).');
        return null;
    }

    if (!vapidKey || vapidKey.startsWith('REPLACE_')) {
        console.error('[FCM] VAPID key not configured in firebase-env.js. Add your VAPID key.');
        return null;
    }

    // Ensure SW is registered — FCM needs it for background delivery
    let swRegistration = null;
    try {
        // Look for the citizen SW (scope: /rapidalert-citizen/)
        swRegistration = await navigator.serviceWorker.getRegistration('/rapidalert-citizen/');
        if (!swRegistration) {
            swRegistration = await navigator.serviceWorker.register('./sw.js', {
                scope: '/rapidalert-citizen/',
            });
            await navigator.serviceWorker.ready;
        }
    } catch (err) {
        console.warn('[FCM] Service Worker not available for FCM:', err.message);
        // FCM can still work in foreground without SW
    }

    try {
        const token = await getTokenFn({
            vapidKey,
            serviceWorkerRegistration: swRegistration,
        });

        if (!token) {
            console.warn('[FCM] Empty token returned — notifications may be blocked.');
            return null;
        }

        // Avoid unnecessary Firestore writes if token hasn't changed
        if (token === _currentToken) {
            console.info('[FCM] Token unchanged — skipping Firestore update.');
            return token;
        }

        _currentToken = token;

        // Persist to Firestore users/{uid}
        // Use setDoc+merge so it works even if the user document doesn't exist yet
        // (updateDoc would throw if doc is missing, silently losing the token)
        await setDoc(doc(db, 'users', user.uid), {
            fcmToken: token,
            fcmTokenUpdated: new Date(),
            uid: user.uid,
        }, { merge: true });

        console.info('[FCM] Token registered & saved to Firestore:', token.slice(0, 20) + '…');
        return token;

    } catch (err) {
        if (err.code === 'messaging/permission-blocked') {
            console.warn('[FCM] Notifications blocked by user in browser settings.');
        } else if (err.code === 'messaging/unsupported-browser') {
            console.warn('[FCM] FCM not supported on this browser.');
        } else {
            console.error('[FCM] getToken error:', err.code, err.message);
        }
        return null;
    }
}


// ── 3. Listen for token rotation ─────────────────────────────────────────────
// Firebase silently rotates FCM tokens. This listener refreshes Firestore
// when that happens so the user never misses a notification.
function setupTokenRefresh() {
    if (_tokenRefreshInitialized) return;
    _tokenRefreshInitialized = true;

    // There is no direct API for token refresh in the modular SDK.
    // Best practice: re-call getToken() once the app becomes visible after
    // being hidden for more than 7 days. Here we just check on every foreground.
    let lastChecked = Date.now();
    const CHECK_INTERVAL = 7 * 24 * 60 * 60 * 1000; // 7 days

    document.addEventListener('visibilitychange', async () => {
        if (!document.hidden && (Date.now() - lastChecked) > CHECK_INTERVAL) {
            lastChecked = Date.now();
            console.info('[FCM] Periodic token refresh check…');
            const newToken = await registerFCMToken();
            if (newToken && newToken !== _currentToken) {
                console.info('[FCM] Token was rotated — Firestore updated.');
            }
        }
    });

    console.info('[FCM] Token refresh listener attached.');
}


// ── 4. Subscribe to district FCM topic ───────────────────────────────────────
// FCM topics allow district-wide broadcasts without querying every user token.
// Topic name pattern: district_{slug}  e.g. district_mumbai
// This is sent from the client side, but subscription is managed server-side
// via Admin SDK for security. Here we store the desired topic in Firestore
// and the Cloud Function onUserCreated / setUserRole subscribes the token.
// For web PWA we call the HTTP endpoint to subscribe the SW subscription.
async function subscribeToDistrictTopic(district) {
    if (!district) return;
    const user = auth.currentUser;
    if (!user) return;

    const slug = district.toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 60);
    const topic = `district_${slug}`;

    try {
        // Store requested topic in user doc — Cloud Function subscribes the actual token
        await setDoc(doc(db, 'users', user.uid), { subscribedTopic: topic }, { merge: true });
        console.info(`[FCM] Requested topic subscription: ${topic}`);
    } catch (err) {
        console.warn('[FCM] Topic subscription request failed (non-fatal):', err.message);
    }
}


// ── 5. Foreground push handler ────────────────────────────────────────────────
// When the app is open (foreground), Firebase does NOT auto-show the system
// notification. We handle the message here and:
//   - Show an in-app toast
//   - Trigger the alarm system for Emergency / Evacuate
//   - Dispatch an event so app.js can update the UI
//   - Show a manual browser notification for background feel
function setupForegroundHandler() {
    const onMessageFn = window.FB.onMessage;
    if (!onMessageFn) {
        console.warn('[FCM] onMessage not available — messaging unsupported.');
        return;
    }

    onMessageFn((payload) => {
        console.info('[FCM] Foreground push received:', payload.data?.type || '?', payload.notification?.title || '');

        const notif = payload.notification || {};
        const data = payload.data || {};
        const severity = data.severity || 'Info';
        const alertId = data.alertId || null;
        const type = data.type || 'ALERT';

        // SOS notifications to officers = different handling
        if (type === 'SOS_RECEIVED') {
            _showForegroundSOSToast(data);
            return;
        }

        if (type === 'SOS_SPIKE') {
            _showForegroundToast(`🚨 SOS Spike: ${data.count} SOS in 5 min in ${data.district || 'your area'}`, 'error', 8000);
            return;
        }

        // ALERT notification
        const sevEmoji = { Info: 'ℹ️', Warning: '⚠️', Emergency: '🔴', Evacuate: '🚨' }[severity] || '⚠️';
        const toastMsg = `${sevEmoji} ${notif.title || 'New Alert'}: ${notif.body || ''}`;
        const toastType = (severity === 'Info') ? 'info' : (severity === 'Warning') ? 'warning' : 'error';

        _showForegroundToast(toastMsg, toastType, 8000);

        // Show alarm overlay for Emergency / Evacuate
        if ((severity === 'Emergency' || severity === 'Evacuate') && window.AlarmSystem) {
            AlarmSystem.startAlarm(severity);
            if (navigator.vibrate) {
                navigator.vibrate(severity === 'Evacuate'
                    ? [500, 100, 500, 100, 500, 100, 1000]
                    : [300, 100, 300, 100, 600]);
            }
        }

        // Let app.js know a new alert arrived (it may already have it via onSnapshot)
        if (alertId) {
            window.dispatchEvent(new CustomEvent('rapidalert:new-alert', {
                detail: {
                    alertId,
                    type: data.alertType || data.type,
                    severity,
                    area: data.area || '',
                    message: notif.body || '',
                },
            }));
        }

        // Also show a system notification while app is in foreground
        // for locked-screen display and notification drawer visibility.
        if (Notification.permission === 'granted') {
            try {
                navigator.serviceWorker.ready.then(swReg => {
                    swReg.showNotification(notif.title || '🚨 RapidAlert', {
                        body: notif.body || '',
                        icon: './icons/icon-192.png',
                        badge: './icons/icon-72.png',
                        tag: `alert-${alertId || Date.now()}`,
                        renotify: true,
                        requireInteraction: severity === 'Emergency' || severity === 'Evacuate',
                        vibrate: severity === 'Evacuate'
                            ? [500, 100, 500, 100, 500, 100, 1000]
                            : [300, 100, 300],
                        data: { alertId, severity, url: `./index.html?alert=${alertId}` },
                        actions: [
                            { action: 'view', title: '👁 View Alert' },
                            { action: 'sos', title: '🆘 SOS' },
                            { action: 'safe', title: '✅ Safe' },
                        ],
                    });
                });
            } catch (_) { /* SW showNotification not critical */ }
        }
    });

    console.info('[FCM] Foreground message handler active.');
}


// ── Internal: show a toast either via App (if loaded) or raw DOM ──────────────
function _showForegroundToast(msg, type = 'info', duration = 5000) {
    if (window.App?.showToast) {
        App.showToast(msg, type, duration);
    } else {
        const c = document.getElementById('toast-container');
        if (!c) return;
        const t = document.createElement('div');
        t.className = `app-toast ${type}`;
        t.textContent = msg;
        c.appendChild(t);
        setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, duration);
    }
}

function _showForegroundSOSToast(data) {
    _showForegroundToast(
        `🆘 SOS from ${data.name || 'Citizen'} at ${data.area || 'unknown location'}`,
        'error',
        8000
    );
}


// ── 6. Full init sequence ─────────────────────────────────────────────────────
// Call this after citizen is authenticated.
async function initFCM() {
    // Step a: Request notification permission
    const permission = await requestPermission();
    if (permission !== 'granted') {
        console.warn('[FCM] Push notifications not granted — token not registered.');
        return;
    }

    // Step b: Small delay to ensure SW is active
    await new Promise(r => setTimeout(r, 600));

    // Step c: Register token (saves to Firestore)
    const token = await registerFCMToken();
    if (!token) return;

    // Step d: Set up token rotation watcher
    setupTokenRefresh();

    // Step e: Subscribe to district topic AND global all_citizens topic
    if (window.App?.state?.citizenProfile?.district) {
        await subscribeToDistrictTopic(App.state.citizenProfile.district);
    }
    // Subscribe to global topic so Path C (district-wide) alerts reach everyone
    try {
        await setDoc(doc(db, 'users', auth.currentUser?.uid || '_'), {
            subscribedTopics: ['all_citizens'],
        }, { merge: true });
        console.info('[FCM] Subscribed to global all_citizens topic');
    } catch (_) { /* non-fatal */ }

    // Step f: Set up foreground push message handler
    setupForegroundHandler();

    console.info('[FCM] Full FCM initialization complete.');
}


// ── Expose globally ───────────────────────────────────────────────────────────
window.FCM = {
    initFCM,
    requestPermission,
    registerFCMToken,
    subscribeToDistrictTopic,
};
