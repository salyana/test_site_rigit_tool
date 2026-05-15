require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const buildingsRouter = require('./routes/buildings');
const cache = require('./services/cache');

const PORT = parseInt(process.env.PORT, 10) || 3001;

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (_req, res) => {
  const microsoft = require('./services/microsoft');
  res.json({
    status: 'ok',
    cached_tiles: cache.getCachedTileCount(),
    manifest_loaded: microsoft.isManifestLoaded()
  });
});

app.use('/api/buildings', buildingsRouter);

// Geocode proxy — Nominatim fallback (used when client-side Google Places is unavailable)
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
app.get('/api/geocode', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'q parameter required' });
  try {
    const fetch = require('node-fetch');
    const url = 'https://nominatim.openstreetmap.org/search?format=json'
      + `&q=${encodeURIComponent(q)}`
      + '&limit=5&countrycodes=gb&addressdetails=1'
      + '&viewbox=-8.6,49.9,1.8,60.8&bounded=0';
    const r = await fetch(url, {
      headers: { 'User-Agent': 'RigIt.ai/1.0 (scaffolding marketplace)' },
      timeout: 10000
    });
    if (!r.ok) return res.status(r.status).json({ error: `Nominatim ${r.status}` });
    const data = await r.json();
    res.json(data);
  } catch (err) {
    console.error('Geocode proxy error:', err.message);
    res.status(502).json({ error: 'Geocoding service unavailable' });
  }
});

// OS Maps raster tile proxy — avoids CORS and hides API key from frontend
const OS_API_KEY = process.env.OS_API_KEY || '';
app.get('/api/os-tiles/:layer/:z/:x/:y.png', async (req, res) => {
  if (!OS_API_KEY) return res.status(503).json({ error: 'OS_API_KEY not configured' });
  const { layer, z, x, y } = req.params;
  const allowed = ['Road_3857', 'Light_3857', 'Outdoor_3857', 'Leisure_3857'];
  if (!allowed.includes(layer)) return res.status(400).json({ error: 'Invalid layer' });
  try {
    const fetch = require('node-fetch');
    const url = `https://api.os.uk/maps/raster/v1/zxy/${layer}/${z}/${x}/${y}.png?key=${OS_API_KEY}`;
    const r = await fetch(url, { timeout: 15000 });
    if (!r.ok) return res.status(r.status).end();
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    r.body.pipe(res);
  } catch (err) {
    console.error('OS tile proxy error:', err.message);
    res.status(502).end();
  }
});

// Expose OS API key availability to frontend (not the key itself)
app.get('/api/config', (_req, res) => {
  res.json({ os_basemap: !!OS_API_KEY, google_maps_key: GOOGLE_MAPS_API_KEY || '' });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Buildings proxy server running on port ${PORT}`);
});
