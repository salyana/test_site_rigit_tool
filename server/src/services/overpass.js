const fetch = require('node-fetch');

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

let currentEndpoint = 0;
let activeRequests = 0;
let lastRequestTime = 0;
const MAX_CONCURRENT = 2;

function getNextEndpoint() {
  const endpoint = ENDPOINTS[currentEndpoint];
  currentEndpoint = (currentEndpoint + 1) % ENDPOINTS.length;
  return endpoint;
}

async function waitForSlot() {
  while (activeRequests >= MAX_CONCURRENT) {
    await new Promise(r => setTimeout(r, 100));
  }
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < 1000) {
    await new Promise(r => setTimeout(r, 1000 - elapsed));
  }
  activeRequests++;
  lastRequestTime = Date.now();
}

function releaseSlot() {
  activeRequests = Math.max(0, activeRequests - 1);
}

function extractHeight(tags) {
  if (!tags) return null;
  if (tags.height) {
    const h = parseFloat(tags.height);
    if (!isNaN(h)) return h;
  }
  if (tags['building:levels']) {
    const levels = parseFloat(tags['building:levels']);
    if (!isNaN(levels)) return levels * 3.2;
  }
  return null;
}

function elementToFeature(element) {
  if (!element.geometry && !element.bounds) return null;

  let coordinates;
  if (element.type === 'way' && element.geometry) {
    coordinates = element.geometry.map(p => [p.lon, p.lat]);
    // Close the ring if not closed
    if (coordinates.length > 0) {
      const first = coordinates[0];
      const last = coordinates[coordinates.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) {
        coordinates.push([...first]);
      }
    }
  } else if (element.type === 'relation' && element.members) {
    // For relations, collect outer ways
    const outerCoords = [];
    for (const member of element.members) {
      if (member.role === 'outer' && member.geometry) {
        outerCoords.push(member.geometry.map(p => [p.lon, p.lat]));
      }
    }
    if (outerCoords.length === 0) return null;
    // Use the first outer ring
    coordinates = outerCoords[0];
    if (coordinates.length > 0) {
      const first = coordinates[0];
      const last = coordinates[coordinates.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) {
        coordinates.push([...first]);
      }
    }
  } else {
    return null;
  }

  if (coordinates.length < 4) return null;

  const tags = element.tags || {};
  const height = extractHeight(tags) || 10;

  return {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [coordinates]
    },
    properties: {
      id: `osm_${element.type}_${element.id}`,
      height,
      source: 'osm',
      confidence: null,
      levels: tags['building:levels'] ? parseInt(tags['building:levels'], 10) : null,
      name: tags.name || null,
      _osmHeightExplicit: !!(tags.height || tags['building:levels'])
    }
  };
}

async function fetchBuildings(lat, lng, radius) {
  const query = `
[out:json][timeout:90];
(
  way["building"](around:${radius},${lat},${lng});
  relation["building"](around:${radius},${lat},${lng});
);
out geom tags;
`.trim();

  // Try each endpoint in turn until one succeeds
  let lastErr = null;
  for (let attempt = 0; attempt < ENDPOINTS.length; attempt++) {
    await waitForSlot();
    try {
      const endpoint = getNextEndpoint();
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        timeout: 95000
      });

      if (!res.ok) {
        throw new Error(`Overpass returned ${res.status}: ${res.statusText}`);
      }

      const data = await res.json();
      const features = [];
      for (const element of (data.elements || [])) {
        const feature = elementToFeature(element);
        if (feature) features.push(feature);
      }
      return features;
    } catch (err) {
      lastErr = err;
      console.warn(`Overpass endpoint failed (attempt ${attempt + 1}/${ENDPOINTS.length}):`, err.message);
      releaseSlot();
    }
  }
  throw lastErr || new Error('All Overpass endpoints failed');
}

module.exports = { fetchBuildings };
