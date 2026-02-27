/**
 * sos-requests.js – Admin Panel  (Regular script, not ES module)
 * ==============================================================
 * Renders SOS Requests page with list + Leaflet map.
 * Data from App.state.sosRequests (Firestore onSnapshot in app.js).
 *
 * Resolve action: Firestore updateDoc({ status: "Resolved", resolvedAt, resolvedByUid })
 * Requires: window.FB, window.App, Leaflet loaded
 */

function renderSOSRequests(container) {
  const { state, timeAgo } = App;
  const { db, doc, updateDoc, serverTimestamp } = window.FB;

  function calculateResponseTime(s) {
    if (!s.time || !s.resolvedAt) return '—';
    const start = s.time instanceof Date ? s.time : s.time.toDate();
    const end = s.resolvedAt instanceof Date ? s.resolvedAt : s.resolvedAt.toDate();
    const diffMs = end - start;
    const mins = Math.floor(diffMs / 60000);
    const secs = Math.floor((diffMs % 60000) / 1000);
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }

  function calculateAvgResponseTime() {
    const resolved = state.sosRequests.filter(s => s.status === 'Resolved' && s.time && s.resolvedAt);
    if (!resolved.length) return '—';
    const totalMs = resolved.reduce((sum, s) => {
      const start = s.time instanceof Date ? s.time : s.time.toDate();
      const end = s.resolvedAt instanceof Date ? s.resolvedAt : s.resolvedAt.toDate();
      return sum + (end - start);
    }, 0);
    const avgMs = totalMs / resolved.length;
    const avgMins = Math.round(avgMs / 60000 * 10) / 10;
    return `${avgMins}m`;
  }

  function getHTML() {
    const pending = state.sosRequests.filter(s => s.status === 'Pending').length;
    const helpSent = state.sosRequests.filter(s => s.status === 'Help Sent').length;

    return `
      <div class="page-header-row">
        <div>
          <h1>🆘 SOS Requests</h1>
          <p style="color:var(--text-secondary);font-size:13px">
            Citizens who triggered emergency SOS.
          </p>
        </div>
        <div style="display:flex;gap:10px;align-items:center">
          <div class="kpi-mini-card">
            <div class="kpi-label">Avg Response</div>
            <div class="kpi-value">${calculateAvgResponseTime()}</div>
          </div>
          <span class="badge badge-emergency" style="font-size:13px;padding:6px 14px">
            ${pending} Pending
          </span>
          <span class="badge badge-warning" style="font-size:13px;padding:6px 14px">
            ${helpSent} Help Sent
          </span>
        </div>
      </div>

      ${(() => {
        const spiked = state.sosRequests.filter(s => s.spikeDetected);
        if (!spiked.length) return '';
        const topSpike = spiked.reduce((a, b) => (b.spikeCount || 0) > (a.spikeCount || 0) ? b : a, spiked[0]);
        const isMass = topSpike.spikeEscalation === 'MASS_CASUALTY';
        const bg = isMass ? 'rgba(239,68,68,0.12)' : 'rgba(245,158,11,0.12)';
        const border = isMass ? '#ef4444' : '#f59e0b';
        const icon = isMass ? '🚨' : '⚠️';
        const label = isMass ? 'MASS CASUALTY EVENT' : 'SOS SPIKE DETECTED';
        return `
          <div style="margin-bottom:16px;padding:14px 18px;background:${bg};border:1.5px solid ${border};border-radius:10px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
            <div>
              <div style="font-weight:700;font-size:14px;color:${border}">${icon} AI ALERT: ${label}</div>
              <div style="font-size:12.5px;color:var(--text-secondary);margin-top:4px">
                <strong>${topSpike.spikeCount || spiked.length}</strong> SOS in
                <strong>${topSpike.spikeWindow || 5} minutes</strong>
                ${topSpike.district ? ` in <strong>${topSpike.district}</strong>` : ''}.
                Auto-notified super_admin via FCM.
              </div>
            </div>
            <button class="btn btn-secondary btn-sm" onclick="App.navigate('dashboard')">View Risk Index →</button>
          </div>`;
      })()}

      <div class="sos-layout">
        <!-- SOS List -->
        <div>
          <div class="sos-list" id="sos-list">
            ${state.sosRequests.length === 0 ?
        `<div class="empty-state"><div class="es-icon">🆘</div><p>No SOS requests received.</p></div>` :
        state.sosRequests.map((s, i) => {
          const hasCoords = s.lat && s.lng && (s.lat !== 0 || s.lng !== 0);
          const timeStr = s.time ? timeAgo(s.time) : '—';
          const coordStr = hasCoords ? `${s.lat.toFixed(4)}, ${s.lng.toFixed(4)}` : 'No GPS';
          const statusBadge = s.status === 'Resolved' ? 'badge-resolved'
            : s.status === 'Help Sent' ? 'badge-warning'
              : 'badge-emergency';
          return `
                  <div class="sos-item" id="sos-item-${s.id}">
                    <div class="sos-item-header">
                      <span class="sos-name">🆘 ${s.name || 'Unknown Citizen'}</span>
                      <span class="badge ${statusBadge}">${s.status}</span>
                    </div>
                    <div class="sos-loc">📍 ${s.area || 'Area not specified'}</div>
                    <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:8px">
                      📡 ${coordStr} · ${timeStr}
                    </div>
                    ${s.message ? `<div style="font-size:12.5px;color:var(--text-secondary);margin-bottom:8px;font-style:italic">"${s.message}"</div>` : ''}
                    <div class="sos-actions">
                      ${s.status !== 'Resolved' ? `
                        <button class="btn btn-sm btn-secondary"
                                onclick="updateSOSStatus('${s.id}', 'Help Sent')">🚑 Help Sent</button>
                        <button class="btn btn-sm btn-success"
                                onclick="resolveSOSById('${s.id}')">✅ Resolve</button>
                        <button class="btn btn-sm" style="background:#ef444420;color:#ef4444;border:1px solid #ef444460"
                                onclick="createAlertFromSOS('${s.id}')">🚨 Create Alert</button>
                        ${hasCoords ? `<button class="btn btn-sm btn-secondary"
                                onclick="focusSOSOnMap('${s.id}')">🗺 Map</button>` : ''}
                      ` : `
                        <div style="display:flex;flex-direction:column;gap:4px">
                          <span style="font-size:12px;color:var(--color-online)">✅ Resolved · ${s.resolvedAt ? timeAgo(s.resolvedAt) : ''}</span>
                          <span style="font-size:11px;color:var(--text-muted)">⏱ Response: ${calculateResponseTime(s)}</span>
                        </div>
                      `}
                    </div>
                  </div>`;
        }).join('')
      }
          </div>
        </div>

        <!-- Map -->
        <div class="card" style="padding:12px">
          <div class="card-title" style="margin-bottom:10px">SOS Locations Map</div>
          <div id="sos-map"></div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:8px">
            🔴 Pending &nbsp; 🟡 Help Sent &nbsp; 🟢 Resolved
          </div>
        </div>
      </div>`;
  }

  container.innerHTML = getHTML();

  // ── Leaflet SOS Map ───────────────────────────────────────────────────────
  const markerRefs = {};
  let sosMap = null;

  setTimeout(() => {
    sosMap = L.map('sos-map', { center: [20.99033, 79.024], zoom: 15 });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
    }).addTo(sosMap);

    state.sosRequests.forEach(s => {
      if (!s.lat || !s.lng) return;
      const color = s.status === 'Resolved' ? '#22c55e'
        : s.status === 'Help Sent' ? '#f59e0b'
          : '#ef4444';
      const icon = L.divIcon({
        className: '',
        html: `<div style="
                  width:16px;height:16px;border-radius:50%;background:${color};
                  border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.5);
                "></div>`,
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      });
      const marker = L.marker([s.lat, s.lng], { icon })
        .addTo(sosMap)
        .bindPopup(`
                  <b>🆘 ${s.name || 'Citizen'}</b><br>
                  📍 ${s.area || 'Unknown'}<br>
                  Status: <b>${s.status}</b><br>
                  ${s.message ? `<em>${s.message}</em><br>` : ''}
                  <small>${s.time ? new Date(s.time).toLocaleString('en-IN') : ''}</small>
                `);
      markerRefs[s.id] = marker;
    });

    window._leafletInstances = window._leafletInstances || [];
    window._leafletInstances.push(sosMap);

    window.focusSOSOnMap = function (id) {
      const s = state.sosRequests.find(x => x.id === id);
      if (!s || !s.lat) return;
      sosMap.setView([s.lat, s.lng], 14, { animate: true });
      markerRefs[id]?.openPopup();
    };
  }, 80);


  // ── Update SOS Status (Pending → Help Sent) ───────────────────────────────
  window.updateSOSStatus = async function (id, newStatus) {
    const btn = document.querySelector(`[onclick="updateSOSStatus('${id}', '${newStatus}')"]`);
    if (btn) { btn.disabled = true; btn.textContent = 'Updating…'; }

    try {
      await updateDoc(doc(db, 'sos_requests', id), {
        status: newStatus,
      });
      showToast(`SOS marked as "${newStatus}".`, 'info');
      // onSnapshot listener re-renders automatically
    } catch (err) {
      console.error('[SOS] Status update error:', err);
      showToast(`Failed: ${err.message}`, 'error');
      if (btn) { btn.disabled = false; btn.textContent = '🚑 Help Sent'; }
    }
  };


  // ── Resolve SOS ───────────────────────────────────────────────────────────
  window.resolveSOSById = async function (id) {
    const btn = document.querySelector(`button[onclick="resolveSOSById('${id}')"]`);
    if (btn) { btn.disabled = true; btn.textContent = 'Resolving…'; }

    try {
      await updateDoc(doc(db, 'sos_requests', id), {
        status: 'Resolved',
        resolvedAt: serverTimestamp(),
        resolvedByUid: App.state.currentAdmin?.uid || null,
        resolvedByName: App.state.currentAdmin?.name || null,
      });
      showToast(`SOS resolved successfully.`, 'success');
      // onSnapshot listener in app.js updates state + re-renders
    } catch (err) {
      console.error('[SOS] Resolve error:', err);
      showToast(`Failed to resolve: ${err.message}`, 'error');
      if (btn) { btn.disabled = false; btn.textContent = '✅ Resolve'; }
    }
  };
  // ── Create Alert from SOS (Admin approves SOS → broadcasts alert) ──────────
  window.createAlertFromSOS = async function (sosId) {
    const sos = state.sosRequests.find(s => s.id === sosId);
    if (!sos) return;

    // Extract lat/lng from Firestore GeoPoint or flat object
    const loc = sos.location;
    const sosLat = loc ? (loc.latitude ?? loc.lat ?? null) : null;
    const sosLng = loc ? (loc.longitude ?? loc.lng ?? null) : null;

    const confirmed = confirm(
      `Create EMERGENCY alert from SOS by ${sos.name || 'Unknown'}?\n` +
      `Area: ${sos.area || 'Unknown'}\n` +
      `Location: ${sosLat ? sosLat.toFixed(4) + ', ' + sosLng.toFixed(4) : 'No GPS'}\n\n` +
      `This will ring alarms on ALL citizen phones in the zone!`
    );
    if (!confirmed) return;

    try {
      const { db, collection, addDoc, serverTimestamp, updateDoc, doc } = window.FB;
      const admin = App.state.currentAdmin;

      // Build geofence around SOS point (1km radius)
      const geofence = sosLat && sosLng ? {
        type: 'radius',
        centerLat: sosLat,
        centerLng: sosLng,
        radius: 1.0, // 1km radius
      } : { type: 'none' };

      const alertPayload = {
        type: 'Other',
        severity: 'Emergency',
        message: `🆘 Emergency SOS by ${sos.name || 'Citizen'}: ${sos.message || 'SOS received. Authorities responding. Stay safe!'}`,
        area: sos.area || sos.district || 'SOS Location',
        isDrill: false,
        geofence,
        active: true,
        creatorUid: admin?.uid || null,
        creatorName: admin?.name || 'Admin',
        district: sos.district || null,
        timeSent: serverTimestamp(),
        sosSourceId: sosId,
        reach: 0,
        deliveredCount: 0,
        openedCount: 0,
      };

      const docRef = await addDoc(collection(db, 'alerts'), alertPayload);

      // Mark SOS as Help Sent → then Resolved
      await updateDoc(doc(db, 'sos_requests', sosId), {
        status: 'Resolved',
        resolvedAt: serverTimestamp(),
        resolvedByUid: admin?.uid || null,
        resolvedByName: admin?.name || null,
        alertCreated: docRef.id,
      });

      showToast(`🚨 Alert broadcasted! Citizens in zone will be alarmed.`, 'success', 5000);
      console.info('[SOS] Created alert from SOS:', docRef.id);

    } catch (err) {
      console.error('[SOS] createAlertFromSOS error:', err);
      showToast(`Failed: ${err.message}`, 'error');
    }
  };
}

window.renderSOSRequests = renderSOSRequests;
