// Shared helpers for the Node tools.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const factory = require('../js/engine.js');

function rng32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loadWeightsFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(/"([A-Za-z0-9+/=]+)"/);
  return new Int8Array(zlib.gunzipSync(Buffer.from(m[1], 'base64')).buffer.slice(0));
}
function loadBookFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  const a = src.indexOf('{', src.indexOf('var d ='));
  return JSON.parse(src.slice(a, src.indexOf('; if (typeof module', a)));
}

// engine with (optionally) weights and book loaded
function makeEngine(opts) {
  const o = Object.assign({ weights: path.join(__dirname, '../js/weights.js'), book: null }, opts);
  const E = factory();
  if (o.weights && fs.existsSync(o.weights)) {
    const buf = loadWeightsFile(o.weights);
    E.setWeights(new Int8Array(buf.buffer, buf.byteOffset, buf.length));
  }
  if (o.book && fs.existsSync(o.book)) E.setBook(loadBookFile(o.book));
  return E;
}

function args() {
  const a = {};
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    if (v[i].startsWith('--')) { const k = v[i].slice(2); a[k] = v[i + 1] && !v[i + 1].startsWith('--') ? v[++i] : true; }
  }
  return a;
}

const sqName = (s) => 'abcdefgh'[s & 7] + ((s >> 3) + 1);
const sqFromName = (n) => (n.charCodeAt(1) - 49) * 8 + (n.toLowerCase().charCodeAt(0) - 97);

module.exports = { rng32, makeEngine, loadWeightsFile, loadBookFile, args, sqName, sqFromName };
