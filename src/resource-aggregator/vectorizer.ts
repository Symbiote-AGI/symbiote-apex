import { createHash } from 'node:crypto';
import type { SourceSnapshot, VectorDocument } from './types.js';

const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'at', 'for', 'with', 'is', 'are', 'as', 'on', 'from', 'by', 'was', 'be']);

export function flatten(value: unknown, depth = 0): string[] {
  if (depth > 8 || value === null || value === undefined) return [];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(item => flatten(item, depth + 1));
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => [`${key}`, ...flatten(item, depth + 1)]);
  }
  return [];
}

export function vectorize(snapshot: SourceSnapshot, dimensions = 512): VectorDocument | null {
  if (snapshot.data === undefined || !snapshot.fetchedAt) return null;
  return vectorizeText({
    id: snapshot.id,
    source: snapshot.path,
    fetchedAt: snapshot.fetchedAt,
  }, flatten(snapshot.data).join(' '), dimensions);
}

export function vectorizeRecords(snapshot: SourceSnapshot, dimensions = 512): VectorDocument[] {
  const fetchedAt = snapshot.fetchedAt;
  if (snapshot.data === undefined || !fetchedAt) return [];
  const data = snapshot.data;
  const root = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : null;
  const features = Array.isArray(root?.features) ? root.features : null;
  const collection = ['vulnerabilities', 'results', 'items', 'data', 'events']
    .map(key => root?.[key])
    .find(Array.isArray);
  const states = Array.isArray(root?.states) ? root.states : null;
  const records = features ?? collection ?? states ?? (Array.isArray(data) ? data : null);
  if (!records) {
    const document = vectorize(snapshot, dimensions);
    return document ? [document] : [];
  }

  return records.slice(0, 2_000).flatMap((record, index) => {
    let value: Record<string, unknown> = record && typeof record === 'object' && !Array.isArray(record)
      ? record as Record<string, unknown>
      : { value: record };
    if (snapshot.id === 'opensky-aircraft' && Array.isArray(record)) {
      const state = record as unknown[];
      value = {
        id: typeof state[0] === 'string' ? state[0] : String(index),
        geometry: { type: 'Point', coordinates: [state[5], state[6]] },
        properties: {
          icao24: state[0],
          callsign: state[1],
          originCountry: state[2],
          barometricAltitude: state[7],
          onGround: state[8],
          velocity: state[9],
          heading: state[10],
          verticalRate: state[11],
          geoAltitude: state[13],
          squawk: state[14],
        },
      };
    }
    const properties = value.properties && typeof value.properties === 'object' && !Array.isArray(value.properties)
      ? value.properties as Record<string, unknown>
      : value;
    const rawId = value.id ?? properties.cveID ?? properties.uuid ?? properties.event_id;
    const id = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : String(index);
    const rawLabel = ['title', 'name', 'callsign', 'flight', 'icao24', 'place', 'event', 'short_description', 'summary', 'ip_address', 'cveID']
      .map(key => properties[key])
      .find((item): item is string => typeof item === 'string' && item.trim().length > 0);
    const label = rawLabel?.trim();
    const geometry = value.geometry && typeof value.geometry === 'object' && !Array.isArray(value.geometry)
      ? value.geometry as Record<string, unknown>
      : null;
    const coordinates = geometry?.type === 'Point' && Array.isArray(geometry.coordinates)
      ? geometry.coordinates
      : null;
    const longitude = typeof coordinates?.[0] === 'number' ? coordinates[0] : undefined;
    const latitude = typeof coordinates?.[1] === 'number' ? coordinates[1] : undefined;
    const text = flatten(record).join(' ');
    const document = vectorizeText({
      id: `${snapshot.id}:${id}`,
      source: snapshot.path,
      fetchedAt,
      label,
      content: text.slice(0, 2_000),
      recordId: id,
      latitude,
      longitude,
    }, text, dimensions);
    return document ? [document] : [];
  });
}

function vectorizeText(
  metadata: Pick<VectorDocument, 'id' | 'source' | 'fetchedAt'>
    & Partial<Pick<VectorDocument, 'label' | 'content' | 'recordId' | 'latitude' | 'longitude'>>,
  text: string,
  dimensions: number,
): VectorDocument | null {
  const tokens = text.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  if (!tokens.length) return null;

  const counts = new Map<number, number>();
  for (const token of tokens) {
    if (stopWords.has(token)) continue;
    const bucket = Number.parseInt(createHash('sha256').update(token).digest('hex').slice(0, 8), 16) % dimensions;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  const vector = Array.from({ length: dimensions }, (_, index) => counts.get(index) ?? 0);
  const magnitude = Math.hypot(...vector);
  if (!magnitude) return null;
  return {
    ...metadata,
    dimensions,
    vector: vector.map(value => value / magnitude),
    magnitude,
    quality: Math.min(1, Buffer.byteLength(text) / 1024),
    textBytes: Buffer.byteLength(text),
  };
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index++) dot += a[index] * b[index];
  return dot;
}

export function enrichDocuments(documents: VectorDocument[]): VectorDocument[] {
  if (!documents.length) return [];
  const mean = Array.from({ length: documents[0].dimensions }, (_, dimension) =>
    documents.reduce((sum, document) => sum + document.vector[dimension], 0) / documents.length);
  const similarities = documents.map(document => cosine(document.vector, mean));
  const average = similarities.reduce((sum, score) => sum + score, 0) / similarities.length;
  const spread = Math.sqrt(similarities.reduce((sum, score) => sum + (score - average) ** 2, 0) / similarities.length);
  const clusterCount = Math.min(8, Math.max(1, Math.floor(Math.sqrt(documents.length))));
  const iterationCount = Math.max(1, Math.min(
    12,
    Math.floor(16_000_000 / (documents.length * clusterCount * documents[0].dimensions)),
  ));
  const centroids = Array.from({ length: clusterCount }, (_, index) =>
    documents[Math.floor(index * documents.length / clusterCount)].vector.slice());

  for (let iteration = 0; iteration < iterationCount; iteration++) {
    const groups = Array.from({ length: clusterCount }, () => [] as VectorDocument[]);
    for (const document of documents) {
      const cluster = centroids.reduce((best, centroid, index) =>
        cosine(document.vector, centroid) > cosine(document.vector, centroids[best]) ? index : best, 0);
      groups[cluster].push(document);
      document.cluster = cluster;
    }
    groups.forEach((group, index) => {
      if (!group.length) return;
      centroids[index] = Array.from({ length: documents[0].dimensions }, (_, dimension) =>
        group.reduce((sum, document) => sum + document.vector[dimension], 0) / group.length);
    });
  }

  for (const [index, document] of documents.entries()) {
    document.anomalyScore = spread > 0
      ? Math.max(0, Math.min(1, (average - similarities[index]) / (3 * spread) + 0.5))
      : 0.5;
  }
  return documents;
}
