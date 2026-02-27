/* ============================================================
   RapidAlert – create-alert.js (UPGRADED)
   Create Alert page with:
   - Geocoding search (country/city/area)
   - Severity-colored zone highlighting
   - GeoJSON extraction + preview
   - Live alert preview panel
   - Confirmation modal + send flow
   ============================================================ */

function renderCreateAlert(container) {
  const { state, severityClass, severityColor, alertTypeIcon } = App;

  let drawnGeoJSON = null;
  let drawnAreaName = 'Not selected';
  let currentSeverity = '';

  // Severity → draw style map
  const SEV_STYLES = {
    Info: { color: '#3b82f6', fillOpacity: 0.15, weight: 2.5 },
    Warning: { color: '#f59e0b', fillOpacity: 0.20, weight: 2.5 },
    Emergency: { color: '#ef4444', fillOpacity: 0.25, weight: 3 },
    Evacuate: { color: '#7c3aed', fillOpacity: 0.30, weight: 3 },
  };

  container.innerHTML = `
    <div class="page-header-row">
      <div>
        <h1>🚨 Create Alert</h1>
        <p style="color:var(--text-secondary);font-size:13px">Select disaster zone on map, fill details, preview and send.</p>
      </div>
      ${state.demoMode ? `<span class="badge badge-warning" style="font-size:12px;padding:5px 12px">🟡 Demo Mode</span>` : ''}
    </div>

    <div class="create-alert-grid">

      <!-- ── LEFT COLUMN ── -->
      <div class="create-alert-left">

        <!-- SECTION A: Alert Details -->
        <div class="card">
          <div class="card-title">Section A – Alert Details</div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Alert Type</label>
              <select class="form-control" id="ca-type">
                <option value="">— Select Type —</option>
                <option>Earthquake</option><option>Tsunami</option>
                <option>Flood</option><option>Fire</option>
                <option>Cyclone</option><option>Other</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Severity Level</label>
              <select class="form-control" id="ca-severity">
                <option value="">— Select Severity —</option>
                <option value="Info">ℹ️ Info</option>
                <option value="Warning">⚠️ Warning</option>
                <option value="Emergency">🔴 Emergency</option>
                <option value="Evacuate">🟣 Evacuate Immediately</option>
              </select>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Alert Message <span style="color:var(--text-muted)">(max 300 chars)</span></label>
            <textarea class="form-control" id="ca-message" rows="4" maxlength="300"
              placeholder="Clear, short instructions for citizens. E.g. 'Severe flooding expected. Evacuate to higher ground immediately.'"></textarea>
            <div style="font-size:11px;color:var(--text-muted);text-align:right;margin-top:3px">
              <span id="ca-char-count">0</span>/300
            </div>
            <!-- AI Severity Suggestion chip -->
            <div id="ai-suggestion-chip" style="display:none;margin-top:8px;padding:10px 14px;background:rgba(139,92,246,0.08);border:1px solid rgba(139,92,246,0.3);border-radius:8px;font-size:12.5px">
              <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
                <div>
                  <span style="color:#7c3aed;font-weight:600">🤖 AI Suggestion:</span>
                  <span id="ai-suggested-sev" style="font-weight:700;margin:0 6px">—</span>
                  <span id="ai-confidence" style="color:var(--text-muted)"></span>
                </div>
                <button id="ai-apply-btn" class="btn btn-sm" style="background:#7c3aed;color:#fff;border:none;padding:3px 12px;border-radius:5px;cursor:pointer;font-size:11.5px">
                  Apply ✓
                </button>
              </div>
              <div id="ai-keywords" style="margin-top:5px;color:var(--text-muted);font-size:11px"></div>
              <div id="ai-loading" style="display:none;color:var(--text-muted);font-size:11px">⏳ Analyzing message…</div>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Affected Area Name</label>
            <input class="form-control" id="ca-area" type="text" placeholder="E.g. Brahmaputra Basin, Assam">
          </div>
          <div class="form-check">
            <input type="checkbox" id="ca-drill">
            <label for="ca-drill">⚠️ This is a <strong>DRILL</strong> – Mark as training alert</label>
          </div>
        </div>

        <!-- SECTION B: Map -->
        <div class="card">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
            <div class="card-title" style="margin:0">Section B – Map Zone Selection</div>
            <button class="btn btn-secondary btn-sm" id="clear-draw-btn">🗑 Clear Zone</button>
          </div>

          <!-- Geocoding search widget mounts here -->
          <div id="geocoder-container" style="margin-bottom:10px"></div>

          <!-- Leaflet Map -->
          <div id="alert-map" style="height:360px;border-radius:8px;border:1px solid var(--border)"></div>

          <!-- Draw instructions -->
          <div class="map-tools-info" style="margin-top:8px;gap:16px">
            <span title="Draw Polygon">🔷 Polygon – Irregular zones</span>
            <span title="Draw Circle">🔵 Circle – Radial impact</span>
            <span title="Draw Rectangle">▪️ Rectangle – Block areas</span>
          </div>

          <!-- Severity color legend -->
          <div id="severity-legend" style="display:none;margin-top:10px;padding:10px;background:var(--bg-secondary);border-radius:8px;border:1px solid var(--border)">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;font-weight:600">ZONE COLOR LEGEND</div>
            <div style="display:flex;gap:14px;flex-wrap:wrap">
              <span style="font-size:12px;display:flex;align-items:center;gap:5px"><span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:#3b82f620;border:2px solid #3b82f6"></span>Info</span>
              <span style="font-size:12px;display:flex;align-items:center;gap:5px"><span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:#f59e0b20;border:2px solid #f59e0b"></span>Warning</span>
              <span style="font-size:12px;display:flex;align-items:center;gap:5px"><span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:#ef444420;border:2px solid #ef4444"></span>Emergency</span>
              <span style="font-size:12px;display:flex;align-items:center;gap:5px"><span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:#7c3aed20;border:2px solid #7c3aed"></span>Evacuate</span>
            </div>
          </div>

          <!-- GeoJSON preview -->
          <div style="margin-top:10px">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;font-weight:600">CAPTURED GEOJSON</div>
            <div class="map-geojson-display" id="geojson-display">No zone drawn yet.</div>
          </div>
        </div>

      </div><!-- /left -->

      <!-- ── RIGHT COLUMN: Preview + Send ── -->
      <div class="create-alert-right">
        <div class="card" style="position:sticky;top:20px">
          <div class="card-title">Section C – Preview & Send</div>

          <!-- Live Preview Box -->
          <div class="alert-preview" id="alert-preview" style="margin-bottom:18px">
            <div class="ap-header">
              <span class="ap-icon" id="ap-icon">🚨</span>
              <span class="ap-title" id="ap-title">Alert Preview</span>
            </div>
            <div class="ap-message" id="ap-message" style="font-size:14px;line-height:1.7">
              Fill in the form on the left to see a live preview.
            </div>
            <div class="ap-meta" style="margin-top:8px;flex-wrap:wrap;gap:6px">
              <span id="ap-severity-badge"></span>
              <span id="ap-drill-badge"></span>
              <span id="ap-type-badge"></span>
            </div>
            <div class="ap-area" style="margin-top:8px;font-size:12px;color:var(--text-muted)" id="ap-area">📍 Area: Not selected</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:3px" id="ap-geo-status">🗺️ Zone: Not drawn</div>
          </div>

          <!-- Estimated reach -->
          <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:16px" id="reach-estimate">
            <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;margin-bottom:8px">Estimated Reach</div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;text-align:center">
              <div>
                <div style="font-size:18px;font-weight:800;color:var(--color-warning)" id="est-devices">—</div>
                <div style="font-size:10px;color:var(--text-muted)">Devices</div>
              </div>
              <div>
                <div style="font-size:18px;font-weight:800;color:var(--color-info)" id="est-sms">—</div>
                <div style="font-size:10px;color:var(--text-muted)">SMS</div>
              </div>
              <div>
                <div style="font-size:18px;font-weight:800;color:var(--color-online)" id="est-coverage">—%</div>
                <div style="font-size:10px;color:var(--text-muted)">Coverage</div>
              </div>
            </div>
          </div>

          <!-- Action Buttons -->
          <div style="display:flex;gap:10px">
            <button class="btn btn-secondary" style="flex:1" onclick="App.navigate('dashboard')">✕ Cancel</button>
            <button class="btn btn-primary btn-lg" style="flex:2;justify-content:center" id="ca-send-btn">🚀 Send Alert</button>
          </div>

          <!-- AI Context Sidebar (Embedded) -->
          <div id="ai-context-panel" style="margin-top:20px;border-top:1px solid var(--border);padding-top:16px;display:none">
            <div style="font-size:11px;font-weight:700;color:var(--brand);text-transform:uppercase;margin-bottom:12px;display:flex;align-items:center;gap:8px">
               <span style="font-size:18px">🧠</span> AI Intelligence Layer
            </div>
            
            <div id="ai-risk-context" style="margin-bottom:16px;background:rgba(59,130,246,0.05);border:1px solid rgba(59,130,246,0.2);border-radius:8px;padding:12px">
              <div style="font-size:12px;font-weight:700;margin-bottom:6px">District Risk Trend</div>
              <div id="ai-risk-msg" style="font-size:12px;color:var(--text-secondary)">Select an area to see historical risk trends.</div>
            </div>

            <div id="ai-keyword-highlights" style="margin-bottom:16px">
              <div style="font-size:12px;font-weight:700;margin-bottom:6px">Detected Risk Keywords</div>
              <div id="ai-keyword-tags" style="display:flex;flex-wrap:wrap;gap:6px"></div>
            </div>

            <div style="font-size:11px;color:var(--text-muted);font-style:italic">
              * AI suggestions are based on real-world patterns and historical dataset analysis.
            </div>
          </div>

          <!-- Validation errors -->
          <div id="ca-validation" style="display:none;margin-top:12px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:12px;font-size:13px;color:#f87171"></div>

          <!-- Success panel -->
          <div id="ca-success" style="display:none;margin-top:16px;padding:20px;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.3);border-radius:12px;text-align:center">
            <div style="font-size:36px;margin-bottom:8px">✅</div>
            <div style="font-size:17px;font-weight:800;color:var(--color-online);margin-bottom:5px">Alert Sent!</div>
            <div style="font-size:13px;color:var(--text-muted)" id="ca-success-msg"></div>
            <div style="margin-top:12px;display:flex;flex-direction:column;gap:8px">
               <button class="btn btn-primary" onclick="App.navigate('active-alerts')">Track Delivery →</button>
               <button class="btn btn-secondary btn-sm" onclick="App.navigate('dashboard')">Back to Dashboard</button>
            </div>
          </div>

          <!-- Tips -->
          <div style="margin-top:18px;padding:12px;background:var(--bg-secondary);border-radius:8px;border:1px solid var(--border)">
            <div style="font-size:11px;font-weight:700;color:var(--text-muted);margin-bottom:7px">💡 BEST PRACTICES</div>
            <ul style="font-size:12px;color:var(--text-muted);padding-left:14px;line-height:1.9">
              <li>Use <strong>Polygon</strong> for coastal / river zones</li>
              <li>Use <strong>Circle</strong> for earthquake epicenters</li>
              <li>Keep message <strong>under 160 chars</strong> for SMS delivery</li>
              <li>Always use <strong>DRILL</strong> for training exercises</li>
              <li>Search for your target area in the map search box</li>
            </ul>
          </div>
        </div>
      </div>

    </div>`;

  // ── Initialize Leaflet Map ────────────────────────────────────
  setTimeout(() => {
    // Map init
    const map = L.map('alert-map', {
      center: [20.5937, 78.9629],
      zoom: 5,
      zoomControl: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
      maxZoom: 18,
    }).addTo(map);

    // Track all drawn layers
    const drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);

    // ── Draw control ──────────────────────────────────────────
    function getDrawStyle() {
      const sev = document.getElementById('ca-severity')?.value || 'Emergency';
      return SEV_STYLES[sev] || SEV_STYLES.Emergency;
    }

    const drawControl = new L.Control.Draw({
      edit: { featureGroup: drawnItems, remove: true },
      draw: {
        polygon: {
          allowIntersection: false,
          shapeOptions: getDrawStyle(),
          showArea: true,
          metric: true,
        },
        circle: {
          shapeOptions: getDrawStyle(),
          showRadius: true,
          metric: true,
        },
        rectangle: {
          shapeOptions: getDrawStyle(),
        },
        polyline: false,
        marker: false,
        circlemarker: false,
      },
    });
    map.addControl(drawControl);

    // ── Existing alert zones overlay (for context) ─────────────
    state.activeAlerts.forEach(a => {
      if (a.geoJSON && a.geoJSON.geometry) {
        const style = SEV_STYLES[a.severity] || SEV_STYLES.Info;
        const layer = L.geoJSON(a.geoJSON, {
          style: { ...style, dashArray: '5,5', opacity: 0.5 },
        }).addTo(map);
        layer.bindTooltip(`<b>${a.type}</b> ${a.severity} – ${a.area}`, { permanent: false });
      }
    });

    // ── On draw created ───────────────────────────────────────
    map.on(L.Draw.Event.CREATED, (e) => {
      drawnItems.clearLayers();
      const sev = document.getElementById('ca-severity')?.value || 'Emergency';
      const style = SEV_STYLES[sev] || SEV_STYLES.Emergency;

      // Apply severity color to drawn layer
      if (e.layer.setStyle) e.layer.setStyle(style);
      drawnItems.addLayer(e.layer);
      drawnGeoJSON = e.layer.toGeoJSON();

      // Compute area name hint
      const type = e.layerType;
      if (type === 'circle') {
        const rad = (e.layer.getRadius() / 1000).toFixed(1);
        const center = e.layer.getLatLng();
        // Save center + radius into GeoJSON properties
        drawnGeoJSON.properties = {
          ...drawnGeoJSON.properties,
          radius: e.layer.getRadius(),
          center: { lat: center.lat, lng: center.lng },
          radiusKm: parseFloat(rad),
        };
        drawnAreaName = document.getElementById('ca-area').value ||
          `Circle Zone – ${rad}km radius @ (${center.lat.toFixed(3)}, ${center.lng.toFixed(3)})`;
      } else {
        drawnAreaName = document.getElementById('ca-area').value || 'Custom Polygon Zone';
      }

      document.getElementById('geojson-display').textContent =
        JSON.stringify(drawnGeoJSON, null, 1).substring(0, 400) + (JSON.stringify(drawnGeoJSON).length > 400 ? '\n…' : '');

      document.getElementById('severity-legend').style.display = 'block';
      updatePreview();
    });

    // On edit / delete
    map.on(L.Draw.Event.EDITED, () => {
      drawnGeoJSON = null;
      drawnItems.eachLayer(layer => {
        drawnGeoJSON = layer.toGeoJSON();
        const metadata = layer.options.metadata;
        if (layer instanceof L.Circle) {
          drawnGeoJSON.properties = {
            ...drawnGeoJSON.properties,
            radius: layer.getRadius(),
            center: { lat: layer.getLatLng().lat, lng: layer.getLatLng().lng },
            radiusKm: parseFloat((layer.getRadius() / 1000).toFixed(1)),
            metadata: metadata || null
          };
        } else {
          drawnGeoJSON.properties = {
            ...drawnGeoJSON.properties,
            metadata: metadata || null
          };
        }
      });

      document.getElementById('geojson-display').textContent =
        JSON.stringify(drawnGeoJSON, null, 1).substring(0, 400) + (JSON.stringify(drawnGeoJSON).length > 400 ? '\n…' : '');
      updatePreview();
    });
    map.on(L.Draw.Event.DELETED, () => {
      drawnGeoJSON = null;
      drawnAreaName = 'Not selected';
      document.getElementById('geojson-display').textContent = 'No zone drawn yet.';
      updatePreview();
    });

    // ── Clear button ──────────────────────────────────────────
    document.getElementById('clear-draw-btn')?.addEventListener('click', () => {
      drawnItems.clearLayers();
      drawnGeoJSON = null;
      drawnAreaName = 'Not selected';
      document.getElementById('geojson-display').textContent = 'No zone drawn yet.';
      document.getElementById('severity-legend').style.display = 'none';
      updatePreview();
    });

    // ── Geocoder widget ───────────────────────────────────────
    if (window.Geocoder) {
      const geoContainer = document.getElementById('geocoder-container');
      const widget = Geocoder.createSearchWidget(map, (result) => {
        const areaInput = document.getElementById('ca-area');
        if (areaInput && !areaInput.value) areaInput.value = result.shortName;

        // Auto-snap micro-location rule
        const isCollege = result.category === 'amenity' && result.type === 'college';
        const isEducation = result.category === 'education';
        const isHighConfidence = result.importance >= 0.4 || result.osm_id ? true : false;
        const isMicro = (isCollege || isEducation) && isHighConfidence;

        if (isMicro && result.lat && result.lng) {
          drawnItems.clearLayers();

          const sev = document.getElementById('ca-severity')?.value || 'Emergency';
          const style = SEV_STYLES[sev] || SEV_STYLES.Emergency;

          const circle = L.circle([result.lat, result.lng], {
            ...style,
            radius: 250
          });

          circle.options.metadata = {
            placeName: result.shortName,
            osmId: result.osm_id,
            osmType: result.osm_type,
            boundingBox: result.boundingBox,
            snappedRadius: true
          };

          drawnItems.addLayer(circle);

          drawnGeoJSON = circle.toGeoJSON();
          drawnGeoJSON.properties = {
            ...drawnGeoJSON.properties,
            radius: 250,
            center: { lat: result.lat, lng: result.lng },
            radiusKm: 0.25,
            metadata: circle.options.metadata
          };
          drawnAreaName = `Zone anchored to: ${result.shortName}`;

          document.getElementById('geojson-display').textContent =
            JSON.stringify(drawnGeoJSON, null, 1).substring(0, 400) + (JSON.stringify(drawnGeoJSON).length > 400 ? '\n…' : '');
          document.getElementById('severity-legend').style.display = 'block';
        }

        updatePreview();
      });
      geoContainer.appendChild(widget);
    }

    // ── Re-style drawn layers when severity changes ───────────
    document.getElementById('ca-severity')?.addEventListener('change', () => {
      const sev = document.getElementById('ca-severity').value;
      const style = SEV_STYLES[sev] || SEV_STYLES.Emergency;
      drawnItems.eachLayer(layer => { if (layer.setStyle) layer.setStyle(style); });
      updatePreview();
    });

    // ── AI Severity Suggestion (Client-Side NLP Engine) ──────────
    let _aiDebounce = null;
    let _lastAISuggested = null;
    const _sevColors = { Evacuate: '#7c3aed', Emergency: '#ef4444', Warning: '#f59e0b', Info: '#3b82f6' };
    const _sevEmoji = { Evacuate: '🟣', Emergency: '🔴', Warning: '⚠️', Info: 'ℹ️' };

    async function fetchAISuggestion(text) {
      const chip = document.getElementById('ai-suggestion-chip');
      const loading = document.getElementById('ai-loading');
      const sugEl = document.getElementById('ai-suggested-sev');
      const confEl = document.getElementById('ai-confidence');
      const kwEl = document.getElementById('ai-keywords');
      if (!chip) return;
      if (!text || text.length < 10) { chip.style.display = 'none'; return; }

      chip.style.display = 'block';
      loading.style.display = 'block';
      loading.textContent = '🤖 AI analyzing…';
      sugEl.textContent = '—';
      confEl.textContent = '';
      kwEl.textContent = '';

      // Small delay to feel like it's "thinking"
      await new Promise(r => setTimeout(r, 280));

      // Run client-side NLP engine (no network call!)
      const ai = window.RapidAlertAI;
      if (!ai) { loading.textContent = 'AI engine loading…'; return; }

      const result = ai.scoreSeverity(text);
      loading.style.display = 'none';

      if (!result) {
        sugEl.innerHTML = `<span style="color:var(--text-muted)">Insufficient text</span>`;
        confEl.textContent = 'Type more details for AI analysis';
        return;
      }

      const { suggested, confidence, matchedKeywords } = result;
      _lastAISuggested = suggested;
      const col = _sevColors[suggested] || '#888';
      const pct = Math.round(confidence * 100);

      sugEl.innerHTML = `
        <span style="color:${col};font-weight:800;font-size:15px">${_sevEmoji[suggested]} ${suggested}</span>`;

      confEl.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
          <div style="flex:1;height:5px;background:var(--bg-primary);border-radius:99px;overflow:hidden">
            <div style="width:${pct}%;height:100%;background:${col};border-radius:99px;transition:width .4s ease"></div>
          </div>
          <span style="font-size:11px;color:${col};font-weight:700;min-width:28px">${pct}%</span>
        </div>`;

      kwEl.innerHTML = matchedKeywords.length
        ? `<div style="margin-top:5px;font-size:11px;color:var(--text-muted)">🔑 Keywords: ${matchedKeywords.map(k =>
          `<span style="background:${col}18;border:1px solid ${col}44;color:${col};padding:1px 6px;border-radius:4px;margin:0 2px">${k}</span>`
        ).join('')}</div>`
        : '';

      // Update AI Context Panel in sidebar
      const panel = document.getElementById('ai-context-panel');
      const tags = document.getElementById('ai-keyword-tags');
      if (panel) panel.style.display = 'block';
      if (tags) {
        tags.innerHTML = matchedKeywords.map(k =>
          `<span class="badge" style="background:var(--bg-secondary);border:1px solid var(--brand);color:var(--brand);font-size:10px">${k}</span>`
        ).join('');
      }
    }

    // Refresh Risk Context based on Area Name
    function updateRiskContext(area) {
      const riskMsg = document.getElementById('ai-risk-msg');
      if (!riskMsg || !area) return;
      const { state } = App;
      const prediction = state.aiPredictions.find(p => area.toLowerCase().includes((p.district || '').toLowerCase()));
      if (prediction) {
        riskMsg.innerHTML = `
            <strong>${prediction.district}</strong>: ${prediction.riskLevel} Risk detected.<br>
            Trend is <strong>${prediction.trend}</strong> with ${Math.round(prediction.confidence * 100)}% confidence.
          `;
      } else {
        riskMsg.textContent = `No historical risk data for "${area}".`;
      }
    }


    document.getElementById('ca-message')?.addEventListener('input', (e) => {
      clearTimeout(_aiDebounce);
      _aiDebounce = setTimeout(() => fetchAISuggestion(e.target.value.trim()), 600);
    });

    document.getElementById('ai-apply-btn')?.addEventListener('click', () => {
      if (!_lastAISuggested) return;
      const s = document.getElementById('ca-severity');
      if (s) { s.value = _lastAISuggested; s.dispatchEvent(new Event('change')); }
    });

    window._leafletInstances = window._leafletInstances || [];
    window._leafletInstances.push(map);
  }, 80);


  // ── Live Preview Update ───────────────────────────────────────
  function updatePreview() {
    const type = document.getElementById('ca-type')?.value || '';
    const severity = document.getElementById('ca-severity')?.value || '';
    const message = document.getElementById('ca-message')?.value.trim() || '';
    const areaInput = document.getElementById('ca-area')?.value.trim() || '';
    const isDrill = document.getElementById('ca-drill')?.checked;

    const cls = App.severityClass(severity);
    const previewEl = document.getElementById('alert-preview');
    if (previewEl) previewEl.className = `alert-preview ${cls}`;

    const iconEl = document.getElementById('ap-icon');
    if (iconEl) iconEl.textContent = App.alertTypeIcon(type) || '🚨';

    const titleEl = document.getElementById('ap-title');
    if (titleEl) titleEl.textContent = type ? `${type} Alert` : 'Alert Preview';

    const msgEl = document.getElementById('ap-message');
    if (msgEl) msgEl.textContent = message || 'Fill in the form on the left to see a live preview.';

    const sevBadgeWrap = document.getElementById('ap-severity-badge');
    if (sevBadgeWrap) {
      sevBadgeWrap.outerHTML = severity
        ? `<span class="badge badge-${cls}" id="ap-severity-badge">${severity}</span>`
        : `<span id="ap-severity-badge"></span>`;
    }

    const drillBadgeWrap = document.getElementById('ap-drill-badge');
    if (drillBadgeWrap) {
      drillBadgeWrap.outerHTML = isDrill
        ? `<span class="badge badge-drill" id="ap-drill-badge">DRILL</span>`
        : `<span id="ap-drill-badge"></span>`;
    }

    const areaEl = document.getElementById('ap-area');
    if (areaEl) areaEl.textContent = `📍 ${areaInput || drawnAreaName}`;

    const geoEl = document.getElementById('ap-geo-status');
    if (geoEl) geoEl.textContent = drawnGeoJSON ? '🗺️ Zone drawn ✓' : '🗺️ Zone: Not drawn';

    updateRiskContext(areaInput || drawnAreaName);

    // Call real reach fetcher
    scheduleReachFetch();
  }

  // ── Real Reach from calculateReach Cloud Function ─────────────
  let _reachDebounce = null;
  let _reachFetching = false;

  async function fetchRealReach() {
    if (_reachFetching) return;
    const el = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };

    // Need a zone drawn for geo-targeted reach
    if (!drawnGeoJSON) {
      el('est-devices', '—'); el('est-sms', '—'); el('est-coverage', '—%');
      return;
    }

    el('est-devices', '…'); el('est-sms', '…'); el('est-coverage', '…');
    _reachFetching = true;

    try {
      const { getFunctions, httpsCallable } = await import(
        'https://www.gstatic.com/firebasejs/10.12.1/firebase-functions.js'
      );
      const fn = httpsCallable(getFunctions(window.FB.app, 'asia-south1'), 'calculateReach');

      // Build params matching the callable signature
      const props = drawnGeoJSON.properties || {};
      let params;
      if (props.radius) {
        params = {
          radius: props.radiusKm || (props.radius / 1000),
          centerLat: props.center?.lat,
          centerLng: props.center?.lng,
          district: App?.state?.currentAdmin?.district || null,
        };
      } else {
        params = {
          geoJSON: drawnGeoJSON,
          district: App?.state?.currentAdmin?.district || null,
        };
      }

      const result = await fn(params);
      const { totalUsersInRange = 0, reachableCount = 0 } = result.data || {};
      const coverage = totalUsersInRange > 0
        ? Math.round((reachableCount / totalUsersInRange) * 100)
        : 0;

      el('est-devices', totalUsersInRange.toLocaleString('en-IN'));
      el('est-sms', reachableCount.toLocaleString('en-IN'));
      el('est-coverage', coverage + '%');
    } catch (err) {
      console.warn('[Reach] calculateReach failed (non-critical):', err.message);
      el('est-devices', '—'); el('est-sms', '—'); el('est-coverage', '—%');
    } finally {
      _reachFetching = false;
    }
  }

  function scheduleReachFetch() {
    clearTimeout(_reachDebounce);
    _reachDebounce = setTimeout(fetchRealReach, 800);
  }



  // Attach live listeners
  ['ca-type', 'ca-severity', 'ca-message', 'ca-area'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', updatePreview);
    document.getElementById(id)?.addEventListener('change', updatePreview);
  });
  document.getElementById('ca-drill')?.addEventListener('change', updatePreview);

  // Character counter
  document.getElementById('ca-message')?.addEventListener('input', function () {
    const cnt = document.getElementById('ca-char-count');
    if (cnt) cnt.textContent = this.value.length;
  });

  // ── Send Alert Button ─────────────────────────────────────────
  document.getElementById('ca-send-btn')?.addEventListener('click', () => {
    const type = document.getElementById('ca-type')?.value;
    const severity = document.getElementById('ca-severity')?.value;
    const message = document.getElementById('ca-message')?.value.trim();
    const area = document.getElementById('ca-area')?.value.trim();
    const isDrill = document.getElementById('ca-drill')?.checked;
    const valEl = document.getElementById('ca-validation');

    // ── Validate ──────────────────────────────────────────────
    const errors = [];
    if (!type) errors.push('• Select an Alert Type');
    if (!severity) errors.push('• Select a Severity Level');
    if (!message || message.length < 10) errors.push('• Enter an Alert Message (min 10 characters)');

    if (errors.length) {
      valEl.innerHTML = errors.join('<br>');
      valEl.style.display = 'block';
      setTimeout(() => { valEl.style.display = 'none'; }, 5000);
      return;
    }
    valEl.style.display = 'none';

    const severityColor = { Info: '#3b82f6', Warning: '#f59e0b', Emergency: '#ef4444', Evacuate: '#7c3aed' }[severity];

    // ── Confirmation Modal ────────────────────────────────────
    showModal({
      icon: '🚨',
      title: `Send ${isDrill ? 'DRILL ' : ''}Alert?`,
      body: `
        <div style="background:${severityColor}15;border:1px solid ${severityColor}40;border-radius:8px;padding:14px;margin-bottom:12px">
          <strong style="color:${severityColor}">${App.alertTypeIcon(type)} ${type} – ${severity}</strong>
          ${isDrill ? `<span style="background:#3b82f620;color:#3b82f6;padding:2px 8px;border-radius:10px;font-size:11px;margin-left:6px">DRILL</span>` : ''}
          <div style="margin-top:8px;font-size:13px">"${message}"</div>
        </div>
        <div style="font-size:13px;color:var(--text-secondary)">
          📍 <strong>${area || drawnAreaName}</strong><br>
          🗺️ Zone: ${drawnGeoJSON ? 'Drawn ✓' : 'No zone drawn (alert will be regional)'}
        </div>`,
      confirmText: isDrill ? '✅ Send DRILL Alert' : '🚨 YES, Send Alert Now',
      confirmClass: 'btn-danger',
      onConfirm: async () => {
        const sendBtn = document.getElementById('ca-send-btn');
        if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = 'Sending…'; }

        try {
          // ── Write to Firestore ──────────────────────────────────
          const { db, collection, addDoc, serverTimestamp } = window.FB;
          const admin = App.state.currentAdmin;

          // Build geofence map to match firestore.rules
          let geofence = null;
          if (drawnGeoJSON) {
            const props = drawnGeoJSON.properties || {};
            if (props.radius) {
              geofence = {
                type: 'radius',
                centerLat: props.center.lat,
                centerLng: props.center.lng,
                radius: props.radius / 1000, // km
                metadata: props.metadata || null
              };
            } else {
              geofence = {
                type: 'polygon',
                geoJSON: JSON.stringify(drawnGeoJSON),
                metadata: props.metadata || null
              };
            }
          }

          const alertPayload = {
            type,
            severity,
            message,
            area: area || drawnAreaName || 'Unspecified',
            isDrill,
            geofence: geofence || { type: 'none' }, // Rules require geofence field
            active: true,
            creatorUid: admin?.uid || null,
            creatorName: admin?.name || null,
            district: admin?.district || null,
            timeSent: serverTimestamp(),
            reach: 0,
            deliveredCount: 0,
            openedCount: 0,
          };

          const docRef = await addDoc(collection(db, 'alerts'), alertPayload);
          const alertId = docRef.id;

          // ── Show success state ─────────────────────────────────
          showToast(`✅ Alert ${alertId} broadcast initiated!`, 'success', 6000);
          if (sendBtn) { sendBtn.textContent = '✅ Alert Sent!'; }
          const successEl = document.getElementById('ca-success');
          const successMsg = document.getElementById('ca-success-msg');
          if (successEl) successEl.style.display = 'block';
          if (successMsg) successMsg.innerHTML =
            `✅ Alert <strong>${alertId.slice(0, 8)}</strong> saved — dispatching push notifications…`;

          console.info('[CreateAlert] Alert published:', alertId, alertPayload);

          // ── Dispatch FCM push directly (no Cloud Function needed) ──────
          try {
            await dispatchFCMDirect(alertId, alertPayload);
            if (successMsg) successMsg.innerHTML =
              `✅ Alert broadcast! FCM push dispatched to citizens. Alert ID: <code>${alertId.slice(0, 8)}</code>`;
          } catch (fcmErr) {
            console.warn('[CreateAlert] FCM direct dispatch failed (non-fatal):', fcmErr.message);
            if (successMsg) successMsg.innerHTML =
              `✅ Alert saved. Push via background service. ID: <code>${alertId.slice(0, 8)}</code>`;
          }

          window.FB.logEvent?.('alert_created', { type, severity, isDrill: String(isDrill) });

        } catch (err) {
          console.error('[CreateAlert] addDoc error:', err.code, err.message);
          showToast(`❌ Failed to send alert: ${err.message}`, 'error', 6000);
          if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '🚀 Send Alert'; }
        }
      },
    });
  });
}

// ── Direct FCM push from admin browser ───────────────────────────────────────
// Works without Cloud Functions by:
//   1. Reading all citizen FCM tokens from Firestore
//   2. Calling FCM REST API directly with each token
// Requires: window.RAPIDALERT_CONFIG.fcmServerKey to be set
async function dispatchFCMDirect(alertId, alertData) {
  const serverKey = window.RAPIDALERT_CONFIG?.fcmServerKey;
  if (!serverKey) {
    console.warn('[FCM-Direct] No fcmServerKey in config — skipping direct push.');
    console.warn('[FCM-Direct] Run push-sender.js locally for background push support.');
    return;
  }

  const { severity, type, message, area, isDrill } = alertData;
  const isEmergency = severity === 'Emergency' || severity === 'Evacuate';
  const sevEmoji = { Emergency: '🔴', Evacuate: '🟣', Warning: '⚠️', Info: 'ℹ️' };
  const title = `${sevEmoji[severity] || '⚠️'} ${isDrill ? '[DRILL] ' : ''}${type} Alert`;
  const body = `📍 ${area}\n${(message || '').slice(0, 100)}`;

  // Fetch all citizen tokens from Firestore
  const { db, collection: col, query, where, getDocs } = window.FB;
  const snap = await getDocs(query(col(db, 'users'), where('fcmToken', '!=', null)));
  const tokens = [];
  snap.forEach(d => { const t = d.data().fcmToken; if (t) tokens.push(t); });

  console.log(`[FCM-Direct] Sending to ${tokens.length} token(s)`);
  if (tokens.length === 0) return;

  // Send in batches of 500 (FCM legacy limit)
  const BATCH = 500;
  for (let i = 0; i < tokens.length; i += BATCH) {
    const batch = tokens.slice(i, i + BATCH);
    const res = await fetch('https://fcm.googleapis.com/fcm/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `key=${serverKey}`,
      },
      body: JSON.stringify({
        registration_ids: batch,
        priority: isEmergency ? 'high' : 'normal',
        notification: {
          title, body,
          icon: '/rapidalert-citizen/icons/icon-192.png',
          sound: 'default',
          badge: '/rapidalert-citizen/icons/icon-72.png',
          click_action: `/rapidalert-citizen/?alert=${alertId}&alarm=${severity}`,
        },
        data: {
          type: 'ALERT', alertId, severity,
          alertType: type || '', message: message || '', area: area || '',
          isDrill: String(!!isDrill),
          url: `/rapidalert-citizen/?alert=${alertId}&alarm=${severity}`,
        },
        android: { priority: isEmergency ? 'high' : 'normal' },
      }),
    });
    const json = await res.json();
    console.log(`[FCM-Direct] Batch ${i / BATCH + 1}: success=${json.success} fail=${json.failure}`);
  }
}

window.renderCreateAlert = renderCreateAlert;
