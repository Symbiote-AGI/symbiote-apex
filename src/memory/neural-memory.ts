import crypto from 'node:crypto';
import path from 'node:path';
import type { VectorDB, VDBDocument, VDBSearchFilter, SearchResult } from './vdb.js';
import { PersistentHnswIndex, type DenseSearchResult } from './dense-index.js';
import { createEmbeddingProvider, type EmbeddingProvider } from './embeddings.js';

export interface NeuralMemoryConfig {
  enabled?: boolean;
  provider?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  lexicalWeight?: number;
  denseWeight?: number;
  temporalHalfLifeDays?: number;
}

export interface NeuralMemoryStatus {
  state: 'ready' | 'degraded';
  provider: string;
  model: string;
  dimensions: number;
  indexedDocuments: number;
  corpusDocuments: number;
  lastError?: string;
}

export interface NeuralMemoryOptions {
  database: VectorDB;
  provider: EmbeddingProvider;
  directory: string;
  lexicalWeight?: number;
  denseWeight?: number;
  temporalHalfLifeDays?: number;
}

const RRF_CONSTANT = 60;
const MAX_RESULTS = 10_000;
const MAX_BACKFILL_BATCH = 32;
const MAX_DENSE_CHUNK_CHARS = 6_000;
const DENSE_CHUNK_OVERLAP_CHARS = 400;
const sharedMemories = new Map<string, NeuralMemoryEngine>();

function documentHash(document: VDBDocument): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    text: document.text,
    source: document.source,
    role: document.role,
    timestamp: document.timestamp,
    namespace: document.namespace,
    sessionId: document.sessionId,
    metadata: document.metadata ?? {},
  })).digest('hex');
}

function normalizedWeights(lexicalWeight: number, denseWeight: number): [number, number] {
  if (!Number.isFinite(lexicalWeight) || lexicalWeight < 0
    || !Number.isFinite(denseWeight) || denseWeight < 0
    || lexicalWeight + denseWeight === 0) {
    throw new RangeError('Neural memory lexical and dense weights must be non-negative and not both zero.');
  }
  const total = lexicalWeight + denseWeight;
  return [lexicalWeight / total, denseWeight / total];
}

function matchesFilter(document: VDBDocument, filter?: VDBSearchFilter): boolean {
  if (filter?.source && document.source !== filter.source) return false;
  if (filter?.role && document.role !== filter.role) return false;
  if (filter?.namespace && document.namespace !== filter.namespace) return false;
  if (filter?.minTimestamp !== undefined && document.timestamp < filter.minTimestamp) return false;
  if (filter?.metadata && Object.entries(filter.metadata).some(([key, value]) => document.metadata?.[key] !== value)) return false;
  return true;
}

function splitForEmbedding(text: string): string[] {
  const normalized = text.trim();
  if (normalized.length <= MAX_DENSE_CHUNK_CHARS) return [normalized];

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + MAX_DENSE_CHUNK_CHARS, normalized.length);
    if (end < normalized.length) {
      const paragraphBreak = normalized.lastIndexOf('\n', end);
      const wordBreak = normalized.lastIndexOf(' ', end);
      const preferredBreak = Math.max(paragraphBreak, wordBreak);
      if (preferredBreak > start + MAX_DENSE_CHUNK_CHARS * 0.6) end = preferredBreak;
    }

    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - DENSE_CHUNK_OVERLAP_CHARS);
  }
  return chunks;
}

function denseVectorId(documentId: string, chunkIndex: number, chunkCount: number): string {
  return chunkCount === 1 ? documentId : `${documentId}::dense:${chunkIndex}`;
}

function denseChunkHash(contentHash: string, chunkIndex: number, text: string): string {
  return crypto.createHash('sha256').update(`${contentHash}\0${chunkIndex}\0${text}`).digest('hex');
}

export class NeuralMemoryEngine {
  private readonly denseIndex: PersistentHnswIndex;
  private readonly lexicalWeight: number;
  private readonly denseWeight: number;
  private readonly temporalHalfLifeDays: number;
  private initialized = false;
  private lastError?: string;
  private indexing?: Promise<number>;
  private retryAfter = 0;

  constructor(private readonly options: NeuralMemoryOptions) {
    const [lexicalWeight, denseWeight] = normalizedWeights(
      options.lexicalWeight ?? 0.4,
      options.denseWeight ?? 0.6,
    );
    this.lexicalWeight = lexicalWeight;
    this.denseWeight = denseWeight;
    this.temporalHalfLifeDays = options.temporalHalfLifeDays ?? 180;
    if (!Number.isFinite(this.temporalHalfLifeDays) || this.temporalHalfLifeDays <= 0) {
      throw new RangeError('Neural memory temporal half-life must be a positive number of days.');
    }

    const modelKey = `${options.provider.id}:${options.provider.model}`;
    const fileKey = crypto.createHash('sha256').update(modelKey).digest('hex').slice(0, 20);
    this.denseIndex = new PersistentHnswIndex(
      path.join(options.directory, `${fileKey}.hnsw`),
      modelKey,
    );
  }

