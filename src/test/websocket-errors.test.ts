import assert from 'node:assert/strict';
import test from 'node:test';
import { isUnhandledWsHandshakeTimeout } from '../runtime/websocket-errors.js';

test('identifies only uncaught ws opening-handshake timeout errors', () => {
  const timeout = new Error('Opening handshake has timed out');
  timeout.stack = [
    'Error: Opening handshake has timed out',
    '    at ClientRequest.<anonymous> (C:\\workspace\\symbiote\\node_modules\\ws\\lib\\websocket.js:904:7)',
  ].join('\n');
  assert.equal(isUnhandledWsHandshakeTimeout(timeout), true);

  const unrelatedStack = new Error('Opening handshake has timed out');
  unrelatedStack.stack = 'Error: Opening handshake has timed out\n    at app.js:1:1';
  assert.equal(isUnhandledWsHandshakeTimeout(unrelatedStack), false);
  assert.equal(isUnhandledWsHandshakeTimeout(new Error('Connection reset')), false);
  assert.equal(isUnhandledWsHandshakeTimeout('Opening handshake has timed out'), false);
});
