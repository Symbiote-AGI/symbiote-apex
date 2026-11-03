import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Aggregator } from './aggregator.js';
import { createResourceAggregatorConfig } from './config.js';
import { Pipeline } from './pipeline.js';
import { DEFAULT_SOURCES } from './sources.js';
import type {
  PipelineReport,
  ResourceAggregatorDashboard,
  SourceSnapshot,
  VectorEntity,
  VectorSimilarityResult,
  VectorSearchResult,
} from './types.js';

const VECTOR_DIMENSIONS = 512;

export class ResourceAggregatorService {
  private readonly config: ReturnType<typeof createResourceAggregatorConfig>;
  private readonly aggregator: Aggregator;
  private readonly pipeline: Pipeline;
  private started = false;
  private stopped = false;
  private heartbeat?: NodeJS.Timeout;
  private retryAt = 0;
  private recoveryFailures = 0;
  private readonly settingsFile: string;

  constructor(workspace: string) {
    this.config = createResourceAggregatorConfig(workspace);
    this.settingsFile = path.resolve(this.config.cacheDir, '..', 'settings.json');
    this.restoreSettings();
    this.aggregator = new Aggregator(this.config, DEFAULT_SOURCES);
    this.pipeline = new Pipeline(this.config, this.aggregator);
  }

  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    try {
      await this.aggregator.restore();
      await this.pipeline.start();
      this.heartbeat = setInterval(() => { void this.supervise(); }, 30_000);
      this.heartbeat.unref();
    } catch (error) {
      this.started = false;
      console.error('[resource-aggregator] Could not start; Symbiote will continue without live refresh:', error);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.pipeline.stop();
  }

  dashboard(): ResourceAggregatorDashboard {
    const sources = [...this.aggregator.snapshots.values()].map(snapshot => ({
      ...snapshot,
      ...(snapshot.data !== undefined ? { data: this.preview(snapshot) } : {}),
    }));
    const enabled = DEFAULT_SOURCES.filter(source => source.enabled);
    const sourceHealth = {
      configured: DEFAULT_SOURCES.length,
      enabled: enabled.length,
      ok: enabled.filter(source => this.aggregator.snapshots.get(source.id)?.status === 'ok').length,
      error: enabled.filter(source => this.aggregator.snapshots.get(source.id)?.status === 'error').length,
      idle: enabled.filter(source => this.aggregator.snapshots.get(source.id)?.status === 'idle').length,
      syncing: enabled.filter(source => this.aggregator.snapshots.get(source.id)?.status === 'syncing').length,
    };
    const status = !this.started
      ? 'unavailable'
      : sourceHealth.error > 0
        ? 'degraded'
        : sourceHealth.ok === 0
          ? 'starting'
          : 'ok';
    const report = this.pipeline.lastReport;
    return {
      status,
      supervisor: {
        name: 'Symbiote',
        status: this.started ? sourceHealth.ok > 0 ? 'running' : 'starting' : this.stopped ? 'stopped' : 'starting',
      },
      sourceHealth,
      sources,
      vectors: {
        count: this.pipeline.vectorDocuments.length,
        dimensions: VECTOR_DIMENSIONS,
        ...(report ? { fetchedAt: report.completedAt } : {}),
      },
      ...(report ? { lastRun: {
        runId: report.runId,
        startedAt: report.startedAt,
        completedAt: report.completedAt,
        durationMs: report.durationMs,
        intervalMs: report.intervalMs,
        attempted: report.attempted,
        succeeded: report.succeeded,
        failed: report.failed,
        vectors: report.vectors,
      } } : {}),
      ...(this.pipeline.lastError ? { lastError: this.pipeline.lastError } : {}),
      timestamp: new Date().toISOString(),
    };
  }

  source(id: string): SourceSnapshot | undefined {
    return this.aggregator.snapshots.get(id);
  }

  entities(): VectorEntity[] {
    return this.pipeline.vectorDocuments.slice(0, 5_000).map(({ vector: _vector, ...document }) => document);
  }

  similar(id: string, limit = 50): VectorSimilarityResult | null {
    const result = this.pipeline.similar(id, limit);
    if (!result) return null;
    return {
      id: result.id,
      matches: result.matches.map(({ vector: _vector, ...document }) => document),
    };
  }

