import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ContextStore } from '../agent/context-store.js';
import { PersistentHnswIndex } from '../memory/dense-index.js';
import { OllamaEmbeddingProvider } from '../memory/embeddings.js';
import { NeuralMemoryEngine } from '../memory/neural-memory.js';
import { VectorDB } from '../memory/vdb.js';
import type { EmbeddingProvider } from '../memory/embeddings.js';
import type { Message } from '../providers/types.js';

function temporaryWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-neural-memory-'));
}

function embeddingFor(text: string): number[] {
  const normalized = text.toLowerCase();
  if (normalized.includes('workload') || normalized.includes('distribut')
    || normalized.includes('kaggle') || normalized.includes('gpu')) return [1, 0, 0];
  if (normalized.includes('lunar') || normalized.includes('telescope')) return [0, 1, 0];
  return [0, 0, 1];
}

class FixtureEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'fixture';
  readonly model = 'fixture-v1';
  readonly observedLengths: number[] = [];

  async health(): Promise<void> {}

  async embed(texts: readonly string[]): Promise<number[][]> {
    this.observedLengths.push(...texts.map(text => text.length));
    return texts.map(embeddingFor);
  }
}

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('HNSW persists dense vectors, collapses chunks to source documents, and removes stale documents', () => {
  const workspace = temporaryWorkspace();
  const indexPath = path.join(workspace, 'memory.hnsw');
  try {
    const index = new PersistentHnswIndex(indexPath, 'fixture:model');
    index.addMany([
      { id: 'compute:0', documentId: 'compute', vector: [1, 0, 0], contentHash: 'chunk-a' },
      { id: 'compute:1', documentId: 'compute', vector: [0.9, 0.1, 0], contentHash: 'chunk-b' },
      { id: 'astronomy', vector: [0, 1, 0], contentHash: 'chunk-c' },
      { id: 'cooking', vector: [0, 0, 1], contentHash: 'chunk-d' },
    ]);

    assert.equal(index.size, 4);
    assert.equal(index.documentCount, 3);
    assert.equal(index.search([1, 0, 0], 3, 10)[0].id, 'compute');

    const restored = new PersistentHnswIndex(indexPath, 'fixture:model');
    assert.equal(restored.documentCount, 3);
    assert.equal(restored.search([1, 0, 0], 3, 10)[0].id, 'compute');
    assert.equal(restored.removeDocuments(new Set(['compute'])), 2);
    assert.deepEqual(restored.search([1, 0, 0], 3, 10).map(result => result.id), ['astronomy', 'cooking']);

    const afterRemoval = new PersistentHnswIndex(indexPath, 'fixture:model');
    assert.equal(afterRemoval.documentCount, 2);
    assert.deepEqual(afterRemoval.search([1, 0, 0], 2, 10).map(result => result.id), ['astronomy', 'cooking']);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('Ollama embedding provider discovers the configured model and validates vector responses', async () => {
  const calls: Array<{ url: URL; method: string; body?: Record<string, unknown> }> = [];
  const provider = new OllamaEmbeddingProvider({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'bge-m3',
    fetcher: async (input, init) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      calls.push({ url, method: init?.method ?? 'GET', body });
      if (url.pathname === '/api/tags') return response({ models: [{ name: 'bge-m3:latest' }] });
      return response({ embeddings: [[0.1, 0.2, 0.3]] });
    },
  });

  await provider.health();
  assert.deepEqual(await provider.embed(['A test memory']), [[0.1, 0.2, 0.3]]);
  assert.equal(calls[0].url.pathname, '/api/tags');
  assert.equal(calls[1].url.pathname, '/api/embed');
  assert.deepEqual(calls[1].body, { model: 'bge-m3', input: ['A test memory'] });

  const missingModel = new OllamaEmbeddingProvider({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'bge-m3',
    fetcher: async () => response({ models: [{ name: 'llama3:latest' }] }),
  });
  await assert.rejects(missingModel.health(), /ollama pull bge-m3/);

  const invalidVector = new OllamaEmbeddingProvider({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'bge-m3',
    fetcher: async () => response({ embeddings: [[1, Number.NaN]] }),
  });
  await assert.rejects(invalidVector.embed(['A test memory']), /invalid embedding vector/);
});

test('hybrid retrieval finds semantically related memories and enforces metadata filters', async () => {
  const workspace = temporaryWorkspace();
  try {
    const database = new VectorDB(workspace);
    database.indexBatch([
      {
        id: 'remote-compute',
        text: 'Ali planned to use Kaggle free GPUs as remote compute workers controlled by his own server.',
        source: 'notes',
        role: 'memory',
        timestamp: Date.now(),
        namespace: 'knowledge',
        metadata: { memoryType: 'semantic', sourceRef: 'notes/compute-plan.md', importance: '0.9' },
      },
      {
        id: 'lunar-observation',
        text: 'A telescope records lunar craters and night-sky observations.',
        source: 'notes',
        role: 'memory',
        timestamp: Date.now(),
        namespace: 'knowledge',
        metadata: { memoryType: 'episodic', sourceRef: 'observatory/log-1.md' },
      },
    ]);
    const provider = new FixtureEmbeddingProvider();
    const engine = new NeuralMemoryEngine({
      database,
      provider,
      directory: path.join(workspace, 'dense'),
    });
    assert.equal((await engine.initialize()).state, 'ready');
    assert.equal(await engine.indexMissing(), 2);

    const results = await engine.search('How did I plan to distribute the AI workloads?', 5, {
      source: 'notes',
      metadata: { memoryType: 'semantic' },
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'remote-compute');
    assert.equal(results[0].metadata?.sourceRef, 'notes/compute-plan.md');
    assert.ok(results[0].score > 0.5);

    const wrongType = await engine.search('How did I plan to distribute the AI workloads?', 5, {
      metadata: { memoryType: 'episodic' },
    });
    assert.deepEqual(wrongType.map(result => result.id), ['lunar-observation']);

    const restored = new NeuralMemoryEngine({
      database,
      provider,
      directory: path.join(workspace, 'dense'),
    });
    await restored.initialize();
    const afterReload = await restored.search('How did I plan to distribute the AI workloads?', 5);
    assert.equal(afterReload[0].id, 'remote-compute');
    assert.equal(restored.status().indexedDocuments, 2);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('neural memory chunks long documents and asynchronously absorbs truncated context', async () => {
  const workspace = temporaryWorkspace();
  try {
    const database = new VectorDB(workspace);
    const provider = new FixtureEmbeddingProvider();
    const engine = new NeuralMemoryEngine({
      database,
      provider,
      directory: path.join(workspace, 'dense'),
    });
    await engine.initialize();

    const longText = `${'Kaggle remote GPU workloads '.repeat(500)}A distinct final compute detail.`;
    const persisted = database.indexAndGet({
      id: '',
      text: longText,
      source: 'project',
      role: 'context',
      timestamp: Date.now(),
      metadata: { memoryType: 'semantic', sourceRef: 'project/architecture.md' },
    });
    assert.ok(persisted);
    assert.equal(await engine.indexDocument(persisted), true);
    assert.equal(engine.status().indexedDocuments, 1);
    assert.ok(provider.observedLengths.length > 1);
    assert.ok(provider.observedLengths.every(length => length <= 6_000));

    const contextStore = new ContextStore(database, { sessionId: 'session-neural' }, engine);
    const dropped: Message[] = [{
      role: 'user',
      content: 'Please remember that the agent now stores this long decision in episodic neural memory for later context retrieval.',
    }];
    assert.equal(await contextStore.absorbAsync(dropped), 1);
    const absorbed = database.listDocuments().find(document => document.source === 'absorbed');
    assert.equal(absorbed?.metadata?.memoryType, 'episodic');
    assert.equal(absorbed?.metadata?.sourceRef, 'session:session-neural');
    assert.equal(engine.status().indexedDocuments, 2);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('neural memory reports embedding failures and preserves lexical records', async () => {
  const workspace = temporaryWorkspace();
  try {
    const database = new VectorDB(workspace);
    database.index({
      id: 'persisted',
      text: 'A lexical memory remains available if embeddings fail.',
      source: 'notes',
      role: 'memory',
      timestamp: Date.now(),
    });
    const provider: EmbeddingProvider = {
      id: 'offline',
      model: 'missing-model',
      health: async () => { throw new Error('embedding service unavailable'); },
      embed: async () => { throw new Error('embedding service unavailable'); },
    };
    const engine = new NeuralMemoryEngine({
      database,
      provider,
      directory: path.join(workspace, 'dense'),
    });
    assert.equal((await engine.initialize()).state, 'degraded');
    await assert.rejects(engine.indexMissing(), /embedding service unavailable/);
    assert.equal(engine.status().state, 'degraded');
    assert.equal(database.search('lexical memory', 1)[0].id, 'persisted');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
