const booleanPointInPolygon = require('@turf/boolean-point-in-polygon').default;
const { point } = require('@turf/helpers');

/**
 * Merge buildings from OSM, Microsoft, and OS NGD.
 * Height priority: OS LiDAR > OSM explicit > Microsoft ML > default 10m
 */
function mergeBuildings(osmFeatures, msFeatures, osFeatures) {
  const hasOsm = osmFeatures && osmFeatures.length > 0;
  const hasMs  = msFeatures  && msFeatures.length  > 0;
  const hasOs  = osFeatures  && osFeatures.length  > 0;

  // No data at all
  if (!hasOsm && !hasMs && !hasOs) return [];

  // Build a spatial index of OS features for height lookups
  // Each OS feature centroid is computed for point-in-polygon matching
  const osCentroids = hasOs ? osFeatures.map(f => {
    const geom = f.geometry;
    const coords = geom.type === 'Polygon' ? geom.coordinates[0]
      : geom.type === 'MultiPolygon' ? geom.coordinates[0][0] : null;
    if (!coords || coords.length === 0) return null;
    let sumLng = 0, sumLat = 0;
    for (const c of coords) { sumLng += c[0]; sumLat += c[1]; }
    return point([sumLng / coords.length, sumLat / coords.length]);
  }) : [];
  const osMatched = new Set();

  // Microsoft centroids for matching
  const msCentroids = hasMs ? msFeatures.map(f => {
    const c = f.properties._centroid;
    return c ? point(c) : null;
  }) : [];
  const msMatched = new Set();

  if (hasOsm) {
    for (const osmFeature of osmFeatures) {
      // Try to match OS height first (LiDAR — most accurate)
      if (hasOs && !osmFeature.properties._osmHeightExplicit) {
        try {
          for (let i = 0; i < osFeatures.length; i++) {
            if (osMatched.has(i)) continue;
            const centroid = osCentroids[i];
            if (!centroid) continue;
            if (booleanPointInPolygon(centroid, osmFeature)) {
              const osHeight = osFeatures[i].properties.height;
              if (osHeight && osHeight > 0) {
                osmFeature.properties.height = osHeight;
                osmFeature.properties.source = 'osm+os';
                osmFeature.properties.confidence = osFeatures[i].properties.confidence;
                osMatched.add(i);
                break;
              }
            }
          }
        } catch { /* geometry error */ }
      }

      // Fall back to Microsoft height if no OS match and no explicit OSM height
      if (hasMs && !osmFeature.properties._osmHeightExplicit
          && osmFeature.properties.source !== 'osm+os') {
        try {
          for (let i = 0; i < msFeatures.length; i++) {
            const centroid = msCentroids[i];
            if (!centroid) continue;
            if (booleanPointInPolygon(centroid, osmFeature)) {
              const msHeight = msFeatures[i].properties.height;
              if (msHeight && msHeight > 0) {
                osmFeature.properties.height = msHeight;
                osmFeature.properties.source = 'osm+microsoft';
                osmFeature.properties.confidence = msFeatures[i].properties.confidence;
                msMatched.add(i);
                break;
              }
            }
          }
        } catch { /* geometry error */ }
      }
    }
  }

  // Collect results: start with OSM buildings (height-augmented)
  const result = hasOsm ? osmFeatures.map(cleanFeature) : [];

  // Add Microsoft-only buildings not matched to OSM
  if (hasMs) {
    const msOnly = msFeatures
      .filter((_, i) => !msMatched.has(i))
      .map(f => cleanMsFeature(f));
    result.push(...msOnly);
  }

  // Add OS-only buildings not matched to OSM (fills gaps in OSM coverage)
  if (hasOs) {
    const osOnly = osFeatures
      .filter((_, i) => !osMatched.has(i))
      .map(f => cleanOsFeature(f));
    result.push(...osOnly);
  }

  return result;
}

function cleanFeature(feature) {
  const p = feature.properties;
  return {
    type: 'Feature',
    geometry: feature.geometry,
    properties: {
      id: p.id || null,
      height: p.height || 10,
      source: p.source || 'osm',
      confidence: p.confidence || null,
      levels: p.levels || null,
      name: p.name || null
    }
  };
}

function cleanMsFeature(feature) {
  const p = feature.properties;
  const c = p._centroid;
  const id = c ? `ms_${c[0].toFixed(6)}_${c[1].toFixed(6)}` : `ms_${Math.random().toString(36).slice(2)}`;
  const height = (p.height && p.height > 0) ? p.height : 10;
  const confidence = (p.confidence && p.confidence > 0) ? p.confidence : null;
  return {
    type: 'Feature',
    geometry: feature.geometry,
    properties: { id, height, source: 'microsoft', confidence, levels: null, name: null }
  };
}

function cleanOsFeature(feature) {
  const p = feature.properties;
  const height = (p.height && p.height > 0) ? p.height : 10;
  return {
    type: 'Feature',
    geometry: feature.geometry,
    properties: {
      id: p.id || `os_${Math.random().toString(36).slice(2)}`,
      height,
      source: 'ordnance_survey',
      confidence: p.confidence || null,
      levels: null,
      name: p.name || null
    }
  };
}

module.exports = { mergeBuildings };
