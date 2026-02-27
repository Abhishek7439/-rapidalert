/* ============================================================
   RapidAlert – dashboard.js  (AI Command Center — Live Edition)
   Smart in-place updates: stats refresh without map rebuild.
   ============================================================ */

let _dashboardActive = false;
let _dashboardMap = null;
let _heatmapLayer = null;
let _markerLayer = null;
let _statInterval = null;
let _clockInterval = null;
let _realStats = { users: 0, totalAlerts: 0 };

function renderDashboard(container) {
  const { state } = App;

  // If #sos-map doesn't exist, the user navigated away and back → full rebuild
  const isMounted = !!document.getElementById('sos-map');
  if (!isMounted) {
    _dashboardActive = false;
    _dashboardMap = null;   // force Leaflet re-init
    clearInterval(_statInterval);
    clearInterval(_clockInterval);
  }

  if (!_dashboardActive) {
    _buildDashboardHTML(container, state);
    _dashboardActive = true;
    _fetchRealStats();
    _loadAIDashboard();
    // Use requestAnimationFrame so map container is painted before init
    requestAnimationFrame(() => _initSOSMap());
    _startStatRefresh();
    _startClock();
  } else {
    // Firestore snapshot arrived → patch in-place, no map rebuild
    _updateStatsInPlace(state);
    _updateLiveFeed(state);
    _loadAIDashboard();
  }
}

