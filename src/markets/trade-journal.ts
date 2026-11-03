import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { VDBDocument } from '../memory/vdb.js';
import type { Mt5Deal, Mt5JournalSnapshot, Mt5Position } from './mt5-bridge.js';

export interface TradeJournalEntry {
  id: string;
  accountLogin?: number;
  accountServer?: string;
  ticket: number;
  positionId?: number;
  kind: 'position' | 'deal';
  status: 'open' | 'closed';
  symbol: string;
  side: string;
  entry?: string;
  volume: number;
  price: number;
  currentPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  profit: number;
  commission?: number;
  swap?: number;
  comment?: string;
  timestamp: number;
  updatedAt: number;
}

interface JournalSnapshot {
  version: 1;
  updatedAt: number;
  lastSyncedAt?: number;
  lastSyncedAtByAccount?: Record<string, number>;
  entries: TradeJournalEntry[];
}

export class TradeJournal {
  private readonly filename: string;
  private readonly syncStateFilename: string;
  private entriesById = new Map<string, TradeJournalEntry>();
  private lastSyncedAtByAccount = new Map<string, number>();
  private updatedAt = 0;
  private lastSyncedAt?: number;
  private loadError?: string;
  private journalCorrupt = false;
  private dirty = false;

  constructor(workspace: string) {
    this.filename = path.resolve(workspace, '.symbiote', 'trades', 'journal.json');
    this.syncStateFilename = path.resolve(workspace, '.symbiote', 'trades', 'sync-state.json');
    this.load();
  }

  historyFromTimestamp(now = Date.now(), accountKey = 'default'): number {
    return Math.max(0, Math.floor(((this.lastSyncedAtByAccount.get(accountKey) ?? now - 365 * 24 * 60 * 60 * 1_000) - 5 * 60_000) / 1_000));
  }

  sync(
    positions: Mt5Position[],
    deals: Mt5Deal[],
    syncedAt = Date.now(),
    account?: Mt5JournalSnapshot['account'],
  ): { entries: number; changed: number } {
    if (this.journalCorrupt) throw new Error('The saved MT5 journal is invalid; refusing to overwrite the existing journal file.');
    const accountKey = account ? `${account.server.toLocaleLowerCase('en-US')}:${account.login}` : 'default';
    const accountId = crypto.createHash('sha256').update(accountKey).digest('hex').slice(0, 16);
    const incoming = new Map<string, TradeJournalEntry>();
    for (const position of positions) {
      const id = `mt5:${accountId}:position:${position.ticket}`;
      incoming.set(id, {
        id,
        ...(account ? { accountLogin: account.login, accountServer: account.server } : {}),
        ticket: position.ticket,
        kind: 'position',
        status: 'open',
        symbol: position.symbol,
        side: position.type,
        volume: position.volume,
        price: position.price_open,
        currentPrice: position.price_current,
        stopLoss: position.sl,
        takeProfit: position.tp,
        profit: position.profit,
        timestamp: syncedAt,
        updatedAt: syncedAt,
      });
    }
    for (const deal of deals) {
      const id = `mt5:${accountId}:deal:${deal.ticket}`;
      incoming.set(id, {
        id,
        ...(account ? { accountLogin: account.login, accountServer: account.server } : {}),
        ticket: deal.ticket,
        positionId: deal.positionId,
        kind: 'deal',
        status: deal.entry === 'in' ? 'open' : 'closed',
        symbol: deal.symbol,
        side: deal.type,
        entry: deal.entry,
        volume: deal.volume,
        price: deal.price,
        profit: deal.profit,
        commission: deal.commission,
        swap: deal.swap,
        comment: deal.comment,
        timestamp: deal.time * 1_000,
        updatedAt: syncedAt,
      });
    }

    let changed = 0;
    for (const [id, entry] of incoming) {
      const previous = this.entriesById.get(id);
      const candidate = previous && entry.kind === 'position' ? { ...entry, timestamp: previous.timestamp } : entry;
      const comparable = (value: TradeJournalEntry) => JSON.stringify({ ...value, updatedAt: 0 });
      if (previous && comparable(previous) === comparable(candidate)) {
        this.entriesById.set(id, previous);
      } else {
        changed++;
        this.dirty = true;
        this.entriesById.set(id, { ...candidate, updatedAt: syncedAt });
      }
    }
    const openPositionIds = new Set(positions.map(position => position.ticket));
    for (const [id, entry] of this.entriesById) {
      if (entry.accountServer === account?.server
        && entry.accountLogin === account?.login
        && entry.kind === 'position'
        && entry.status === 'open'
        && !openPositionIds.has(entry.ticket)) {
        this.entriesById.set(id, { ...entry, status: 'closed', updatedAt: syncedAt });
        changed++;
        this.dirty = true;
      }
    }
    this.lastSyncedAtByAccount.set(accountKey, syncedAt);
    this.lastSyncedAt = syncedAt;
    if (this.dirty || !fs.existsSync(this.filename)) {
      this.updatedAt = syncedAt;
      this.persist();
      this.dirty = false;
    }
    this.persistSyncState();
    this.loadError = undefined;
    return { entries: this.entriesById.size, changed };
  }

