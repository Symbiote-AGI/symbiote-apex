import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { WebServerSupervisor, type RecoverableWebServer } from '../web/server-supervisor.js';

class FakeServer extends EventEmitter implements RecoverableWebServer {
  listening = false;

  close(callback?: (error?: Error) => void): this {
    this.listening = false;
    this.emit('close');
    callback?.();
    return this;
  }

  startListening(): void {
    this.listening = true;
    this.emit('listening');
  }

  crash(): void {
    this.listening = false;
    this.emit('close');
  }

  fail(error: Error): void {
    this.emit('error', error);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('web server supervisor restarts unexpected closes and stops cleanly', async () => {
  const servers: FakeServer[] = [];
  const issues: string[] = [];
  const supervisor = new WebServerSupervisor(
    () => {
      const server = new FakeServer();
      servers.push(server);
      return server;
    },
    message => issues.push(message),
    { retryBaseMs: 5, retryMaxMs: 10 },
  );

  supervisor.start();
  assert.equal(servers.length, 1);
  servers[0].startListening();
  servers[0].crash();
  await wait(15);

  assert.equal(servers.length, 2);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /closed unexpectedly/);

  servers[1].startListening();
  supervisor.stop();
  await wait(15);
  assert.equal(servers.length, 2);
  assert.equal(servers[1].listening, false);
});

test('web server supervisor retries bind errors with capped backoff and reports one incident per outage', async () => {
  const servers: FakeServer[] = [];
  const issues: string[] = [];
  const supervisor = new WebServerSupervisor(
    () => {
      const server = new FakeServer();
      servers.push(server);
      return server;
    },
    message => issues.push(message),
    { retryBaseMs: 5, retryMaxMs: 10 },
  );

  supervisor.start();
  servers[0].fail(new Error('port is already in use'));
  await wait(15);
  assert.equal(servers.length, 2);
  servers[1].fail(new Error('port is still in use'));
  await wait(15);
  assert.equal(servers.length, 3);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /port is already in use/);

  servers[2].startListening();
  servers[2].crash();
  await wait(15);
  assert.equal(servers.length, 4);
  assert.equal(issues.length, 2);
  supervisor.stop();
});
