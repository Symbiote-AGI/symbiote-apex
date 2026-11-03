import assert from 'node:assert/strict';
import test from 'node:test';
import { getPublicMarketHistory } from '../markets/public-market-data.js';

test('crypto history parses and normalizes exchange candle timestamps', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([
    [1_700_000_000_000, '100', '110', '95', '108'],
  ]), { status: 200 });

  try {
    const history = await getPublicMarketHistory('btc', '5m', '1');
    assert.equal(history.symbol, 'BTC');
    assert.equal(history.interval, '5m');
    assert.deepEqual(history.bars, [{ time: 1_700_000_000, open: 100, high: 110, low: 95, close: 108 }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('metal and reference-rate endpoints expose keyless quotes with accurate provenance', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes('gold-api.com')) {
      return new Response(JSON.stringify({ price: 2_500, updatedAt: '2026-04-10T12:00:00.000Z' }), { status: 200 });
    }
    return new Response(JSON.stringify({
      date: '2026-04-10',
      rates: { EUR: 0.92, JPY: 152, GBP: 0.78, CAD: 1.42, SEK: 10.1, CHF: 0.88 },
    }), { status: 200 });
  };

  try {
    const gold = await getPublicMarketHistory('XAU', '1m', '1');
    assert.equal(gold.bars[0]?.close, 2_500);
    assert.match(gold.note ?? '', /no historical candles/i);

    const dollarIndex = await getPublicMarketHistory('DXY', '1d', '1');
    assert.equal(dollarIndex.bars.length, 1);
    assert.match(dollarIndex.source, /Frankfurter/);
    assert.match(dollarIndex.note ?? '', /not an exchange-traded DXY quote/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('CBOE history is parsed as daily bars and unsupported symbols are rejected', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response([
    'DATE,OPEN,HIGH,LOW,CLOSE',
    '04/09/2026,20.1,21.2,19.5,20.7',
    '04/10/2026,20.7,22.0,20.0,21.4',
  ].join('\n'), { status: 200, headers: { 'content-type': 'text/csv' } });

  try {
    const history = await getPublicMarketHistory('VIX', '1m', '1');
    assert.equal(history.interval, '1d');
    assert.equal(history.bars.length, 1);
    assert.equal(history.bars[0]?.close, 21.4);
    await assert.rejects(getPublicMarketHistory('GDP', '1d', '10'), /Unsupported market symbol/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
