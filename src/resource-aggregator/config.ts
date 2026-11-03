import path from 'node:path';

export interface ResourceAggregatorConfig {
  cacheDir: string;
  vectorDir: string;
  concurrency: number;
  requestTimeoutMs: number;
  collectionIntervalMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
}

export function createResourceAggregatorConfig(workspace: string): ResourceAggregatorConfig {
  const stateDir = path.resolve(workspace, '.symbiote', 'resource-aggregator');
  return {
    cacheDir: path.join(stateDir, 'cache'),
    vectorDir: path.join(stateDir, 'vectors'),
    concurrency: 4,
    requestTimeoutMs: 15_000,
    collectionIntervalMs: 60_000,
    retryBaseMs: 60_000,
    retryMaxMs: 30 * 60_000,
  };
}
