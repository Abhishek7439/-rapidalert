/* ==============================================================
   RapidAlert Citizen – Service Worker  (Phase 4 Production)
   sw.js is loaded by Firebase Messaging AND by the Cache API.

   Handles:
     1. Install + Cache core assets (offline shell)
     2. Activate + Clean old caches
     3. Fetch: Cache-first for static assets, network-first for API
     4. Push: Receive FCM background push, show rich notification
     5. notificationclick: Route to correct app view
     6. Message: Commands from main app (SKIP_WAITING, TEST_PUSH)

   FCM Background Push Flow:
     Firebase → FCM → sw.js push event → showNotification()
     → user taps → notificationclick → open / focus app

   Push payload structure (from functions/index.js):
     notification.title  – displayed in notification
     notification.body   – message text
     data.alertId        – Firestore document ID
     data.severity       – Info | Warning | Emergency | Evacuate
     data.alertType      – Earthquake | Flood | Fire | etc.
     data.area           – affected area string
     data.url            – deep link URL
     data.type           – ALERT | SOS_RECEIVED | SOS_SPIKE
   ============================================================== */

'use strict';

// ── Firebase Messaging compat SDK (required for FCM push in SW) ───────────────
// The compat SDK is the ONLY option for Service Workers (no ES modules in SW).
// Scripts are loaded from the CDN in the importScripts call below.
importScripts('https://www.gstatic.com/firebasejs/10.12.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.1/firebase-messaging-compat.js');

// ── Firebase config ───────────────────────────────────────────────────────────
// These must match firebase-env.js. Duplicated here because SW cannot
// access window or import non-module scripts from the parent page.
// ⚠️  Fill in your actual values from Firebase Console before deploying.
// ── Firebase config ── HARDCODED for background push (SW cannot access window) ──
const FIREBASE_CONFIG = {
    apiKey: 'AIzaSyAnG1USSC94DNxlnzeufs3PpTNzXhcoqHM',
    authDomain: 'smart-community-8fd9a.firebaseapp.com',
    projectId: 'smart-community-8fd9a',
    storageBucket: 'smart-community-8fd9a.firebasestorage.app',
    messagingSenderId: '864478830317',
    appId: '1:864478830317:web:f6eb2213f8c222363b36e4',
};

// ── SW Config ─────────────────────────────────────────────────────────────────
const SW_VERSION = 'phase6-v4-raw-push'; // alarm.html + alarm.wav added
const CACHE_NAME = `rapidalert-citizen-${SW_VERSION}`;

// Assets to pre-cache on install (offline shell)
const PRECACHE_ASSETS = [
    './',
    './index.html',
    './alarm.html',
    './alarm.wav',
    './css/app.css',
    './js/alarm.js',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-72.png',
];

// URLs that should always be network-first (never cached)
const NETWORK_ONLY_PATTERNS = [
    /firestore\.googleapis\.com/,
    /fcm\.googleapis\.com/,
    /identitytoolkit\.googleapis\.com/,
    /firebase-env\.js/,
    /\.js\?v=/,        // versioned JS — always fetch fresh
    /\.css\?v=/,       // versioned CSS — always fetch fresh
];

// Severity → vibration mapping (millis on/off)
const VIBRATE = {
    Evacuate: [500, 100, 500, 100, 500, 100, 1000],
    Emergency: [300, 100, 300, 100, 600],
    Warning: [200, 100, 200],
    Info: [100],
};

// Severity → notification background color (for Android)
const SEV_COLOR = {
    Evacuate: '#7c3aed',
    Emergency: '#ef4444',
    Warning: '#f59e0b',
    Info: '#3b82f6',
};


// ═══════════════════════════════════════════════════════════════════════════════
// Firebase Messaging in SW — handles FCM push even when app is CLOSED
// Uses the compat SDK because ES modules are not supported in Service Workers.
// ═══════════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════
// Firebase Messaging in SW — ONLY used to parse FCM payload format.
// We do NOT use onBackgroundMessage for showing notifications or opening windows
// because it runs OUTSIDE the push event scope and loses audio/window privileges.
// ALL notification display + alarm triggering happens in the raw 'push' handler.
// ═══════════════════════════════════════════════════════════════════════════════
let messagingInitialized = false;

