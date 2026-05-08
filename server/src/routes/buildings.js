const { Router } = require('express');
const overpass = require('../services/overpass');
const microsoft = require('../services/microsoft');
const osBuildings = require('../services/os-buildings');
const merger = require('../services/merger');
const cache = require('../services/cache');

const router = Router();

// GET /api/buildings?lat=...&lng=...&radius=...
router.get('/', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radius = parseFloat(req.query.radius) || 200;

    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ error: 'lat and lng are required numeric parameters' });
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'lat must be [-90,90], lng must be [-180,180]' });
    }
    if (radius <= 0 || radius > 5000) {
      return res.status(400).json({ error: 'radius must be between 1 and 5000 metres' });
    }

    const osData = await osBuildings.fetchBuildings(lat, lng, radius);

    const merged = merger.mergeBuildings([], [], osData);

    res.json({
      type: 'FeatureCollection',
      features: merged
    });
  } catch (err) {
    console.error('Buildings query error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/buildings/tile/:z/:x/:y
router.get('/tile/:z/:x/:y', async (req, res) => {
  try {
    const z = parseInt(req.params.z, 10);
    const x = parseInt(req.params.x, 10);
    const y = parseInt(req.params.y, 10);

    if (isNaN(z) || isNaN(x) || isNaN(y)) {
      return res.status(400).json({ error: 'z, x, y must be integers' });
    }

    const cached = cache.getTile(z, x, y);
    if (cached) {
      return res.json(cached);
    }

    // Compute tile center for fetching
    const { tileCenterLatLng } = require('../utils/geo');
    const { lat, lng } = tileCenterLatLng(z, x, y);

    // Tile width in metres approximation for radius
    const tileWidthMetres = (40075016.686 * Math.cos(lat * Math.PI / 180)) / Math.pow(2, z);
    const radius = Math.min(tileWidthMetres / 2, 5000);

    const osData = await osBuildings.fetchBuildings(lat, lng, radius);

    const merged = merger.mergeBuildings([], [], osData);

    const geojson = {
      type: 'FeatureCollection',
      features: merged
    };

    cache.setTile(z, x, y, geojson);
    res.json(geojson);
  } catch (err) {
    console.error('Tile query error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/buildings/test-os?lat=...&lng=...&radius=...
// Test endpoint for Ordnance Survey building heights (does NOT affect main flow)
router.get('/test-os', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radius = parseFloat(req.query.radius) || 200;

    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ error: 'lat and lng are required numeric parameters' });
    }

    const osData = await osBuildings.fetchBuildings(lat, lng, radius);

    // Also fetch current sources for comparison
    const [osmResult, msResult] = await Promise.allSettled([
      overpass.fetchBuildings(lat, lng, radius),
      microsoft.fetchBuildings(lat, lng, radius)
    ]);
    const osmData = osmResult.status === 'fulfilled' ? osmResult.value : [];
    const msData = msResult.status === 'fulfilled' ? msResult.value : [];

    // Build comparison summary
    const osHeights = osData.filter(f => f.properties.height !== null);
    const msHeights = msData.filter(f => f.properties.height !== null);
    const osmHeights = osmData.filter(f => f.properties._osmHeightExplicit);

    res.json({
      summary: {
        ordnance_survey: {
          total: osData.length,
          with_height: osHeights.length,
          avg_height: osHeights.length > 0
            ? +(osHeights.reduce((s, f) => s + f.properties.height, 0) / osHeights.length).toFixed(1)
            : null,
          source_note: 'LiDAR-measured heights (sub-metre accuracy)'
        },
        microsoft: {
          total: msData.length,
          with_height: msHeights.length,
          avg_height: msHeights.length > 0
            ? +(msHeights.reduce((s, f) => s + f.properties.height, 0) / msHeights.length).toFixed(1)
            : null,
          source_note: 'ML-estimated from satellite imagery'
        },
        osm: {
          total: osmData.length,
          with_explicit_height: osmHeights.length,
          source_note: 'Volunteer-mapped, height only where tagged'
        }
      },
      os_buildings: {
        type: 'FeatureCollection',
        features: osData
      }
    });
  } catch (err) {
    console.error('OS test error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
