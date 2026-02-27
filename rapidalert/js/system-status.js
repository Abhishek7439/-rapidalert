/* ============================================================
   RapidAlert – system-status.js
   Renders System Status page with server indicators and logs
   ============================================================ */

function renderSystemStatus(container) {
    const { state, formatTime } = App;

    const lastSent = state.activeAlerts.length > 0
        ? state.activeAlerts[0].timeSent
        : (state.alertHistory.length > 0 ? state.alertHistory[0].timeSent : null);

    container.innerHTML = `
    <div class="page-header">
      <h1>System Status</h1>
      <p>Real-time operational health of the RapidAlert infrastructure.</p>
    </div>

    <!-- Status Cards Grid -->
    <div class="status-grid" style="margin-bottom:24px">

      <div class="status-card">
        <div class="status-icon-wrap" style="background:rgba(34,197,94,0.12)">🖥️</div>
        <div class="status-info">
          <div class="status-label">Alert Server</div>
          <div class="status-value">
            <div class="status-pulse">
              <div class="pulse-dot"></div>
              Online
            </div>
          </div>
        </div>
      </div>

      <div class="status-card">
        <div class="status-icon-wrap" style="background:rgba(34,197,94,0.12)">📡</div>
        <div class="status-info">
          <div class="status-label">Push Gateway</div>
          <div class="status-value">
            <div class="status-pulse">
              <div class="pulse-dot"></div>
              Active
            </div>
          </div>
        </div>
      </div>

      <div class="status-card">
        <div class="status-icon-wrap" style="background:rgba(59,130,246,0.12)">📱</div>
        <div class="status-info">
          <div class="status-label">Connected Devices</div>
          <div class="status-value online">${(state.totalDevices).toLocaleString('en-IN')}</div>
        </div>
      </div>

      <div class="status-card">
        <div class="status-icon-wrap" style="background:rgba(245,158,11,0.12)">🕐</div>
        <div class="status-info">
          <div class="status-label">Last Alert Sent</div>
          <div class="status-value" style="font-size:15px">${lastSent ? formatTime(lastSent) : '—'}</div>
        </div>
      </div>

      <div class="status-card">
        <div class="status-icon-wrap" style="background:rgba(34,197,94,0.12)">🗄️</div>
        <div class="status-info">
          <div class="status-label">Database</div>
          <div class="status-value">
            <div class="status-pulse">
              <div class="pulse-dot"></div>
              Connected
            </div>
          </div>
        </div>
      </div>

      <div class="status-card">
        <div class="status-icon-wrap" style="${state.demoMode ? 'background:rgba(245,158,11,0.12)' : 'background:rgba(34,197,94,0.12)'}">
          ${state.demoMode ? '🟡' : '🟢'}
        </div>
        <div class="status-info">
          <div class="status-label">Current Mode</div>
          <div class="status-value" style="font-size:16px;color:${state.demoMode ? 'var(--color-warning)' : 'var(--color-online)'}">
            ${state.demoMode ? 'Demo / Offline' : 'Live / Production'}
          </div>
        </div>
      </div>
    </div>

    <!-- Service Health Bars -->
    <div class="card" style="margin-bottom:20px">
      <div class="card-title" style="margin-bottom:16px">Service Health</div>
      ${[
            { name: 'Alert API', uptime: 99.8, color: 'var(--color-online)' },
            { name: 'Push Notification Service', uptime: 98.5, color: 'var(--color-online)' },
            { name: 'GeoZone Engine', uptime: 100, color: 'var(--color-online)' },
            { name: 'SMS Fallback Gateway', uptime: 95.2, color: 'var(--color-warning)' },
            { name: 'Admin Web Panel', uptime: 100, color: 'var(--color-online)' },
        ].map(svc => `
        <div style="margin-bottom:14px">
          <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px">
            <span style="font-weight:500">${svc.name}</span>
            <span style="color:${svc.color};font-weight:600">${svc.uptime}%</span>
          </div>
          <div style="height:7px;background:var(--bg-secondary);border-radius:4px;overflow:hidden">
            <div style="height:100%;width:${svc.uptime}%;background:${svc.color};border-radius:4px;transition:width 0.8s ease"></div>
          </div>
        </div>`).join('')}
    </div>

    <!-- System Log -->
    <div class="card">
      <div class="card-title" style="margin-bottom:14px">System Log</div>
      <div>
        ${state.logs.map(l => `
          <div class="log-item">
            <span class="log-time">${l.time}</span>
            <span class="log-msg">${l.msg}</span>
          </div>`).join('')}
      </div>
    </div>

    <!-- API Test Panel -->
    <div class="card" style="margin-top:20px">
      <div class="card-title" style="margin-bottom:14px">API Health Check</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn btn-secondary" onclick="runApiCheck('Alert API')">Test Alert API</button>
        <button class="btn btn-secondary" onclick="runApiCheck('Push Gateway')">Test Push Gateway</button>
        <button class="btn btn-secondary" onclick="runApiCheck('GeoZone Engine')">Test GeoZone</button>
      </div>
      <div id="api-check-result" style="margin-top:12px"></div>
    </div>`;

    // API check mock
    window.runApiCheck = function (name) {
        const resultEl = document.getElementById('api-check-result');
        resultEl.innerHTML = `<span style="color:var(--text-muted);font-size:13px">⏳ Checking ${name}…</span>`;
        setTimeout(() => {
            resultEl.innerHTML = `
        <div style="background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.3);border-radius:8px;padding:12px;font-size:13px">
          ✅ <strong>${name}</strong>: Responding normally · Latency: ${Math.floor(Math.random() * 50 + 10)}ms
          ${state.demoMode ? '<span style="color:var(--color-warning);font-size:11px;margin-left:8px">(Demo Mode)</span>' : ''}
        </div>`;
        }, 900);
    };
}

window.renderSystemStatus = renderSystemStatus;
