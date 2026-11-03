import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface DenseVectorRecord {
  id: string;
  documentId?: string;
  vector: readonly number[];
  contentHash?: string;
}

export interface DenseSearchResult {
  id: string;
  similarity: number;
}

interface HnswNode {
  id: string;
  documentId: string;
  vector: Float32Array;
  contentHash?: string;
  level: number;
  links: number[][];
}

interface PersistedNode {
  id: string;
  documentId?: string;
  contentHash?: string;
  level: number;
  links: number[][];
}

interface PersistedIndex {
  schemaVersion: 1;
  modelKey: string;
  dimensions: number;
  entryPoint: number;
  maxLevel: number;
  m: number;
  efConstruction: number;
  nodes: PersistedNode[];
}

const MAGIC = Buffer.from('SYMHNSW1', 'ascii');
const MAX_DIMENSIONS = 8192;
const MAX_LEVEL = 16;
const MAX_INDEX_BYTES = 1_500_000_000;
const MAX_HEADER_BYTES = 256_000_000;

function normalizeVector(vector: readonly number[], dimensions: number): Float32Array {
  if (!Array.isArray(vector) || vector.length === 0 || vector.length > MAX_DIMENSIONS) {
    throw new Error(`Embedding dimensions must be between 1 and ${MAX_DIMENSIONS}.`);
  }
  if (dimensions > 0 && vector.length !== dimensions) {
    throw new Error(`Embedding dimension mismatch: expected ${dimensions}, received ${vector.length}.`);
  }
  if (vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('Embedding vectors must contain only finite numbers.');
  }

  const normalized = Float32Array.from(vector);
  let magnitudeSquared = 0;
  for (const value of normalized) magnitudeSquared += value * value;
  if (!Number.isFinite(magnitudeSquared) || magnitudeSquared <= Number.EPSILON) {
    throw new Error('Embedding vectors must have a non-zero finite magnitude.');
  }
  const magnitude = Math.sqrt(magnitudeSquared);
  for (let index = 0; index < normalized.length; index++) normalized[index] /= magnitude;
  return normalized;
}

function cosine(left: Float32Array, right: Float32Array): number {
  let score = 0;
  for (let index = 0; index < left.length; index++) score += left[index] * right[index];
  return score;
}

function stableLevel(id: string, m: number): number {
  const hash = crypto.createHash('sha256').update(id).digest();
  const value = (hash.readUInt32LE(0) + 1) / 0x1_0000_0000;
  return Math.min(MAX_LEVEL, Math.floor(-Math.log(value) / Math.log(m)));
}

export class PersistentHnswIndex {
  private readonly filePath: string;
  private readonly nodes: HnswNode[] = [];
  private readonly nodeById = new Map<string, number>();
  private entryPoint = -1;
  private maxLevel = -1;
  private dimensions = 0;
  private dirty = false;
  private readonly m: number;
  private readonly efConstruction: number;

  constructor(
    filePath: string,
    readonly modelKey: string,
    options: { m?: number; efConstruction?: number } = {},
  ) {
    this.filePath = path.resolve(filePath);
    this.m = options.m ?? 16;
    this.efConstruction = options.efConstruction ?? 128;
    if (!Number.isInteger(this.m) || this.m < 2 || this.m > 64) {
      throw new RangeError('HNSW M must be an integer from 2 to 64.');
    }
    if (!Number.isInteger(this.efConstruction) || this.efConstruction < this.m || this.efConstruction > 4096) {
      throw new RangeError('HNSW efConstruction must be an integer between M and 4096.');
    }
    this.load();
  }

  get size(): number {
    return this.nodes.length;
  }

  get documentCount(): number {
    return new Set(this.nodes.map(node => node.documentId)).size;
  }

  get documentIds(): string[] {
    return [...new Set(this.nodes.map(node => node.documentId))];
  }

  get dimension(): number {
    return this.dimensions;
  }

