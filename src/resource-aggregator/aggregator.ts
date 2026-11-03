import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ResourceAggregatorConfig } from './config.js';
import type { FeedEntry, SourceConfig, SourceSnapshot } from './types.js';

export class Aggregator {
  readonly snapshots = new Map<string, SourceSnapshot>();
  private readonly running = new Set<string>();

  constructor(private readonly config: ResourceAggregatorConfig, readonly sources: SourceConfig[]) {
    for (const source of sources) {
      this.snapshots.set(source.id, {
        id: source.id,
        category: source.category,
        label: source.label,
        description: source.description,
        path: source.path,
        requestUrl: this.requestUrl(source),
        status: 'idle',
      });
    }
  }

  async restore(): Promise<void> {
    await Promise.all(this.sources.map(async source => {
      const file = path.resolve(this.config.cacheDir, `${source.id}.json`);
      try {
        const snapshot = JSON.parse(await readFile(file, 'utf8')) as SourceSnapshot;
        if (snapshot.id !== source.id || !['idle', 'syncing', 'ok', 'error'].includes(snapshot.status)) {
          throw new Error('snapshot does not match the configured source');
        }
        this.snapshots.set(source.id, {
          ...snapshot,
          requestUrl: this.requestUrl(source),
          status: snapshot.status === 'syncing' ? 'error' : snapshot.status,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        console.warn(`[resource-aggregator] Could not restore ${source.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
  }

  async syncOne(source: SourceConfig): Promise<SourceSnapshot> {
    const previous = this.snapshots.get(source.id);
    if (!previous) throw new Error(`Unknown source: ${source.id}`);
    if (this.running.has(source.id)) return previous;
    this.running.add(source.id);
    const started = Date.now();
    const attemptedAt = new Date(started).toISOString();
    this.snapshots.set(source.id, { ...previous, status: 'syncing', error: undefined, attemptedAt });

    try {
      const response = await fetch(this.requestUrl(source), {
        headers: { accept: 'application/json, text/csv;q=0.9, text/plain;q=0.8' },
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
      if (!response.ok) throw new Error(`Upstream returned ${response.status} ${response.statusText}`);
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      const data: unknown = contentType.includes('json') ? await response.json() : await response.text();
      const fetchedAt = new Date().toISOString();
      const snapshot: SourceSnapshot = {
        id: source.id,
        category: source.category,
        label: source.label,
        description: source.description,
        path: source.path,
        requestUrl: this.requestUrl(source),
        status: 'ok',
        fetchedAt,
        staleAt: new Date(Date.now() + source.ttlMs).toISOString(),
        attemptedAt,
        failureCount: 0,
        durationMs: Date.now() - started,
        data,
      };
      this.snapshots.set(source.id, snapshot);
      await this.persist(snapshot);
      return snapshot;
    } catch (error) {
      const failureCount = (previous.failureCount ?? 0) + 1;
      const retryDelay = Math.min(this.config.retryBaseMs * 2 ** (failureCount - 1), this.config.retryMaxMs);
      const snapshot: SourceSnapshot = {
        ...previous,
        status: 'error',
        attemptedAt,
        retryAt: new Date(Date.now() + retryDelay).toISOString(),
        failureCount,
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      };
      this.snapshots.set(source.id, snapshot);
      try {
        await this.persist(snapshot);
      } catch (persistError) {
        console.error(`[resource-aggregator] Could not persist failed snapshot for ${source.id}:`, persistError);
      }
      return snapshot;
    } finally {
      this.running.delete(source.id);
    }
  }

  async syncOneById(id: string, force = false): Promise<SourceSnapshot> {
    const source = this.sources.find(item => item.id === id);
    if (!source) throw new Error(`Unknown source: ${id}`);
    const snapshot = this.snapshots.get(id)!;
    const lastAttempt = snapshot.attemptedAt ? Date.parse(snapshot.attemptedAt) : NaN;
    if (source.minIntervalMs && Number.isFinite(lastAttempt) && Date.now() - lastAttempt < source.minIntervalMs) return snapshot;
    if (!force && snapshot.staleAt && Date.now() < Date.parse(snapshot.staleAt)) return snapshot;
    if (!force && snapshot.retryAt && Date.now() < Date.parse(snapshot.retryAt)) return snapshot;
    return this.syncOne(source);
  }

  async syncAll(force = false): Promise<SourceSnapshot[]> {
    const enabled = this.sources.filter(source => source.enabled);
    const results: SourceSnapshot[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < enabled.length) {
        const source = enabled[cursor++];
        results.push(await this.syncOneById(source.id, force));
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.config.concurrency, enabled.length) }, worker));
    return results;
  }

  feed(query?: string, limit = 100): FeedEntry[] {
    const needle = query?.trim().toLowerCase();
    return this.sources
      .map(source => this.snapshots.get(source.id)!)
      .filter(snapshot => snapshot.data !== undefined && snapshot.fetchedAt &&
        (!needle || snapshot.id.includes(needle) || snapshot.path.toLowerCase().includes(needle) || JSON.stringify(snapshot.data).toLowerCase().includes(needle)))
      .sort((a, b) => (b.fetchedAt ?? '').localeCompare(a.fetchedAt ?? ''))
      .slice(0, limit)
      .map(snapshot => ({ id: snapshot.id, source: snapshot.path, fetchedAt: snapshot.fetchedAt!, data: snapshot.data }));
  }

  private async persist(snapshot: SourceSnapshot): Promise<void> {
    await mkdir(this.config.cacheDir, { recursive: true });
    const file = path.resolve(this.config.cacheDir, `${snapshot.id}.json`);
    const temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify(snapshot), 'utf8');
    await rename(temporary, file);
  }

  private requestUrl(source: SourceConfig): string {
    const url = new URL(source.path);
    for (const [key, value] of Object.entries(source.params ?? {})) url.searchParams.set(key, value);
    return url.toString();
  }
}