function initFirebaseMessaging() {
    if (messagingInitialized) return;
    if (!FIREBASE_CONFIG.projectId) {
        console.warn('[SW] Firebase config not set — FCM background push disabled.');
        return;
    }
    try {
        if (!firebase.apps.length) {
            firebase.initializeApp(FIREBASE_CONFIG);
        }
        // Register onBackgroundMessage but do nothing — we handle everything
        // in the raw push event below so we keep the event scope privileges.
        firebase.messaging().onBackgroundMessage((payload) => {
            console.info('[SW] onBackgroundMessage (already handled by push event):', payload.data?.type || '?');
            // Intentionally do nothing here - raw push handler already showed notification
            // and opened alarm.html with full event scope privileges.
        });

        messagingInitialized = true;
        console.info('[SW] Firebase Messaging initialized (raw push handler is primary).');
    } catch (err) {
        console.error('[SW] Firebase Messaging init failed:', err.message);
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// 1. INSTALL – Pre-cache shell assets
// ═══════════════════════════════════════════════════════════════════════════════
self.addEventListener('install', (event) => {
    console.info(`[SW] Installing ${CACHE_NAME}…`);
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(PRECACHE_ASSETS)
                .catch(err => console.warn('[SW] Pre-cache partial fail (OK in dev):', err.message))
            )
            .then(() => {
                console.info('[SW] Install complete.');
                initFirebaseMessaging();
            })
    );
    self.skipWaiting();
});


// ═══════════════════════════════════════════════════════════════════════════════
// 2. ACTIVATE – Remove old caches, claim clients
// ═══════════════════════════════════════════════════════════════════════════════
self.addEventListener('activate', (event) => {
    console.info('[SW] Activating…');
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys
                    .filter(k => k.startsWith('rapidalert-citizen-') && k !== CACHE_NAME)
                    .map(k => {
                        console.info('[SW] Deleting old cache:', k);
                        return caches.delete(k);
                    })
            ))
            .then(() => {
                initFirebaseMessaging();
                return self.clients.claim();
            })
    );
});


// ═══════════════════════════════════════════════════════════════════════════════
// 3. FETCH – Cache-first for static assets, network-first for API calls
// ═══════════════════════════════════════════════════════════════════════════════
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = request.url;

    // Only handle same-origin GET requests
    if (request.method !== 'GET' || !url.startsWith(self.location.origin)) return;

    // Network-only for API and Firebase endpoints
    if (NETWORK_ONLY_PATTERNS.some(p => p.test(url))) return;

    // Cache-first strategy for static assets
    event.respondWith(
        caches.match(request)
            .then(cached => {
                if (cached) return cached;
                return fetch(request)
                    .then(response => {
                        // Only cache successful same-origin static responses
                        if (response && response.status === 200 && response.type === 'basic') {
                            const clone = response.clone();
                            caches.open(CACHE_NAME).then(c => c.put(request, clone));
                        }
                        return response;
                    })
                    .catch(() => {
                        // Offline fallback for navigation requests
                        if (request.mode === 'navigate') {
                            return caches.match('./index.html');
                        }
                    });
            })
    );
});


// ═══════════════════════════════════════════════════════════════════════════════
// 4. PUSH – Raw Web Push event handler
//    This is the PRIMARY handler. It runs WITHIN the push event scope which
//    grants full privileges for:
//      • clients.openWindow()  → opens alarm.html with audio autoplay
//      • clients postMessage   → wakes open app window to ring alarm
//    Firebase's onBackgroundMessage runs AFTER this and does nothing extra.
// ═══════════════════════════════════════════════════════════════════════════════
self.addEventListener('push', (event) => {
    console.info('[SW] 🔔 Raw push event received');

    if (!event.data) {
        console.warn('[SW] Push received with no data — showing fallback.');
        event.waitUntil(showFallbackNotification());
        return;
    }

    let data = {};
    let notif = {};
    try {
        const parsed = event.data.json();
        // FCM v1 sends { notification: {...}, data: {...} }
        // FCM legacy sends flat { data: {...} } or the payload directly
        data = parsed.data || parsed;
        notif = parsed.notification || {};
    } catch (_) {
        data = {};
        notif = { title: '🚨 RapidAlert', body: event.data.text() };
    }

    if (!notif.title && data.title) notif.title = data.title;
    if (!notif.body && data.body) notif.body = data.body;

    console.info('[SW] Push data:', data.type || 'ALERT', '| severity:', data.severity || '?');

    // Run handlePushPayload inside the push event scope (critical for openWindow privilege)
    event.waitUntil(handlePushPayload(data, notif));
});



