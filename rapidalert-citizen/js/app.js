/**
 * app.js – Citizen PWA Main Application  (ES Module)
 * ====================================================
 * Replaces all localStorage/Bridge references with:
 *   - Firestore onSnapshot for real-time alerts
 *   - Firestore addDoc for SOS submission
 *   - Firestore setDoc for "I'm Safe" reporting
 *
 * All UI rendering logic is preserved from original.
 * SOS panic button and history both use Firestore.
 *
 * Requires: window.FB (firebase-init.js), window.Auth (auth.js),
 *           window.FCM (fcm.js), window.Geo (geo.js)
 * Exposes:  window.App
 */

import {
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  addDoc,
  setDoc,
  doc,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.1/firebase-firestore.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.1/firebase-auth.js';

const { db } = window.FB;
const auth = getAuth();

const App = (function () {

  // ── State ─────────────────────────────────────────────────────
  const state = {
    alerts: [],            // From Firestore onSnapshot
    alertHistory: [],      // Inactive alerts for history tab
    dismissedIds: new Set(),
    safeReportIds: new Set(),
    activeAlarm: null,
    currentView: 'home',
    citizenProfile: null,          // Full profile from Firestore
    notifPermission: 'default',
    swReady: false,
    selectedAlertId: null,
    _unsubAlerts: null,          // Firestore listener handle
    _unsubHistory: null,         // History listener handle
  };

  // ── Severity / type config ────────────────────────────────────
  const SEV = {
    Info: { color: '#3b82f6', bg: 'rgba(59,130,246,0.12)', emoji: 'ℹ️', label: 'Info' },
    Warning: { color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', emoji: '⚠️', label: 'Warning' },
    Emergency: { color: '#ef4444', bg: 'rgba(239,68,68,0.12)', emoji: '🔴', label: 'Emergency' },
    Evacuate: { color: '#7c3aed', bg: 'rgba(124,58,237,0.12)', emoji: '🚨', label: 'Evacuate' },
  };
  const TYPE_ICONS = { Earthquake: '🌍', Tsunami: '🌊', Flood: '💧', Fire: '🔥', Cyclone: '🌀', Other: '⚠️' };

  function sevCfg(s) { return SEV[s] || SEV.Info; }
  function typeIcon(t) { return TYPE_ICONS[t] || '⚠️'; }

  function formatTime(ts) {
    if (!ts) return '—';
    const d = ts?.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function timeAgo(ts) {
    if (!ts) return '—';
    const d = ts?.toDate ? ts.toDate() : new Date(ts);
    const diff = Date.now() - d.getTime();
    const m = Math.round(diff / 60000);
    if (m < 1) return 'Just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  }


  // ── Boot ──────────────────────────────────────────────────────
  async function init() {
    const user = auth.currentUser;
    const profile = state.citizenProfile;
    state.notifPermission = Notification.permission;

    // Register Service Worker
    if ('serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.register(
          '/rapidalert-citizen/sw.js',
          { scope: '/rapidalert-citizen/' }
        );
        state.swReady = true;
        console.info('[App] Service Worker registered.', reg.scope);
      } catch (err) {
        console.warn('[App] SW registration failed:', err);
      }
    }

    // Start Firestore alerts listener
    startAlertsListener(user, profile);

    // Init FCM (request push permission + register token)
    if (window.FCM) await FCM.initFCM();

    // Init Geo (request location + save to Firestore)
    if (window.Geo) await Geo.initGeo();

    // Handle URL params (deep links from notification clicks)
    const params = new URLSearchParams(window.location.search);
    if (params.get('sos') === '1') {
      setTimeout(() => showSOSView(), 600);
    } else if (params.get('alert')) {
      setTimeout(() => showAlertDetail(params.get('alert')), 600);
    } else {
      renderView();
    }

    // Auto-ring alarm if app was opened via notification tap (?alarm=Emergency)
    const alarmParam = params.get('alarm');
    if (alarmParam && ['Emergency', 'Evacuate', 'Warning'].includes(alarmParam)) {
      console.info('[App] Opened from notification — auto-ringing alarm for:', alarmParam);
      setTimeout(() => {
        if (window.AlarmSystem) {
          AlarmSystem.unlock().then(() => AlarmSystem.startAlarm(alarmParam));
        }
      }, 800);
    }

    // Listen for SW → app messages (notification action tapped OR auto-alarm)
    navigator.serviceWorker?.addEventListener('message', (e) => {
      if (e.data?.type === 'NOTIFICATION_ACTION') {
        if (e.data.action === 'sos') showSOSView();
        else if (e.data.action === 'safe') markSafe(e.data.alertId);
        else if (e.data.alertId) showAlertDetail(e.data.alertId);
      }

      // SW sends PLAY_ALARM when Emergency push arrives while app is open
      // Push event grants audio autoplay privilege — ring without tap!
      if (e.data?.type === 'PLAY_ALARM') {
        const sev = e.data.severity || 'Emergency';
        console.info('[App] PLAY_ALARM from SW — ringing:', sev);
        if (window.AlarmSystem) {
          AlarmSystem.unlock().then(() => {
            AlarmSystem.startAlarm(sev);
            if (navigator.vibrate) {
              navigator.vibrate(sev === 'Evacuate'
                ? [500, 100, 500, 100, 500, 100, 1000]
                : [300, 100, 300, 100, 600]);
            }
          });
        }
        // Show alarm overlay for the specific alert
        if (e.data.alertId) {
          const found = state.alerts.find(a => a.id === e.data.alertId);
          if (found) showAlarmOverlay(found);
        }
      }
    });

    // Listen for foreground FCM push event (from fcm.js)
    window.addEventListener('rapidalert:new-alert', (e) => {
      const newAlert = e.detail;
      if (!state.alerts.find(a => a.id === newAlert.alertId)) {
        // Firestore listener will add it; just trigger alarm
        if (window.AlarmSystem) {
          AlarmSystem.startAlarm(newAlert.severity);
        }
      }
    });

    // ── AudioContext & Fullscreen Unlock ──────────────────────────
    const unlockHandler = () => {
      if (window.AlarmSystem) AlarmSystem.unlock();
      document.removeEventListener('click', unlockHandler);
      document.removeEventListener('touchstart', unlockHandler);
      console.info('[App] User interaction detected — Audio/Vibration unlocked.');
    };
    document.addEventListener('click', unlockHandler);
    document.addEventListener('touchstart', unlockHandler);
  }


  // ── Firestore Alerts Listener ─────────────────────────────────
  function startAlertsListener(user, profile) {
    // Detach any existing listeners
    if (state._unsubAlerts) { state._unsubAlerts(); state._unsubAlerts = null; }
    if (state._unsubHistory) { state._unsubHistory(); state._unsubHistory = null; }

    // Listen to ALL active alerts (district filter can be added later)
    const alertsQ = query(
      collection(db, 'alerts'),
      where('active', '==', true),
      orderBy('timeSent', 'desc'),
      limit(50)
    );

    const knownIds = new Set(state.alerts.map(a => a.id));

    let _firstSnap = true;

    state._unsubAlerts = onSnapshot(alertsQ, (snap) => {
      const incoming = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      if (_firstSnap) {
        // First load: populate state, then ring alarm if active Emergency/Evacuate exists
        _firstSnap = false;
        state.alerts = incoming;
        incoming.forEach(a => knownIds.add(a.id));
        renderView();

        const SORD = { Evacuate: 4, Emergency: 3, Warning: 2, Info: 1 };
        const top = incoming
          .filter(a => ['Emergency', 'Evacuate'].includes(a.severity))
          .sort((a, b) => (SORD[b.severity] || 0) - (SORD[a.severity] || 0))[0];

        if (top && !state.activeAlarm) {
          console.info('[App] Active alert found on load — ringing alarm in 800ms');
          setTimeout(() => onNewAlert(top), 800);
        }
        return;
      }

      // Subsequent snapshots: only new alerts trigger alarm
      incoming.forEach(a => {
        if (!knownIds.has(a.id)) onNewAlert(a);
      });

      incoming.forEach(a => knownIds.add(a.id));
      state.alerts = incoming;
      renderView();

    }, (err) => {
      console.error('[App] Alerts listener error:', err.code, err.message);
    });

    // Listen to ALL inactive alerts for history tab
    const historyQ = query(
      collection(db, 'alerts'),
      where('active', '==', false),
      orderBy('timeSent', 'desc'),
      limit(20)
    );

    state._unsubHistory = onSnapshot(historyQ, (snap) => {
      state.alertHistory = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (state.currentView === 'history') renderView();
    }, (err) => {
      console.error('[App] Alerts history listener error:', err.code, err.message);
    });
  }


  // -- New Alert (geofence-aware) --
  function onNewAlert(alert) {
    var userLat = (state.citizenProfile && state.citizenProfile.lat) || window._lastGeoLat;
    var userLng = (state.citizenProfile && state.citizenProfile.lng) || window._lastGeoLng;
    if (userLat && userLng && alert.geofence && alert.geofence.type !== "none") {
      if (!isUserInAlertZone(userLat, userLng, alert.geofence)) {
        console.info("[App] User outside alert zone - no alarm.");
        return;
      }
    }
    showAlarmOverlay(alert);
    if (window.AlarmSystem) { AlarmSystem.startAlarm(alert.severity); state.activeAlarm = alert.id; }
    if (["Emergency", "Evacuate"].includes(alert.severity) && window.Geo) Geo.setEmergencyMode(true);
  }

  function isUserInAlertZone(lat, lng, geofence) {
    if (!geofence || geofence.type === "none") return true;
    if (geofence.type === "radius") {
      var R = 6371, dLat = (geofence.centerLat - lat) * Math.PI / 180, dLng = (geofence.centerLng - lng) * Math.PI / 180;
      var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat * Math.PI / 180) * Math.cos(geofence.centerLat * Math.PI / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) <= (geofence.radius || 5);
    }
    if (geofence.type === "polygon") {
      try {
        var gj = typeof geofence.geoJSON === "string" ? JSON.parse(geofence.geoJSON) : geofence.geoJSON;
        var coords = (gj && gj.geometry && gj.geometry.coordinates && gj.geometry.coordinates[0]) || (gj && gj.coordinates && gj.coordinates[0]);
        if (!coords) return true;
        var inside = false;
        for (var i = 0, j = coords.length - 1; i < coords.length; j = i++) {
          var xi = coords[i][0], yi = coords[i][1], xj = coords[j][0], yj = coords[j][1];
          if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
        }
        return inside;
      } catch (e) { return true; }
    }
    return true;
  }


  // ── Alarm Overlay ─────────────────────────────────────────────
  function showAlarmOverlay(alert) {
    const cfg = sevCfg(alert.severity);
    const overlay = document.createElement('div');
    overlay.id = 'alarm-overlay';
    overlay.className = `alarm-intensity-${alert.severity.toLowerCase()}`;
    overlay.innerHTML = `
      <div class="alarm-bg" style="background:${cfg.bg}"></div>
      <div class="alarm-content">
        <div class="alarm-flash-layer"></div>
        <div class="alarm-pulse-ring"></div>
        <div class="alarm-icon">${typeIcon(alert.type)}</div>
        <div class="alarm-severity" style="color:${cfg.color}">${cfg.emoji} ${alert.severity.toUpperCase()}</div>
        ${alert.isDrill ? '<div class="alarm-drill-badge">⚠️ THIS IS A DRILL</div>' : ''}
        <div class="alarm-type">${alert.type} Alert</div>
        <div class="alarm-area">📍 ${alert.area}</div>
        <div class="alarm-message">${alert.message}</div>
        <div class="alarm-time">Issued: ${formatTime(alert.timeSent)}</div>
        <div class="alarm-actions">
          <button class="alarm-btn safe-btn" onclick="App.markSafe('${alert.id}')">
            ✅ I Am Safe
          </button>
          <button class="alarm-btn sos-btn" onclick="App.showSOSView()">
            🆘 HELP / SOS
          </button>
        </div>
        <button class="alarm-dismiss" onclick="App.dismissAlarm()">
          Dismiss &amp; View Details
        </button>
      </div>`;
    document.body.appendChild(overlay);
    window.scrollTo(0, 0);
    // Request Wake Lock if possible
    if ('wakeLock' in navigator) {
      navigator.wakeLock.request('screen').catch(() => { });
    }
  }


  function dismissAlarm() {
    if (window.AlarmSystem) AlarmSystem.stopAlarm();
    state.activeAlarm = null;
    const o = document.getElementById('alarm-overlay');
    if (o) { o.classList.add('alarm-fade-out'); setTimeout(() => o.remove(), 400); }

    // Deactivate emergency tracking if no other top-tier alerts exist
    const hasEmergency = state.alerts.some(a => ['Emergency', 'Evacuate'].includes(a.severity));
    if (!hasEmergency && window.Geo) Geo.setEmergencyMode(false);

    renderView();
  }


  // ── Mark Safe (writes to Firestore safe_reports) ──────────────
  async function markSafe(alertId) {
    state.safeReportIds.add(alertId);
    if (window.AlarmSystem) { AlarmSystem.stopAlarm(); AlarmSystem.playSafeConfirmation?.(); }
    state.activeAlarm = null;
    const o = document.getElementById('alarm-overlay');
    if (o) { o.classList.add('alarm-fade-out'); setTimeout(() => o.remove(), 400); }
    showToast('✅ You have been marked as safe. Stay alert.', 'success', 4000);
    renderView();

    // Write to Firestore (non-blocking, best-effort)
    const user = auth.currentUser;
    if (user) {
      try {
        await setDoc(
          doc(db, 'safe_reports', `${user.uid}_${alertId}`),
          {
            citizenUid: user.uid,
            alertId,
            reportedAt: serverTimestamp(),
          },
          { merge: true }
        );
      } catch (err) {
        console.warn('[App] Safe report write failed (non-fatal):', err.message);
      }
    }
  }


  // ── Views ─────────────────────────────────────────────────────
  function renderView() {
    const root = document.getElementById('app-root');
    if (!root) return;
    switch (state.currentView) {
      case 'home': root.innerHTML = getHomeHTML(); attachHomeHandlers(); break;
      case 'alert-detail': root.innerHTML = getAlertDetailHTML(); attachDetailHandlers(); break;
      case 'sos': root.innerHTML = getSOSHTML(); attachSOSHandlers(); break;
      case 'history': root.innerHTML = getHistoryHTML(); break;
      case 'settings': root.innerHTML = getSettingsHTML(); attachSettingsHandlers(); break;
    }
  }

  function getHomeHTML() {
    const active = state.alerts.filter(a => !state.dismissedIds.has(a.id));
    const emergencyCount = active.filter(a => a.severity === 'Emergency' || a.severity === 'Evacuate').length;
    const warnCount = active.filter(a => a.severity === 'Warning').length;
    const name = (state.citizenProfile && state.citizenProfile.name) || 'Citizen';
    const now = new Date();
    const hour = now.getHours();
    const greeting = hour < 12 ? 'Good Morning' : hour < 17 ? 'Good Afternoon' : 'Good Evening';
    const safetyLevel = emergencyCount > 0 ? 'DANGER' : warnCount > 0 ? 'CAUTION' : 'SAFE';
    const safetyColor = emergencyCount > 0 ? '#ef4444' : warnCount > 0 ? '#f59e0b' : '#22c55e';
    const safetyBg = emergencyCount > 0 ? 'rgba(239,68,68,0.12)' : warnCount > 0 ? 'rgba(245,158,11,0.1)' : 'rgba(34,197,94,0.1)';
    const safetyEmoji = emergencyCount > 0 ? '\u{1F6A8}' : warnCount > 0 ? '\u26A0\uFE0F' : '\u2705';
    const tips = [
      { icon: '\u{1F4F1}', tip: 'Keep your phone charged above 50% during emergencies' },
      { icon: '\u{1F3C3}', tip: 'Know your nearest evacuation route in advance' },
      { icon: '\u{1F4A7}', tip: 'Store 3 days of water — 1 liter per person per day' },
      { icon: '\u{1F526}', tip: 'Keep a flashlight and first-aid kit at home' },
      { icon: '\u{1F4CB}', tip: 'Save emergency contacts: 100 Police, 101 Fire, 102 Ambulance' },
    ];
    const tip = tips[now.getMinutes() % tips.length];

    return `
      <div class="app-header ${emergencyCount > 0 ? 'header-emergency' : ''}">
        <div class="header-brand">\u{1F6A8} RapidAlert</div>
        <div class="header-status">
          <div class="status-dot ${emergencyCount > 0 ? 'pulse' : ''}"></div>
          <span>${emergencyCount > 0 ? emergencyCount + ' Emergency' : 'Monitoring'}</span>
        </div>
      </div>

      ${state.notifPermission !== 'granted' ? `
        <div class="perm-banner" id="perm-banner">
          <div>\u{1F514} Enable notifications for real-time alerts</div>
          <button class="perm-btn" id="enable-notif-btn">Enable</button>
        </div>` : ''}

      <div style="padding:14px;display:flex;flex-direction:column;gap:12px">

        <div style="background:${safetyBg};border:1px solid ${safetyColor}30;border-radius:16px;padding:16px;display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-size:12px;color:rgba(255,255,255,0.5);margin-bottom:2px">${greeting}, ${name}</div>
            <div style="font-size:22px;font-weight:800;color:${safetyColor}">${safetyEmoji} ${safetyLevel}</div>
            <div style="font-size:12px;color:rgba(255,255,255,0.5);margin-top:2px">${active.length} active alert${active.length !== 1 ? 's' : ''} in your region</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:36px">${safetyEmoji}</div>
            <div style="font-size:10px;color:rgba(255,255,255,0.4)">${now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</div>
          </div>
        </div>

        <div class="sos-strip" onclick="App.showSOSView()" style="margin:0">
          <span>\u{1F198} Emergency? Press here to send SOS</span>
          <span>&rsaquo;</span>
        </div>

        <div style="background:#12151c;border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden">
          <div style="padding:12px 14px 8px;display:flex;justify-content:space-between;align-items:center">
            <div style="font-size:14px;font-weight:700">\u{1F4CD} Live Location Map</div>
            <div id="map-gps-status" style="font-size:11px;color:#22c55e">● Locating…</div>
          </div>
          <div id="citizen-map" style="height:220px;width:100%;background:#0d1117"></div>
          <div style="padding:8px 14px;font-size:11px;color:rgba(255,255,255,0.35)">
            Your location is only used to deliver zone-matched alerts
          </div>
        </div>

        <div>
          <div style="font-size:13px;font-weight:700;margin-bottom:10px;color:rgba(255,255,255,0.7)">\u26A1 Quick Actions</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <button onclick="App.showSOSView()" style="background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);border-radius:14px;padding:16px 12px;text-align:left;color:#fff">
              <div style="font-size:24px;margin-bottom:6px">\u{1F198}</div>
              <div style="font-size:13px;font-weight:700">Send SOS</div>
              <div style="font-size:11px;color:rgba(255,255,255,0.4)">Alert authorities</div>
            </button>
            <button onclick="showHistory();setTab('history')" style="background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.25);border-radius:14px;padding:16px 12px;text-align:left;color:#fff">
              <div style="font-size:24px;margin-bottom:6px">\u{1F4CB}</div>
              <div style="font-size:13px;font-weight:700">Alert History</div>
              <div style="font-size:11px;color:rgba(255,255,255,0.4)">Past alerts</div>
            </button>
            <button onclick="callEmergency('100')" style="background:rgba(168,85,247,0.1);border:1px solid rgba(168,85,247,0.25);border-radius:14px;padding:16px 12px;text-align:left;color:#fff">
              <div style="font-size:24px;margin-bottom:6px">\u{1F694}</div>
              <div style="font-size:13px;font-weight:700">Call Police</div>
              <div style="font-size:11px;color:rgba(255,255,255,0.4)">Dial 100</div>
            </button>
            <button onclick="callEmergency('108')" style="background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.25);border-radius:14px;padding:16px 12px;text-align:left;color:#fff">
              <div style="font-size:24px;margin-bottom:6px">\u{1F691}</div>
              <div style="font-size:13px;font-weight:700">Ambulance</div>
              <div style="font-size:11px;color:rgba(255,255,255,0.4)">Dial 108</div>
            </button>
          </div>
        </div>

        <div>
          <div style="font-size:14px;font-weight:700;margin-bottom:10px">\u{1F6A8} Active Alerts</div>
          ${active.length === 0
        ? `<div class="empty-card" style="margin:0">
                 <div class="empty-icon">\u2705</div>
                 <div class="empty-title">All Clear</div>
                 <div class="empty-sub">No active alerts. Stay prepared.</div>
               </div>`
        : active.map(a => getAlertCardHTML(a)).join('')
      }
        </div>

        <div style="background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.2);border-radius:14px;padding:14px 16px;display:flex;gap:12px;align-items:flex-start">
          <div style="font-size:28px">${tip.icon}</div>
          <div>
            <div style="font-size:12px;font-weight:700;color:#3b82f6;margin-bottom:4px">\u{1F4A1} Safety Tip</div>
            <div style="font-size:13px;color:rgba(255,255,255,0.7);line-height:1.5">${tip.tip}</div>
          </div>
        </div>

        <div style="background:#12151c;border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:14px">
          <div style="font-size:13px;font-weight:700;margin-bottom:10px;color:rgba(255,255,255,0.7)">\u{1F4DE} Emergency Helplines</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            ${[['\u{1F694} Police', '100'], ['\u{1F692} Fire', '101'], ['\u{1F691} Ambulance', '102'], ['\u{1F3DB} NDMA', '1078']].map(([label, num]) => `
              <button onclick="callEmergency('${num}')" style="background:#1a1f2e;border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:2px;text-align:left;color:#fff">
                <span style="font-size:12px;color:rgba(255,255,255,0.5)">${label}</span>
                <span style="font-size:18px;font-weight:800;color:#ef4444">${num}</span>
              </button>`).join('')}
          </div>
        </div>

      </div>`;
  }

  function getAlertCardHTML(a) {
    const cfg = sevCfg(a.severity);
    const safe = state.safeReportIds.has(a.id);
    return `
      <div class="alert-card" style="border-color:${cfg.color};background:${cfg.bg}"
           onclick="App.showAlertDetail('${a.id}')">
        <div class="ac-header">
          <div class="ac-type">
            <span class="ac-icon">${typeIcon(a.type)}</span>
            <div>
              <div class="ac-title">${a.type} Alert ${a.isDrill ? '<span class="drill-tag">DRILL</span>' : ''}</div>
              <div class="ac-area">📍 ${a.area}</div>
            </div>
          </div>
          <div class="ac-sev" style="background:${cfg.color}15;color:${cfg.color};border:1px solid ${cfg.color}40">
            ${cfg.emoji} ${a.severity}
          </div>
        </div>
        <div class="ac-msg">${(a.message || '').substring(0, 100)}${(a.message || '').length > 100 ? '…' : ''}</div>
        <div class="ac-footer">
          <div class="ac-time">🕐 ${timeAgo(a.timeSent)}</div>
          ${safe
        ? '<div class="safe-chip">✅ Reported Safe</div>'
        : `<button class="safe-mini-btn" onclick="event.stopPropagation();App.markSafe('${a.id}')">✅ I'm Safe</button>`}
        </div>
      </div>`;
  }

  function attachHomeHandlers() {
    document.getElementById('enable-notif-btn')?.addEventListener('click', async () => {
      if (window.FCM) state.notifPermission = await FCM.requestPermission();
      if (state.notifPermission === 'granted' && window.FCM) await FCM.registerFCMToken();
      renderView();
      if (state.notifPermission === 'granted') {
        showToast('🔔 Notifications enabled!', 'success');
      }
    });

    // Init map after DOM is ready
    setTimeout(initCitizenMap, 100);
    // Wire callEmergency globally
    window.callEmergency = function (num) {
      if (confirm('Call ' + num + ' (Emergency)?')) window.location.href = 'tel:' + num;
    };
  }

  function showAlertDetail(alertId) {
    state.selectedAlertId = alertId;
    state.currentView = 'alert-detail';
    renderView();
  }

  function getAlertDetailHTML() {
    const a = state.alerts.find(x => x.id === state.selectedAlertId);
    if (!a) return `<div class="empty-card"><div class="empty-icon">🔍</div><div>Alert not found.</div></div>`;
    const cfg = sevCfg(a.severity);
    const safe = state.safeReportIds.has(a.id);
    return `
      <div class="detail-header" style="background:${cfg.bg};border-bottom:2px solid ${cfg.color}">
        <button class="back-btn" onclick="App.goHome()">‹ Back</button>
        <div class="detail-type">
          <span style="font-size:36px">${typeIcon(a.type)}</span>
          <div>
            <div class="detail-title">${a.type} Alert ${a.isDrill ? '<span class="drill-tag">DRILL</span>' : ''}</div>
            <div class="detail-sev" style="color:${cfg.color}">${cfg.emoji} ${a.severity}</div>
          </div>
        </div>
      </div>
      <div class="detail-body">
        <div class="detail-card" style="border-left:4px solid ${cfg.color}">
          <div class="detail-label">📢 Alert Message</div>
          <div class="detail-message">${a.message}</div>
        </div>
        <div class="detail-card">
          <div class="detail-label">📍 Affected Area</div>
          <div class="detail-value">${a.area}</div>
        </div>
        <div class="detail-row">
          <div class="detail-card" style="flex:1">
            <div class="detail-label">Alert ID</div>
            <div class="detail-value mono">${a.id}</div>
          </div>
          <div class="detail-card" style="flex:1">
            <div class="detail-label">Issued At</div>
            <div class="detail-value">${formatTime(a.timeSent)}</div>
          </div>
        </div>
        <div class="detail-card">
          <div class="detail-label">🗺️ What To Do</div>
          <div class="evac-steps">
            ${getEvacSteps(a.type, a.severity).map((s, i) =>
      `<div class="evac-step"><span class="evac-num">${i + 1}</span><span>${s}</span></div>`
    ).join('')}
          </div>
        </div>
        <div class="detail-card helpline-card">
          <div class="detail-label">📞 Emergency Helplines</div>
          <div class="helpline-row"><span>🚒 Fire &amp; Rescue</span><strong>101</strong></div>
          <div class="helpline-row"><span>🚑 Ambulance</span><strong>102</strong></div>
          <div class="helpline-row"><span>🚔 Police</span><strong>100</strong></div>
          <div class="helpline-row"><span>🏛️ NDMA Helpline</span><strong>1078</strong></div>
        </div>
        <div class="detail-actions">
          ${safe
        ? '<div class="safe-reported">✅ You reported safe for this alert</div>'
        : `<button class="daction-btn safe" onclick="App.markSafe('${a.id}')">✅ I Am Safe</button>`}
          <button class="daction-btn sos" onclick="App.showSOSView()">🆘 Send SOS / Need Help</button>
          <button class="daction-btn share" onclick="App.shareAlert('${a.id}')">📤 Share Alert</button>
        </div>
      </div>`;
  }

  function attachDetailHandlers() { }

  function getEvacSteps(type, severity) {
    const common = ['Stay calm.', 'Keep phone charged.', 'Carry ID and medications.'];
    const steps = {
      Earthquake: ['Drop, Cover, Hold.', 'Move away from windows.', 'Evacuate after shaking stops.'],
      Tsunami: ['Move to high ground immediately.', 'Do not return until all-clear.', 'Use official evacuation routes.'],
      Flood: ['Move to higher ground.', 'Avoid walking in floodwater.', 'Disconnect electrical appliances.'],
      Fire: ['Evacuate via escape routes.', 'Do not use elevators.', 'Cover mouth if smoky.'],
      Cyclone: ['Stay indoors away from windows.', 'Stock water and food for 3 days.', 'Avoid open areas.'],
      Other: ['Follow authority instructions.', 'Monitor official channels.'],
    };
    return [...(steps[type] || steps.Other), ...(severity === 'Evacuate' ? ['Evacuate NOW as directed.'] : []), ...common];
  }


  // ── SOS View ──────────────────────────────────────────────────
  function showSOSView() {
    dismissAlarm();
    state.currentView = 'sos';
    renderView();
  }

  function getSOSHTML() {
    const name = state.citizenProfile?.name || '';
    return `
      <div class="sos-view">
        <div class="sos-header">
          <button class="back-btn" onclick="App.goHome()">‹ Back</button>
          <div class="sos-title">🆘 Emergency SOS</div>
        </div>
        <div class="sos-panic-area">
          <div class="sos-ring-1"></div>
          <div class="sos-ring-2"></div>
          <div class="sos-ring-3"></div>
          <button class="sos-panic-btn" id="sos-panic-btn">
            <span style="font-size:40px">🆘</span>
            <span>SEND SOS</span>
            <span style="font-size:12px;opacity:0.8">Tap to alert authorities</span>
          </button>
        </div>
        <div class="sos-form-area">
          <div class="sos-form-label">Your Name</div>
          <input type="text" class="sos-input" id="sos-name"
                 placeholder="Enter your name" value="${name}">
          <div class="sos-form-label" style="margin-top:12px">Describe your emergency</div>
          <textarea class="sos-input" id="sos-desc" rows="3"
                    placeholder="E.g. I am trapped on 2nd floor, flooded…"></textarea>
          <div id="sos-location-status" class="sos-loc-status">📍 Getting your location…</div>
          <button class="sos-send-full-btn" id="sos-send-btn">🆘 Send SOS to Authorities</button>
          <div style="font-size:12px;color:rgba(255,255,255,0.5);text-align:center;margin-top:10px">
            Your location and details will be sent to emergency response teams.
          </div>
        </div>
        <div id="sos-sent-confirm" style="display:none">
          <div class="sos-confirm-card">
            <div style="font-size:48px;margin-bottom:12px">✅</div>
            <div class="sos-confirm-title">SOS Sent!</div>
            <div class="sos-confirm-msg">Authorities have been alerted. Help is on the way. Stay calm.</div>
            <div style="font-size:13px;margin-top:8px;opacity:0.7" id="sos-confirm-id"></div>
            <button class="sos-confirm-back" onclick="App.goHome()">← Back to Alerts</button>
          </div>
        </div>
      </div>`;
  }

  function attachSOSHandlers() {
    let userLocation = null;

    // Attempt geolocation for SOS
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          const el = document.getElementById('sos-location-status');
          if (el) el.innerHTML = `📍 ${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)} ✓`;
        },
        () => {
          const el = document.getElementById('sos-location-status');
          if (el) el.innerHTML = '📍 Location unavailable — SOS will still be sent.';
        },
        { enableHighAccuracy: true, timeout: 8000 }
      );
    } else {
      const el = document.getElementById('sos-location-status');
      if (el) el.innerHTML = '📍 Geolocation not supported.';
    }

    document.getElementById('sos-panic-btn')?.addEventListener('click', sendSOS);
    document.getElementById('sos-send-btn')?.addEventListener('click', sendSOS);

    async function sendSOS() {
      if (state._sendingSOS) return; // Protection

      const sendBtn = document.getElementById('sos-send-btn');
      const panicBtn = document.getElementById('sos-panic-btn');

      state._sendingSOS = true;
      if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = 'Sending…'; }
      if (panicBtn) { panicBtn.disabled = true; panicBtn.classList.add('loading'); }

      // Force emergency tracking immediately
      if (window.Geo) Geo.setEmergencyMode(true);

      const name = document.getElementById('sos-name')?.value.trim()
        || state.citizenProfile?.name || 'Anonymous';
      const message = document.getElementById('sos-desc')?.value.trim() || null;
      const user = auth.currentUser;

      const sosPayload = {
        citizenUid: user?.uid || 'anonymous',
        name,
        phone: user?.phoneNumber || state.citizenProfile?.phone || null,
        message,
        area: state.citizenProfile?.city || state.citizenProfile?.district || 'Unknown',
        district: state.citizenProfile?.district || null,
        status: 'Pending',
        time: serverTimestamp(),
        location: userLocation
          ? new window.FB.GeoPoint(userLocation.lat, userLocation.lng)
          : null,
        geohash: userLocation
          ? (window.Geo?.encodeGeohash(userLocation.lat, userLocation.lng, 9) || null)
          : null,
      };

      try {
        const docRef = await addDoc(collection(db, 'sos_requests'), sosPayload);

        if (window.AlarmSystem?.playSosConfirmation) AlarmSystem.playSosConfirmation();
        if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);

        document.querySelector('.sos-form-area').style.display = 'none';
        document.querySelector('.sos-panic-area').style.display = 'none';
        const confirmEl = document.getElementById('sos-sent-confirm');
        const confirmId = document.getElementById('sos-confirm-id');
        if (confirmEl) confirmEl.style.display = 'block';
        if (confirmId) confirmId.textContent = `SOS ID: ${docRef.id}`;
        showToast('🆘 SOS sent to authorities!', 'error', 5000);

        window.FB.logEvent('sos_sent', { district: sosPayload.district || 'unknown' });

      } catch (err) {
        console.error('[App] SOS addDoc error:', err);
        showToast(`Failed to send SOS: ${err.message}`, 'error', 6000);
        if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '🆘 Send SOS'; }
        if (panicBtn) panicBtn.disabled = false;
      } finally {
        state._sendingSOS = false;
      }
    }

  }

  // ── History View ──────────────────────────────────────────────
  function getHistoryHTML() {
    return `
      <div class="app-header">
        <button class="back-btn" style="color:#fff" onclick="App.goHome()">‹ Back</button>
        <div class="header-brand">📋 Alert History</div>
      </div>
      <div style="padding:12px">
        ${state.alerts.length === 0
        ? '<div class="empty-card"><div class="empty-icon">📋</div><div>No history yet.</div></div>'
        : state.alerts.map(a => getAlertCardHTML(a)).join('')}
      </div>`;
  }

  // ── Settings View ─────────────────────────────────────────────
  function getSettingsHTML() {
    const profile = state.citizenProfile || {};
    const geoStatus = state.lastGeoUpdate
      ? `✅ Updated ${timeAgo(state.lastGeoUpdate)}`
      : '⚠️ Not yet updated';
    return `
      <div class="app-header">
        <button class="back-btn" style="color:#fff" onclick="App.goHome()">‹ Back</button>
        <div class="header-brand">⚙️ Settings</div>
      </div>
      <div style="padding:16px;display:flex;flex-direction:column;gap:14px">
        <div class="settings-card">
          <div class="settings-label">Your Name</div>
          <input type="text" class="sos-input" id="set-name" value="${profile.name || ''}">
        </div>
        <div class="settings-card">
          <div class="settings-label">Mobile Number</div>
          <div style="font-size:14px;color:rgba(255,255,255,0.7)">${profile.phone || '—'}</div>
        </div>
        <div class="settings-card">
          <div class="settings-label">Notifications</div>
          <div class="settings-row">
            <span>Push Notifications</span>
            <span style="color:${state.notifPermission === 'granted' ? '#22c55e' : '#ef4444'}">
              ${state.notifPermission === 'granted' ? '✅ Enabled' : '❌ Disabled'}
            </span>
          </div>
        </div>
        <div class="settings-card">
          <div class="settings-label">Location</div>
          <div class="settings-row"><span>Geolocation</span><span>${geoStatus}</span></div>
        </div>
        <div class="settings-card">
          <div class="settings-label">System</div>
          <div class="settings-row"><span>User ID</span><span class="mono">${profile.uid?.slice(0, 12) || '—'}…</span></div>
          <div class="settings-row"><span>SW Status</span><span>${state.swReady ? '✅ Active' : '⚠️ Inactive'}</span></div>
        </div>
        <button class="daction-btn safe" id="save-settings-btn">💾 Save Settings</button>
        <button class="daction-btn" style="background:rgba(59,130,246,0.1);border-color:rgba(59,130,246,0.3);color:#3b82f6"
                id="install-pwa-btn">📲 Install App on Home Screen</button>
        <button class="daction-btn" style="background:rgba(239,68,68,0.1);border-color:rgba(239,68,68,0.3);color:#ef4444"
                id="logout-btn">🔓 Logout</button>
      </div>`;
  }

  function attachSettingsHandlers() {
    document.getElementById('save-settings-btn')?.addEventListener('click', async () => {
      const name = document.getElementById('set-name')?.value.trim();
      if (name && auth.currentUser) {
        state.citizenProfile = { ...state.citizenProfile, name };
        try {
          // Use the imported updateDoc and doc (not window.FB which may not expose updateDoc)
          const { updateDoc: fsUpdateDoc, doc: fsDoc } = await import(
            'https://www.gstatic.com/firebasejs/10.12.1/firebase-firestore.js'
          );
          await fsUpdateDoc(fsDoc(db, 'users', auth.currentUser.uid), { name });
          showToast('✅ Name saved.', 'success');
        } catch (err) {
          console.error('[Settings] updateDoc error:', err);
          showToast('Failed to save. Try again.', 'error');
        }
      }
    });
    document.getElementById('install-pwa-btn')?.addEventListener('click', () => {
      if (window.triggerInstall) {
        window.triggerInstall();
      } else {
        showToast('To install: tap the browser menu → "Add to Home Screen"', 'info', 6000);
      }
    });
    document.getElementById('logout-btn')?.addEventListener('click', async () => {
      if (state._unsubAlerts) { state._unsubAlerts(); state._unsubAlerts = null; }
      if (state._unsubHistory) { state._unsubHistory(); state._unsubHistory = null; }
      if (window.Auth) await Auth.logout();
      window.location.reload();
    });
  }

  // -- Citizen Map --

  // -- Citizen Map --
  function initCitizenMap() {
    const mapEl = document.getElementById('citizen-map');
    if (!mapEl) return;
    const statusEl = document.getElementById('map-gps-status');
    // Leaflet is already loaded in <head>, call directly
    if (window.L) {
      _initLeafletMap(mapEl, statusEl);
    } else {
      // Fallback: wait for Leaflet
      let tries = 0;
      const wait = setInterval(function () {
        if (window.L) { clearInterval(wait); _initLeafletMap(mapEl, statusEl); }
        if (++tries > 20) clearInterval(wait);
      }, 200);
    }
  }

  function _initLeafletMap(mapEl, statusEl) {
    // Prevent double init
    if (mapEl._leafletMap) {
      try { mapEl._leafletMap.off(); mapEl._leafletMap.remove(); } catch (e) { }
      mapEl._leafletMap = null;
      delete mapEl._leaflet_id;
    }
    mapEl.innerHTML = '';

    var defaultLat = 21.1458, defaultLng = 79.0882; // Nagpur center
    var map = L.map(mapEl, {
      zoomControl: true,
      attributionControl: false,
      preferCanvas: true
    }).setView([defaultLat, defaultLng], 12);

    // Use OpenStreetMap tiles with a dark CSS filter (best quality, free, reliable)
    // The filter makes it dark-themed while keeping all road details visible
    var tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      subdomains: 'abc',
      crossOrigin: true
    }).addTo(map);

    // Apply dark mode filter to tiles
    tileLayer.getContainer && setTimeout(function () {
      var container = tileLayer.getContainer ? tileLayer.getContainer() : null;
      if (container) {
        container.style.filter = 'invert(0.9) hue-rotate(180deg) brightness(1.4) contrast(1.3)';
      }
    }, 500);

    mapEl._leafletMap = map;

    // Add CSS filter to the pane for dark mode effect
    var tilesPane = map.getPane('tilePane');
    if (tilesPane) {
      tilesPane.style.filter = 'invert(0.9) hue-rotate(180deg) brightness(1.4) contrast(1.3)';
    }

    // invalidateSize multiple times to ensure tiles fill container
    setTimeout(function () { try { map.invalidateSize(true); } catch (e) { } }, 150);
    setTimeout(function () { try { map.invalidateSize(true); } catch (e) { } }, 600);
    setTimeout(function () { try { map.invalidateSize(true); } catch (e) { } }, 1500);

    // Add existing alert zone markers
    var alerts = state.alerts || [];
    alerts.forEach(function (a) {
      if (!a.geofence) return;
      var lat = a.geofence.centerLat, lng = a.geofence.centerLng;
      if (!lat || !lng) return;
      var color = (a.severity === 'Emergency' || a.severity === 'Evacuate') ? '#ef4444'
        : a.severity === 'Warning' ? '#f59e0b' : '#3b82f6';
      L.circle([lat, lng], {
        radius: (a.geofence.radius || 1) * 1000,
        color: color, fillColor: color, fillOpacity: 0.15, weight: 2
      }).addTo(map).bindPopup(
        '<b style="color:' + color + '">' + (a.type || 'Alert') + '</b><br>' +
        (a.area || '') + '<br>Severity: ' + a.severity
      );
    });

    // Pulsing CSS for user marker (injected once)
    if (!document.getElementById('map-pulse-css')) {
      var style = document.createElement('style');
      style.id = 'map-pulse-css';
      style.textContent = '@keyframes mapPulse{0%,100%{box-shadow:0 0 0 0 rgba(34,197,94,0.7)}50%{box-shadow:0 0 0 14px rgba(34,197,94,0)}}' +
        '.user-location-dot{width:18px;height:18px;background:#22c55e;border-radius:50%;border:3px solid #fff;animation:mapPulse 1s infinite; box-shadow: 0 0 20px rgba(34,197,94,0.8); z-index: 10001;position:relative}';
      document.head.appendChild(style);
    }

    // Request GPS location
    if (statusEl) { statusEl.textContent = '● Getting location…'; statusEl.style.color = '#f59e0b'; }

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          var lat = pos.coords.latitude;
          var lng = pos.coords.longitude;
          var acc = pos.coords.accuracy; // meters
          window._lastGeoLat = lat;
          window._lastGeoLng = lng;

          // Animated user marker
          var userIcon = L.divIcon({
            html: '<div class="user-location-dot"></div>',
            iconSize: [18, 18],
            iconAnchor: [9, 9],
            className: ''
          });

          L.marker([lat, lng], { icon: userIcon, zIndexOffset: 1000 })
            .addTo(map)
            .bindPopup(
              '<b style="color:#22c55e">\u{1F4CD} You are here</b><br>' +
              'Lat: ' + lat.toFixed(5) + '<br>' +
              'Lng: ' + lng.toFixed(5) + '<br>' +
              'Accuracy: ±' + Math.round(acc) + 'm'
            ).openPopup();

          // Accuracy circle
          if (acc < 1000) {
            L.circle([lat, lng], {
              radius: acc,
              color: '#22c55e',
              fillColor: '#22c55e',
              fillOpacity: 0.05,
              weight: 1,
              dashArray: '4'
            }).addTo(map);
          }

          // Fly to user location smoothly
          map.flyTo([lat, lng], 15, { duration: 1.2 });

          setTimeout(function () { try { map.invalidateSize(true); } catch (e) { } }, 200);

          if (statusEl) { statusEl.textContent = '● GPS Active (±' + Math.round(acc) + 'm)'; statusEl.style.color = '#22c55e'; }
        },
        function (err) {
          var msg = err.code === 1 ? 'Location denied' : err.code === 2 ? 'No GPS signal' : 'GPS timeout';
          if (statusEl) { statusEl.textContent = '● ' + msg; statusEl.style.color = '#f59e0b'; }
          // Show India overview if no GPS
          map.setView([20.5937, 78.9629], 5);
          setTimeout(function () { try { map.invalidateSize(true); } catch (e) { } }, 200);
        },
        { timeout: 12000, enableHighAccuracy: true, maximumAge: 30000 }
      );
    } else {
      if (statusEl) { statusEl.textContent = '● GPS not supported'; statusEl.style.color = '#6b7280'; }
    }
  }

  function _initLeafletMap(mapEl, statusEl) {
    // Prevent double init
    if (mapEl._leafletMap) { mapEl._leafletMap.remove(); mapEl._leafletMap = null; }

    const defaultLat = 20.5937, defaultLng = 78.9629; // India center
    const map = L.map(mapEl, { zoomControl: true, attributionControl: false })
      .setView([defaultLat, defaultLng], 5);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd', maxZoom: 18
    }).addTo(map);

    mapEl._leafletMap = map;

    // Add alert zone markers
    var alerts = state.alerts || [];
    alerts.forEach(function (a) {
      if (!a.geofence) return;
      var lat = a.geofence.centerLat, lng = a.geofence.centerLng;
      if (!lat || !lng) return;
      var color = a.severity === 'Emergency' || a.severity === 'Evacuate' ? '#ef4444'
        : a.severity === 'Warning' ? '#f59e0b' : '#3b82f6';
      var radius = (a.geofence.radius || 1) * 1000;
      L.circle([lat, lng], { radius: radius, color: color, fillColor: color, fillOpacity: 0.12, weight: 2 })
        .addTo(map)
        .bindPopup('<b>' + a.type + '</b><br>' + (a.area || '') + '<br><span style="color:' + color + '">' + a.severity + '</span>');
      L.marker([lat, lng], {
        icon: L.divIcon({ html: '<div style="background:' + color + ';width:10px;height:10px;border-radius:50%;border:2px solid #fff"></div>', iconSize: [10, 10], className: '' })
      }).addTo(map).bindPopup('<b>' + (a.area || 'Alert Zone') + '</b><br>' + a.severity);
    });

    // Get user GPS
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(function (pos) {
        var lat = pos.coords.latitude, lng = pos.coords.longitude;
        // Store for geofence checks
        window._lastGeoLat = lat;
        window._lastGeoLng = lng;

        var userIcon = L.divIcon({
          html: '<div style="width:16px;height:16px;background:#22c55e;border-radius:50%;border:3px solid #fff;box-shadow:0 0 10px rgba(34,197,94,0.8)"></div>',
          iconSize: [16, 16], className: ''
        });
        L.marker([lat, lng], { icon: userIcon }).addTo(map).bindPopup('<b>You are here</b>').openPopup();
        map.setView([lat, lng], alerts.length > 0 ? 11 : 13);
        if (statusEl) statusEl.textContent = '● GPS Active';
        if (statusEl) statusEl.style.color = '#22c55e';
      }, function () {
        if (statusEl) { statusEl.textContent = '● Location denied'; statusEl.style.color = '#f59e0b'; }
        // Show India if no GPS
        map.setView([20.5937, 78.9629], 5);
      }, { timeout: 8000, enableHighAccuracy: true });
    }
  }


  // ── Navigation ────────────────────────────────────────────────
  function goHome() { state.currentView = 'home'; setActiveTab('home'); renderView(); }
  function setActiveTab(tab) {
    document.querySelectorAll('.tab-item').forEach(el => {
      el.classList.toggle('active', el.dataset.tab === tab);
    });
  }
  function shareAlert(alertId) {
    const a = state.alerts.find(x => x.id === alertId);
    if (!a) return;
    const text = `🚨 ${a.type} Alert (${a.severity})\n📍 ${a.area}\n📢 ${a.message}\n\nStay safe! – RapidAlert`;
    if (navigator.share) { navigator.share({ title: `RapidAlert: ${a.type}`, text }); }
    else { navigator.clipboard?.writeText(text); showToast('📋 Alert copied!', 'info'); }
  }
  function showToast(msg, type = 'info', duration = 3500) {
    let c = document.getElementById('toast-container');
    if (!c) { c = document.createElement('div'); c.id = 'toast-container'; document.body.appendChild(c); }
    const icons = { success: '✅', error: '🆘', warning: '⚠️', info: 'ℹ️' };
    const t = document.createElement('div');
    t.className = `app-toast ${type}`;
    t.innerHTML = `<span>${icons[type]}</span><span>${msg}</span>`;
    c.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, duration);
  }

  // -- Expose public API --
  function renderSettings() { state.currentView = "settings"; renderView(); }

  return {
    init, onNewAlert, dismissAlarm, markSafe,
    showAlertDetail, showSOSView, goHome, shareAlert, showToast, renderSettings, renderView,
    get state() { return state; },
    setCitizenProfile(p) {
      state.citizenProfile = p;
      if (p && p.lat) window._lastGeoLat = p.lat;
      if (p && p.lng) window._lastGeoLng = p.lng;
    },
  };

})();

window.App = App;
