import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BinanceBridge } from '../markets/binance-bridge.js';
import { CredentialVault } from '../security/credential-vault.js';

test('Binance credentials are encrypted and connection tests read account permissions plus a public tick', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-binance-'));
  const vault = new CredentialVault({
    adminEnvPath: path.join(workspace, '.admin', '.env'),
    vaultPath: path.join(workspace, 'vault', 'integrations.enc'),
  });
  const bridge = new BinanceBridge(vault);
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  try {
    bridge.save({ apiKey: 'test-api-key', apiSecret: 'test-api-secret' });
    assert.deepEqual(bridge.status(), { configured: true });
    const storedVault = fs.readFileSync(path.join(workspace, 'vault', 'integrations.enc'), 'utf8');
    assert.equal(storedVault.includes('test-api-secret'), false);

    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push({ url, init });
      return url.pathname.endsWith('/account')
        ? new Response(JSON.stringify({ accountType: 'SPOT', canTrade: true }), { status: 200 })
        : new Response(JSON.stringify({ bidPrice: '67000.12', askPrice: '67000.14' }), { status: 200 });
    };
    const result = await bridge.testConnection();
    assert.equal(result.connected, true);
    assert.equal(result.accountType, 'SPOT');
    assert.equal(result.canTrade, true);
    assert.deepEqual({ bid: result.tick.bid, ask: result.tick.ask }, { bid: 67000.12, ask: 67000.14 });
    assert.equal(requests.length, 2);
    const signedRequest = requests.find(request => request.url.pathname.endsWith('/account'));
    assert.ok(signedRequest?.url.searchParams.get('signature')?.match(/^[a-f0-9]{64}$/));
    assert.equal(new Headers(signedRequest?.init?.headers).get('X-MBX-APIKEY'), 'test-api-key');

    await assert.rejects(bridge.placeMarketOrder({ symbol: 'BTCUSDT', side: 'buy', quantity: Number.NaN }), /Quantity/);
    assert.equal(requests.length, 2);
    bridge.delete();
    assert.deepEqual(bridge.status(), { configured: false });
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
