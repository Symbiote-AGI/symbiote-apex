import { EventEmitter } from 'node:events';

export interface RecoverableWebServer extends EventEmitter {
  readonly listening: boolean;
  close(callback?: (error?: Error) => void): this;
}

export interface WebServerSupervisorOptions {
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export class WebServerSupervisor {
  private server: RecoverableWebServer | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  private failureReported = false;
  private stopping = true;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  constructor(
    private readonly createServer: () => RecoverableWebServer,
    private readonly onIssue: (message: string) => void,
    options: WebServerSupervisorOptions = {},
  ) {
    this.retryBaseMs = options.retryBaseMs ?? 1_000;
    this.retryMaxMs = options.retryMaxMs ?? 30_000;
    if (!Number.isSafeInteger(this.retryBaseMs) || this.retryBaseMs < 1
      || !Number.isSafeInteger(this.retryMaxMs) || this.retryMaxMs < this.retryBaseMs) {
      throw new Error('Web UI retry delays must be positive whole milliseconds, with the maximum at least the base delay.');
    }
  }

  start(): void {
    if (!this.stopping && (this.server || this.restartTimer)) return;
    this.stopping = false;
    this.startInstance();
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;

    const server = this.server;
    this.server = null;
    if (server?.listening) {
      server.close(error => {
        if (error) this.onIssue(`Web UI did not close cleanly: ${error.message}`);
      });
    }
  }

  private startInstance(): void {
    if (this.stopping || this.server || this.restartTimer) return;

    let server: RecoverableWebServer;
    try {
      server = this.createServer();
    } catch (error) {
      this.scheduleRestart(error);
      return;
    }

    this.server = server;
    server.on('listening', () => {
      if (this.server !== server) {
        if (server.listening) server.close();
        return;
      }
      this.retryCount = 0;
      this.failureReported = false;
    });
    server.on('close', () => {
      if (this.server !== server) return;
      this.server = null;
      if (!this.stopping) this.scheduleRestart(new Error('The Web UI server closed unexpectedly.'));
    });
    server.on('error', error => {
      if (this.stopping || this.server !== server || server.listening) return;
      this.server = null;
      this.scheduleRestart(error);
    });
  }

  private scheduleRestart(error: unknown): void {
    if (this.stopping || this.restartTimer) return;

    const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(this.retryCount, 30));
    this.retryCount++;
    const detail = error instanceof Error ? error.message : String(error);
    if (!this.failureReported) {
      this.failureReported = true;
      this.onIssue(`Web UI is unavailable: ${detail}. Retrying in ${delay}ms.`);
    }

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.startInstance();
    }, delay);
    this.restartTimer.unref?.();
  }
}
