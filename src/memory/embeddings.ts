export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  health(): Promise<void>;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
}

export interface OllamaEmbeddingOptions {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

export interface ArtifactEngineEmbeddingOptions {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

const MAX_BATCH_SIZE = 32;
const MAX_TEXT_LENGTH = 32_000;
const MAX_RESPONSE_BYTES = 16_000_000;

async function responseText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error(`Embedding service response exceeded the ${MAX_RESPONSE_BYTES} byte limit.`);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(`Embedding service response exceeded the ${MAX_RESPONSE_BYTES} byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function jsonResponse(response: Response): Promise<unknown> {
  const text = await responseText(response);
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch (failure) {
    if (failure instanceof SyntaxError) {
      throw new Error(`Embedding service returned invalid JSON: ${failure.message}`, { cause: failure });
    }
    throw failure;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'ollama';
  readonly model: string;
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(options: OllamaEmbeddingOptions) {
    if (!options.model.trim() || options.model.length > 200) {
      throw new Error('An Ollama embedding model name is required.');
    }
    this.baseUrl = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(this.baseUrl.protocol) || this.baseUrl.username || this.baseUrl.password
      || this.baseUrl.search || this.baseUrl.hash) {
      throw new Error('Ollama embedding URL must be an HTTP(S) origin without credentials, query, or fragment.');
    }
    this.baseUrl.pathname = this.baseUrl.pathname.replace(/\/+$/, '') || '/';
    this.model = options.model.trim();
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 300_000) {
      throw new RangeError('Ollama embedding timeout must be between 1000 and 300000 milliseconds.');
    }
    this.fetcher = options.fetcher ?? fetch;
  }

  async health(): Promise<void> {
    const response = await this.fetcher(new URL('/api/tags', this.baseUrl), {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(Math.min(this.timeoutMs, 15_000)),
    });
    const payload = await jsonResponse(response);
    if (!response.ok) {
      throw new Error(`Ollama model discovery failed with HTTP ${response.status}.`);
    }
    if (!isRecord(payload) || !Array.isArray(payload.models)) {
      throw new Error('Ollama model discovery returned an invalid response.');
    }
    const available = payload.models.some(model => {
      if (!isRecord(model) || typeof model.name !== 'string') return false;
      return model.name === this.model
        || (!this.model.includes(':') && model.name.split(':')[0] === this.model);
    });
    if (!available) {
      throw new Error(`Ollama embedding model "${this.model}" is not installed. Run "ollama pull ${this.model}" to enable dense memory.`);
    }
  }

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0 || texts.length > MAX_BATCH_SIZE) {
      throw new RangeError(`Embedding batches must contain between 1 and ${MAX_BATCH_SIZE} texts.`);
    }
    if (texts.some(text => typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_LENGTH)) {
      throw new Error(`Embedding inputs must be non-empty strings of at most ${MAX_TEXT_LENGTH} characters.`);
    }
    const response = await this.fetcher(new URL('/api/embed', this.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
      redirect: 'error',
      signal: signal ?? AbortSignal.timeout(this.timeoutMs),
    });
    const payload = await jsonResponse(response);
    if (!response.ok) {
      const detail = isRecord(payload) && typeof payload.error === 'string'
        ? `: ${payload.error.slice(0, 500)}`
        : '';
      throw new Error(`Ollama embeddings request failed with HTTP ${response.status}${detail}.`);
    }
    if (!isRecord(payload) || !Array.isArray(payload.embeddings) || payload.embeddings.length !== texts.length) {
      throw new Error('Ollama embeddings response did not contain one vector per input.');
    }
    return payload.embeddings.map((vector, index) => {
      if (!Array.isArray(vector) || vector.length === 0 || vector.length > 8192
        || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error(`Ollama returned an invalid embedding vector for input ${index}.`);
      }
      return vector as number[];
    });
  }
}

export class ArtifactEngineEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'artifact-engine';
  readonly model: string;
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(options: ArtifactEngineEmbeddingOptions) {
    if (!options.model.trim() || options.model.length > 200) {
      throw new Error('An Artifact Engine embedding model name is required.');
    }
    this.baseUrl = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(this.baseUrl.protocol) || this.baseUrl.username || this.baseUrl.password
      || this.baseUrl.search || this.baseUrl.hash) {
      throw new Error('Artifact Engine embedding URL must be an HTTP(S) URL without credentials, query, or fragment.');
    }
    this.baseUrl.pathname = this.baseUrl.pathname.replace(/\/+$/, '') || '/v1';
    this.model = options.model.trim();
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 300_000) {
      throw new RangeError('Artifact Engine embedding timeout must be between 1000 and 300000 milliseconds.');
    }
    this.fetcher = options.fetcher ?? fetch;
  }

  async health(): Promise<void> {
    const endpoint = new URL(`${this.baseUrl.pathname}/models`, this.baseUrl);
    const response = await this.fetcher(endpoint, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(Math.min(this.timeoutMs, 15_000)),
    });
    const payload = await jsonResponse(response);
    if (!response.ok) {
      throw new Error(`Artifact Engine model discovery failed with HTTP ${response.status}.`);
    }
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new Error('Artifact Engine model discovery returned an invalid response.');
    }
    if (!payload.data.some(model => isRecord(model) && model.id === this.model)) {
      throw new Error(`Artifact Engine model "${this.model}" is not loaded.`);
    }
  }

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0 || texts.length > MAX_BATCH_SIZE) {
      throw new RangeError(`Embedding batches must contain between 1 and ${MAX_BATCH_SIZE} texts.`);
    }
    if (texts.some(text => typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_LENGTH)) {
      throw new Error(`Embedding inputs must be non-empty strings of at most ${MAX_TEXT_LENGTH} characters.`);
    }
    const endpoint = new URL(`${this.baseUrl.pathname}/embeddings`, this.baseUrl);
    const response = await this.fetcher(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
      redirect: 'error',
      signal: signal ?? AbortSignal.timeout(this.timeoutMs),
    });
    const payload = await jsonResponse(response);
    if (!response.ok) {
      const detail = isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string'
        ? `: ${payload.error.message.slice(0, 500)}`
        : '';
      throw new Error(`Artifact Engine embeddings request failed with HTTP ${response.status}${detail}.`);
    }
    if (!isRecord(payload) || !Array.isArray(payload.data) || payload.data.length !== texts.length) {
      throw new Error('Artifact Engine embeddings response did not contain one vector per input.');
    }
    const vectors = payload.data.map((item, index) => {
      if (!isRecord(item) || !Array.isArray(item.embedding) || item.embedding.length === 0
        || item.embedding.length > 32768
        || item.embedding.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error(`Artifact Engine returned an invalid embedding vector for input ${index}.`);
      }
      return item.embedding as number[];
    });
    if (new Set(vectors.map(vector => vector.length)).size !== 1) {
      throw new Error('Artifact Engine returned embeddings with inconsistent dimensions.');
    }
    return vectors;
  }
}

export function createEmbeddingProvider(config: {
  provider?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}): EmbeddingProvider {
  if (config.provider && config.provider !== 'ollama' && config.provider !== 'artifact-engine') {
    throw new Error(`Unsupported embedding provider: ${config.provider}`);
  }
  if (!config.model?.trim()) throw new Error('Configure memory.neural.model before enabling neural memory.');
  if (config.provider === 'artifact-engine') {
    return new ArtifactEngineEmbeddingProvider({
      baseUrl: config.baseUrl ?? 'http://127.0.0.1:8080/v1',
      model: config.model,
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      ...(config.fetcher ? { fetcher: config.fetcher } : {}),
    });
  }
  return new OllamaEmbeddingProvider({
    baseUrl: config.baseUrl ?? 'http://127.0.0.1:11434',
    model: config.model,
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.fetcher ? { fetcher: config.fetcher } : {}),
  });
}
