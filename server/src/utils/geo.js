/**
 * Convert tile coordinates to the center lat/lng.
 */
function tileCenterLatLng(z, x, y) {
  const n = 1 << z;
  const lng = (x + 0.5) / n * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / n)));
  const lat = latRad * 180 / Math.PI;
  return { lat, lng };
}

module.exports = { tileCenterLatLng };