  async initialize(): Promise<NeuralMemoryStatus> {
    try {
      await this.options.provider.health();
      this.initialized = true;
      this.lastError = undefined;
    } catch (failure) {
      this.lastError = failure instanceof Error ? failure.message : String(failure);
    }
    return this.status();
  }

  status(): NeuralMemoryStatus {
    return {
      state: this.lastError || !this.initialized ? 'degraded' : 'ready',
      provider: this.options.provider.id,
      model: this.options.provider.model,
      dimensions: this.denseIndex.dimension,
      indexedDocuments: this.denseIndex.documentCount,
      corpusDocuments: this.options.database.stats().documentCount,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  async indexDocument(document: VDBDocument): Promise<boolean> {
    return (await this.indexDocuments([document])) > 0;
  }

  async indexDocuments(documents: readonly VDBDocument[]): Promise<number> {
    const pending = documents.filter(document => {
      if (!document.id) throw new Error('Neural memory indexing requires a persisted VDB document ID.');
      return !this.isDocumentIndexed(document);
    });
    if (pending.length === 0) return 0;

    try {
      const indexed = await this.embedAndIndex(pending);
      this.initialized = true;
      this.lastError = undefined;
      return indexed;
    } catch (failure) {
      this.lastError = failure instanceof Error ? failure.message : String(failure);
      throw failure;
    }
  }

  indexMissing(limit = 128): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new RangeError('Neural memory backfill limit must be an integer from 1 to 10000.');
    }
    if (this.indexing) return this.indexing;
    if (Date.now() < this.retryAfter) return Promise.resolve(0);
    this.indexing = this.indexMissingInternal(limit)
      .catch(failure => {
        this.retryAfter = Date.now() + 30_000;
        throw failure;
      })
      .finally(() => {
        this.indexing = undefined;
      });
    return this.indexing;
  }

