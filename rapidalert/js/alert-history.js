/* ============================================================
   RapidAlert – alert-history.js
   Renders Alert History page with filters and detail modal
   ============================================================ */

function renderAlertHistory(container) {
  const { state, severityClass, alertTypeIcon, formatTime } = App;

  function filterAlerts() {
    let alerts = [...state.alertHistory];
    const type = document.getElementById('hf-type')?.value;
    const sev = document.getElementById('hf-sev')?.value;
    const date = document.getElementById('hf-date')?.value;
    if (type) alerts = alerts.filter(a => a.type === type);
    if (sev) alerts = alerts.filter(a => a.severity === sev);
    if (date) alerts = alerts.filter(a => a.timeSent.startsWith(date));
    return alerts;
  }

  function renderList() {
    const alerts = filterAlerts();
    const list = document.getElementById('history-list');
    if (!list) return;
    if (alerts.length === 0) {
      list.innerHTML = `<div class="empty-state"><div class="es-icon">📋</div><p>No alerts match the filters.</p></div>`;
      return;
    }
    list.innerHTML = alerts.map(a => {
      const reach = Number(a.reach) || 0;
      const reachDisplay = reach >= 10000 ? `${(reach / 1000).toFixed(1)}K`
        : reach > 0 ? reach.toLocaleString('en-IN') : '—';
      return `
      <div class="history-item" onclick="viewHistoryDetail('${a.id}')">
        <div class="hi-dot" style="background:${App.severityColor(a.severity)}"></div>
        <div class="hi-body">
          <div class="hi-title">${alertTypeIcon(a.type)} ${a.type} Alert – ${a.area.split('–')[0].trim()}
            ${a.isDrill ? `<span class="badge badge-drill" style="margin-left:6px">DRILL</span>` : ''}
          </div>
          <div class="hi-meta">${formatTime(a.timeSent)} · <span class="badge badge-${severityClass(a.severity)}" style="font-size:11px">${a.severity}</span> · ${a.area}</div>
        </div>
        <div class="hi-stats">
          <div class="hi-stat-val">${reachDisplay}</div>
          <div class="hi-stat-lbl">Notified</div>
        </div>
        <span style="color:var(--text-muted);font-size:18px">›</span>
      </div>`;
    }).join('');
  }

  container.innerHTML = `
    <div class="page-header">
      <h1>Alert History</h1>
      <p>All past alerts with delivery statistics.</p>
    </div>

    <!-- Filters -->
    <div class="history-filters card" style="padding:14px;align-items:flex-end;gap:12px">
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;width:100%">
        <div class="form-group" style="margin:0;flex:1;min-width:140px">
          <label class="form-label">Alert Type</label>
          <select class="form-control" id="hf-type">
            <option value="">All Types</option>
            <option>Earthquake</option><option>Tsunami</option><option>Flood</option>
            <option>Fire</option><option>Cyclone</option><option>Other</option>
          </select>
        </div>
        <div class="form-group" style="margin:0;flex:1;min-width:140px">
          <label class="form-label">Severity</label>
          <select class="form-control" id="hf-sev">
            <option value="">All Severities</option>
            <option>Info</option><option>Warning</option><option>Emergency</option><option>Evacuate</option>
          </select>
        </div>
        <div class="form-group" style="margin:0;flex:1;min-width:160px">
          <label class="form-label">Date</label>
          <input type="date" class="form-control" id="hf-date">
        </div>
        <button class="btn btn-secondary" onclick="document.getElementById('hf-type').value='';document.getElementById('hf-sev').value='';document.getElementById('hf-date').value='';renderHistoryList()">
          Clear
        </button>
      </div>
    </div>

    <!-- History list -->
    <div id="history-list" style="margin-top:14px"></div>`;

  // Attach filter listeners
  ['hf-type', 'hf-sev', 'hf-date'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', renderList);
  });

  window.renderHistoryList = renderList;
  renderList();

  // ── History Detail Modal ──────────────────────────────────────
  window.viewHistoryDetail = function (id) {
    const a = state.alertHistory.find(x => x.id === id);
    if (!a) return;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box history-detail" style="max-width:600px;max-height:85vh;overflow-y:auto">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
          <div style="display:flex;align-items:center;gap:10px">
            <span style="font-size:28px">${alertTypeIcon(a.type)}</span>
            <div>
              <div style="font-size:18px;font-weight:700">${a.type} – <span class="badge badge-${severityClass(a.severity)}">${a.severity}</span> ${a.isDrill ? `<span class="badge badge-drill">DRILL</span>` : ''}</div>
              <div style="font-size:12px;color:var(--text-muted)">${a.id} · ${formatTime(a.timeSent)}</div>
            </div>
          </div>
          <button class="btn btn-secondary btn-sm" id="hd-close">✕</button>
        </div>

        <!-- Message -->
        <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:14px">
          <div style="font-size:11px;color:var(--text-muted);font-weight:600;text-transform:uppercase;margin-bottom:6px">Alert Message</div>
          <div style="font-size:14px;line-height:1.7">${a.message}</div>
        </div>

        <!-- Area -->
        <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:14px">
          <div style="font-size:11px;color:var(--text-muted);font-weight:600;text-transform:uppercase;margin-bottom:5px">Affected Area</div>
          <div style="font-size:14px">📍 ${a.area}</div>
        </div>

        <!-- Delivery Stats (Real Data) -->
        <div style="margin-bottom:14px">
          <div style="font-size:11px;color:var(--text-muted);font-weight:600;text-transform:uppercase;margin-bottom:10px">Delivery Statistics</div>
          <div class="stats-mini">
            <div class="stat-m">
              <div class="stat-m-val" style="color:var(--color-warning)">${(() => { const r = Number(a.reach) || 0; return r >= 10000 ? `${(r / 1000).toFixed(1)}K` : r > 0 ? r.toLocaleString('en-IN') : '—'; })()}</div>
              <div class="stat-m-lbl">Citizens Reached</div>
            </div>
            <div class="stat-m">
              <div class="stat-m-val" style="color:var(--color-info)">${a.area?.split(',').length || 1}</div>
              <div class="stat-m-lbl">Zones Covered</div>
            </div>
            <div class="stat-m">
              <div class="stat-m-val" style="color:var(--color-online)">${a.isDrill ? 'Drill' : 'Live'}</div>
              <div class="stat-m-lbl">Alert Type</div>
            </div>
            <div class="stat-m">
              <div class="stat-m-val" style="color:var(--text-secondary)">${a.cancelledAt ? '✅ Resolved' : '📡 Broadcast'}</div>
              <div class="stat-m-lbl">Status</div>
            </div>
          </div>
        </div>

        <!-- Real reach bar -->
        ${(() => {
        const reach = Number(a.reach) || 0;
        return reach > 0 ? `
        <div style="margin-bottom:14px">
          <div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--text-muted);margin-bottom:4px">
            <span>Citizens Reached</span>
            <span>${reach.toLocaleString('en-IN')} people</span>
          </div>
          <div style="height:6px;background:var(--bg-secondary);border-radius:3px;overflow:hidden">
            <div style="height:100%;width:100%;background:linear-gradient(90deg,var(--color-info),var(--color-online));border-radius:3px"></div>
          </div>
        </div>` : '<div style="color:var(--text-muted);font-size:12px;padding:8px 0">📊 Delivery data not available for this alert</div>';
      })()}
      </div>`;

    document.body.appendChild(overlay);
    overlay.querySelector('#hd-close').onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  };
}

window.renderAlertHistory = renderAlertHistory;