  has(id: string, contentHash?: string): boolean {
    const index = this.nodeById.get(id);
    if (index === undefined) return false;
    return contentHash === undefined || this.nodes[index].contentHash === contentHash;
  }

  addMany(records: readonly DenseVectorRecord[]): number {
    if (records.length === 0) return 0;
    const ids = new Set<string>();
    const prepared = records.map(record => {
      if (!record.id.trim() || record.id.length > 500) throw new Error('Dense vector records require a valid ID.');
      if (ids.has(record.id)) throw new Error(`Duplicate dense vector ID in one batch: ${record.id}`);
      ids.add(record.id);
      const documentId = record.documentId ?? record.id;
      if (!documentId.trim() || documentId.length > 500) throw new Error('Dense vector records require a valid parent document ID.');
      return {
        id: record.id,
        documentId,
        vector: normalizeVector(record.vector, this.dimensions),
        contentHash: record.contentHash,
      };
    });

    const dimensions = this.dimensions || prepared[0].vector.length;
    if (prepared.some(record => record.vector.length !== dimensions)) {
      throw new Error('All embedding vectors in a batch must have the same dimensions.');
    }
    if (this.dimensions === 0) this.dimensions = dimensions;
    const newRecords: typeof prepared = [];
    let updated = false;
    for (const record of prepared) {
      const existingIndex = this.nodeById.get(record.id);
      if (existingIndex === undefined) {
        newRecords.push(record);
        continue;
      }

      const existing = this.nodes[existingIndex];
      if (record.contentHash !== undefined && existing.contentHash === record.contentHash
        && existing.documentId === record.documentId) continue;
      if (record.contentHash === undefined && existing.documentId === record.documentId
        && existing.vector.every((value, index) => value === record.vector[index])) continue;
      existing.vector = record.vector;
      existing.contentHash = record.contentHash;
      existing.documentId = record.documentId;
      updated = true;
    }

    if (updated) this.rebuildGraph();
    for (const record of newRecords) {
      this.insertNode(record.id, record.vector, record.contentHash, record.documentId);
    }

    const added = newRecords.length;
    if (added > 0 || updated) {
      this.dirty = true;
      this.save();
    }
    return added;
  }

  removeDocuments(documentIds: ReadonlySet<string>, persist = true): number {
    if (documentIds.size === 0 || this.nodes.length === 0) return 0;
    const retained = this.nodes
      .filter(node => !documentIds.has(node.documentId))
      .map(node => ({
        id: node.id,
        documentId: node.documentId,
        vector: node.vector,
        contentHash: node.contentHash,
        level: node.level,
      }));
    const removed = this.nodes.length - retained.length;
    if (removed === 0) return 0;

    if (retained.length === 0 && persist) {
      this.nodes.length = 0;
      this.nodeById.clear();
      this.entryPoint = -1;
      this.maxLevel = -1;
      this.dimensions = 0;
      this.dirty = false;
      try {
        fs.unlinkSync(this.filePath);
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure;
      }
      return removed;
    }

    this.nodes.length = 0;
    this.nodeById.clear();
    this.entryPoint = -1;
    this.maxLevel = -1;
    for (const node of retained) {
      this.insertNode(node.id, node.vector, node.contentHash, node.documentId, node.level);
    }
    this.dirty = true;
    if (persist) this.save();
    return removed;
  }

  search(vector: readonly number[], limit: number, efSearch = 128): DenseSearchResult[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new RangeError('Dense search limit must be an integer from 1 to 10000.');
    }
    if (!Number.isInteger(efSearch) || efSearch < limit || efSearch > 10_000) {
      throw new RangeError('HNSW efSearch must be an integer at least as large as the result limit.');
    }
    if (this.nodes.length === 0) return [];
    const query = normalizeVector(vector, this.dimensions);
    let current = this.entryPoint;