// ── Build the full HTML (only once) ─────────────────────────────────────────
function _buildDashboardHTML(container, state) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const statusOk = (state.systemStatus?.overall || 'Online') !== 'Offline';

  container.innerHTML = `
  <!-- ── HERO HEADER ─────────────────────────────────────── -->
  <div id="dash-hero" style="
    background: linear-gradient(135deg,rgba(232,65,65,0.10) 0%,rgba(124,58,237,0.07) 50%,rgba(13,17,23,0) 100%);
    border:1px solid rgba(232,65,65,0.18);
    border-radius:16px;padding:22px 26px;margin-bottom:20px;
    display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:14px;
    position:relative;overflow:hidden;">
    <div style="position:absolute;top:-30px;right:-30px;width:180px;height:180px;
      background:radial-gradient(circle,rgba(232,65,65,0.08),transparent 70%);pointer-events:none"></div>
    <div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span id="hero-dot" style="width:9px;height:9px;background:${statusOk ? '#22c55e' : '#ef4444'};border-radius:50%;
          box-shadow:0 0 0 3px ${statusOk ? 'rgba(34,197,94,0.22)' : 'rgba(239,68,68,0.22)'};display:inline-block"></span>
        <span id="hero-status" style="font-size:11px;font-weight:700;color:${statusOk ? '#22c55e' : '#ef4444'};
          text-transform:uppercase;letter-spacing:1px">System ${state.systemStatus?.overall || 'Online'}</span>
      </div>
      <h1 style="font-size:24px;font-weight:900;letter-spacing:-0.6px;margin-bottom:3px;
        background:linear-gradient(90deg,#e6edf3,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent">
        RapidAlert AI Command Center
      </h1>
      <p style="font-size:12px;color:var(--text-muted)">${dateStr}&nbsp;&nbsp;·&nbsp;&nbsp;<span id="dash-clock">${timeStr}</span></p>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn btn-primary" onclick="App.navigate('create-alert')" style="box-shadow:0 4px 16px rgba(232,65,65,0.3)">🚨 Issue Alert</button>
      <button class="btn btn-secondary" onclick="App.navigate('sos-requests')">🆘 SOS Center</button>
    </div>
  </div>

  <!-- ── STAT CARDS ──────────────────────────────────────── -->
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px" class="stat-grid">

    <div onclick="App.navigate('active-alerts')"
      style="background:linear-gradient(135deg,rgba(239,68,68,0.1),var(--bg-card));
        border:1px solid rgba(239,68,68,0.22);border-radius:14px;padding:18px;cursor:pointer;
        transition:transform .18s,box-shadow .18s;position:relative;overflow:hidden"
      onmouseover="this.style.transform='translateY(-3px)';this.style.boxShadow='0 8px 24px rgba(239,68,68,0.18)'"
      onmouseout="this.style.transform='';this.style.boxShadow=''">
      <div style="position:absolute;top:-16px;right:-16px;font-size:56px;opacity:0.06;pointer-events:none">🚨</div>
      <div style="font-size:10px;font-weight:700;color:#ef4444;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px">Active Alerts</div>
      <div id="stat-alerts" style="font-size:40px;font-weight:900;color:#ef4444;line-height:1;margin-bottom:5px">—</div>
      <div style="font-size:11px;color:var(--text-muted)">Live broadcasts →</div>
    </div>

    <div onclick="App.navigate('sos-requests')"
      style="background:linear-gradient(135deg,rgba(245,158,11,0.1),var(--bg-card));
        border:1px solid rgba(245,158,11,0.22);border-radius:14px;padding:18px;cursor:pointer;
        transition:transform .18s,box-shadow .18s;position:relative;overflow:hidden"
      onmouseover="this.style.transform='translateY(-3px)';this.style.boxShadow='0 8px 24px rgba(245,158,11,0.18)'"
      onmouseout="this.style.transform='';this.style.boxShadow=''">
      <div style="position:absolute;top:-16px;right:-16px;font-size:56px;opacity:0.06;pointer-events:none">🆘</div>
      <div style="font-size:10px;font-weight:700;color:#f59e0b;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px">SOS Pending</div>
      <div id="stat-sos" style="font-size:40px;font-weight:900;color:#f59e0b;line-height:1;margin-bottom:5px">—</div>
      <div style="font-size:11px;color:var(--text-muted)">Needs response →</div>
    </div>

    <div style="background:linear-gradient(135deg,rgba(59,130,246,0.1),var(--bg-card));
        border:1px solid rgba(59,130,246,0.22);border-radius:14px;padding:18px;
        position:relative;overflow:hidden">
      <div style="position:absolute;top:-16px;right:-16px;font-size:56px;opacity:0.06;pointer-events:none">👥</div>
      <div style="font-size:10px;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px">Registered Users</div>
      <div id="stat-users" style="font-size:40px;font-weight:900;color:#3b82f6;line-height:1;margin-bottom:5px">—</div>
      <div style="font-size:11px;color:var(--text-muted)">Citizens protected</div>
    </div>

    <div style="background:linear-gradient(135deg,rgba(124,58,237,0.1),var(--bg-card));
        border:1px solid rgba(124,58,237,0.22);border-radius:14px;padding:18px;
        position:relative;overflow:hidden">
      <div style="position:absolute;top:-16px;right:-16px;font-size:56px;opacity:0.06;pointer-events:none">🤖</div>
      <div style="font-size:10px;font-weight:700;color:#a78bfa;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px">Total Alerts Sent</div>
      <div id="stat-total-alerts" style="font-size:40px;font-weight:900;color:#a78bfa;line-height:1;margin-bottom:5px">—</div>
      <div style="font-size:11px;color:var(--text-muted)">All time dispatched</div>
    </div>
  </div>

  <!-- ── LIVE FEED + TIMELINE ──────────────────────────────── -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:20px" class="feed-grid">

    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:18px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div>
          <div style="font-size:13px;font-weight:700">📡 Live Alerts</div>
          <div style="font-size:11px;color:var(--text-muted)">Real-time broadcasts</div>
        </div>
        <button class="btn btn-sm" onclick="App.navigate('active-alerts')"
          style="background:rgba(239,68,68,0.10);border:1px solid rgba(239,68,68,0.25);color:#ef4444;font-size:11px">View All →</button>
      </div>
      <div id="dash-live-alerts" style="max-height:280px;overflow-y:auto">
        <div style="text-align:center;padding:28px;color:var(--text-muted)">
          <div style="font-size:28px;opacity:0.5">⏳</div>
          <div style="font-size:12px;margin-top:8px">Loading alerts…</div>
        </div>
      </div>
    </div>

    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:18px">
      <div style="margin-bottom:14px">
        <div style="font-size:13px;font-weight:700">🕐 Activity Timeline</div>
        <div style="font-size:11px;color:var(--text-muted)">All recent events</div>
      </div>
      <div id="dash-timeline" style="max-height:280px;overflow-y:auto">
        <div style="text-align:center;padding:28px;color:var(--text-muted)">
          <div style="font-size:28px;opacity:0.5">⏳</div>
          <div style="font-size:12px;margin-top:8px">Loading events…</div>
        </div>
      </div>
    </div>
  </div>

  <!-- ── AI RISK INTELLIGENCE ──────────────────────────────── -->
  <div id="ai-risk-card" style="
    background:linear-gradient(135deg,rgba(124,58,237,0.07),rgba(232,65,65,0.03),var(--bg-card));
    border:1px solid rgba(124,58,237,0.26);border-radius:14px;padding:20px;
    margin-bottom:20px;position:relative;overflow:hidden">
    <div style="position:absolute;top:-50px;right:-50px;width:220px;height:220px;
      background:radial-gradient(circle,rgba(124,58,237,0.09),transparent 65%);pointer-events:none"></div>

    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:10px">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="width:42px;height:42px;background:linear-gradient(135deg,#7c3aed,#ef4444);
          border-radius:12px;display:flex;align-items:center;justify-content:center;
          font-size:20px;box-shadow:0 4px 14px rgba(124,58,237,0.38);flex-shrink:0">🤖</div>
        <div>
          <div style="font-weight:900;font-size:16px;
            background:linear-gradient(90deg,#a78bfa,#f87171);
            -webkit-background-clip:text;-webkit-text-fill-color:transparent">
            AI Risk Intelligence Engine</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:1px">
            Real-time NLP &bull; Pattern Detection &bull; Predictive Risk Scoring</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-shrink:0">
        <div id="ai-spike-badge" style="display:none;background:rgba(239,68,68,0.14);
          border:1px solid rgba(239,68,68,0.38);color:#ef4444;
          padding:4px 12px;border-radius:20px;font-size:11px;font-weight:700">⚡ SOS SPIKE</div>
        <button class="btn btn-sm" onclick="window._reloadAIDashboard && _reloadAIDashboard()"
          style="background:rgba(124,58,237,0.1);border:1px solid rgba(124,58,237,0.28);color:#a78bfa;font-size:11px">↻ Refresh</button>
      </div>
    </div>

    <div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:16px">
      <span style="background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.22);color:#60a5fa;padding:3px 11px;border-radius:20px;font-size:10.5px;font-weight:600">🧠 NLP Severity</span>
      <span style="background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.22);color:#4ade80;padding:3px 11px;border-radius:20px;font-size:10.5px;font-weight:600">📊 Risk Predictor</span>
      <span style="background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.22);color:#fbbf24;padding:3px 11px;border-radius:20px;font-size:10.5px;font-weight:600">⚡ Spike Detector</span>
      <span style="background:rgba(124,58,237,0.1);border:1px solid rgba(124,58,237,0.22);color:#a78bfa;padding:3px 11px;border-radius:20px;font-size:10.5px;font-weight:600">🗺️ Geofence AI</span>
    </div>
    <div id="ai-risk-body">
      <div style="text-align:center;padding:20px;color:var(--text-muted)">
        <div style="font-size:28px">🤖</div><p style="font-size:12px;margin-top:8px">Computing risk scores…</p>
      </div>
    </div>
  </div>

  <!-- ── SOS HEATMAP ──────────────────────────────────────── -->
  <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:18px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:10px">
      <div>
        <div style="font-size:13px;font-weight:700">📍 Live SOS Density Heatmap</div>
        <div style="font-size:11px;color:var(--text-muted)">Real-time emergency clusters</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;cursor:pointer;color:var(--text-secondary)">
          Heatmap <input type="checkbox" id="heatmap-toggle" checked
            onclick="window._toggleHeatmap && _toggleHeatmap(this.checked)"
            style="accent-color:var(--brand);width:14px;height:14px">
        </label>
        <button class="btn btn-sm btn-secondary" onclick="App.navigate('sos-requests')">Response Center →</button>
      </div>
    </div>
    <div id="sos-map" style="height:350px;border-radius:10px;border:1px solid var(--border);overflow:hidden"></div>
  </div>`;

  // Immediately fill whatever data is already in state
  _updateStatsInPlace(state);
  _updateLiveFeed(state);
}

