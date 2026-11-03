import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TradeJournal } from '../markets/trade-journal.js';

test('MT5 trade journal persists positions and deals and exposes indexed memory documents', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-trade-journal-'));
  const now = 1_800_000_000_000;
  const journal = new TradeJournal(workspace);
  try {
    const result = journal.sync([{
      ticket: 90,
      symbol: 'XAUUSD',
      type: 'buy',
      volume: 0.1,
      price_open: 2_300,
      price_current: 2_310,
      sl: 2_280,
      tp: 2_350,
      profit: 1,
    }], [{
      ticket: 120,
      order: 90,
      positionId: 90,
      time: Math.floor(now / 1_000) - 60,
      symbol: 'XAUUSD',
      type: 'buy',
      entry: 'in',
      volume: 0.1,
      price: 2_300,
      profit: 0,
      commission: -0.5,
      swap: 0,
      comment: 'entry',
    }], now, { login: 1001, server: 'Demo-Server' });

    assert.equal(result.entries, 2);
    assert.equal(journal.historyFromTimestamp(now + 60_000, 'demo-server:1001'), Math.floor((now - 5 * 60_000) / 1_000));
    assert.equal(journal.vectorDocuments().length, 2);
    assert.equal(journal.vectorDocuments()[0].namespace, 'trade-journal:mt5');

    journal.sync([], [], now + 60_000, { login: 1001, server: 'Demo-Server' });
    const restored = new TradeJournal(workspace).snapshot();
    assert.equal(restored.entries.length, 2);
    assert.equal(restored.entries.find(entry => entry.kind === 'position')?.status, 'closed');
    assert.equal(restored.entries.find(entry => entry.kind === 'deal')?.ticket, 120);
    assert.equal(restored.lastSyncedAt, now + 60_000);

    const otherAccount = new TradeJournal(workspace);
    otherAccount.sync([{
      ticket: 90,
      symbol: 'XAUUSD',
      type: 'buy',
      volume: 0.1,
      price_open: 2_300,
      price_current: 2_310,
      sl: 2_280,
      tp: 2_350,
      profit: 1,
    }], [], now + 120_000, { login: 2002, server: 'Demo-Server' });
    const combined = otherAccount.snapshot();
    assert.equal(combined.entries.filter(entry => entry.kind === 'position').length, 2);
    assert.equal(combined.entries.filter(entry => entry.kind === 'position' && entry.status === 'closed').length, 1);
    assert.equal(
      otherAccount.historyFromTimestamp(now + 120_000, 'demo-server:2002'),
      Math.floor((now + 120_000 - 5 * 60_000) / 1_000),
    );
    assert.equal(
      otherAccount.historyFromTimestamp(now + 120_000, 'demo-server:1001'),
      Math.floor((now + 60_000 - 5 * 60_000) / 1_000),
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
