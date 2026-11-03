import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import type { CredentialVault } from '../security/credential-vault.js';

export interface Mt5Credentials {
  login: string;
  password: string;
  server: string;
  terminalPath?: string;
}

export interface Mt5Tick {
  symbol: string;
  bid: number;
  ask: number;
  time: number;
}

export interface Mt5ConnectionResult {
  connected: true;
  account: number;
  server: string;
  latencyMs: number;
  tick: Mt5Tick;
}

export interface Mt5Position {
  ticket: number;
  symbol: string;
  type: string;
  volume: number;
  price_open: number;
  price_current: number;
  sl: number;
  tp: number;
  profit: number;
}

export interface Mt5Deal {
  ticket: number;
  order: number;
  positionId: number;
  time: number;
  symbol: string;
  type: string;
  entry: string;
  volume: number;
  price: number;
  profit: number;
  commission: number;
  swap: number;
  comment: string;
}

export interface Mt5JournalSnapshot {
  account: {
    login: number;
    server: string;
  };
  positions: Mt5Position[];
  deals: Mt5Deal[];
}

export interface Mt5Order {
  symbol: string;
  side: 'buy' | 'sell';
  volume: number;
  stopLoss?: number;
  takeProfit?: number;
}

const workerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'mt5-worker.py');

export class Mt5Bridge {
  constructor(private readonly vault: CredentialVault, private readonly envPath = path.resolve('.env')) {}

  configured(): boolean {
    return this.credentials() !== null;
  }

  save(input: unknown): void {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('MetaTrader 5 credentials must be an object.');
    const body = input as Record<string, unknown>;
    for (const field of ['login', 'password', 'server']) {
      if (field in body && typeof body[field] !== 'string') throw new Error(`${field} must be a string.`);
    }
    if ('terminalPath' in body && typeof body.terminalPath !== 'string') throw new Error('terminalPath must be a string.');
    const current = this.vault.get('mt5') ?? this.credentials() ?? {};
    const login = typeof body.login === 'string' && body.login.trim() ? body.login : current.login;
    const password = typeof body.password === 'string' && body.password ? body.password : current.password;
    const server = typeof body.server === 'string' && body.server.trim() ? body.server : current.server;
    const terminalPath = typeof body.terminalPath === 'string' && body.terminalPath.trim()
      ? this.validateTerminalPath(body.terminalPath)
      : current.terminalPath ?? this.terminalPath();
    if (typeof login !== 'string' || !/^\d{1,20}$/.test(login.trim())) throw new Error('Account must be a numeric MetaTrader login.');
    if (typeof password !== 'string' || !password.trim() || password.length > 1_024) throw new Error('Password is required and must be 1,024 characters or fewer.');
    if (typeof server !== 'string' || !server.trim() || server.length > 255) throw new Error('Server is required and must be 255 characters or fewer.');
    if (terminalPath && typeof body.terminalPath === 'string' && body.terminalPath.trim()) {
      this.saveTerminalPathToEnv(terminalPath);
    }
    this.vault.set('mt5', { login: login.trim(), password, server: server.trim(), ...(terminalPath ? { terminalPath } : {}) });
  }

  delete(): void {
    this.vault.delete('mt5');
  }

  status(): { configured: boolean; terminalPath?: string } {
    const terminalPath = this.terminalPath();
    return { configured: this.configured(), ...(terminalPath ? { terminalPath } : {}) };
  }

  saveTerminalPath(value: string): void {
    const terminalPath = this.validateTerminalPath(value);
    this.saveTerminalPathToEnv(terminalPath);
    if (this.vault.get('mt5')) this.vault.set('mt5', { terminalPath });
  }

  private credentials(): Mt5Credentials | null {
    const stored = this.vault.get('mt5');
    const login = stored?.login ?? process.env.MT5_LOGIN ?? '';
    const password = stored?.password ?? process.env.MT5_PASSWORD ?? '';
    const server = stored?.server ?? process.env.MT5_SERVER ?? '';
    return login.trim() && /^\d{1,20}$/.test(login.trim()) && password && server.trim()
      ? { login: login.trim(), password, server: server.trim(), ...(stored?.terminalPath || this.terminalPath() ? { terminalPath: stored?.terminalPath || this.terminalPath() } : {}) }
      : null;
  }

