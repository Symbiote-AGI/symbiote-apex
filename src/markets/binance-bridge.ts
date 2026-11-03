import { createHmac } from 'node:crypto';
import type { CredentialVault } from '../security/credential-vault.js';

const API_ORIGIN = 'https://api.binance.com';
const MAX_ORDER_QUANTITY = 1_000_000;

export interface BinanceCredentials {
  apiKey: string;
  apiSecret: string;
}

export interface BinanceMarketOrder {
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
}

export interface BinanceConnectionResult {
  connected: true;
  accountType: string;
  canTrade: boolean;
  latencyMs: number;
  tick: { symbol: string; bid: number; ask: number; time: number };
}

export class BinanceBridge {
  constructor(private readonly vault: CredentialVault) {}

  status(): { configured: boolean } {
    return { configured: this.credentials() !== null };
  }

  save(input: unknown): void {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Binance credentials must be an object.');
    const body = input as Record<string, unknown>;
    for (const field of ['apiKey', 'apiSecret']) {
      if (field in body && typeof body[field] !== 'string') throw new Error(`${field} must be a string.`);
    }
    const current = this.vault.get('binance') ?? {};
    const apiKey = typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : current.apiKey ?? process.env.BINANCE_API_KEY ?? '';
    const apiSecret = typeof body.apiSecret === 'string' && body.apiSecret ? body.apiSecret : current.apiSecret ?? process.env.BINANCE_API_SECRET ?? '';
    if (!apiKey || apiKey.length > 256 || /[\r\n]/.test(apiKey)) throw new Error('A valid Binance API key is required.');
    if (!apiSecret || apiSecret.length > 512 || /[\r\n]/.test(apiSecret)) throw new Error('A valid Binance API secret is required.');
    this.vault.set('binance', { apiKey, apiSecret });
  }

  delete(): void {
    this.vault.delete('binance');
  }

  async testConnection(): Promise<BinanceConnectionResult> {
    const credentials = this.requireCredentials();
    const started = Date.now();
    const [account, ticker] = await Promise.all([
      this.signedRequest('/api/v3/account', 'GET', credentials),
      this.publicTicker('BTCUSDT'),
    ]);
    const latencyMs = Date.now() - started;
    if (typeof account.accountType !== 'string' || typeof account.canTrade !== 'boolean') {
      throw new Error('Binance returned an invalid account capability response.');
    }
    return {
      connected: true,
      accountType: account.accountType,
      canTrade: account.canTrade,
      latencyMs,
      tick: { symbol: 'BTCUSDT', bid: ticker.bid, ask: ticker.ask, time: Date.now() },
    };
  }

  async placeMarketOrder(order: BinanceMarketOrder): Promise<{
    symbol: string;
    orderId: number;
    status: string;
    executedQty: number;
    quoteQty: number;
    averagePrice: number | null;
  }> {
    if (!/^[A-Z0-9]{5,20}$/.test(order.symbol)) throw new Error('Binance symbol must be an uppercase alphanumeric trading pair.');
    if (order.side !== 'buy' && order.side !== 'sell') throw new Error('Order side must be buy or sell.');
    if (!Number.isFinite(order.quantity) || order.quantity <= 0 || order.quantity > MAX_ORDER_QUANTITY) {
      throw new Error(`Quantity must be greater than zero and at most ${MAX_ORDER_QUANTITY}.`);
    }
    const result = await this.signedRequest('/api/v3/order', 'POST', this.requireCredentials(), {
      symbol: order.symbol,
      side: order.side.toUpperCase(),
      type: 'MARKET',
      quantity: String(order.quantity),
    });
    const orderId = Number(result.orderId);
    const executedQty = Number(result.executedQty);
    const quoteQty = Number(result.cummulativeQuoteQty);
    if (!Number.isSafeInteger(orderId) || typeof result.status !== 'string'
      || !Number.isFinite(executedQty) || !Number.isFinite(quoteQty)) {
      throw new Error('Binance returned an invalid market-order response.');
    }
    return {
      symbol: order.symbol,
      orderId,
      status: result.status,
      executedQty,
      quoteQty,
      averagePrice: executedQty > 0 ? quoteQty / executedQty : null,
    };
  }

  private credentials(): BinanceCredentials | null {
    const stored = this.vault.get('binance');
    const apiKey = stored?.apiKey ?? process.env.BINANCE_API_KEY ?? '';
    const apiSecret = stored?.apiSecret ?? process.env.BINANCE_API_SECRET ?? '';
    return apiKey.trim() && apiSecret ? { apiKey: apiKey.trim(), apiSecret } : null;
  }

  private requireCredentials(): BinanceCredentials {
    const credentials = this.credentials();
    if (!credentials) throw new Error('Configure Binance API key and secret in Integrations before using the exchange.');
    return credentials;
  }

  private async publicTicker(symbol: string): Promise<{ bid: number; ask: number }> {
    const url = new URL('/api/v3/ticker/bookTicker', API_ORIGIN);
    url.searchParams.set('symbol', symbol);
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Binance public tick request failed (${response.status}).`);
    const value = payload as { bidPrice?: unknown; askPrice?: unknown } | null;
    const bid = Number(value?.bidPrice);
    const ask = Number(value?.askPrice);
    if (!Number.isFinite(bid) || bid <= 0 || !Number.isFinite(ask) || ask <= 0) {
      throw new Error('Binance returned an invalid bid/ask tick.');
    }
    return { bid, ask };
  }

  private async signedRequest(
    endpoint: string,
    method: 'GET' | 'POST',
    credentials: BinanceCredentials,
    parameters: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({
      ...parameters,
      timestamp: String(Date.now()),
      recvWindow: '5000',
    });
    const signature = createHmac('sha256', credentials.apiSecret).update(query.toString()).digest('hex');
    const url = new URL(endpoint, API_ORIGIN);
    url.search = `${query.toString()}&signature=${signature}`;
    const response = await fetch(url, {
      method,
      headers: { 'X-MBX-APIKEY': credentials.apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = payload && typeof payload === 'object' ? payload as { msg?: unknown; code?: unknown } : {};
      const detail = typeof error.msg === 'string' ? error.msg : `HTTP ${response.status}`;
      throw new Error(`Binance API request failed${typeof error.code === 'number' ? ` (${error.code})` : ''}: ${detail}`);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Binance returned an invalid API response.');
    }
    return payload as Record<string, unknown>;
  }
}
