const fetch = require('node-fetch');
const zlib = require('zlib');
const { promisify } = require('util');
const { latLngToQuadkey } = require('../utils/quadkey');

const gunzip = promisify(zlib.gunzip);

const MANIFEST_URL = 'https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv';
const CACHE_TTL = (parseInt(process.env.CACHE_TTL_HOURS, 10) || 24) * 3600 * 1000;

let manifest = null;       // Map<quadkey, {url, size}>
let manifestLoadedAt = 0;
let manifestLoading = null;

// In-memory cache for downloaded tile data
const tileCache = new Map();

function isManifestLoaded() {
  return manifest !== null;
}

async function loadManifest() {
  // Deduplicate concurrent manifest loads
  if (manifestLoading) return manifestLoading;

  manifestLoading = (async () => {
    try {
      console.log('Loading Microsoft buildings manifest...');
      const res = await fetch(MANIFEST_URL, { timeout: 60000 });
      if (!res.ok) throw new Error(`Manifest fetch failed: ${res.status}`);
      const text = await res.text();

      const newManifest = new Map();
      const lines = text.split('\n');
      // Skip header line (Location,QuadKey,Url,Size,UploadDate)
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const commaIdx = line.indexOf(',');
        if (commaIdx === -1) continue;
        const afterFirst = line.indexOf(',', commaIdx + 1);
        if (afterFirst === -1) continue;
        const quadkey = line.substring(commaIdx + 1, afterFirst);
        const afterSecond = line.indexOf(',', afterFirst + 1);
        const url = afterSecond === -1
          ? line.substring(afterFirst + 1)
          : line.substring(afterFirst + 1, afterSecond);
        // Parse size (e.g. "113.1MB", "138.6KB")
        let sizeBytes = 0;
        if (afterSecond !== -1) {
          const afterThird = line.indexOf(',', afterSecond + 1);
          const sizeStr = afterThird === -1
            ? line.substring(afterSecond + 1)
            : line.substring(afterSecond + 1, afterThird);
          const m = sizeStr.match(/([\d.]+)\s*(KB|MB|GB)/i);
          if (m) {
            const val = parseFloat(m[1]);
            const unit = m[2].toUpperCase();
            sizeBytes = val * (unit === 'GB' ? 1e9 : unit === 'MB' ? 1e6 : 1e3);
          }
        }

        if (quadkey && url) {
          newManifest.set(quadkey, { url, sizeBytes });
        }
      }

      manifest = newManifest;
      manifestLoadedAt = Date.now();
      console.log(`Manifest loaded: ${manifest.size} tiles`);
    } finally {
      manifestLoading = null;
    }
  })();

  return manifestLoading;
}

async function ensureManifest() {
  if (!manifest || (Date.now() - manifestLoadedAt) > CACHE_TTL) {
    await loadManifest();
  }
}

function findTileEntry(quadkey) {
  if (!manifest) return null;
  // Exact match first
  if (manifest.has(quadkey)) return manifest.get(quadkey);
  // Try parent quadkeys (the manifest may use a different zoom level)
  for (let len = quadkey.length - 1; len >= 1; len--) {
    const parent = quadkey.substring(0, len);
    if (manifest.has(parent)) return manifest.get(parent);
  }
  return null;
}

function pointInBBox(lat, lng, bbox) {
  return lat >= bbox[1] && lat <= bbox[3] && lng >= bbox[0] && lng <= bbox[2];
}

function distanceMetres(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Stream-download a tile and filter features by bounding box on the fly.
// For large tiles (>10MB) we stream to avoid buffering hundreds of MB in memory.
const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10 MB — buffer small tiles, stream large ones

async function downloadTileBuffered(url) {
  const res = await fetch(url, { timeout: 120000 });
  if (!res.ok) throw new Error(`Tile download failed: ${res.status}`);

  const buffer = await res.buffer();
  let text;
  try {
    const decompressed = await gunzip(buffer);
    text = decompressed.toString('utf8');
  } catch {
    text = buffer.toString('utf8');
  }

  const features = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.geometry) {
        features.push({
          type: 'Feature',
          geometry: obj.geometry,
          properties: {
            height: obj.properties?.height || null,
            confidence: obj.properties?.confidence || null
          }
        });
      }
    } catch { /* skip */ }
  }
  return features;
}

