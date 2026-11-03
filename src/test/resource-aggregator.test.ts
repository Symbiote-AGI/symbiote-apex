import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Aggregator } from '../resource-aggregator/aggregator.js';
import { createResourceAggregatorConfig } from '../resource-aggregator/config.js';
import { Pipeline } from '../resource-aggregator/pipeline.js';
import { ResourceAggregatorService } from '../resource-aggregator/service.js';
import { vectorize, vectorizeRecords } from '../resource-aggregator/vectorizer.js';
import type { SourceConfig, SourceSnapshot } from '../resource-aggregator/types.js';

const source: SourceConfig = {
  id: 'public-test-feed',
  category: 'intelligence',
  label: 'Public test feed',
  description: 'A deterministic feed used by unit tests.',
  path: 'https://example.test/feed',
  ttlMs: 60_000,
  enabled: true,
};

test('feed failures preserve the last successful cache and restore it from disk', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'symbiote-resource-feed-'));
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return attempts === 1
      ? new Response(JSON.stringify({ title: 'Regional earthquake activity', magnitude: 4.2 }), { status: 200 })
      : new Response('upstream unavailable', { status: 503 });
  };

  try {
    const config = createResourceAggregatorConfig(workspace);
    const aggregator = new Aggregator(config, [source]);
    const successful = await aggregator.syncOne(source);
    assert.equal(successful.status, 'ok');
    assert.ok(successful.data);

    const degraded = await aggregator.syncOne(source);
    assert.equal(degraded.status, 'error');
    assert.equal(degraded.data, successful.data);
    assert.equal(degraded.fetchedAt, successful.fetchedAt);

    const restored = new Aggregator(config, [source]);
    await restored.restore();
    assert.equal(restored.snapshots.get(source.id)?.status, 'error');
    assert.equal(restored.snapshots.get(source.id)?.fetchedAt, successful.fetchedAt);
    assert.deepEqual(restored.snapshots.get(source.id)?.data, successful.data);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('pipeline persists vectors and ranks matching public-feed content', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'symbiote-resource-vectors-'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    title: 'Regional earthquake activity',
    details: 'Magnitude 4.2 earthquake detected near the coast.',
  }), { status: 200 });

  try {
    const config = createResourceAggregatorConfig(workspace);
    const aggregator = new Aggregator(config, [source]);
    const pipeline = new Pipeline(config, aggregator);
    const report = await pipeline.runOnce('unit-test');
    assert.equal(report.attempted, 1);
    assert.equal(report.succeeded, 1);
    assert.equal(report.vectors, 1);

    const result = await pipeline.search('earthquake magnitude', 5);
    assert.equal(result.documents[0]?.id, source.id);
    assert.ok((result.scores[0] ?? 0) > 0);

    const snapshot: SourceSnapshot = {
      id: source.id,
      category: source.category,
      label: source.label,
      description: source.description,
      path: source.path,
      status: 'ok',
      fetchedAt: new Date().toISOString(),
      data: { message: 'A public market closes for the day.' },
    };
    const vector = vectorize(snapshot);
    assert.equal(vector?.dimensions, 512);
    assert.ok(Math.abs(Math.hypot(...(vector?.vector ?? [])) - 1) < 1e-10);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('concurrent manual collection requests share the active collection run', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'symbiote-resource-deduplicate-'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    return new Response(JSON.stringify({ title: 'Regional earthquake activity' }), { status: 200 });
  };
  try {
    const config = createResourceAggregatorConfig(workspace);
    const pipeline = new Pipeline(config, new Aggregator(config, [source]));
    const first = pipeline.runOnce('user-refresh', true);
    const second = pipeline.runOnce('startup-refresh', true);
    assert.equal(first, second);
    const report = await first;
    assert.equal(report.succeeded, 1);
    assert.equal(report.runId, 'user-refresh');
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('resource collection cadence validates and persists across service restarts', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'symbiote-resource-settings-'));
  try {
    const service = new ResourceAggregatorService(workspace);
    assert.deepEqual(service.setCollectionInterval(120_000), { collectionIntervalMs: 120_000 });
    const restored = new ResourceAggregatorService(workspace);
    assert.deepEqual(restored.settings(), { collectionIntervalMs: 120_000 });
    assert.throws(() => restored.setCollectionInterval(10_000), /30 seconds to 15 minutes/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('record vectorization indexes nested public records without inventing coordinates', () => {
  const snapshot: SourceSnapshot = {
    id: 'public-vulnerability-feed',
    category: 'intelligence',
    label: 'Public vulnerability feed',
    description: 'Public records.',
    path: 'https://example.test/vulnerabilities',
    status: 'ok',
    fetchedAt: new Date().toISOString(),
    data: {
      vulnerabilities: [
        { cveID: 'CVE-2026-1234', vulnerabilityName: 'Example remote vulnerability' },
        { cveID: 'CVE-2026-2345', vulnerabilityName: 'Example local vulnerability' },
      ],
    },
  };

  const documents = vectorizeRecords(snapshot);
  assert.equal(documents.length, 2);
  assert.equal(documents[0]?.id, 'public-vulnerability-feed:CVE-2026-1234');
  assert.equal(documents[0]?.label, 'CVE-2026-1234');
  assert.equal(documents[0]?.latitude, undefined);
  assert.equal(documents[0]?.longitude, undefined);
});

test('OpenSky state vectors become geolocated records without bypassing the anonymous request interval', async () => {
  const snapshot: SourceSnapshot = {
    id: 'opensky-aircraft',
    category: 'intelligence',
    label: 'OpenSky aircraft positions',
    description: 'Public aircraft state vectors.',
    path: 'https://opensky-network.org/api/states/all',
    status: 'ok',
    fetchedAt: new Date().toISOString(),
    data: {
      states: [[
        'abc123',
        'UAL123  ',
        'United States',
        1_800_000_000,
        1_800_000_001,
        -122.3,
        37.6,
        10_000,
        false,
        220,
        90,
        0,
        null,
        10_200,
        '1234',
      ]],
    },
  };
  const documents = vectorizeRecords(snapshot);
  assert.equal(documents.length, 1);
  assert.equal(documents[0]?.id, 'opensky-aircraft:abc123');
  assert.equal(documents[0]?.label, 'UAL123');
  assert.equal(documents[0]?.longitude, -122.3);
  assert.equal(documents[0]?.latitude, 37.6);

  const workspace = mkdtempSync(join(tmpdir(), 'symbiote-opensky-limit-'));
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return new Response(JSON.stringify({ states: [] }), { status: 200 });
  };
  try {
    const limitedSource: SourceConfig = {
      ...source,
      id: 'limited-aircraft-feed',
      minIntervalMs: 15 * 60_000,
    };
    const config = createResourceAggregatorConfig(workspace);
    const aggregator = new Aggregator(config, [limitedSource]);
    const prior = aggregator.snapshots.get(limitedSource.id)!;
    aggregator.snapshots.set(limitedSource.id, { ...prior, attemptedAt: new Date().toISOString() });
    await aggregator.syncOneById(limitedSource.id, true);
    assert.equal(attempts, 0);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(workspace, { recursive: true, force: true });
  }
});