// ── In-place stat update (no DOM rebuild) ────────────────────────────────────
function _updateStatsInPlace(state) {
  const { getPendingSOS } = App;

  const elAlerts = document.getElementById('stat-alerts');
  const elSOS = document.getElementById('stat-sos');
  const elUsers = document.getElementById('stat-users');
  const elTotal = document.getElementById('stat-total-alerts');

  if (elAlerts) elAlerts.textContent = state.activeAlerts.length;
  if (elSOS) elSOS.textContent = getPendingSOS();
  if (elUsers) elUsers.textContent = _realStats.users > 0 ? _realStats.users : (state.users?.length || '—');
  if (elTotal) elTotal.textContent = _realStats.totalAlerts > 0
    ? _realStats.totalAlerts
    : (state.activeAlerts.length + state.alertHistory.length) || '—';
}

// ── Live feed update (only the feed DIVs) ────────────────────────────────────
function _updateLiveFeed(state) {
  const { alertTypeIcon, formatTime, timeAgo, severityColor } = App;
  const alertsEl = document.getElementById('dash-live-alerts');
  const timelineEl = document.getElementById('dash-timeline');
  if (!alertsEl || !timelineEl) return;

  // Live Alerts
  if (state.activeAlerts.length === 0) {
    alertsEl.innerHTML = `<div style="text-align:center;padding:28px;color:var(--text-muted)">
      <div style="font-size:30px;opacity:0.5">✅</div>
      <div style="font-size:12px;margin-top:8px">No active alerts — all clear</div></div>`;
  } else {
    alertsEl.innerHTML = state.activeAlerts.map(a => {
      const col = severityColor(a.severity);
      return `<div style="display:flex;align-items:center;gap:10px;padding:9px 0;
          border-bottom:1px solid rgba(255,255,255,0.04);cursor:pointer" onclick="App.navigate('active-alerts')">
        <div style="width:34px;height:34px;background:${col}18;border:1px solid ${col}30;
          border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">
          ${alertTypeIcon(a.type)}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            ${a.type} – ${a.area.split('–')[0].trim()}</div>
          <div style="font-size:11px;color:var(--text-muted)">${formatTime(a.timeSent)} · ${a.reach || 0} notified</div>
        </div>
        <span style="font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:20px;
          background:${col}18;color:${col};border:1px solid ${col}30;white-space:nowrap">${a.severity}</span>
      </div>`;
    }).join('');
  }

  // Timeline
  const events = [
    ...state.activeAlerts.map(a => ({
      icon: alertTypeIcon(a.type), ts: a.timeSent,
      text: `<strong>${a.type} ${a.severity}</strong> – ${a.area.split('–')[0].trim()}`,
      col: severityColor(a.severity)
    })),
    ...state.sosRequests.filter(s => s.status === 'Pending').map(s => ({
      icon: '🆘', ts: s.time,
      text: `<strong>SOS: ${s.name || 'Unknown'}</strong> – ${s.area || 'Unknown location'}`,
      col: '#ef4444'
    })),
    ...state.safeReports.map(r => ({
      icon: '✅', ts: r.reportedAt,
      text: `<strong>${r.name || 'Citizen'}</strong> marked Safe`,
      col: '#22c55e'
    })),
    ...state.alertHistory.slice(0, 5).map(a => ({
      icon: '📁', ts: a.timeSent,
      text: `Alert resolved: ${a.type} ${a.severity} – ${(a.area || '').split('–')[0].trim()}`,
      col: '#6b7280'
    })),
  ].filter(e => e.ts).sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 10);

  if (events.length === 0) {
    timelineEl.innerHTML = `<div style="text-align:center;padding:28px;color:var(--text-muted)">
      <div style="font-size:28px;opacity:0.5">🕐</div>
      <div style="font-size:12px;margin-top:8px">No recent activity</div></div>`;
  } else {
    timelineEl.innerHTML = events.map(e => `
      <div style="display:flex;align-items:flex-start;gap:9px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
        <div style="width:26px;height:26px;background:var(--bg-secondary);border-radius:6px;
          display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;margin-top:1px">
          ${e.icon}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:12.5px;line-height:1.4">${e.text}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:1px">${App.timeAgo(e.ts)}</div>
        </div>
      </div>`).join('');
  }
}