// ═══════════════════════════════════════════════════════════════════════════════
// Core push handler – shared by onBackgroundMessage + push event
// KEY TRICK: The push event handler is allowed to:
//   1. Post a message to an existing app window → app plays alarm immediately
//   2. Call clients.openWindow() → new window opens with audio autoplay allowed
// Both methods bypass the normal "user gesture required for audio" restriction.
// ═══════════════════════════════════════════════════════════════════════════════
async function handlePushPayload(data, notif) {
    const type = data.type || 'ALERT';
    const severity = data.severity || 'Info';
    const alertId = data.alertId || null;
    const sosId = data.sosId || null;
    const deepUrl = data.url || self.location.origin + '/rapidalert-citizen/';

    // Always show the notification banner first
    let notifPromise;

    // ── SOS notification for officers ─────────────────────────────
    if (type === 'SOS_RECEIVED') {
        notifPromise = showNotification({
            title: `\uD83C\uDD98 SOS – ${data.name || 'Citizen'}`,
            body: `\uD83D\uDCCD ${data.area || 'Location unavailable'} · Tap to respond`,
            tag: `sos-${sosId || Date.now()}`,
            icon: '/rapidalert/icons/icon-192.png',
            badge: '/rapidalert/icons/icon-72.png',
            vibrate: VIBRATE.Emergency,
            color: SEV_COLOR.Emergency,
            requireInteraction: true,
            actions: [
                { action: 'respond', title: '\uD83D\uDE95 Respond Now' },
                { action: 'view', title: '\uD83D\uDC41 View Details' },
            ],
            data: { type, sosId, name: data.name || '', area: data.area || '', url: '/rapidalert/index.html?sos=1' },
        });
        return notifPromise;
    }

    // ── SOS Spike ────────────────────────────────────────────────
    if (type === 'SOS_SPIKE') {
        return showNotification({
            title: '\uD83D\uDEA8 SOS SPIKE ALERT',
            body: `${data.count} SOS in 5 min in ${data.district || 'your area'}`,
            tag: `sos-spike-${Date.now()}`,
            icon: '/rapidalert/icons/icon-192.png',
            badge: '/rapidalert/icons/icon-72.png',
            vibrate: VIBRATE.Emergency,
            color: SEV_COLOR.Emergency,
            requireInteraction: true,
            data: { type, url: '/rapidalert/index.html?sos=1' },
        });
    }

    // ── Alert notification ─────────────────────────────────────
    const title = notif.title
        || buildAlertTitle(data.alertType || data.type, severity, data.isDrill === 'true');
    const body = notif.body
        || (data.area ? `\uD83D\uDCCD ${data.area}\n${(data.message || '').slice(0, 120)}` : data.message || '');

    const isEmergency = severity === 'Emergency' || severity === 'Evacuate';

    notifPromise = showNotification({
        title,
        body,
        tag: `alert-${alertId || Date.now()}`,
        icon: '/rapidalert-citizen/icons/icon-192.png',
        badge: '/rapidalert-citizen/icons/icon-72.png',
        vibrate: VIBRATE[severity] || VIBRATE.Warning,
        color: SEV_COLOR[severity] || SEV_COLOR.Info,
        requireInteraction: isEmergency,
        renotify: true,
        silent: false,   // Always play notification sound
        actions: [
            { action: 'view', title: '\uD83D\uDC41 View Alert' },
            { action: 'sos', title: '\uD83C\uDD98 SOS' },
            { action: 'safe', title: '\u2705 I\'m Safe' },
        ],
        data: { type: 'ALERT', alertId, severity, url: deepUrl },
    });

    // ── AUTO-RING: For Emergency/Evacuate, ring the app without waiting for tap ──
    // This works because push event handlers have special audio privileges.
    if (isEmergency) {
        const clientsPromise = self.clients
            .matchAll({ type: 'window', includeUncontrolled: true })
            .then(async (clientList) => {
                const appClients = clientList.filter(c =>
                    c.url.includes('/rapidalert-citizen/')
                );

                if (appClients.length > 0) {
                    // App is already open — post PLAY_ALARM message, rings immediately
                    console.info('[SW] App is open — posting PLAY_ALARM to', appClients.length, 'client(s)');
                    appClients.forEach(c => c.postMessage({
                        type: 'PLAY_ALARM',
                        severity,
                        alertId,
                    }));
                } else {
                    // App is CLOSED — open dedicated alarm.html page
                    // Uses <audio autoplay> which works without user gesture
                    // when opened from a push event handler.
                    const alarmPageUrl = `${self.location.origin}/rapidalert-citizen/alarm.html`
                        + `?alarm=${severity}`
                        + (alertId ? `&alert=${alertId}` : '');

                    console.info('[SW] App is closed — opening alarm page:', alarmPageUrl);
                    if (self.clients.openWindow) {
                        await self.clients.openWindow(alarmPageUrl);
                    }
                }
            })
            .catch(err => console.warn('[SW] Auto-ring error:', err));

        return Promise.all([notifPromise, clientsPromise]);
    }

    return notifPromise;
}