    for (let layer = this.maxLevel; layer > 0; layer--) {
      current = this.greedySearch(query, current, layer);
    }
    const unique = new Map<string, DenseSearchResult>();
    for (const candidate of this.searchLayer(query, [current], Math.min(efSearch, this.nodes.length), 0)) {
      const documentId = this.nodes[candidate.index].documentId;
      const existing = unique.get(documentId);
      if (!existing || candidate.score > existing.similarity) {
        unique.set(documentId, { id: documentId, similarity: candidate.score });
      }
    }
    return [...unique.values()]
      .sort((left, right) => right.similarity - left.similarity || left.id.localeCompare(right.id))
      .slice(0, limit);
  }

  private insertNode(
    id: string,
    vector: Float32Array,
    contentHash?: string,
    documentId = id,
    forcedLevel?: number,
  ): void {
    const level = forcedLevel ?? stableLevel(id, this.m);
    const index = this.nodes.length;
    const node: HnswNode = {
      id,
      documentId,
      vector,
      ...(contentHash ? { contentHash } : {}),
      level,
      links: Array.from({ length: level + 1 }, () => []),
    };

    if (this.entryPoint < 0) {
      this.nodes.push(node);
      this.nodeById.set(id, index);
      this.entryPoint = index;
      this.maxLevel = level;
      return;
    }

    this.nodes.push(node);
    this.nodeById.set(id, index);
    let current = this.entryPoint;
    for (let layer = this.maxLevel; layer > level; layer--) {
      current = this.greedySearch(vector, current, layer);
    }

    for (let layer = Math.min(level, this.maxLevel); layer >= 0; layer--) {
      const candidates = this.searchLayer(vector, [current], this.efConstruction, layer);
      const maxLinks = layer === 0 ? this.m * 2 : this.m;
      const selected = candidates.filter(candidate => candidate.index !== index).slice(0, maxLinks);
      node.links[layer] = selected.map(candidate => candidate.index);
      for (const candidate of selected) {
        const neighbor = this.nodes[candidate.index];
        neighbor.links[layer].push(index);
        this.pruneLinks(candidate.index, layer, maxLinks);
      }
      if (candidates.length > 0) current = candidates[0].index;
    }

    if (level > this.maxLevel) {
      this.entryPoint = index;
      this.maxLevel = level;
    }
  }

  private greedySearch(query: Float32Array, entry: number, layer: number): number {
    let current = entry;
    let currentScore = cosine(query, this.nodes[current].vector);
    let improved = true;
    while (improved) {
      improved = false;
      for (const neighborIndex of this.nodes[current].links[layer] ?? []) {
        const score = cosine(query, this.nodes[neighborIndex].vector);
        if (score > currentScore) {
          current = neighborIndex;
          currentScore = score;
          improved = true;
        }
      }
    }
    return current;
  }

  private searchLayer(
    query: Float32Array,
    entryPoints: number[],
    ef: number,
    layer: number,
  ): Array<{ index: number; score: number }> {
    const visited = new Set<number>();
    const candidates: Array<{ index: number; score: number }> = [];
    const results: Array<{ index: number; score: number }> = [];
    for (const index of entryPoints) {
      if (index < 0 || index >= this.nodes.length || visited.has(index)) continue;
      visited.add(index);
      const candidate = { index, score: cosine(query, this.nodes[index].vector) };
      candidates.push(candidate);
      results.push(candidate);
    }

    while (candidates.length > 0) {
      candidates.sort((left, right) => right.score - left.score || left.index - right.index);
      const current = candidates.shift()!;
      const worst = results[results.length - 1];
      if (results.length >= ef && worst && current.score < worst.score) break;

      for (const neighborIndex of this.nodes[current.index].links[layer] ?? []) {
        if (visited.has(neighborIndex)) continue;
        visited.add(neighborIndex);
        const candidate = { index: neighborIndex, score: cosine(query, this.nodes[neighborIndex].vector) };
        const currentWorst = results[results.length - 1];
        if (results.length < ef || !currentWorst || candidate.score > currentWorst.score) {
          candidates.push(candidate);
          results.push(candidate);
          results.sort((left, right) => right.score - left.score || left.index - right.index);
          if (results.length > ef) results.pop();
        }
      }
    }
    return results.sort((left, right) => right.score - left.score || left.index - right.index);
  }

  private pruneLinks(index: number, layer: number, maximum: number): void {
    const node = this.nodes[index];
    const unique = [...new Set(node.links[layer] ?? [])]
      .filter(neighbor => neighbor !== index)
      .map(neighbor => ({ index: neighbor, score: cosine(node.vector, this.nodes[neighbor].vector) }))
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, maximum);
    node.links[layer] = unique.map(neighbor => neighbor.index);
  }

  private rebuildGraph(): void {
    const existing = this.nodes.map(node => ({
      id: node.id,
      documentId: node.documentId,
      vector: node.vector,
      contentHash: node.contentHash,
      level: node.level,
    }));
    this.nodes.length = 0;
    this.nodeById.clear();
    this.entryPoint = -1;
    this.maxLevel = -1;
    for (const node of existing) this.insertNode(node.id, node.vector, node.contentHash, node.documentId, node.level);
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    if (fs.statSync(this.filePath).size > MAX_INDEX_BYTES) {
      throw new Error(`HNSW index exceeds the ${MAX_INDEX_BYTES} byte local-index limit; configure a remote vector store for larger corpora.`);
    }
    const content = fs.readFileSync(this.filePath);
    if (content.length < MAGIC.length + 4 || !content.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error(`Invalid HNSW index header: ${this.filePath}`);
    }
    const headerLength = content.readUInt32LE(MAGIC.length);
    const headerStart = MAGIC.length + 4;
    const vectorsStart = headerStart + headerLength + ((4 - ((headerStart + headerLength) % 4)) % 4);
    if (headerLength < 2 || headerLength > MAX_HEADER_BYTES || vectorsStart > content.length) {
      throw new Error(`Invalid HNSW index metadata length: ${this.filePath}`);
    }

    let persisted: PersistedIndex;
    try {
      persisted = JSON.parse(content.toString('utf8', headerStart, headerStart + headerLength)) as PersistedIndex;
    } catch (failure) {
      throw new Error(`Could not parse HNSW index metadata at ${this.filePath}: ${failure instanceof Error ? failure.message : String(failure)}`, { cause: failure });
    }
    if (persisted.schemaVersion !== 1 || persisted.modelKey !== this.modelKey
      || !Number.isInteger(persisted.dimensions) || persisted.dimensions < 1 || persisted.dimensions > MAX_DIMENSIONS
      || persisted.m !== this.m || persisted.efConstruction !== this.efConstruction
      || !Array.isArray(persisted.nodes) || persisted.nodes.length > 10_000_000
      || !Number.isInteger(persisted.entryPoint) || persisted.entryPoint < 0 || persisted.entryPoint >= persisted.nodes.length
      || !Number.isInteger(persisted.maxLevel) || persisted.maxLevel < 0 || persisted.maxLevel > MAX_LEVEL) {
      throw new Error(`Invalid or incompatible HNSW index metadata: ${this.filePath}`);
    }
    const expectedLength = vectorsStart + persisted.nodes.length * persisted.dimensions * Float32Array.BYTES_PER_ELEMENT;
    if (expectedLength !== content.length) {
      throw new Error(`HNSW vector data length does not match its metadata: ${this.filePath}`);
    }

    this.dimensions = persisted.dimensions;
    this.entryPoint = persisted.entryPoint;
    this.maxLevel = persisted.maxLevel;
    const vectorBytes = persisted.dimensions * Float32Array.BYTES_PER_ELEMENT;
    for (let index = 0; index < persisted.nodes.length; index++) {
      const source = persisted.nodes[index];
      if (!source || typeof source.id !== 'string' || !source.id || this.nodeById.has(source.id)
        || (source.documentId !== undefined && (typeof source.documentId !== 'string' || !source.documentId || source.documentId.length > 500))
        || !Number.isInteger(source.level) || source.level < 0 || source.level > MAX_LEVEL
        || !Array.isArray(source.links) || source.links.length !== source.level + 1) {
        throw new Error(`Invalid HNSW node ${index} in ${this.filePath}`);
      }
      const vector = new Float32Array(persisted.dimensions);
      const vectorOffset = vectorsStart + index * vectorBytes;
      for (let dimension = 0; dimension < persisted.dimensions; dimension++) {
        const value = content.readFloatLE(vectorOffset + dimension * Float32Array.BYTES_PER_ELEMENT);
        if (!Number.isFinite(value)) throw new Error(`Non-finite HNSW vector value at node ${index}.`);
        vector[dimension] = value;
      }
      const links = source.links.map((layerLinks, layer) => {
        if (!Array.isArray(layerLinks) || layerLinks.length > (layer === 0 ? persisted.m * 2 : persisted.m)
          || layerLinks.some(neighbor => !Number.isInteger(neighbor) || neighbor < 0 || neighbor >= persisted.nodes.length || neighbor === index)) {
          throw new Error(`Invalid HNSW neighbor list at node ${index}, layer ${layer}.`);
        }
        return [...new Set(layerLinks)];
      });
      this.nodes.push({
        id: source.id,
        documentId: source.documentId ?? source.id,
        vector,
        ...(typeof source.contentHash === 'string' ? { contentHash: source.contentHash } : {}),
        level: source.level,
        links,
      });
      this.nodeById.set(source.id, index);
    }
    for (let index = 0; index < this.nodes.length; index++) {
      for (let layer = 0; layer < this.nodes[index].links.length; layer++) {
        if (this.nodes[index].links[layer].some(neighbor => this.nodes[neighbor].level < layer)) {
          throw new Error(`HNSW edge references a node missing layer ${layer}.`);
        }
      }
    }
    this.dirty = false;
  }

  private save(): void {
    if (!this.dirty || this.dimensions === 0) return;
    const persisted: PersistedIndex = {
      schemaVersion: 1,
      modelKey: this.modelKey,
      dimensions: this.dimensions,
      entryPoint: this.entryPoint,
      maxLevel: this.maxLevel,
      m: this.m,
      efConstruction: this.efConstruction,
      nodes: this.nodes.map(({ id, documentId, contentHash, level, links }) => ({
        id,
        ...(documentId !== id ? { documentId } : {}),
        ...(contentHash ? { contentHash } : {}),
        level,
        links,
      })),
    };
    const header = Buffer.from(JSON.stringify(persisted), 'utf8');
    const headerStart = MAGIC.length + 4;
    const vectorsStart = headerStart + header.length + ((4 - ((headerStart + header.length) % 4)) % 4);
    const vectorBytes = this.nodes.length * this.dimensions * Float32Array.BYTES_PER_ELEMENT;
    if (header.length > MAX_HEADER_BYTES || vectorsStart + vectorBytes > MAX_INDEX_BYTES) {
      throw new Error(`HNSW index exceeds the ${MAX_INDEX_BYTES} byte local-index limit; configure a remote vector store for larger corpora.`);
    }
    const output = Buffer.alloc(vectorsStart + vectorBytes);
    MAGIC.copy(output, 0);
    output.writeUInt32LE(header.length, MAGIC.length);
    header.copy(output, headerStart);
    for (let index = 0; index < this.nodes.length; index++) {
      const vectorOffset = vectorsStart + index * this.dimensions * Float32Array.BYTES_PER_ELEMENT;
      for (let dimension = 0; dimension < this.dimensions; dimension++) {
        output.writeFloatLE(this.nodes[index].vector[dimension], vectorOffset + dimension * Float32Array.BYTES_PER_ELEMENT);
      }
    }

    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, output);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, this.filePath);
      this.dirty = false;
    } catch (failure) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try {
        fs.unlinkSync(temporary);
      } catch (cleanupFailure) {
        if ((cleanupFailure as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error(`[memory] Could not remove incomplete HNSW index ${temporary}: ${cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)}`);
        }
      }
      throw failure;
    }
  }
}
