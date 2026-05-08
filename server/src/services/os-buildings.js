const fetch = require('node-fetch');

// OS NGD API – Features (OGC API Features)
// Free API key from https://osdatahub.os.uk
// Uses bld-fts-buildingpart-1 which has LiDAR-measured heights

const API_KEY = process.env.OS_API_KEY || '';
const NGD_BASE = 'https://api.os.uk/features/ngd/ofa/v1';
const COLLECTION = 'bld-fts-buildingpart-1';

async function fetchBuildings(lat, lng, radius) {
  if (!API_KEY) {
    throw new Error('OS_API_KEY not set. Get a free key at https://osdatahub.os.uk');
  }

  // Cap radius to avoid huge bbox queries that timeout
  const cappedRadius = Math.min(radius, 500);

  // Convert radius to bbox in WGS84
  const latDelta = cappedRadius / 111320;
  const lngDelta = cappedRadius / (111320 * Math.cos(lat * Math.PI / 180));
  const bbox = [
    (lng - lngDelta).toFixed(6),
    (lat - latDelta).toFixed(6),
    (lng + lngDelta).toFixed(6),
    (lat + latDelta).toFixed(6)
  ].join(',');

  // Paginate through results (API max 100 per page)
  const allFeatures = [];
  let offset = 0;
  const pageSize = 100;
  const maxFeatures = 500;

  while (offset < maxFeatures) {
    const url = `${NGD_BASE}/collections/${COLLECTION}/items?` + [
      `key=${API_KEY}`,
      `bbox=${bbox}`,
      `limit=${pageSize}`,
      `offset=${offset}`
    ].join('&');

    const res = await fetch(url, { timeout: 60000 });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OS NGD returned ${res.status}: ${body.substring(0, 200)}`);
    }

    const data = await res.json();
    const features = data.features || [];
    allFeatures.push(...features);

    // Stop if we got fewer than requested (no more pages)
    if (features.length < pageSize) break;
    offset += pageSize;
  }

  console.log(`OS NGD: ${allFeatures.length} building parts in bbox`);

  return allFeatures.map(f => {
    const p = f.properties || {};

    // relativeheightmaximum = ground-to-top height (best for 3D)
    // absoluteheightmaximum - absoluteheightminimum = alternative
    const height = p.relativeheightmaximum
      || (p.absoluteheightmaximum && p.absoluteheightminimum
        ? p.absoluteheightmaximum - p.absoluteheightminimum
        : null);

    const confidenceMap = { 'High': 0.95, 'Moderate': 0.8, 'Low': 0.5 };

    return {
      type: 'Feature',
      geometry: f.geometry,
      properties: {
        id: `os_${p.toid || p.osid || Math.random().toString(36).slice(2)}`,
        height,
        source: 'ordnance_survey',
        confidence: confidenceMap[p.heightconfidencelevel] || null,
        levels: null,
        name: p.description || null,
        os_toid: p.toid || null,
        os_height_source: p.height_source || null,
        os_height_confidence: p.heightconfidencelevel || null,
        os_abs_max: p.absoluteheightmaximum || null,
        os_abs_min: p.absoluteheightminimum || null,
        os_roof_base: p.relativeheightroofbase || null
      }
    };
  });
}

module.exports = { fetchBuildings };
