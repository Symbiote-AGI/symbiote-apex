import assert from 'node:assert/strict';
import test from 'node:test';
import { createHeroOrbGeometryData, HERO_ORB_PARTICLE_COUNT } from '../src/components/hero-orb-geometry.js';

function radiusAt(positions: Float32Array, index: number): number {
  const offset = index * 3;
  return Math.hypot(positions[offset], positions[offset + 1], positions[offset + 2]);
}

test('orb state geometry is deterministic, finite and capped at 1,000 particles', () => {
  const first = createHeroOrbGeometryData();
  const second = createHeroOrbGeometryData();

  assert.equal(HERO_ORB_PARTICLE_COUNT, 1_000);
  for (const state of ['idle', 'thinking', 'executing', 'responding'] as const) {
    assert.equal(first[state].length, HERO_ORB_PARTICLE_COUNT * 3);
    assert.deepEqual(first[state], second[state]);
    assert.ok(first[state].every(Number.isFinite));
  }
  assert.equal(first.seeds.length, HERO_ORB_PARTICLE_COUNT * 4);
  assert.ok(first.seeds.every(Number.isFinite));
});

test('idle is a stable spherical shell and execution is formed from three ordered orbits', () => {
  const { idle, thinking, executing } = createHeroOrbGeometryData();
  const trackCount = HERO_ORB_PARTICLE_COUNT / 4;

  for (let index = 0; index < HERO_ORB_PARTICLE_COUNT; index++) {
    assert.ok(Math.abs(radiusAt(idle, index) - 1.42) < 0.00001);

    const offset = index * 3;
    const trackProgress = (Math.floor(index / 4) + 0.5) / trackCount;
    const normalizedY = (trackProgress - 0.5) * 2;
    const expectedThinkingY = normalizedY * 1.42 * 0.93;
    const expectedThinkingRadius = Math.sqrt(1 - normalizedY * normalizedY) * 1.42;
    assert.ok(Math.abs(thinking[offset + 1] - expectedThinkingY) < 0.00001);
    assert.ok(Math.abs(Math.hypot(thinking[offset], thinking[offset + 2]) - expectedThinkingRadius) < 0.00001);

    const orbit = index % 3;
    if (orbit === 0) assert.equal(executing[offset + 2], 0);
    else if (orbit === 1) assert.equal(executing[offset], 0);
    else assert.equal(executing[offset + 1], 0);
    assert.ok(Math.abs(radiusAt(executing, index) - 1.42) < 0.00001);
  }
});

test('response geometry uses four distinct concentric shells', () => {
  const { responding } = createHeroOrbGeometryData();

  for (let index = 0; index < HERO_ORB_PARTICLE_COUNT; index++) {
    const expectedRadius = 0.82 + (index % 4) * 0.2;
    assert.ok(Math.abs(radiusAt(responding, index) - expectedRadius) < 0.00001);
  }
});