  async searchVectors(query: string, limit = 10): Promise<VectorSearchResult> {
    const normalized = query.trim();
    if (!normalized) throw new Error('A non-empty query is required');
    if (normalized.length > 500) throw new Error('Query must be 500 characters or fewer');
    const boundedLimit = Math.min(50, Math.max(1, Math.floor(limit) || 10));
    const result = await this.pipeline.search(normalized, boundedLimit);
    return {
      query: normalized,
      matches: result.documents.map((document, index) => ({ ...document, score: result.scores[index] })),
    };
  }

  async refresh(): Promise<PipelineReport> {
    return this.pipeline.runOnce(`manual-${Date.now()}`, true);
  }

  settings(): { collectionIntervalMs: number } {
    return { collectionIntervalMs: this.config.collectionIntervalMs };
  }

  setCollectionInterval(milliseconds: number): { collectionIntervalMs: number } {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 30_000 || milliseconds > 900_000) {
      throw new Error('Resource collection interval must be from 30 seconds to 15 minutes.');
    }
    this.config.collectionIntervalMs = milliseconds;
    this.pipeline.setCollectionInterval(milliseconds);
    fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.settingsFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify({ collectionIntervalMs: milliseconds })}\n`, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, this.settingsFile);
    } catch (failure) {
      throw new Error(`Could not persist resource collection settings at ${this.settingsFile}.`, { cause: failure });
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    return this.settings();
  }

  private async supervise(): Promise<void> {
    if (!this.started || this.stopped || this.pipeline.isRunning || Date.now() < this.retryAt) return;
    const lastActivity = Date.parse(this.pipeline.lastStartedAt ?? this.pipeline.lastReport?.completedAt ?? '');
    if (Number.isFinite(lastActivity) && Date.now() - lastActivity < this.config.collectionIntervalMs * 2) return;

    try {
      console.warn('[gamma] Resource feed heartbeat detected a stalled pipeline; restarting collection.');
      await this.pipeline.runOnce('gamma-heartbeat-recovery');
      this.recoveryFailures = 0;
      this.retryAt = 0;
    } catch (error) {
      this.recoveryFailures++;
      this.retryAt = Date.now() + Math.min(30_000 * 2 ** (this.recoveryFailures - 1), 15 * 60_000);
      console.error('[gamma] Resource feed recovery failed; Symbiote remains available:', error);
    }
  }

  private restoreSettings(): void {
    try {
      const settings = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')) as { collectionIntervalMs?: unknown };
      if (typeof settings.collectionIntervalMs !== 'number'
        || !Number.isSafeInteger(settings.collectionIntervalMs)
        || settings.collectionIntervalMs < 30_000
        || settings.collectionIntervalMs > 900_000) {
        throw new Error('Stored resource collection interval must be an integer from 30 seconds to 15 minutes.');
      }
      this.config.collectionIntervalMs = settings.collectionIntervalMs;
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return;
      console.error('[resource-aggregator] Could not restore collection settings; using the default interval:', failure);
    }
  }

  private preview(snapshot: SourceSnapshot): unknown {
    const data = snapshot.data;
    if (!data || typeof data !== 'object') return data;

    if (snapshot.id === 'cisa-known-exploited-vulnerabilities') {
      const catalog = data as { catalogVersion?: unknown; dateReleased?: unknown; vulnerabilities?: unknown };
      return {
        catalogVersion: catalog.catalogVersion,
        dateReleased: catalog.dateReleased,
        total: Array.isArray(catalog.vulnerabilities) ? catalog.vulnerabilities.length : 0,
        vulnerabilities: Array.isArray(catalog.vulnerabilities) ? catalog.vulnerabilities.slice(0, 12) : [],
      };
    }
    if (snapshot.id === 'usgs-earthquakes-2-5-day') {
      const geojson = data as { type?: unknown; metadata?: unknown; features?: unknown };
      return {
        type: geojson.type,
        metadata: geojson.metadata,
        features: Array.isArray(geojson.features) ? geojson.features.slice(0, 120) : [],
      };
    }
    if (Array.isArray(data)) return data.slice(0, 30);
    return data;
  }
}
