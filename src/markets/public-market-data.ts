export type MarketSymbol = 'BTC' | 'ETH' | 'SOL' | 'XAU' | 'XAG' | 'DXY' | 'VIX';
export type MarketInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export interface MarketBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface MarketHistory {
  symbol: MarketSymbol;
  interval: MarketInterval;
  bars: MarketBar[];
  source: string;
  updatedAt: string;
  note?: string;
}

const CRYPTO_PAIRS: Record<'BTC' | 'ETH' | 'SOL', string> = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
};

const ALLOWED_INTERVALS = new Set<MarketInterval>(['1m', '5m', '15m', '1h', '4h', '1d']);
const USD_BASKET = ['EUR', 'JPY', 'GBP', 'CAD', 'SEK', 'CHF'] as const;

export async function getPublicMarketHistory(
  rawSymbol: string,
  rawInterval: string,
  rawLimit: string | null,
): Promise<MarketHistory> {
  const symbol = rawSymbol.toUpperCase() as MarketSymbol;
  if (!['BTC', 'ETH', 'SOL', 'XAU', 'XAG', 'DXY', 'VIX'].includes(symbol)) {
    throw new Error('Unsupported market symbol.');
  }
  const interval = (ALLOWED_INTERVALS.has(rawInterval as MarketInterval) ? rawInterval : '1m') as MarketInterval;
  const requestedLimit = Number(rawLimit ?? 500);
  const limit = Number.isFinite(requestedLimit) ? Math.min(1_000, Math.max(1, Math.floor(requestedLimit))) : 500;

  if (symbol === 'BTC' || symbol === 'ETH' || symbol === 'SOL') {
    const pair = CRYPTO_PAIRS[symbol];
    const params = new URLSearchParams({ symbol: pair, interval, limit: String(limit) });
    const response = await fetch(`https://api.binance.com/api/v3/klines?${params}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`Crypto history provider returned ${response.status}.`);
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error('Crypto history provider returned an invalid response.');
    const bars = payload.flatMap((row): MarketBar[] => {
      if (!Array.isArray(row) || row.length < 5) return [];
      const time = Number(row[0]);
      const open = Number(row[1]);
      const high = Number(row[2]);
      const low = Number(row[3]);
      const close = Number(row[4]);
      return [time, open, high, low, close].every(Number.isFinite)
        ? [{ time: Math.floor(time / 1_000), open, high, low, close }]
        : [];
    });
    return { symbol, interval, bars, source: 'Binance public market data', updatedAt: new Date().toISOString() };
  }

  if (symbol === 'XAU' || symbol === 'XAG') {
    const response = await fetch(`https://api.gold-api.com/price/${symbol}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Metal quote provider returned ${response.status}.`);
    const payload = await response.json() as { price?: unknown; updatedAt?: unknown };
    if (typeof payload.price !== 'number' || !Number.isFinite(payload.price)) {
      throw new Error('Metal quote provider returned an invalid price.');
    }
    const updatedAt = typeof payload.updatedAt === 'string' ? payload.updatedAt : new Date().toISOString();
    const time = Math.floor(Date.parse(updatedAt) / 1_000);
    if (!Number.isFinite(time)) throw new Error('Metal quote provider returned an invalid timestamp.');
    return {
      symbol,
      interval,
      bars: [{ time, open: payload.price, high: payload.price, low: payload.price, close: payload.price }],
      source: 'Gold API public spot quote',
      updatedAt,
      note: 'Public spot quotes provide no historical candles; the chart accumulates live samples while open.',
    };
  }

  if (symbol === 'DXY') {
    const rates = await getUsdBasket();
    const value = calculateDollarIndex(rates);
    const time = Math.floor(Date.parse(rates.date) / 1_000);
    return {
      symbol,
      interval,
      bars: [{ time, open: value, high: value, low: value, close: value }],
      source: 'ECB reference rates via Frankfurter',
      updatedAt: new Date().toISOString(),
      note: 'Indicative daily basket estimate; it is not an exchange-traded DXY quote.',
    };
  }

  const response = await fetch('https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv', {
    headers: { accept: 'text/csv' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`CBOE VIX history returned ${response.status}.`);
  const csv = await response.text();
  const lines = csv.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error('CBOE VIX history contains no observations.');
  const headers = lines[0].split(',').map(value => value.trim().toLowerCase().replaceAll('"', ''));
  const dateIndex = headers.findIndex(value => value === 'date');
  const openIndex = headers.findIndex(value => value === 'vix open' || value === 'open');
  const highIndex = headers.findIndex(value => value === 'vix high' || value === 'high');
  const lowIndex = headers.findIndex(value => value === 'vix low' || value === 'low');
  const closeIndex = headers.findIndex(value => value === 'vix close' || value === 'close');
  if ([dateIndex, openIndex, highIndex, lowIndex, closeIndex].some(index => index < 0)) {
    throw new Error('CBOE VIX history format is not recognized.');
  }
  const bars = lines.slice(1).flatMap((line): MarketBar[] => {
    const columns = line.split(',').map(value => value.trim().replaceAll('"', ''));
    const date = columns[dateIndex];
    const [month, day, year] = (date ?? '').split('/');
    const time = Date.UTC(Number(year), Number(month) - 1, Number(day)) / 1_000;
    const open = Number(columns[openIndex]);
    const high = Number(columns[highIndex]);
    const low = Number(columns[lowIndex]);
    const close = Number(columns[closeIndex]);
    return Number.isFinite(time) && [open, high, low, close].every(Number.isFinite)
      ? [{ time, open, high, low, close }]
      : [];
  });
  return {
    symbol,
    interval: '1d',
    bars: bars.slice(-limit),
    source: 'CBOE daily VIX history',
    updatedAt: new Date().toISOString(),
    note: 'CBOE publishes this index as daily history; intraday VIX candles are not available from this public feed.',
  };
}

async function getUsdBasket(): Promise<{ date: string; rates: Record<string, number> }> {
  const url = new URL('https://api.frankfurter.app/latest');
  url.searchParams.set('from', 'USD');
  url.searchParams.set('to', USD_BASKET.join(','));
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`ECB currency reference provider returned ${response.status}.`);
  const payload = await response.json() as { date?: unknown; rates?: unknown };
  if (typeof payload.date !== 'string' || !payload.rates || typeof payload.rates !== 'object') {
    throw new Error('ECB currency reference provider returned an invalid response.');
  }
  const rates = payload.rates as Record<string, number>;
  if (USD_BASKET.some(currency => typeof rates[currency] !== 'number' || !Number.isFinite(rates[currency]) || rates[currency] <= 0)) {
    throw new Error('ECB currency reference provider omitted a required currency.');
  }
  return { date: payload.date, rates };
}

function calculateDollarIndex({ rates }: { date: string; rates: Record<string, number> }): number {
  return 50.14348112
    * rates.EUR ** 0.576
    * rates.JPY ** 0.136
    * rates.GBP ** 0.119
    * rates.CAD ** 0.091
    * rates.SEK ** 0.042
    * rates.CHF ** 0.036;
}