  async search(query: string, limit = 5, filter?: VDBSearchFilter): Promise<SearchResult[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
      throw new RangeError(`Neural memory result limit must be an integer from 1 to ${MAX_RESULTS}.`);
    }
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];

    const candidateLimit = Math.min(MAX_RESULTS, Math.max(limit * 4, 50));
    const lexicalResults = this.options.database.search(normalizedQuery, candidateLimit, filter);
    if (this.denseIndex.size === 0) return lexicalResults.slice(0, limit);

    try {
      const [queryVector] = await this.options.provider.embed([normalizedQuery]);
      if (!queryVector) throw new Error('Embedding provider returned no vector for the memory query.');
      const denseResults = this.denseIndex.search(queryVector, candidateLimit, Math.min(MAX_RESULTS, Math.max(candidateLimit, 128)));
      const merged = this.mergeCandidates(lexicalResults, denseResults, filter);
      this.lastError = undefined;
      return merged.slice(0, limit);
    } catch (failure) {
      this.lastError = failure instanceof Error ? failure.message : String(failure);
      throw failure;
    }
  }

  private async indexMissingInternal(limit: number): Promise<number> {
    const corpus = this.options.database.listDocuments();
    const corpusIds = new Set(corpus.map(document => document.id));
    const staleIds = new Set(this.denseIndex.documentIds.filter(id => !corpusIds.has(id)));
    if (staleIds.size > 0) this.denseIndex.removeDocuments(staleIds);
    const documents = corpus
      .filter(document => !this.isDocumentIndexed(document))
      .sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id))
      .slice(0, limit);
    if (documents.length === 0) return 0;

    let indexed = 0;
    try {
      indexed = await this.embedAndIndex(documents);
      this.initialized = true;
      this.lastError = undefined;
      return indexed;
    } catch (failure) {
      this.lastError = failure instanceof Error ? failure.message : String(failure);
      throw failure;
    }
  }

  private async embedAndIndex(documents: readonly VDBDocument[]): Promise<number> {
    const chunks = documents.flatMap(document => {
      const contentHash = documentHash(document);
      const textChunks = splitForEmbedding(document.text);
      return textChunks.map((text, index) => ({
        documentId: document.id,
        id: denseVectorId(document.id, index, textChunks.length),
        text,
        contentHash: denseChunkHash(contentHash, index, text),
      }));
    });
    const records: Array<{ id: string; documentId: string; vector: number[]; contentHash: string }> = [];
    for (let start = 0; start < chunks.length; start += MAX_BACKFILL_BATCH) {
      const batch = chunks.slice(start, start + MAX_BACKFILL_BATCH);
      const vectors = await this.options.provider.embed(batch.map(chunk => chunk.text));
      if (vectors.length !== batch.length) {
        throw new Error(`Embedding provider returned ${vectors.length} vectors for ${batch.length} chunks.`);
      }
      batch.forEach((chunk, index) => {
        const vector = vectors[index];
        if (!vector) throw new Error(`Embedding provider returned no vector for chunk ${chunk.id}.`);
        records.push({
          id: chunk.id,
          documentId: chunk.documentId,
          vector,
          contentHash: chunk.contentHash,
        });
      });
    }

    this.denseIndex.removeDocuments(new Set(documents.map(document => document.id)), false);
    this.denseIndex.addMany(records);
    return documents.length;
  }

  private isDocumentIndexed(document: VDBDocument): boolean {
    const contentHash = documentHash(document);
    const chunks = splitForEmbedding(document.text);
    return chunks.length > 0 && chunks.every((text, index) =>
      this.denseIndex.has(
        denseVectorId(document.id, index, chunks.length),
        denseChunkHash(contentHash, index, text),
      ),
    );
  }

  private mergeCandidates(
    lexicalResults: SearchResult[],
    denseResults: DenseSearchResult[],
    filter?: VDBSearchFilter,
  ): SearchResult[] {
    const candidates = new Map<string, { document: VDBDocument; lexicalRank?: number; denseRank?: number }>();
    lexicalResults.forEach((result, index) => {
      const document = this.options.database.getDocument(result.id);
      if (document && matchesFilter(document, filter)) {
        candidates.set(document.id, { document, lexicalRank: index + 1 });
      }
    });
    denseResults.forEach((result, index) => {
      const document = this.options.database.getDocument(result.id);
      if (!document || !matchesFilter(document, filter)) return;
      const current = candidates.get(document.id) ?? { document };
      current.denseRank = index + 1;
      candidates.set(document.id, current);
    });

    const ranked = [...candidates.values()].map(candidate => {
      const reciprocalRank = (rank: number | undefined, weight: number) =>
        rank === undefined ? 0 : weight / (RRF_CONSTANT + rank);
      const rawScore = reciprocalRank(candidate.lexicalRank, this.lexicalWeight)
        + reciprocalRank(candidate.denseRank, this.denseWeight);
      const ageDays = Math.max(0, Date.now() - candidate.document.timestamp) / 86_400_000;
      const temporalRelevance = Math.exp(-Math.LN2 * ageDays / this.temporalHalfLifeDays);
      const importance = Number(candidate.document.metadata?.importance);
      const importanceBoost = Number.isFinite(importance) ? Math.min(1, Math.max(0, importance)) : 0.5;
      return { ...candidate, rawScore, temporalRelevance, importanceBoost };
    });
    const maximumScore = Math.max(1e-12, ...ranked.map(candidate => candidate.rawScore));
    return ranked
      .sort((left, right) =>
        right.rawScore * (0.9 + right.temporalRelevance * 0.08 + right.importanceBoost * 0.02)
        - left.rawScore * (0.9 + left.temporalRelevance * 0.08 + left.importanceBoost * 0.02)
        || left.document.id.localeCompare(right.document.id),
      )
      .map(candidate => ({
        ...candidate.document,
        score: Math.min(1, (candidate.rawScore / maximumScore)
          * (0.9 + candidate.temporalRelevance * 0.08 + candidate.importanceBoost * 0.02)),
      }));
  }
}

export function createNeuralMemoryEngine(
  database: VectorDB,
  workspace: string,
  config: NeuralMemoryConfig | undefined,
): NeuralMemoryEngine | undefined {
  if (!config?.enabled) return undefined;
  const provider = createEmbeddingProvider(config);
  return new NeuralMemoryEngine({
    database,
    provider,
    directory: path.join(path.resolve(workspace), '.symbiote', 'neural-memory'),
    ...(config.lexicalWeight !== undefined ? { lexicalWeight: config.lexicalWeight } : {}),
    ...(config.denseWeight !== undefined ? { denseWeight: config.denseWeight } : {}),
    ...(config.temporalHalfLifeDays !== undefined ? { temporalHalfLifeDays: config.temporalHalfLifeDays } : {}),
  });
}

export function registerSharedNeuralMemory(workspace: string, engine: NeuralMemoryEngine | undefined): void {
  const key = path.resolve(workspace);
  if (engine) sharedMemories.set(key, engine);
  else sharedMemories.delete(key);
}

export function getSharedNeuralMemory(workspace: string): NeuralMemoryEngine | undefined {
  return sharedMemories.get(path.resolve(workspace));
}
