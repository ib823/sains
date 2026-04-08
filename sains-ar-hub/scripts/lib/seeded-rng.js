'use strict';

/**
 * Mulberry32 PRNG — deterministic, fast, good distribution.
 * Same seed always produces the same sequence.
 */
function createRNG(seed = 42) {
  let state = seed | 0;

  function next() {
    state = (state + 0x6D2B79F5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function nextInt(min, max) {
    // inclusive range
    return Math.floor(next() * (max - min + 1)) + min;
  }

  function nextFloat(min, max) {
    return next() * (max - min) + min;
  }

  function pick(array) {
    return array[Math.floor(next() * array.length)];
  }

  function weightedPick(items, weights) {
    let total = 0;
    for (const w of weights) total += w;
    let r = next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  // Box-Muller transform
  let _spare = null;
  function gaussian(mean = 0, stddev = 1) {
    if (_spare !== null) {
      const v = _spare;
      _spare = null;
      return mean + stddev * v;
    }
    let u = 0, v = 0;
    while (u === 0) u = next();
    while (v === 0) v = next();
    const mag = Math.sqrt(-2.0 * Math.log(u));
    const z0 = mag * Math.cos(2.0 * Math.PI * v);
    const z1 = mag * Math.sin(2.0 * Math.PI * v);
    _spare = z1;
    return mean + stddev * z0;
  }

  function shuffle(array) {
    const a = array.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  return { next, nextInt, nextFloat, pick, weightedPick, gaussian, shuffle };
}

module.exports = { createRNG };
