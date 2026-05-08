/**
 * Convert lat/lng to a Bing Maps quadkey at a given zoom level.
 * Uses Mercator projection to compute tile x/y, then interleaves bits.
 */
function latLngToQuadkey(lat, lng, zoom) {
  const tileX = Math.floor(((lng + 180) / 360) * (1 << zoom));
  const latRad = lat * Math.PI / 180;
  const tileY = Math.floor(
    (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * (1 << zoom)
  );

  return tileXYToQuadkey(tileX, tileY, zoom);
}

function tileXYToQuadkey(tileX, tileY, zoom) {
  let quadkey = '';
  for (let i = zoom; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((tileX & mask) !== 0) digit += 1;
    if ((tileY & mask) !== 0) digit += 2;
    quadkey += digit.toString();
  }
  return quadkey;
}

module.exports = { latLngToQuadkey, tileXYToQuadkey };
