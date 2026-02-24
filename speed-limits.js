/**
 * Speed Limits module — TomTom Snap to Roads API with localStorage caching
 */

const CACHE_PREFIX = 'sl_';
const CACHE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SAMPLE_INTERVAL = 10; // every Nth point

/** Round to 5 decimal places (~1m precision) */
function round5(v) {
  return Math.round(v * 1e5) / 1e5;
}

/** Build cache key from lat/lng */
function cacheKey(lat, lng) {
  return `${CACHE_PREFIX}${round5(lat)}_${round5(lng)}`;
}

/** Prune expired cache entries on load */
function pruneCache() {
  const now = Date.now();
  const keysToRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(CACHE_PREFIX)) {
      try {
        const entry = JSON.parse(localStorage.getItem(key));
        if (!entry.fetched || now - entry.fetched > CACHE_EXPIRY_MS) {
          keysToRemove.push(key);
        }
      } catch {
        keysToRemove.push(key);
      }
    }
  }
  keysToRemove.forEach(k => localStorage.removeItem(k));
}

// Prune on module load
pruneCache();

/**
 * Fetch speed limits for a track.
 * @param {Array<{lat:number, lng:number, ts:any}>} points - track points
 * @param {string} apiKey - TomTom API key
 * @returns {Promise<Array<number|null>>} speed limit (km/h) per point, null if unknown
 */
export async function fetchSpeedLimits(points, apiKey) {
  if (!points.length || !apiKey) return [];

  // 1. Sample points (every Nth, plus first and last)
  const sampledIndices = [];
  for (let i = 0; i < points.length; i++) {
    if (i === 0 || i === points.length - 1 || i % SAMPLE_INTERVAL === 0) {
      const p = points[i];
      if (p.lat && p.lng) {
        sampledIndices.push(i);
      }
    }
  }

  // 2. Check cache for sampled points
  const results = new Array(points.length).fill(null);
  const uncachedIndices = [];

  for (const idx of sampledIndices) {
    const p = points[idx];
    const key = cacheKey(p.lat, p.lng);
    const cached = localStorage.getItem(key);
    if (cached) {
      try {
        const entry = JSON.parse(cached);
        if (Date.now() - entry.fetched <= CACHE_EXPIRY_MS) {
          results[idx] = entry.limit;
          continue;
        }
      } catch { /* fall through */ }
    }
    uncachedIndices.push(idx);
  }

  // 3. API call for uncached points (POST with JSON body)
  if (uncachedIndices.length > 0) {
    // Pre-encode the fields param — braces must be percent-encoded
    const fieldsParam = '%7BprojectedPoints%7Bproperties%7BrouteIndex%7D%7D%2Croute%7Bproperties%7BspeedLimits%7Bvalue%2Cunit%7D%7D%7D%7D';

    const BATCH_SIZE = 2000;
    for (let b = 0; b < uncachedIndices.length; b += BATCH_SIZE) {
      const batchIndices = uncachedIndices.slice(b, b + BATCH_SIZE);

      // Build GeoJSON Feature array for POST body
      const geoPoints = batchIndices.map(idx => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [points[idx].lng, points[idx].lat]
        },
        properties: {}
      }));

      const url = `https://api.tomtom.com/snapToRoads/1`
        + `?fields=${fieldsParam}`
        + `&vehicleType=PassengerCar`
        + `&key=${apiKey}`;

      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ points: geoPoints })
        });
        if (!resp.ok) {
          console.error('TomTom API error:', resp.status, await resp.text());
          continue;
        }
        const data = await resp.json();

        if (data.route && data.projectedPoints) {
          // Map each projected point to its route segment's speed limit
          for (let pi = 0; pi < data.projectedPoints.length; pi++) {
            const pp = data.projectedPoints[pi];
            const routeIdx = pp.properties?.routeIndex ?? 0;
            const origIdx = batchIndices[pi];
            if (origIdx === undefined) continue;

            const segment = data.route[routeIdx];
            const sl = segment?.properties?.speedLimits;
            if (!sl || sl.value == null) continue;

            const limitKmh = sl.unit === 'MPH'
              ? Math.round(sl.value * 1.60934)
              : sl.value;

            results[origIdx] = limitKmh;

            // 4. Cache store
            const p = points[origIdx];
            const key = cacheKey(p.lat, p.lng);
            try {
              localStorage.setItem(key, JSON.stringify({
                limit: limitKmh,
                unit: 'kmph',
                fetched: Date.now()
              }));
            } catch { /* storage full — skip */ }
          }
        }
      } catch (err) {
        console.error('TomTom fetch failed:', err);
      }
    }
  }

  // 5. Interpolate — fill non-sampled points from nearest sampled point
  // Forward pass
  let lastKnown = null;
  for (let i = 0; i < results.length; i++) {
    if (results[i] !== null) {
      lastKnown = results[i];
    } else if (lastKnown !== null) {
      results[i] = lastKnown;
    }
  }
  // Backward pass for leading nulls
  lastKnown = null;
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i] !== null) {
      lastKnown = results[i];
    } else if (lastKnown !== null) {
      results[i] = lastKnown;
    }
  }

  return results;
}