  snapshot(limit = 1_000): { updatedAt: number; lastSyncedAt?: number; entries: TradeJournalEntry[]; error?: string } {
    const boundedLimit = Math.min(5_000, Math.max(1, Math.floor(limit) || 1_000));
    return {
      updatedAt: this.updatedAt,
      ...(this.lastSyncedAt ? { lastSyncedAt: this.lastSyncedAt } : {}),
      entries: [...this.entriesById.values()]
        .sort((left, right) => right.timestamp - left.timestamp || right.ticket - left.ticket)
        .slice(0, boundedLimit),
      ...(this.loadError ? { error: this.loadError } : {}),
    };
  }

  vectorDocuments(): VDBDocument[] {
    return [...this.entriesById.values()].map(entry => ({
      id: entry.id,
      text: [
        `MetaTrader 5 ${entry.kind} ${entry.status}`,
        `Symbol: ${entry.symbol}`,
        `Side: ${entry.side}`,
        `Volume: ${entry.volume}`,
        `Price: ${entry.price}`,
        `Profit: ${entry.profit}`,
        entry.comment ? `Comment: ${entry.comment}` : '',
      ].filter(Boolean).join('\n'),
      source: 'trade-journal',
      role: 'memory',
      timestamp: entry.timestamp,
      namespace: 'trade-journal:mt5',
      metadata: {
        ticket: String(entry.ticket),
        kind: entry.kind,
        status: entry.status,
        symbol: entry.symbol,
        side: entry.side,
        ...(entry.positionId ? { positionId: String(entry.positionId) } : {}),
      },
    }));
  }

  private load(): void {
    let contents: string;
    try {
      contents = fs.readFileSync(this.filename, 'utf8');
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(`Could not read the MetaTrader trade journal at ${this.filename}.`, { cause: failure });
    }
    try {
      const snapshot = JSON.parse(contents) as Partial<JournalSnapshot>;
      if (snapshot.version !== 1 || !Array.isArray(snapshot.entries)) throw new Error('Unsupported or invalid journal format.');
      for (const entry of snapshot.entries) {
        if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || typeof entry.ticket !== 'number') {
          throw new Error('The trade journal contains an invalid entry.');
        }
        this.entriesById.set(entry.id, entry);
      }
      this.updatedAt = typeof snapshot.updatedAt === 'number' ? snapshot.updatedAt : 0;
      this.lastSyncedAt = typeof snapshot.lastSyncedAt === 'number' ? snapshot.lastSyncedAt : undefined;
      if (snapshot.lastSyncedAtByAccount && typeof snapshot.lastSyncedAtByAccount === 'object') {
        for (const [accountKey, timestamp] of Object.entries(snapshot.lastSyncedAtByAccount)) {
          if (typeof timestamp === 'number' && Number.isFinite(timestamp)) this.lastSyncedAtByAccount.set(accountKey, timestamp);
        }
      }
      if (this.lastSyncedAtByAccount.size === 0 && this.lastSyncedAt !== undefined) {
        this.lastSyncedAtByAccount.set('default', this.lastSyncedAt);
      }
    } catch (failure) {
      this.loadError = failure instanceof Error ? failure.message : String(failure);
      this.journalCorrupt = true;
      console.error(`[trade-journal] Could not restore journal; the existing file was preserved: ${this.loadError}`);
    }
    try {
      const state = JSON.parse(fs.readFileSync(this.syncStateFilename, 'utf8')) as {
        lastSyncedAt?: unknown;
        lastSyncedAtByAccount?: unknown;
      };
      if (typeof state.lastSyncedAt === 'number' && Number.isFinite(state.lastSyncedAt)) this.lastSyncedAt = state.lastSyncedAt;
      if (state.lastSyncedAtByAccount && typeof state.lastSyncedAtByAccount === 'object' && !Array.isArray(state.lastSyncedAtByAccount)) {
        for (const [accountKey, timestamp] of Object.entries(state.lastSyncedAtByAccount)) {
          if (typeof timestamp === 'number' && Number.isFinite(timestamp)) this.lastSyncedAtByAccount.set(accountKey, timestamp);
        }
      } else if (typeof state.lastSyncedAt === 'number' && Number.isFinite(state.lastSyncedAt)) {
        this.lastSyncedAtByAccount.set('default', state.lastSyncedAt);
      }
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.loadError = `Could not restore trade-journal sync state: ${failure instanceof Error ? failure.message : String(failure)}`;
        console.error(`[trade-journal] ${this.loadError}`);
      }
    }
  }

  private persist(): void {
    const snapshot: JournalSnapshot = {
      version: 1,
      updatedAt: this.updatedAt,
      ...(this.lastSyncedAt ? { lastSyncedAt: this.lastSyncedAt } : {}),
      lastSyncedAtByAccount: Object.fromEntries(this.lastSyncedAtByAccount),
      entries: [...this.entriesById.values()],
    };
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, this.filename);
    } catch (failure) {
      throw new Error(`Could not persist the MetaTrader trade journal at ${this.filename}.`, { cause: failure });
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  private persistSyncState(): void {
    const temporary = `${this.syncStateFilename}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.mkdirSync(path.dirname(this.syncStateFilename), { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(temporary, `${JSON.stringify({
        lastSyncedAt: this.lastSyncedAt,
        lastSyncedAtByAccount: Object.fromEntries(this.lastSyncedAtByAccount),
      })}\n`, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, this.syncStateFilename);
    } catch (failure) {
      throw new Error(`Could not persist MetaTrader trade-journal sync state at ${this.syncStateFilename}.`, { cause: failure });
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}