function buildAlertTitle(alertType, severity, isDrill) {
    const emojis = {
        Info: '\u2139\uFE0F', Warning: '\u26A0\uFE0F',
        Emergency: '\uD83D\uDD34', Evacuate: '\uD83D\uDEA8',
    };
    const e = emojis[severity] || '\u26A0\uFE0F';
    return `${e} ${isDrill ? '[DRILL] ' : ''}${alertType || 'Emergency'} Alert`;
}

function showNotification(opts) {
    const { title, ...options } = opts;
    return self.registration.showNotification(title, options);
}

function showFallbackNotification() {
    return showNotification({
        title: '\uD83D\uDEA8 RapidAlert',
        body: 'A new emergency alert has been issued in your area.',
        icon: '/rapidalert-citizen/icons/icon-192.png',
        badge: '/rapidalert-citizen/icons/icon-72.png',
        tag: 'rapidalert-fallback',
        data: { url: '/rapidalert-citizen/' },
    });
}


// ═══════════════════════════════════════════════════════════════════════════════
// 5. NOTIFICATIONCLICK – Route to correct app view
//    Works in all states: foreground, background, closed, locked screen
// ═══════════════════════════════════════════════════════════════════════════════
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    const action = event.action;
    const data = event.notification.data || {};
    const alertId = data.alertId || null;
    const sosId = data.sosId || null;
    const severity = data.severity || 'Info';

    // Determine the target URL based on action
    let targetUrl = data.url || '/rapidalert-citizen/';

    if (action === 'sos' || action === 'respond') {
        targetUrl = '/rapidalert-citizen/index.html?sos=1';
    } else if (action === 'safe' && alertId) {
        targetUrl = `/rapidalert-citizen/index.html?safe=${alertId}`;
    } else if (action === 'view' && alertId) {
        targetUrl = `/rapidalert-citizen/index.html?alert=${alertId}`;
    } else if (data.type === 'SOS_RECEIVED') {
        targetUrl = '/rapidalert/index.html?sos=1';   // Admin panel for officers
    }

    const appOrigin = self.location.origin;
    const fullTarget = new URL(targetUrl, appOrigin).href;

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then(clientList => {
                // Try to find and focus an existing app window
                for (const client of clientList) {
                    const clientUrl = new URL(client.url);
                    if (clientUrl.origin === appOrigin && 'focus' in client) {
                        // Tell the existing page to navigate
                        client.postMessage({
                            type: 'NOTIFICATION_ACTION',
                            action,
                            alertId,
                            sosId,
                            severity,
                            targetUrl: fullTarget,
                        });
                        return client.focus();
                    }
                }

                // No existing window — open a new one with alarm trigger params
                if (clients.openWindow) {
                    const alarmUrl = severity === 'Emergency' || severity === 'Evacuate'
                        ? fullTarget + (fullTarget.includes('?') ? '&' : '?') + `alarm=${severity}`
                        : fullTarget;
                    return clients.openWindow(alarmUrl);
                }
            })
    );
});


// ═══════════════════════════════════════════════════════════════════════════════
// 6. MESSAGE – Handle commands from main app
// ═══════════════════════════════════════════════════════════════════════════════
self.addEventListener('message', (event) => {
    const { type } = event.data || {};

    if (type === 'SKIP_WAITING') {
        // Allow waiting SW to become active immediately
        console.info('[SW] SKIP_WAITING received — activating new SW.');
        self.skipWaiting();
        return;
    }

    if (type === 'TEST_PUSH') {
        // Allow the admin/debug page to trigger a test notification
        console.info('[SW] TEST_PUSH received.');
        const { alertType = 'Flood', severity = 'Emergency', message = 'Test notification', area = 'Test Area' } = event.data;
        handlePushPayload(
            { type: 'ALERT', alertType, severity, message, area, alertId: 'test-push', isDrill: 'true' },
            {}
        );
        return;
    }

    if (type === 'SET_FIREBASE_CONFIG') {
        // Allow the main page to pass Firebase config to the SW
        // (Alternative to hardcoding FIREBASE_CONFIG above)
        Object.assign(FIREBASE_CONFIG, event.data.config || {});
        if (!messagingInitialized) initFirebaseMessaging();
        console.info('[SW] Firebase config updated from main page.');
        return;
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// notificationclose – Track dismissed notifications (analytics)
// ═══════════════════════════════════════════════════════════════════════════════
self.addEventListener('notificationclose', (event) => {
    const data = event.notification.data || {};
    if (data.alertId) {
        console.info('[SW] Notification dismissed by user:', data.alertId);
        // Could post to analytics endpoint here in future
    }
});
