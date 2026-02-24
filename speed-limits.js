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

  // 3. API call for uncached points (POST to avoid URL length limits)
  if (uncachedIndices.length > 0) {
    const BATCH_SIZE = 2000;
    for (let b = 0; b < uncachedIndices.length; b += BATCH_SIZE) {
      const batchIndices = uncachedIndices.slice(b, b + BATCH_SIZE);
      const postBody = batchIndices
        .map(idx => `${points[idx].lng},${points[idx].lat}`)
        .join(';');

      const url = `https://api.tomtom.com/snapToRoads/1`
        + `?fields=${encodeURIComponent('speedLimits{value,unit}')}`
        + `&vehicleType=PassengerCar`
        + `&key=${apiKey}`;

      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `points=${postBody}`
        });
        if (!resp.ok) {
          console.error('TomTom API error:', resp.status, await resp.text());
          continue;
        }
        const data = await resp.json();

        // Parse response — map projected points back to our input indices
        if (data.route && data.projectedPoints) {
          // Build a map from projected point index → speed limit
          // Each projected point has properties.index (original input index within the batch)
          // Each route leg has speed limits
          const projLimits = new Map();

          // Extract speed limits from route segments
          if (data.route) {
            for (const segment of data.route) {
              if (segment.properties && segment.properties.speedLimits) {
                for (const sl of segment.properties.speedLimits) {
                  // Speed limit applies to this segment
                  const limitKmh = sl.unit === 'MPH' ? sl.value * 1.60934 : sl.value;
                  // Store on segment — we'll map via projected points below
                  if (!segment._limitKmh) segment._limitKmh = limitKmh;
                }
              }
            }
          }

          // Map projected points to speed limits
          // projectedPoints[i] corresponds to input point i in the batch
          for (let pi = 0; pi < data.projectedPoints.length; pi++) {
            const pp = data.projectedPoints[pi];
            const batchIdx = pp.properties?.index ?? pi;
            const origIdx = batchIndices[batchIdx];
            if (origIdx === undefined) continue;

            // Find which route segment this projected point belongs to
            // Use routeIndex if available
            const routeIdx = pp.properties?.routeIndex ?? 0;
            const segment = data.route[routeIdx];
            let limitKmh = null;

            if (segment && segment.properties && segment.properties.speedLimits) {
              const sl = segment.properties.speedLimits[0];
              if (sl) {
                limitKmh = sl.unit === 'MPH'
                  ? Math.round(sl.value * 1.60934)
                  : sl.value;
              }
            }

            if (limitKmh !== null) {
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
