import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDefaultHeroOrbAppearance,
  hslToRgb,
  parseHeroOrbAppearance,
} from '../src/components/hero-orb-appearance.js';

test('default hues and white-to-black brightness match the simulation controls', () => {
  const defaults = createDefaultHeroOrbAppearance();
  assert.deepEqual(defaults, {
    brightness: 0,
    hues: {
      idle: 205,
      thinking: 275,
      executing: 150,
      responding: 28,
    },
  });
  assert.deepEqual(parseHeroOrbAppearance(defaults), defaults);
});

test('appearance validation rejects out-of-range and incomplete values', () => {
  const valid = createDefaultHeroOrbAppearance();
  assert.equal(parseHeroOrbAppearance({ ...valid, brightness: -0.01 }), null);
  assert.equal(parseHeroOrbAppearance({ ...valid, brightness: 1.01 }), null);
  assert.equal(parseHeroOrbAppearance({ ...valid, hues: { ...valid.hues, idle: 361 } }), null);
  assert.equal(parseHeroOrbAppearance({ ...valid, hues: { idle: 205 } }), null);
  assert.equal(parseHeroOrbAppearance(null), null);
});

test('hue conversion wraps at 360 degrees and preserves state colors', () => {
  const red = hslToRgb(0, 0.82, 0.56);
  assert.deepEqual(hslToRgb(360, 0.82, 0.56), red);
  assert.ok(red[0] > red[1] && red[0] > red[2]);

  const green = hslToRgb(120, 0.82, 0.56);
  assert.ok(green[1] > green[0] && green[1] > green[2]);
});