// ── Fetch REAL stats from Firestore ─────────────────────────────────────────
async function _fetchRealStats() {
  try {
    const { collection, getCountFromServer, query } = await import(
      'https://www.gstatic.com/firebasejs/10.12.1/firebase-firestore.js'
    );
    const db = window.FB.db;

    const [usersSnap, alertsSnap] = await Promise.all([
      getCountFromServer(collection(db, 'users')),
      getCountFromServer(collection(db, 'alerts')),
    ]);

    _realStats.users = usersSnap.data().count;
    _realStats.totalAlerts = alertsSnap.data().count;
    _updateStatsInPlace(App.state);
  } catch (err) {
    // getCountFromServer might not be available in older SDK — fallback
    console.warn('[Dashboard] Count API not available, falling back');
    try {
      const { collection, getDocs, query, limit } = await import(
        'https://www.gstatic.com/firebasejs/10.12.1/firebase-firestore.js'
      );
      const db = window.FB.db;
      const usersSnap = await getDocs(query(collection(db, 'users'), limit(500)));
      _realStats.users = usersSnap.size;
      _updateStatsInPlace(App.state);
    } catch (e) {
      console.warn('[Dashboard] Fallback count failed:', e.message);
    }
  }
}

// ── Auto-refresh stats every 10 seconds ─────────────────────────────────────
function _startStatRefresh() {
  clearInterval(_statInterval);
  _statInterval = setInterval(() => {
    if (!document.getElementById('stat-alerts')) {
      // Dashboard unmounted
      clearInterval(_statInterval);
      clearInterval(_clockInterval);
      _dashboardActive = false;
      return;
    }
    _updateStatsInPlace(App.state);
  }, 10000);
}

