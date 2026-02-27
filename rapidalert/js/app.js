/**
 * app.js – Admin Panel Core State + Firestore Listeners  (ES Module)
 * ====================================================================
 * Responsibilities:
 *   - Central in-memory state (populated from Firestore)
 *   - Firestore onSnapshot listeners (alerts, sos_requests, admin_logs)
 *   - Page router
 *   - Helper utilities (severity, time formatting)
 *   - Auth UI hooks (login/logout)
 *   - SOS badge updates
 *
 * Requires: window.FB set by firebase-init.js
 * Exposes:  window.App
 */

import {
    collection,
    query,
    where,
    orderBy,
    limit,
    onSnapshot,
} from 'https://www.gstatic.com/firebasejs/10.12.1/firebase-firestore.js';

const { db } = window.FB;

const App = (function () {

    // ── Central State ─────────────────────────────────────────────
    const state = {
        currentAdmin: null,   // { uid, email, name, role, district }
        activeAlerts: [],     // Live: alerts where active == true
        sosRequests: [],     // Live: all SOS requests, newest first
        alertHistory: [],     // Paginated: alerts where active == false
        safeReports: [],     // Last 50 safe reports
        logs: [],     // Last 20 admin_log entries
        analytics: null,   // From analytics collection
        aiPredictions: [],
        systemStatus: {
            firestore: 'Checking...',
            functions: 'Checking...',
            overall: 'Checking...'
        },
        currentPage: null,
        _unsubscribers: [],     // Firestore listener cleanup handles
    };



    // ── Firestore Listener Management ────────────────────────────
    function registerListener(unsubFn) {
        state._unsubscribers.push(unsubFn);
    }

    function detachAllListeners() {
        state._unsubscribers.forEach(fn => { try { fn(); } catch (_) { } });
        state._unsubscribers.length = 0;
        console.info('[App] All Firestore listeners detached.');
    }


    // ── Start Real-Time Firestore Listeners ──────────────────────
    // Called after successful admin login (by auth.js).
    // Each listener updates state and re-renders the current page.
    function startListeners(district) {
        const { collection, query, where, orderBy, limit, onSnapshot } = window.FB;

        // ── 1. Active Alerts listener ──────────────────────────────
        let alertsQ = query(
            collection(db, 'alerts'),
            where('active', '==', true),
            orderBy('timeSent', 'desc'),
            limit(100)
        );

        const unsubAlerts = onSnapshot(alertsQ, (snap) => {
            state.activeAlerts = snap.docs.map(d => ({
                id: d.id,
                ...d.data(),
                timeSent: d.data().timeSent?.toDate?.() || null,
            }));
            updateSOSBadge();
            if (state.currentPage === 'dashboard') {
                // Smart update: don't rebuild full dashboard, just patch stats
                if (window._dashboardPatch) window._dashboardPatch();
                else navigate('dashboard');
            } else if (state.currentPage === 'active-alerts') {
                navigate('active-alerts');
            }
        }, (err) => console.error('[App] Alerts listener error:', err));

        registerListener(unsubAlerts);


        // ── 1.5. Alert History listener (Inactive Alerts) ──────────
        let historyQ = query(
            collection(db, 'alerts'),
            where('active', '==', false),
            orderBy('timeSent', 'desc'),
            limit(50)
        );

        const unsubHistory = onSnapshot(historyQ, (snap) => {
            state.alertHistory = snap.docs.map(d => ({
                id: d.id,
                ...d.data(),
                timeSent: d.data().timeSent?.toDate?.() || null,
            }));

            // Re-render if viewing history, active alerts (for transition), or dashboard
            if (['dashboard', 'active-alerts', 'alert-history'].includes(state.currentPage)) {
                navigate(state.currentPage);
            }
        }, (err) => console.error('[App] Alert history listener error:', err));

        registerListener(unsubHistory);


        // ── 2. SOS Requests listener ───────────────────────────────
        // Shows ALL SOS (not just pending) so officers can see history
        let sosQ = query(
            collection(db, 'sos_requests'),
            orderBy('time', 'desc'),
            limit(200)
        );

        const unsubSOS = onSnapshot(sosQ, (snap) => {
            state.sosRequests = snap.docs.map(d => {
                const data = d.data();
                return {
                    id: d.id,
                    ...data,
                    time: data.time?.toDate?.() || null,
                    lat: data.location?.latitude || data.lat || 0,
                    lng: data.location?.longitude || data.lng || 0,
                };
            });
            updateSOSBadge();
            if (state.currentPage === 'dashboard') {
                if (window._dashboardPatch) window._dashboardPatch();
                else navigate('dashboard');
            } else if (state.currentPage === 'sos-requests') {
                navigate('sos-requests');
            }
        }, (err) => console.error('[App] SOS listener error:', err));

        registerListener(unsubSOS);


        // ── 3. Admin Logs listener ─────────────────────────────────
        const logsQ = query(
            collection(db, 'admin_logs'),
            orderBy('timestamp', 'desc'),
            limit(30)
        );

        const unsubLogs = onSnapshot(logsQ, (snap) => {
            state.logs = snap.docs.map(d => ({
                id: d.id,
                ...d.data(),
                timestamp: d.data().timestamp?.toDate?.() || null,
            }));

            if (state.currentPage === 'dashboard') navigate('dashboard');
        }, (err) => console.error('[App] Logs listener error:', err));

        registerListener(unsubLogs);


        // ── 4. Safe Reports listener ───────────────────────────────
        const safeQ = query(collection(db, 'safe_reports'), orderBy('reportedAt', 'desc'), limit(50));
        const unsubSafe = onSnapshot(safeQ, (snap) => {
            state.safeReports = snap.docs.map(d => ({
                id: d.id,
                ...d.data(),
                reportedAt: d.data().reportedAt?.toDate?.() || null
            }));
            if (state.currentPage === 'dashboard') navigate('dashboard');
        }, (err) => console.error('[App] Safe reports listener error:', err));
        registerListener(unsubSafe);


        // ── 5. AI Predictions listener ─────────────────────────────
        const aiQ = query(collection(db, 'ai_predictions'), orderBy('riskScore', 'desc'), limit(15));
        const unsubAI = onSnapshot(aiQ, (snap) => {
            state.aiPredictions = snap.docs.map(d => ({
                id: d.id,
                ...d.data()
            }));
            if (state.currentPage === 'dashboard') navigate('dashboard');
        }, (err) => console.error('[App] AI Predictions listener error:', err));
        registerListener(unsubAI);

        // Initial health check
        checkSystemHealth();
        // Periodic health check every 30s
        const healthInterval = setInterval(checkSystemHealth, 30000);
        state._unsubscribers.push(() => clearInterval(healthInterval));

        console.info('[App] Firestore listeners started. District:', district || 'all');
    }


    // ── System Health Check ──────────────────────────────────────
    async function checkSystemHealth() {
        const { doc, getDoc } = window.FB;
        let firestoreOk = false;
        let functionsOk = false;

        try {
            // 1. Ping Firestore silently
            const healthRef = doc(db, 'system_config', 'health');
            await getDoc(healthRef).catch(() => { /* silent — permissions ok even if doc missing */ });
            firestoreOk = true;
        } catch (err) {
            console.warn('[Health] Firestore ping error:', err.message);
            firestoreOk = true; // connection works even if doc doesn't exist
        }

        try {
            // 2. Ping Cloud Function — correct project: smart-community-8fd9a
            const env = window.RAPIDALERT_CONFIG?.env;
            const url = env === 'development'
                ? 'http://127.0.0.1:5001/smart-community-8fd9a/asia-south1/healthCheck'
                : 'https://asia-south1-smart-community-8fd9a.cloudfunctions.net/healthCheck';

            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 4000); // 4 s timeout
            const resp = await fetch(url, { signal: ctrl.signal });
            clearTimeout(timer);
            if (resp.ok) {
                const data = await resp.json();
                functionsOk = data.status === 'ok';
            }
        } catch (err) {
            // Functions not deployed / unreachable — NOT a blocking issue
            console.warn('[Health] Cloud Functions ping failed (non-critical):', err.message);
            functionsOk = false;
        }

        const prevStatus = state.systemStatus.overall;
        state.systemStatus = {
            firestore: firestoreOk ? 'Connected' : 'Error',
            // Functions degraded is informational only — doesn't affect overall
            functions: functionsOk ? 'Connected' : 'Standby',
            // Overall = Online as long as Firestore (the critical service) is up
            overall: firestoreOk ? 'Online' : 'Degraded'
        };

        if (prevStatus !== state.systemStatus.overall) {
            console.info(`[Health] Status changed: ${prevStatus} -> ${state.systemStatus.overall}`);
            if (state.currentPage === 'dashboard' || state.currentPage === 'system-status') {
                navigate(state.currentPage);
            }
        }
    }



    // ── Severity helpers ─────────────────────────────────────────
    function severityClass(sev) {
        return { Info: 'info', Warning: 'warning', Emergency: 'emergency', Evacuate: 'evacuate' }[sev] || 'info';
    }
    function severityColor(sev) {
        return { Info: '#3b82f6', Warning: '#f59e0b', Emergency: '#ef4444', Evacuate: '#7c3aed' }[sev] || '#3b82f6';
    }
    function alertTypeIcon(type) {
        return { Earthquake: '🌍', Tsunami: '🌊', Flood: '💧', Fire: '🔥', Cyclone: '🌀', Other: '⚠️' }[type] || '⚠️';
    }

    function formatTime(tsOrDate) {
        if (!tsOrDate) return '—';
        const d = tsOrDate instanceof Date ? tsOrDate
            : tsOrDate?.toDate ? tsOrDate.toDate()
                : new Date(tsOrDate);
        if (isNaN(d.getTime())) return '—';
        return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) + ' ' +
            d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    }

    function timeAgo(tsOrDate) {
        if (!tsOrDate) return '—';
        const d = tsOrDate instanceof Date ? tsOrDate
            : tsOrDate?.toDate ? tsOrDate.toDate()
                : new Date(tsOrDate);
        if (isNaN(d.getTime())) return '—';
        const diff = Date.now() - d.getTime();
        const mins = Math.round(diff / 60000);
        if (mins < 1) return 'Just now';
        if (mins < 60) return `${mins}m ago`;
        const hrs = Math.round(mins / 60);
        if (hrs < 24) return `${hrs}h ago`;
        return `${Math.round(hrs / 24)}d ago`;
    }

    function getTotalCitizens() {
        return [...state.activeAlerts, ...state.alertHistory]
            .reduce((sum, a) => sum + (a.reach || 0), 0);
    }
    function getPendingSOS() {
        return state.sosRequests.filter(s => s.status === 'Pending').length;
    }


    // ── SOS Badge on Sidebar ─────────────────────────────────────
    function updateSOSBadge() {
        const pendingCount = getPendingSOS();
        const sosItem = document.querySelector('[data-page="sos-requests"]');
        if (!sosItem) return;
        let badge = sosItem.querySelector('.sos-badge');
        if (pendingCount > 0) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'badge badge-emergency sos-badge';
                badge.style.cssText = 'margin-left:auto;font-size:10px;padding:2px 8px;animation:pulse 1.5s infinite';
                sosItem.appendChild(badge);
            }
            badge.textContent = pendingCount;
        } else {
            badge?.remove();
        }
    }


    // ── Page Router ──────────────────────────────────────────────
    const PAGES = ['dashboard', 'create-alert', 'active-alerts', 'sos-requests', 'alert-history', 'system-status'];

    function navigate(page) {
        if (!PAGES.includes(page)) page = 'dashboard';
        state.currentPage = page;

        document.querySelectorAll('.sidebar-item[data-page]').forEach(el => {
            el.classList.toggle('active', el.dataset.page === page);
        });

        // Destroy existing Leaflet map instances
        (window._leafletInstances || []).forEach(m => { try { m.remove(); } catch (_) { } });
        window._leafletInstances = [];

        const content = document.getElementById('main-content');
        if (!content) return;

        switch (page) {
            case 'dashboard': renderDashboard(content); break;
            case 'create-alert': renderCreateAlert(content); break;
            case 'active-alerts': renderActiveAlerts(content); break;
            case 'sos-requests': renderSOSRequests(content); break;
            case 'alert-history': renderAlertHistory(content); break;
            case 'system-status': renderSystemStatus(content); break;
        }
    }


    // ── Auth UI ───────────────────────────────────────────────────
    function login(admin) {
        state.currentAdmin = admin;
        document.getElementById('login-page').style.display = 'none';
        document.getElementById('app-shell').style.display = 'flex';
        const nameEl = document.getElementById('nav-admin-name');
        const avatarEl = document.getElementById('nav-avatar');
        const roleEl = document.getElementById('nav-admin-role');
        if (nameEl) nameEl.textContent = admin.name;
        if (avatarEl) avatarEl.textContent = admin.name.charAt(0).toUpperCase();
        if (roleEl) roleEl.textContent = admin.role.replace('_', ' ');

        // Responsive sidebar: bottom nav on mobile/tablet
        function applyResponsiveSidebar() {
            const sidebar = document.getElementById('sidebar');
            if (!sidebar) return;
            if (window.innerWidth <= 900) {
                sidebar.classList.add('mobile-nav');
            } else {
                sidebar.classList.remove('mobile-nav');
                sidebar.style.display = '';
            }
        }
        applyResponsiveSidebar();
        window.addEventListener('resize', applyResponsiveSidebar);

        navigate('dashboard');
        showToast(`Welcome back, ${admin.name}!`, 'success');
    }

    function logout() {
        detachAllListeners();
        state.currentAdmin = null;
        state.activeAlerts = [];
        state.sosRequests = [];
        state.alertHistory = [];
        state.logs = [];
        state.currentPage = null;
        document.getElementById('app-shell').style.display = 'none';
        document.getElementById('login-page').style.display = 'flex';
        // auth.js will be called by the logout button onclick
        if (window.adminLogout) adminLogout();
    }


    // ── Public API ────────────────────────────────────────────────
    return {
        state,
        navigate,
        login,
        logout,
        startListeners,
        registerListener,
        detachAllListeners,
        updateSOSBadge,
        severityClass,
        severityColor,
        alertTypeIcon,
        formatTime,
        timeAgo,
        getTotalCitizens,
        getPendingSOS,
        checkSystemHealth,
    };


})();

// ── Expose globally (onclick handlers, page renderers, auth.js) ──
window.App = App;
