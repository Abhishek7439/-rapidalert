/**
 * active-alerts.js – Admin Panel  (Regular script, not ES module)
 * ================================================================
 * Renders the Active Alerts table.
 * Data is read from App.state.activeAlerts (populated by Firestore
 * onSnapshot listener in app.js — auto-updates in real time).
 *
 * Cancel action: Firestore updateDoc({ active: false, cancelledAt })
 * Requires: window.FB (firebase-init.js), window.App (app.js)
 */

function renderActiveAlerts(container) {
  const { state, severityClass, alertTypeIcon, formatTime, timeAgo } = App;
  const { db, doc, updateDoc, serverTimestamp } = window.FB;

  function getHTML() {
    return `
      <div class="page-header-row">
        <div>
          <h1>Active Alerts</h1>
          <p style="color:var(--text-secondary);font-size:13px">
            ${state.activeAlerts.length} alert(s) currently broadcasting.
          </p>
        </div>
        <button class="btn btn-primary" onclick="App.navigate('create-alert')">
          🚨 New Alert
        </button>
      </div>

      <div class="card">
        <div class="table-wrapper">
          ${state.activeAlerts.length === 0 ? `
            <div class="empty-state">
              <div class="es-icon">✅</div>
              <p>No active alerts.</p>
            </div>` : `
          <table id="active-alerts-table">
            <thead>
              <tr>
                <th>Alert ID</th>
                <th>Type</th>
                <th>Severity</th>
                <th>Area</th>
                <th>Time Sent</th>
                <th>Reach</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${state.activeAlerts.map(a => `
                <tr id="alert-row-${a.id}">
                  <td style="font-family:monospace;font-size:12px;color:var(--text-muted)">${a.id}</td>
                  <td>
                    <div style="display:flex;align-items:center;gap:7px">
                      <span style="font-size:18px">${alertTypeIcon(a.type)}</span>
                      <span style="font-weight:600">${a.type}</span>
                    </div>
                  </td>
                  <td>
                    <span class="badge badge-${severityClass(a.severity)}">${a.severity}</span>
                    ${a.isDrill ? `<span class="badge badge-drill" style="margin-left:4px">DRILL</span>` : ''}
                  </td>
                  <td style="max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
                      title="${a.area}">${a.area}</td>
                  <td>
                    <div style="font-size:13px">${formatTime(a.timeSent)}</div>
                    <div style="font-size:11px;color:var(--text-muted)">${timeAgo(a.timeSent)}</div>
                  </td>
                  <td style="font-weight:600;color:var(--color-warning)">
                    ${a.reach ? (a.reach >= 10000 ? `${(a.reach / 1000).toFixed(1)}K` : a.reach.toLocaleString('en-IN')) : '—'}
                  </td>
                  <td><span class="badge badge-active">Active</span></td>
                  <td>
                    <div style="display:flex;gap:6px">
                      <button class="btn btn-sm btn-secondary"
                              onclick="viewAlertDetail('${a.id}')">👁 Details</button>
                      <button class="btn btn-sm btn-danger"
                              id="cancel-btn-${a.id}"
                              onclick="cancelAlertById('${a.id}')">✕ Cancel</button>
                    </div>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>`}
        </div>
      </div>`;
  }

  container.innerHTML = getHTML();

  // ── Cancel Alert ──────────────────────────────────────────────────────────
  window.cancelAlertById = async function (id) {
    const alert = state.activeAlerts.find(a => a.id === id);
    if (!alert) return;

    showModal({
      icon: '⚠️',
      title: `Cancel Alert?`,
      body: `<strong>${alert.type} – ${alert.severity}</strong><br><br>
                           Area: <em>${alert.area}</em><br><br>
                           This will stop broadcasting to all citizens in this zone. Are you sure?`,
      confirmText: 'Yes, Cancel Alert',
      confirmClass: 'btn-danger',
      onConfirm: async () => {
        const btn = document.getElementById(`cancel-btn-${id}`);
        if (btn) { btn.disabled = true; btn.textContent = 'Cancelling…'; }

        try {
          await updateDoc(doc(db, 'alerts', id), {
            active: false,
            cancelledAt: serverTimestamp(),
            cancelledBy: App.state.currentAdmin?.uid || null,
          });
          // onSnapshot listener in app.js will remove this alert from
          // state.activeAlerts and re-render automatically.
          showToast(`Alert cancelled and removed from broadcast.`, 'warning');

        } catch (err) {
          console.error('[ActiveAlerts] Cancel error:', err);
          showToast(`Failed to cancel alert: ${err.message}`, 'error');
          if (btn) { btn.disabled = false; btn.textContent = '✕ Cancel'; }
        }
      },
    });
  };

  // ── View Detail Modal ─────────────────────────────────────────────────────
  window.viewAlertDetail = function (id) {
    const a = [...state.activeAlerts, ...state.alertHistory].find(x => x.id === id);
    if (!a) return;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box" style="max-width:620px;max-height:88vh;overflow-y:auto">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
          <div style="display:flex;align-items:center;gap:10px">
            <span style="font-size:28px">${alertTypeIcon(a.type)}</span>
            <div>
              <div style="font-size:18px;font-weight:700">
                ${a.type} Alert
                <span class="badge badge-${severityClass(a.severity)}" style="font-size:12px">${a.severity}</span>
                ${a.isDrill ? `<span class="badge badge-drill">DRILL</span>` : ''}
              </div>
              <div style="font-size:12px;color:var(--text-muted)">
                ${a.id} · ${formatTime(a.timeSent)}
              </div>
            </div>
          </div>
          <button class="btn btn-secondary btn-sm" id="detail-close">✕</button>
        </div>

        <div class="detail-section">
          <div class="detail-section-label">Message</div>
          <div style="font-size:14px;line-height:1.7">${a.message}</div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0">
          <div class="detail-section">
            <div class="detail-section-label">Area</div>
            <div>📍 ${a.area}</div>
          </div>
        <div class="detail-section">
          <div class="detail-section-label">Citizens Reached</div>
          <div id="reach-display-${a.id}" style="font-size:20px;font-weight:700;color:var(--color-warning)">
            ${a.reach ? a.reach.toLocaleString('en-IN') : '—'}
          </div>
          <div id="reach-detail-${a.id}" style="font-size:11px;color:var(--text-muted);margin-top:4px">Loading delivery stats…</div>
        </div>
        </div>

        <div class="detail-section">
          <div class="detail-section-label">Creator</div>
          <div style="font-size:13px;color:var(--text-muted)">
            ${a.creatorName || a.creatorUid || 'Unknown'}
          </div>
        </div>

        <div class="detail-section">
          <div class="detail-section-label">GeoJSON</div>
          <div style="font-family:monospace;font-size:11px;color:var(--text-muted)">
            ${a.geoJSON ? JSON.stringify(a.geoJSON).substring(0, 200) + '…' : 'No zone drawn (manual area entry)'}
          </div>
        </div>

        <div style="text-align:right;margin-top:16px">
          <button class="btn btn-secondary btn-sm" id="detail-close-2">Close</button>
          ${a.active ? `
            <button class="btn btn-danger btn-sm" style="margin-left:8px"
                    onclick="cancelAlertById('${a.id}');document.getElementById('detail-close').click()">
              ✕ Cancel Alert
            </button>` : ''}
        </div>
      </div>`;

    document.body.appendChild(overlay);
    const closeAll = () => overlay.remove();
    overlay.querySelector('#detail-close').onclick = closeAll;
    overlay.querySelector('#detail-close-2').onclick = closeAll;
    overlay.onclick = (e) => { if (e.target === overlay) closeAll(); };

    // ── Fetch real delivery stats from notification_logs ──────────
    import('https://www.gstatic.com/firebasejs/10.12.1/firebase-firestore.js')
      .then(({ doc: fsDoc, getDoc }) => getDoc(fsDoc(db, 'notification_logs', id)))
      .then(snap => {
        const detailEl = document.getElementById(`reach-detail-${id}`);
        const reachEl = document.getElementById(`reach-display-${id}`);
        if (!detailEl) return;
        if (snap.exists()) {
          const d = snap.data();
          if (reachEl) reachEl.textContent = (d.totalUsersInZone || 0).toLocaleString('en-IN');
          detailEl.innerHTML = [
            `📨 Sent: <strong>${(d.notificationsSent || 0).toLocaleString('en-IN')}</strong>`,
            `❌ Failed: <strong>${d.failedCount || 0}</strong>`,
            `📡 Path: <strong>${d.dispatchPath || '—'}</strong>`,
            d.topicDelivered ? `✅ Topic push: yes` : '',
          ].filter(Boolean).join(' &nbsp;·&nbsp; ');
        } else {
          detailEl.textContent = 'Delivery stats not yet available (Cloud Function may be processing).';
        }
      })
      .catch(() => {
        const detailEl = document.getElementById(`reach-detail-${id}`);
        if (detailEl) detailEl.textContent = 'Could not load delivery stats.';
      });
  };
}

window.renderActiveAlerts = renderActiveAlerts;