// ── Live clock ────────────────────────────────────────────────────────────────
function _startClock() {
  clearInterval(_clockInterval);
  _clockInterval = setInterval(() => {
    const el = document.getElementById('dash-clock');
    if (el) el.textContent = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }, 1000);
}

// ── AI Dashboard Loader ──────────────────────────────────────────────────────
async function _loadAIDashboard() {
  const body = document.getElementById('ai-risk-body');
  if (!body) return;
  window._reloadAIDashboard = _loadAIDashboard;

  const ai = window.RapidAlertAI;
  if (!ai) {
    body.innerHTML = `<div style="text-align:center;padding:16px;color:var(--text-muted)">⏳ AI engine loading…</div>`;
    setTimeout(_loadAIDashboard, 1500);
    return;
  }

  const { state } = App;
  const spikes = ai.detectSOSSpike(state.sosRequests || []);
  const badge = document.getElementById('ai-spike-badge');
  if (badge && spikes.length > 0) {
    badge.style.display = 'block';
    badge.textContent = `⚡ SOS SPIKE: ${spikes[0].district} (${spikes[0].count} in 15min)`;
  }

  const predictions = await ai.computeRiskScores(state.activeAlerts || [], state.sosRequests || []);

  if (predictions.length === 0) {
    const caps = [['🧠', 'NLP Engine', 'Analyzing text patterns', '#3b82f6'], ['📊', 'Risk Model', 'Awaiting event data', '#22c55e'], ['⚡', 'Spike Detector', 'Monitoring 15-min SOS', '#f59e0b']];
    body.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:14px">
        ${caps.map(([icon, label, sub, col]) => `
          <div style="background:rgba(124,58,237,0.06);border:1px solid rgba(124,58,237,0.16);border-radius:10px;padding:14px;text-align:center">
            <div style="font-size:22px;margin-bottom:5px">${icon}</div>
            <div style="font-size:12px;color:${col};font-weight:700">${label}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:3px">${sub}</div>
          </div>`).join('')}
      </div>
      <div style="text-align:center;padding:14px;color:var(--text-muted);font-size:13px;
        border:1px dashed rgba(124,58,237,0.22);border-radius:8px">
        🤖 Create an alert or submit SOS to activate risk predictions</div>`;
    return;
  }

  const rows = predictions.map(p => {
    const score = Math.round(p.riskScore || 0);
    const barClr = score >= 60 ? '#ef4444' : score >= 30 ? '#f59e0b' : '#22c55e';
    const bgClr = score >= 60 ? 'rgba(239,68,68,0.07)' : score >= 30 ? 'rgba(245,158,11,0.07)' : 'rgba(34,197,94,0.06)';
    const trend = p.trend || 'Stable';
    const conf = Math.round((p.confidence || 0) * 100);
    const trendI = trend === 'Rising' ? '📈' : trend === 'Elevated' ? '⚠️' : '➡️';
    return `
      <div style="display:flex;align-items:center;gap:12px;padding:11px;border-radius:10px;
        background:${bgClr};margin-bottom:8px;border:1px solid ${barClr}28">
        <div style="min-width:120px">
          <div style="font-weight:700;font-size:13px;text-transform:capitalize">
            ${p.district}
            ${p.spikeDetected ? `<span style="background:rgba(239,68,68,0.16);border:1px solid rgba(239,68,68,0.32);
              color:#ef4444;padding:1px 6px;border-radius:4px;font-size:9px;margin-left:4px;
              vertical-align:middle;font-weight:700">⚡ SPIKE</span>`: ''}
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${p.alertCount} event(s)</div>
        </div>
        <div style="flex:1">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <div style="flex:1;height:8px;background:rgba(255,255,255,0.07);border-radius:99px;overflow:hidden">
              <div style="width:${score}%;height:100%;
                background:linear-gradient(90deg,${barClr}88,${barClr});
                border-radius:99px;transition:width .7s cubic-bezier(.4,0,.2,1)"></div>
            </div>
            <span style="font-size:15px;font-weight:900;color:${barClr};min-width:28px;text-align:right">${score}</span>
          </div>
          <div style="font-size:11px;color:var(--text-muted)">${trendI} ${trend} &nbsp;·&nbsp; ${p.predictedType} &nbsp;·&nbsp; ${conf}% confidence</div>
        </div>
        <span style="font-size:11.5px;font-weight:700;color:${barClr};background:${barClr}16;
          border:1px solid ${barClr}38;border-radius:7px;padding:4px 10px;white-space:nowrap">
          ${p.riskLevel} Risk</span>
      </div>`;
  }).join('');

  body.innerHTML = `
    <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:12px;font-size:11.5px;color:var(--text-muted);align-items:center">
      <span>🟢 Low &lt;30</span><span>🟡 Medium 30–59</span><span>🔴 High 60+</span>
      <span style="margin-left:auto;font-size:11px;color:rgba(167,139,250,0.65);font-weight:600">⚡ RapidAlert AI Engine</span>
    </div>
    ${rows}`;
}


// ── SOS Density Map ──────────────────────────────────────────────────────────
function _initSOSMap() {
  const mapEl = document.getElementById('sos-map');
  if (!mapEl || typeof L === 'undefined') {
    // Leaflet not ready yet — retry once
    setTimeout(_initSOSMap, 300);
    return;
  }
  const { state } = App;

  _dashboardMap = L.map('sos-map', {
    center: [20.99033, 79.024], zoom: 13,
    zoomControl: true,
    preferCanvas: true   // faster rendering
  });
  window._leafletInstances = window._leafletInstances || [];
  window._leafletInstances.push(_dashboardMap);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    maxZoom: 19,
    updateWhenIdle: false,   // fetch tiles immediately during pan
    keepBuffer: 4            // cache more tiles around viewport
  }).addTo(_dashboardMap);

  _markerLayer = L.layerGroup().addTo(_dashboardMap);
  const heatData = state.sosRequests
    .filter(s => s.lat && s.lng)
    .map(s => [s.lat, s.lng, 0.7]);

  if (L.heatLayer) {
    _heatmapLayer = L.heatLayer(heatData, {
      radius: 28, blur: 18, maxZoom: 17,
      gradient: { 0.3: '#3b82f6', 0.55: '#22c55e', 0.75: '#f59e0b', 1.0: '#ef4444' }
    }).addTo(_dashboardMap);
  }

  state.sosRequests.filter(s => s.lat && s.lng).slice(0, 30).forEach(s => {
    const isPending = s.status === 'Pending';
    L.circleMarker([s.lat, s.lng], {
      radius: isPending ? 9 : 5,
      fillColor: isPending ? '#ef4444' : '#6b7280',
      color: '#fff', weight: 1.5, opacity: 1, fillOpacity: 0.9
    }).bindPopup(`<strong>${s.name || 'Unknown'}</strong><br>${s.area || ''}<br>Status: <b>${s.status}</b>`)
      .addTo(_markerLayer);
  });

  if (heatData.length > 0) {
    try {
      const bounds = L.latLngBounds(heatData.map(p => [p[0], p[1]]));
      _dashboardMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    } catch (_) { }
  } else {
    // No SOS data — show base Nagpur city view with a reference marker
    L.marker([20.99033, 79.024], {
      icon: L.divIcon({
        html: '<div style="background:#7c3aed;border:2px solid #fff;border-radius:50%;width:14px;height:14px;box-shadow:0 0 8px rgba(124,58,237,0.6)"></div>',
        className: '', iconSize: [14, 14], iconAnchor: [7, 7]
      })
    }).bindPopup('<strong>Nagpur HQ</strong><br>Monitoring active').addTo(_markerLayer);
  }

  // Must call after container is fully visible — fixes grey map bug
  setTimeout(() => {
    if (_dashboardMap) _dashboardMap.invalidateSize();
  }, 100);

  window._toggleHeatmap = (enabled) => {
    if (!_dashboardMap || !_heatmapLayer) return;
    enabled ? _dashboardMap.addLayer(_heatmapLayer) : _dashboardMap.removeLayer(_heatmapLayer);
  };
}

// Reset on page leave
const _origNavigate = typeof App !== 'undefined' ? App.navigate : null;
window.addEventListener('dashboardLeave', () => {
  _dashboardActive = false;
  clearInterval(_statInterval);
  clearInterval(_clockInterval);
});

// Patch function: called by Firestore listeners to update stats without full rebuild
window._dashboardPatch = function () {
  _updateStatsInPlace(App.state);
  _updateLiveFeed(App.state);
  _loadAIDashboard();
};

window.renderDashboard = renderDashboard;