  terminalPath(): string | undefined {
    const stored = this.vault.get('mt5')?.terminalPath;
    if (stored?.trim()) return stored;
    try {
      const value = parse(fs.readFileSync(this.envPath, 'utf8')).MT5_TERMINAL_PATH?.trim();
      return value || process.env.MT5_TERMINAL_PATH?.trim() || undefined;
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return process.env.MT5_TERMINAL_PATH?.trim() || undefined;
      throw new Error(`Could not read the MetaTrader 5 environment settings at ${this.envPath}.`, { cause: failure });
    }
  }

  async launchTerminal(): Promise<{ launched: true; pid?: number }> {
    const executable = this.terminalPath();
    if (!executable) throw new Error('Set the MetaTrader 5 terminal path in Integrations before launching it.');
    this.validateTerminalPath(executable);
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [], { detached: true, stdio: 'ignore', windowsHide: false });
      child.once('error', failure => reject(new Error(`Could not launch MetaTrader 5 at ${executable}: ${failure.message}`, { cause: failure })));
      child.once('spawn', () => {
        child.unref();
        resolve({ launched: true, ...(child.pid ? { pid: child.pid } : {}) });
      });
    });
  }

  private validateTerminalPath(value: string): string {
    const terminalPath = path.resolve(value.trim());
    let stat: fs.Stats;
    try {
      stat = fs.statSync(terminalPath);
    } catch (failure) {
      throw new Error(`MetaTrader 5 terminal executable does not exist: ${terminalPath}`, { cause: failure });
    }
    if (!stat.isFile()) throw new Error('MetaTrader 5 terminal path must point to an executable file.');
    return terminalPath;
  }

  private saveTerminalPathToEnv(terminalPath: string): void {
    let contents = '';
    try {
      contents = fs.readFileSync(this.envPath, 'utf8');
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Could not read the environment file ${this.envPath}.`, { cause: failure });
      }
    }
    const lines = contents.trim() ? contents.replace(/\r?\n+$/, '').split(/\r?\n/) : [];
    if (/[\r\n\u0000]/.test(terminalPath)) throw new Error('MetaTrader 5 terminal path contains unsupported characters.');
    const assignment = `MT5_TERMINAL_PATH=${terminalPath}`;
    const matchingLine = lines.findIndex(line => /^\s*MT5_TERMINAL_PATH\s*=/.test(line));
    if (matchingLine >= 0) lines[matchingLine] = assignment;
    else lines.push(assignment);
    fs.mkdirSync(path.dirname(this.envPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.envPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, `${lines.join('\n')}\n`, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporaryPath, this.envPath);
    } finally {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
  }

  test(symbol = process.env.MT5_SYMBOL?.trim() || 'XAUUSD'): Promise<Mt5ConnectionResult> {
    if (!/^[A-Za-z0-9._-]{1,24}$/.test(symbol)) throw new Error('Test symbol contains unsupported characters.');
    return this.invoke<Mt5ConnectionResult>('test', { ...this.requireCredentials(), symbol });
  }

  positions(): Promise<{ positions: Mt5Position[] }> {
    return this.invoke<{ positions: Mt5Position[] }>('positions', this.requireCredentials());
  }

  history(fromTimestamp: number): Promise<{ deals: Mt5Deal[] }> {
    if (!Number.isSafeInteger(fromTimestamp) || fromTimestamp < 0 || fromTimestamp > Math.floor(Date.now() / 1_000)) {
      throw new Error('Trade history start time must be a valid past Unix timestamp.');
    }
    return this.invoke<{ deals: Mt5Deal[] }>('history', { ...this.requireCredentials(), fromTimestamp });
  }

  journal(fromTimestamp: number): Promise<Mt5JournalSnapshot> {
    if (!Number.isSafeInteger(fromTimestamp) || fromTimestamp < 0 || fromTimestamp > Math.floor(Date.now() / 1_000)) {
      throw new Error('Trade history start time must be a valid past Unix timestamp.');
    }
    return this.invoke<Mt5JournalSnapshot>('journal', { ...this.requireCredentials(), fromTimestamp });
  }

  journalAccountKey(): string {
    const credentials = this.requireCredentials();
    return `${credentials.server.toLocaleLowerCase('en-US')}:${credentials.login}`;
  }

  order(order: Mt5Order): Promise<{ ticket: number; retcode: number; comment: string }> {
    if (!/^[A-Za-z0-9._-]{1,24}$/.test(order.symbol)) throw new Error('Instrument symbol contains unsupported characters.');
    if (!Number.isFinite(order.volume) || order.volume < 0.01 || order.volume > 100) throw new Error('Volume must be between 0.01 and 100 lots.');
    for (const [label, price] of [['Stop loss', order.stopLoss], ['Take profit', order.takeProfit]] as const) {
      if (price !== undefined && (!Number.isFinite(price) || price <= 0)) throw new Error(`${label} must be a positive price.`);
    }
    return this.invoke('order', { ...this.requireCredentials(), ...order });
  }

  close(ticket: number): Promise<{ ticket: number; retcode: number; comment: string }> {
    if (!Number.isSafeInteger(ticket) || ticket <= 0) throw new Error('Position ticket must be a positive integer.');
    return this.invoke('close', { ...this.requireCredentials(), ticket });
  }

  modify(ticket: number, stopLoss?: number, takeProfit?: number): Promise<{ ticket: number; retcode: number; comment: string }> {
    if (!Number.isSafeInteger(ticket) || ticket <= 0) throw new Error('Position ticket must be a positive integer.');
    for (const [label, price] of [['Stop loss', stopLoss], ['Take profit', takeProfit]] as const) {
      if (price !== undefined && (!Number.isFinite(price) || price < 0)) throw new Error(`${label} must be a non-negative price.`);
    }
    return this.invoke('modify', { ...this.requireCredentials(), ticket, stopLoss, takeProfit });
  }

  private requireCredentials(): Mt5Credentials {
    const credentials = this.credentials();
    if (!credentials) {
      throw new Error('Configure Account, Password and Server in Integrations before using MetaTrader 5.');
    }
    return credentials;
  }

  private invoke<T>(operation: string, payload: object): Promise<T> {
    return new Promise((resolve, reject) => {
      const python = process.env.MT5_PYTHON?.trim() || process.env.PYTHON?.trim() || 'python';
      const child = spawn(python, [workerPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
        reject(new Error('MetaTrader 5 connector did not respond within 30 seconds.'));
      }, 30_000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.once('error', failure => {
        clearTimeout(timeout);
        reject(new Error(`Could not start the MetaTrader 5 Python connector (${python}): ${failure.message}`, { cause: failure }));
      });
      child.once('close', code => {
        clearTimeout(timeout);
        if (timedOut) return;
        let result: { ok?: boolean; result?: T; error?: string };
        try {
          result = JSON.parse(stdout) as { ok?: boolean; result?: T; error?: string };
        } catch (failure) {
          reject(new Error(stderr.trim() || `MetaTrader 5 connector returned invalid JSON (exit code ${code ?? 'unknown'}).`, { cause: failure }));
          return;
        }
        if (!result.ok || result.result === undefined) {
          reject(new Error(result.error || stderr.trim() || 'MetaTrader 5 connector returned an invalid response.'));
          return;
        }
        if (code !== 0) {
          reject(new Error(stderr.trim() || `MetaTrader 5 connector exited with code ${code ?? 'unknown'}.`));
          return;
        }
        resolve(result.result);
      });
      child.stdin.end(JSON.stringify({ operation, ...payload }));
    });
  }
}
