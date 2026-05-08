const fetch = require('node-fetch');
const key = 'u3OXJaYG5C1pPsUbU0iNyg06wWX2mAGy';
const NGD = 'https://api.os.uk/features/ngd/ofa/v1';

const landmarks = [
  { name: 'The Shard', lat: 51.5045, lng: -0.0865, knownHeight: 310, source: 'Official/Wikipedia' },
  { name: 'St Pauls Cathedral (dome)', lat: 51.5138, lng: -0.0984, knownHeight: 111, source: 'Wikipedia' },
  { name: 'Tower of London White Tower', lat: 51.5081, lng: -0.0759, knownHeight: 27, source: 'Wikipedia' },
  { name: 'Buckingham Palace', lat: 51.5014, lng: -0.1419, knownHeight: 24, source: 'Wikipedia' },
  { name: 'Big Ben / Elizabeth Tower', lat: 51.5007, lng: -0.1246, knownHeight: 96, source: 'Wikipedia' },
  { name: 'BT Tower', lat: 51.5215, lng: -0.1389, knownHeight: 177, source: 'Wikipedia' },
  { name: 'One Canada Square', lat: 51.5049, lng: -0.0199, knownHeight: 235, source: 'Wikipedia' },
  { name: 'Tate Modern chimney', lat: 51.5076, lng: -0.0994, knownHeight: 99, source: 'Wikipedia' },
  { name: 'Tower Bridge towers', lat: 51.5055, lng: -0.0754, knownHeight: 65, source: 'Wikipedia' },
  { name: 'Westminster Abbey', lat: 51.4993, lng: -0.1273, knownHeight: 69, source: 'Wikipedia' },
];

async function check(lm) {
  const r = 40;
  const latD = r / 111320;
  const lngD = r / (111320 * Math.cos(lm.lat * Math.PI / 180));
  const bbox = [lm.lng - lngD, lm.lat - latD, lm.lng + lngD, lm.lat + latD]
    .map(v => v.toFixed(6)).join(',');

  const url = `${NGD}/collections/bld-fts-buildingpart-1/items?key=${key}&bbox=${bbox}&limit=100`;
  const res = await fetch(url, { timeout: 15000 });
  const data = await res.json();

  let tallest = null;
  for (const f of (data.features || [])) {
    const h = f.properties.relativeheightmaximum;
    if (h && (tallest === null || h > tallest.properties.relativeheightmaximum)) {
      tallest = f;
    }
  }

  return {
    name: lm.name,
    knownHeight: lm.knownHeight,
    source: lm.source,
    osHeight: tallest ? tallest.properties.relativeheightmaximum : null,
    osConfidence: tallest ? tallest.properties.heightconfidencelevel : null,
    osToid: tallest ? tallest.properties.toid : null,
    totalInBbox: data.features ? data.features.length : 0
  };
}

async function run() {
  console.log('\nComparing OS NGD heights against known real-world building heights:\n');
  console.log(
    'Building'.padEnd(35) +
    'Known(m)'.padEnd(10) +
    'OS(m)'.padEnd(10) +
    'Diff(m)'.padEnd(10) +
    'Error%'.padEnd(10) +
    'Confidence'
  );
  console.log('-'.repeat(90));

  const errors = [];

  for (const lm of landmarks) {
    try {
      const r = await check(lm);
      const osStr = r.osHeight !== null ? String(r.osHeight) : 'N/A';
      let diffStr = 'N/A', pctStr = 'N/A';
      if (r.osHeight !== null) {
        const diff = r.osHeight - r.knownHeight;
        const pct = (Math.abs(diff) / r.knownHeight) * 100;
        diffStr = (diff >= 0 ? '+' : '') + diff.toFixed(1);
        pctStr = pct.toFixed(1) + '%';
        errors.push(pct);
      }
      console.log(
        r.name.padEnd(35) +
        (r.knownHeight + 'm').padEnd(10) +
        (osStr + 'm').padEnd(10) +
        diffStr.padEnd(10) +
        pctStr.padEnd(10) +
        (r.osConfidence || 'N/A')
      );
    } catch (err) {
      console.log(lm.name.padEnd(35) + 'ERROR: ' + err.message);
    }
  }

  if (errors.length > 0) {
    const avg = errors.reduce((a, b) => a + b, 0) / errors.length;
    console.log('\n' + '-'.repeat(90));
    console.log('Average error: ' + avg.toFixed(1) + '% across ' + errors.length + ' buildings');
    console.log('Median error:  ' + errors.sort((a, b) => a - b)[Math.floor(errors.length / 2)].toFixed(1) + '%');
  }
}

run().catch(e => console.error(e));
