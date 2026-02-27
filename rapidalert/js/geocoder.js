/* ============================================================
   RapidAlert Admin – geocoder.js
   Country / City / Area search using OpenStreetMap Nominatim API.
   Integrates with Leaflet map on the Create Alert page.
   ============================================================ */

window.Geocoder = (function () {

    const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
    const HEADERS = { 'Accept-Language': 'en', 'User-Agent': 'RapidAlert/1.0' };

    // Rate limiting (Nominatim TOS: max 1 req/sec)
    let lastRequestTime = 0;
    let searchDebounce = null;

    // ── Search locations ─────────────────────────────────────────
    /**
     * Search for a place by name.
     * @param {string} query
     * @returns {Promise<Array>} list of result objects
     */
    async function search(query) {
        if (!query || query.length < 2) return [];

        // Rate limit: ensure 1 second between requests
        const now = Date.now();
        const gap = now - lastRequestTime;
        if (gap < 1100) await new Promise(r => setTimeout(r, 1100 - gap));
        lastRequestTime = Date.now();

        // Primary search — broad, includes amenities, buildings, roads, colleges
        const url = `${NOMINATIM_BASE}/search?format=json&q=${encodeURIComponent(query)}&limit=10&countrycodes=in&addressdetails=1&extratags=1&namedetails=1`;

        try {
            const res = await fetch(url, { headers: HEADERS });
            if (!res.ok) throw new Error('Nominatim error ' + res.status);
            const data = await res.json();

            if (data.length > 0) {
                return data.map(item => ({
                    displayName: item.display_name,
                    shortName: buildShortName(item),
                    lat: parseFloat(item.lat),
                    lng: parseFloat(item.lon),
                    type: item.type,
                    class: item.class,
                    category: item.class || item.category,
                    osm_type: item.osm_type,
                    osm_id: item.osm_id,
                    importance: item.importance || 0.5,
                    boundingBox: item.boundingbox ? {
                        south: parseFloat(item.boundingbox[0]),
                        north: parseFloat(item.boundingbox[1]),
                        west: parseFloat(item.boundingbox[2]),
                        east: parseFloat(item.boundingbox[3]),
                    } : null,
                    raw: item,
                }));
            }

            // No results — fallback to mock
            return getMockResults(query);

        } catch (err) {
            console.warn('[Geocoder] Search failed:', err.message);
            return getMockResults(query);
        }
    }

    // Build readable short name — prefer name over generic city/state
    function buildShortName(item) {
        const a = item.address || {};
        const nn = item.namedetails?.name || item.namedetails?.['name:en'] || '';
        // For specific places (amenity, building, etc.), show the place name + city
        if (['amenity', 'building', 'tourism', 'leisure', 'office', 'shop', 'landuse'].includes(item.class)) {
            const place = nn || a.amenity || a.building || '';
            const city = a.city || a.town || a.village || a.municipality || '';
            const state = a.state || '';
            return [place, city, state].filter(Boolean).join(', ') || item.display_name.split(',').slice(0, 3).join(',');
        }
        const parts = [
            a.city || a.town || a.village || a.county || a.district,
            a.state,
            a.country,
        ].filter(Boolean);
        return parts.slice(0, 3).join(', ') || item.display_name.split(',').slice(0, 3).join(',');
    }

    // ── Mock results (used if Nominatim is offline) ─────────────
    function getMockResults(query) {
        const q = query.toLowerCase();
        const places = [
            { displayName: 'Wainganga College of Engineering and Management, Nagpur, Maharashtra, India', shortName: 'Wainganga College, Nagpur', lat: 20.99033, lng: 79.024, category: 'amenity', type: 'college', osm_id: 1000001, osm_type: 'node', importance: 1.0, boundingBox: { south: 20.985, north: 20.995, west: 79.019, east: 79.029 } },
            { displayName: 'Nagpur, Maharashtra, India', shortName: 'Nagpur, Maharashtra', lat: 21.1458, lng: 79.0882, category: 'place', type: 'city', osm_id: 1000002, osm_type: 'node', importance: 0.95, boundingBox: { south: 20.95, north: 21.30, west: 78.90, east: 79.25 } },
            { displayName: 'Ganga College Dongargaon, Chhattisgarh, India', shortName: 'Ganga College Dongargaon', lat: 20.95, lng: 80.85, category: 'amenity', type: 'college', osm_id: 999999, osm_type: 'node', importance: 0.9 },
            { displayName: 'Mumbai, Maharashtra, India', shortName: 'Mumbai, Maharashtra', lat: 19.0760, lng: 72.8777 },
            { displayName: 'Delhi, National Capital Territory', shortName: 'Delhi, NCT', lat: 28.6139, lng: 77.2090 },
            { displayName: 'Kolkata, West Bengal, India', shortName: 'Kolkata, West Bengal', lat: 22.5726, lng: 88.3639 },
            { displayName: 'Chennai, Tamil Nadu, India', shortName: 'Chennai, Tamil Nadu', lat: 13.0827, lng: 80.2707 },
            { displayName: 'Bangalore, Karnataka, India', shortName: 'Bangalore, Karnataka', lat: 12.9716, lng: 77.5946 },
            { displayName: 'Hyderabad, Telangana, India', shortName: 'Hyderabad, Telangana', lat: 17.3850, lng: 78.4867 },
            { displayName: 'Pune, Maharashtra, India', shortName: 'Pune, Maharashtra', lat: 18.5204, lng: 73.8567 },
            { displayName: 'Ahmedabad, Gujarat, India', shortName: 'Ahmedabad, Gujarat', lat: 23.0225, lng: 72.5714 },
            { displayName: 'Jaipur, Rajasthan, India', shortName: 'Jaipur, Rajasthan', lat: 26.9124, lng: 75.7873 },
            { displayName: 'Surat, Gujarat, India', shortName: 'Surat, Gujarat', lat: 21.1702, lng: 72.8311 },
            { displayName: 'Lucknow, Uttar Pradesh, India', shortName: 'Lucknow, Uttar Pradesh', lat: 26.8467, lng: 80.9462 },
            { displayName: 'Guwahati, Assam, India', shortName: 'Guwahati, Assam', lat: 26.1445, lng: 91.7362 },
            { displayName: 'Puri, Odisha, India', shortName: 'Puri, Odisha', lat: 19.8135, lng: 85.8312 },
            { displayName: 'Bhuj, Gujarat, India', shortName: 'Bhuj, Gujarat', lat: 23.2420, lng: 69.6669 },
            { displayName: 'Visakhapatnam, Andhra Pradesh, India', shortName: 'Vizag, AP', lat: 17.6868, lng: 83.2185 },
            { displayName: 'Uttarkashi, Uttarakhand, India', shortName: 'Uttarkashi, Uttarakhand', lat: 30.7268, lng: 78.4354 },
            { displayName: 'Rameshwaram, Tamil Nadu, India', shortName: 'Rameshwaram, TN', lat: 9.2876, lng: 79.3129 },
            { displayName: 'Dharmshala, Himachal Pradesh, India', shortName: 'Dharamshala, HP', lat: 32.2190, lng: 76.3234 },
        ];
        return places.filter(p => p.displayName.toLowerCase().includes(q) || p.shortName.toLowerCase().includes(q));
    }

    // ── Debounced search ─────────────────────────────────────────
    function searchDebounced(query, callback, delay = 500) {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(async () => {
            const results = await search(query);
            callback(results);
        }, delay);
    }

    // ── Create Search Widget ─────────────────────────────────────
    /**
     * Creates and returns a search widget HTML element.
     * @param {Object} map – Leaflet map instance
     * @param {Function} onSelect – called with { lat, lng, shortName, boundingBox }
     */
    function createSearchWidget(map, onSelect) {
        const wrapper = document.createElement('div');
        wrapper.className = 'geocoder-widget';
        wrapper.innerHTML = `
      <div class="geocoder-input-wrap">
        <span class="geocoder-icon">🔍</span>
        <input type="text" class="geocoder-input" id="geocoder-input"
               placeholder="Search city, district, area…" autocomplete="off"/>
        <button class="geocoder-clear" id="geocoder-clear" style="display:none">✕</button>
      </div>
      <div class="geocoder-results" id="geocoder-results" style="display:none"></div>`;

        const input = wrapper.querySelector('#geocoder-input');
        const results = wrapper.querySelector('#geocoder-results');
        const clearBtn = wrapper.querySelector('#geocoder-clear');

        // Current search marker on map
        let searchMarker = null;

        input.addEventListener('input', () => {
            const q = input.value.trim();
            clearBtn.style.display = q ? 'block' : 'none';
            if (!q) { results.style.display = 'none'; return; }

            results.style.display = 'block';
            results.innerHTML = '<div class="geocoder-loading">Searching…</div>';

            searchDebounced(q, (items) => {
                if (!items.length) {
                    results.innerHTML = '<div class="geocoder-no-results">No results found.</div>';
                    return;
                }
                results.innerHTML = items.map((item, i) => `
          <div class="geocoder-item" data-idx="${i}">
            <span class="gc-icon">${getPlaceIcon(item.type || item.class)}</span>
            <div class="gc-body">
              <div class="gc-name">${item.shortName}</div>
              <div class="gc-sub">${item.displayName.split(',').slice(-2).join(',').trim()}</div>
            </div>
          </div>`).join('');

                // Click handler
                results.querySelectorAll('.geocoder-item').forEach((el, i) => {
                    el.addEventListener('click', () => {
                        const item = items[i];
                        input.value = item.shortName;
                        results.style.display = 'none';

                        // Fly map to location
                        if (item.boundingBox) {
                            // For large areas use fitBounds; for specific places use setView at high zoom
                            const isSpecificPlace = ['amenity', 'building', 'tourism', 'leisure', 'office', 'shop'].includes(item.class);
                            if (isSpecificPlace) {
                                map.setView([item.lat, item.lng], 17, { animate: true });
                            } else {
                                map.fitBounds([
                                    [item.boundingBox.south, item.boundingBox.west],
                                    [item.boundingBox.north, item.boundingBox.east],
                                ], { padding: [30, 30], maxZoom: 14 });
                            }
                        } else {
                            map.setView([item.lat, item.lng], 15, { animate: true });
                        }

                        // Place a temporary search marker
                        if (searchMarker) map.removeLayer(searchMarker);
                        searchMarker = L.marker([item.lat, item.lng], {
                            icon: L.divIcon({
                                className: '',
                                html: `<div style="background:#3b82f6;width:14px;height:14px;border-radius:50%;border:3px solid white;box-shadow:0 2px 8px rgba(59,130,246,0.6)"></div>`,
                                iconSize: [14, 14], iconAnchor: [7, 7],
                            }),
                        }).addTo(map).bindPopup(`📍 <b>${item.shortName}</b>`).openPopup();

                        onSelect && onSelect({
                            lat: item.lat,
                            lng: item.lng,
                            shortName: item.shortName,
                            boundingBox: item.boundingBox,
                            osm_id: item.osm_id,
                            osm_type: item.osm_type,
                            category: item.category,
                            type: item.type,
                            importance: item.importance || 0.5
                        });
                    });
                });
            });
        });

        // Clear button
        clearBtn.addEventListener('click', () => {
            input.value = '';
            clearBtn.style.display = 'none';
            results.style.display = 'none';
            if (searchMarker) { map.removeLayer(searchMarker); searchMarker = null; }
        });

        // Hide results when clicking outside
        document.addEventListener('click', (e) => {
            if (!wrapper.contains(e.target)) results.style.display = 'none';
        });

        return wrapper;
    }

    function getPlaceIcon(type) {
        const map = {
            city: '🏙️', town: '🏘️', village: '🏡', district: '📍',
            state: '🗺️', country: '🌍', administrative: '📍',
            suburb: '🏘️', county: '📍', region: '🗺️',
            college: '🎓', university: '🎓', school: '🏫', education: '🎓',
            hospital: '🏥', clinic: '🏥', amenity: '🏢', building: '🏢',
            police: '🚓', fire_station: '🚒'
        };
        return map[type] || '📍';
    }

    return { search, searchDebounced, createSearchWidget };

})();