async function downloadTileStreaming(url, bbox) {
  // bbox = [minLng, minLat, maxLng, maxLat] — pre-filter during download
  const res = await fetch(url, { timeout: 300000 }); // 5 min for large tiles
  if (!res.ok) throw new Error(`Tile download failed: ${res.status}`);

  return new Promise((resolve, reject) => {
    const features = [];
    const decompressor = zlib.createGunzip();
    let partial = '';

    decompressor.on('data', (chunk) => {
      partial += chunk.toString('utf8');
      const lines = partial.split('\n');
      // Keep the last (potentially incomplete) line
      partial = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (!obj.geometry) continue;
          // Quick bbox check on first coordinate to skip most features
          const coords = obj.geometry.type === 'Polygon'
            ? obj.geometry.coordinates[0]
            : obj.geometry.type === 'MultiPolygon'
              ? obj.geometry.coordinates[0][0]
              : null;
          if (!coords || coords.length === 0) continue;

          // Check if any vertex falls within the expanded bbox
          let inBBox = false;
          for (const c of coords) {
            if (c[0] >= bbox[0] && c[0] <= bbox[2] && c[1] >= bbox[1] && c[1] <= bbox[3]) {
              inBBox = true;
              break;
            }
          }
          if (!inBBox) continue;

          features.push({
            type: 'Feature',
            geometry: obj.geometry,
            properties: {
              height: obj.properties?.height || null,
              confidence: obj.properties?.confidence || null
            }
          });
        } catch { /* skip */ }
      }
    });

    decompressor.on('end', () => {
      // Process any remaining partial line
      if (partial.trim()) {
        try {
          const obj = JSON.parse(partial.trim());
          if (obj.geometry) {
            features.push({
              type: 'Feature',
              geometry: obj.geometry,
              properties: {
                height: obj.properties?.height || null,
                confidence: obj.properties?.confidence || null
              }
            });
          }
        } catch { /* skip */ }
      }
      resolve(features);
    });

    decompressor.on('error', (err) => {
      // If decompression fails, resolve with whatever we have so far
      console.warn('Decompression error (returning partial results):', err.message);
      resolve(features);
    });

    res.body.on('error', reject);
    res.body.pipe(decompressor);
  });
}

function computeBBox(lat, lng, radius) {
  // Compute a bounding box around the point, with some padding
  const paddedRadius = radius * 1.5;
  const latDelta = paddedRadius / 111320;
  const lngDelta = paddedRadius / (111320 * Math.cos(lat * Math.PI / 180));
  return [lng - lngDelta, lat - latDelta, lng + lngDelta, lat + latDelta];
}

async function fetchBuildings(lat, lng, radius) {
  await ensureManifest();

  const quadkey = latLngToQuadkey(lat, lng, 9);
  const entry = findTileEntry(quadkey);
  if (!entry) return [];

  const { url, sizeBytes } = entry;
  const bbox = computeBBox(lat, lng, radius);

  // Check cache first
  const cacheKey = `${url}_${bbox.join(',')}`;
  const cached = tileCache.get(cacheKey);
  if (cached && (Date.now() - cached.time) < CACHE_TTL) {
    return cached.features;
  }

  let allFeatures;
  if (sizeBytes > MAX_BUFFER_SIZE) {
    // Large tile: stream and filter by bbox during download
    console.log(`Streaming large tile (${(sizeBytes / 1e6).toFixed(1)}MB) for quadkey ${quadkey}...`);
    allFeatures = await downloadTileStreaming(url, bbox);
    console.log(`Streamed tile complete: ${allFeatures.length} features in bbox`);
  } else {
    allFeatures = await downloadTileBuffered(url);
  }

  // Filter to only buildings within the requested radius
  const nearby = [];
  for (const feature of allFeatures) {
    const geom = feature.geometry;
    let centLat, centLng;

    if (geom.type === 'Polygon') {
      const coords = geom.coordinates[0];
      let sumLat = 0, sumLng = 0;
      for (const c of coords) {
        sumLng += c[0];
        sumLat += c[1];
      }
      centLng = sumLng / coords.length;
      centLat = sumLat / coords.length;
    } else if (geom.type === 'MultiPolygon') {
      const coords = geom.coordinates[0][0];
      let sumLat = 0, sumLng = 0;
      for (const c of coords) {
        sumLng += c[0];
        sumLat += c[1];
      }
      centLng = sumLng / coords.length;
      centLat = sumLat / coords.length;
    } else {
      continue;
    }

    const dist = distanceMetres(lat, lng, centLat, centLng);
    if (dist <= radius) {
      feature.properties._centroid = [centLng, centLat];
      nearby.push(feature);
    }
  }

  // Cache the filtered results
  tileCache.set(cacheKey, { features: nearby, time: Date.now() });
  return nearby;
}

module.exports = { fetchBuildings, isManifestLoaded };
