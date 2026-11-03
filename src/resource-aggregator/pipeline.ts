import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ResourceAggregatorConfig } from './config.js';
import type { Aggregator } from './aggregator.js';
import { cosine, enrichDocuments, vectorize, vectorizeRecords } from './vectorizer.js';
import type { PipelineReport, VectorDocument } from './types.js';

const jitter = (milliseconds: number) => milliseconds * (0.8 + Math.random() * 0.4);

export class Pipeline {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private currentRun?: Promise<PipelineReport>;
  private documents: VectorDocument[] = [];
  lastReport?: PipelineReport;
  lastStartedAt?: string;
  lastError?: string;

  constructor(private readonly config: ResourceAggregatorConfig, private readonly aggregator: Aggregator) {}

  get isRunning(): boolean {
    return this.running;
  }

  get vectorDocuments(): readonly VectorDocument[] {
    return this.documents;
  }

  async start(): Promise<void> {
    if (this.timer || this.running) return;
    await this.restoreIndex();
    this.stopped = false;
    void this.runScheduledCollection('startup');
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  runOnce(runId = `manual-${Date.now()}`, force = false): Promise<PipelineReport> {
    if (this.currentRun) return this.currentRun;
    const currentRun = this.executeRun(runId, force).finally(() => {
      if (this.currentRun === currentRun) this.currentRun = undefined;
    });
    this.currentRun = currentRun;
    return currentRun;
  }

  setCollectionInterval(milliseconds: number): void {
    this.config.collectionIntervalMs = milliseconds;
    const wasScheduled = Boolean(this.timer);
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (wasScheduled) this.schedule();
  }

  private async executeRun(runId: string, force: boolean): Promise<PipelineReport> {
    this.running = true;
    this.lastStartedAt = new Date().toISOString();
    const startedAt = new Date();
    try {
      const results = await this.aggregator.syncAll(force);
      const documents = enrichDocuments(results.flatMap(result => vectorizeRecords(result)));
      await this.persistIndex(documents);
      const report: PipelineReport = {
        runId,
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        intervalMs: this.config.collectionIntervalMs,
        attempted: results.length,
        succeeded: results.filter(result => result.status === 'ok').length,
        failed: results.filter(result => result.status === 'error').length,
        vectors: documents.length,
        documents,
      };
      this.documents = documents;
      this.lastReport = report;
      this.lastError = undefined;
      await this.persistReport(report);
      return report;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.running = false;
    }
  }

  async search(query: string, limit = 10): Promise<{ documents: VectorDocument[]; scores: number[] }> {
    const pseudo = vectorize({
      id: '__query__',
      category: 'intelligence',
      label: 'query',
      description: '',
      path: '/query',
      status: 'ok',
      fetchedAt: new Date().toISOString(),
      data: query,
    });
    if (!pseudo) return { documents: [], scores: [] };
    const ranked = this.documents
      .map(document => ({ document, score: cosine(pseudo.vector, document.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return { documents: ranked.map(item => item.document), scores: ranked.map(item => item.score) };
  }

  similar(id: string, limit = 50): { id: string; matches: Array<VectorDocument & { score: number }> } | null {
    const selected = this.documents.find(document => document.id === id);
    if (!selected) return null;
    const matches = this.documents
      .filter(document => document.id !== id)
      .map(document => ({ document, score: cosine(selected.vector, document.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(50, Math.max(1, Math.floor(limit) || 50)));
    return {
      id,
      matches: matches.map(({ document, score }) => ({ ...document, score })),
    };
  }

  private schedule(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runScheduledCollection('timer');
    }, jitter(this.config.collectionIntervalMs));
    this.timer.unref();
  }

  private async runScheduledCollection(runId: string): Promise<void> {
    try {
      const report = await this.runOnce(runId);
      console.log(`[resource-aggregator] ${runId}: ${report.succeeded}/${report.attempted} sources healthy, ${report.failed} degraded, ${report.vectors} vectors`);
    } catch (error) {
      console.error(`[resource-aggregator] ${runId} failed:`, error);
    } finally {
      this.schedule();
    }
  }

  private indexFile(): string {
    return path.resolve(this.config.vectorDir, 'vectors.json');
  }

  private async persistIndex(documents: VectorDocument[]): Promise<void> {
    await mkdir(this.config.vectorDir, { recursive: true });
    const file = this.indexFile();
    const temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, createdAt: new Date().toISOString(), dimensions: 512, documents }), 'utf8');
    await rename(temporary, file);
  }

  private async restoreIndex(): Promise<void> {
    try {
      const report = await this.loadReport();
      if (report) {
        this.lastReport = report;
        this.documents = report.documents ?? [];
        return;
      }
      this.documents = await this.loadIndex();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      console.warn('[resource-aggregator] Could not restore vector state:', this.lastError);
    }
  }

  private async loadIndex(): Promise<VectorDocument[]> {
    try {
      const raw = JSON.parse(await readFile(this.indexFile(), 'utf8')) as { documents?: VectorDocument[] };
      return raw.documents ?? [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async persistReport(report: PipelineReport): Promise<void> {
    await mkdir(this.config.cacheDir, { recursive: true });
    await writeFile(path.resolve(this.config.cacheDir, 'pipeline-report.json'), JSON.stringify(report), 'utf8');
  }

  private async loadReport(): Promise<PipelineReport | undefined> {
    try {
      return JSON.parse(await readFile(path.resolve(this.config.cacheDir, 'pipeline-report.json'), 'utf8')) as PipelineReport;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
}
