export type SourceCategory = 'intelligence' | 'markets';

export interface SourceConfig {
  id: string;
  category: SourceCategory;
  label: string;
  description: string;
  path: string;
  ttlMs: number;
  minIntervalMs?: number;
  enabled: boolean;
  params?: Record<string, string>;
}

export type SourceStatus = 'idle' | 'syncing' | 'ok' | 'error';

export interface SourceSnapshot {
  id: string;
  category: SourceCategory;
  label: string;
  description: string;
  path: string;
  requestUrl?: string;
  status: SourceStatus;
  fetchedAt?: string;
  staleAt?: string;
  attemptedAt?: string;
  retryAt?: string;
  failureCount?: number;
  durationMs?: number;
  error?: string;
  data?: unknown;
}

export interface FeedEntry {
  id: string;
  source: string;
  fetchedAt: string;
  data: unknown;
}

export interface VectorDocument {
  id: string;
  source: string;
  fetchedAt: string;
  label?: string;
  content?: string;
  recordId?: string;
  latitude?: number;
  longitude?: number;
  dimensions: number;
  vector: number[];
  magnitude: number;
  quality: number;
  textBytes: number;
  cluster?: number;
  anomalyScore?: number;
}

export interface PipelineReport {
  runId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  intervalMs: number;
  attempted: number;
  succeeded: number;
  failed: number;
  vectors: number;
  documents: VectorDocument[];
}

export interface ResourceAggregatorDashboard {
  status: 'starting' | 'ok' | 'degraded' | 'unavailable';
  supervisor: { name: 'Symbiote'; status: 'running' | 'starting' | 'stopped' };
  sourceHealth: {
    configured: number;
    enabled: number;
    ok: number;
    error: number;
    idle: number;
    syncing: number;
  };
  sources: SourceSnapshot[];
  vectors: { count: number; dimensions: number; fetchedAt?: string };
  lastRun?: Omit<PipelineReport, 'documents'>;
  lastError?: string;
  timestamp: string;
}

export interface VectorSearchResult {
  query: string;
  matches: Array<VectorDocument & { score: number }>;
}

export interface VectorSimilarityResult {
  id: string;
  matches: Array<Omit<VectorDocument, 'vector'> & { score: number }>;
}

export type VectorEntity = Omit<VectorDocument, 'vector'>;
