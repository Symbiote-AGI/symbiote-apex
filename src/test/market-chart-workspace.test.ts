import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MarketChartWorkspaceStore } from '../markets/chart-workspace.js';
import { createMarketChartTool } from '../tools/builtin/market-chart.js';

async function withWorkspace(run: (workspace: string) => void | Promise<void>): Promise<void> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-market-chart-'));
  try {
    await run(workspace);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

test('market chart state persists indicators and drawings by symbol and interval', async () => {
  await withWorkspace(workspace => {
    const store = new MarketChartWorkspaceStore(workspace);
    const indicator = store.addIndicator('BTC', '1h', { kind: 'rsi', period: 14 });
    const drawing = store.addDrawing('BTC', '1h', {
      kind: 'trendline',
      points: [{ time: 1_700_000_000, price: 42_000 }, { time: 1_700_003_600, price: 43_000 }],
      label: 'Support trend',
    });

    const restored = new MarketChartWorkspaceStore(workspace);
    assert.deepEqual(restored.get('BTC', '1h').indicators, indicator.indicators);
    assert.deepEqual(restored.get('BTC', '1h').drawings, drawing.drawings);
    assert.equal(restored.get('BTC', '4h').drawings.length, 0);
  });
});

test('market chart state rejects invalid and duplicate entries', async () => {
  await withWorkspace(workspace => {
    const store = new MarketChartWorkspaceStore(workspace);
    store.addIndicator('XAU', '1d', { kind: 'sma', period: 20 });
    assert.throws(() => store.addIndicator('XAU', '1d', { kind: 'sma', period: 20 }), /already present/);
    assert.throws(() => store.addDrawing('XAU', '1d', {
      kind: 'trendline',
      points: [{ time: 100, price: 1 }, { time: 100, price: 2 }],
    }), /different timestamps/);
    assert.throws(() => store.get('USDGDP', '1d'), /symbol must be one of/);
  });
});

test('market chart management tool updates the same persistent workspace', async () => {
  await withWorkspace(async workspace => {
    const store = new MarketChartWorkspaceStore(workspace);
    const tool = createMarketChartTool(store);
    const result = await tool.execute({ action: 'add_indicator', symbol: 'ETH', interval: '15m', indicator: { kind: 'ema', period: 50 } });
    assert.match(result, /"kind": "ema"/);
    assert.equal(store.get('ETH', '15m').indicators[0].period, 50);
  });
});
