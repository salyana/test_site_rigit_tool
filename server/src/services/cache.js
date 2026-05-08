const Database = require('better-sqlite3');
const path = require('path');

const CACHE_TTL_HOURS = parseInt(process.env.CACHE_TTL_HOURS, 10) || 24;
const DB_PATH = path.join(__dirname, '..', '..', 'tiles.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS tiles (
        key TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
  }
  return db;
}

function tileKey(z, x, y) {
  return `${z}/${x}/${y}`;
}

function getTile(z, x, y) {
  try {
    const d = getDb();
    const key = tileKey(z, x, y);
    const cutoff = Date.now() - CACHE_TTL_HOURS * 3600 * 1000;

    const row = d.prepare('SELECT data, created_at FROM tiles WHERE key = ?').get(key);
    if (!row) return null;
    if (row.created_at < cutoff) {
      d.prepare('DELETE FROM tiles WHERE key = ?').run(key);
      return null;
    }
    return JSON.parse(row.data);
  } catch (err) {
    console.error('Cache read error:', err);
    return null;
  }
}

function setTile(z, x, y, geojson) {
  try {
    const d = getDb();
    const key = tileKey(z, x, y);
    d.prepare('INSERT OR REPLACE INTO tiles (key, data, created_at) VALUES (?, ?, ?)')
      .run(key, JSON.stringify(geojson), Date.now());
  } catch (err) {
    console.error('Cache write error:', err);
  }
}

function getCachedTileCount() {
  try {
    const d = getDb();
    const cutoff = Date.now() - CACHE_TTL_HOURS * 3600 * 1000;
    const row = d.prepare('SELECT COUNT(*) as count FROM tiles WHERE created_at >= ?').get(cutoff);
    return row ? row.count : 0;
  } catch {
    return 0;
  }
}

module.exports = { getTile, setTile, getCachedTileCount };
