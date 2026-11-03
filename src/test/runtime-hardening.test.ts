import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SessionManager } from '../sessions/manager.js';
import { MessageQueue, type QueuedMessage } from '../sessions/queue.js';
import { HotResumeManager } from '../sessions/hot-resume.js';
import { ProcessManager } from '../tools/builtin/process.js';

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-runtime-hardening-'));
}

async function waitForQueueIdle(queue: MessageQueue, sessionIds: string[], timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (sessionIds.every(sessionId => !queue.isBusy(sessionId) && queue.depth(sessionId) === 0)) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`Message queues did not become idle: ${sessionIds.join(', ')}`);
}

function message(sessionId: string, id: string, content = id): QueuedMessage {
  return {
    id,
    sessionId,
    content,
    sender: 'owner',
    channelId: `channel-${sessionId}`,
    timestamp: Date.now(),
  };
}

test('session messages survive a process-style manager reconstruction', () => {
  const directory = temporaryDirectory();
  try {
    const firstManager = new SessionManager(directory);
    const session = firstManager.create('crash-recovery', {
      label: 'Crash recovery',
      provider: 'test-provider',
      model: 'test-model',
    });
    session.messages.push(
      { role: 'user', content: 'Preserve this request.' },
      { role: 'assistant', content: 'The request was saved before shutdown.' },
    );
    firstManager.save(session);

    const recovered = new SessionManager(directory).load('crash-recovery');
    assert.ok(recovered);
    assert.deepEqual(recovered.messages.map(item => item.content), [
      'Preserve this request.',
      'The request was saved before shutdown.',
    ]);
    assert.equal(recovered.metadata.label, 'Crash recovery');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('messages enqueued before handler registration remain queued instead of disappearing', async () => {
  const queue = new MessageQueue();
  const originalError = console.error;
  const errors: string[] = [];
  const processed: string[] = [];
  try {
    console.error = (...values: unknown[]) => errors.push(values.map(String).join(' '));
    assert.equal(queue.enqueue(message('late-handler', 'retained')), 1);
    assert.equal(queue.isBusy('late-handler'), false);
    queue.registerHandler('late-handler', async item => {
      processed.push(item.id);
    });
    await waitForQueueIdle(queue, ['late-handler']);
    assert.deepEqual(processed, ['retained']);
    assert.ok(errors.some(line => line.includes('no default handler')));
  } finally {
    console.error = originalError;
  }
});

test('failed queue handlers do not block later messages and can be retried', async () => {
  const queue = new MessageQueue();
  const processed: string[] = [];
  const originalError = console.error;
  const errors: string[] = [];
  let attempts = 0;
  try {
    console.error = (...values: unknown[]) => errors.push(values.map(String).join(' '));
    queue.registerHandler('session-retry', async item => {
      if (item.id === 'interrupted' && attempts++ === 0) throw new Error('simulated interruption');
      processed.push(item.id);
    });

    queue.enqueue(message('session-retry', 'interrupted'));
    queue.enqueue(message('session-retry', 'after-interruption'));
    await waitForQueueIdle(queue, ['session-retry']);

    assert.deepEqual(processed, ['after-interruption']);
    assert.ok(errors.some(line => line.includes('simulated interruption')));
    queue.enqueue(message('session-retry', 'interrupted'));
    await waitForQueueIdle(queue, ['session-retry']);
    assert.deepEqual(processed, ['after-interruption', 'interrupted']);
  } finally {
    console.error = originalError;
  }
});

test('duplicate message IDs are processed once while distinct sessions run concurrently', async () => {
  const queue = new MessageQueue();
  const processed: string[] = [];
  let releaseFirst!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
  queue.registerHandler('session-a', async item => {
    if (item.id === 'same-request') {
      markStarted();
      await gate;
    }
    processed.push(`${item.sessionId}:${item.id}`);
  });
  queue.enqueue(message('session-a', 'same-request'));
  await started;
  assert.equal(queue.enqueue(message('session-a', 'same-request')), 0);
  releaseFirst();
  await waitForQueueIdle(queue, ['session-a']);
  assert.equal(queue.enqueue(message('session-a', 'same-request')), 0);
  await waitForQueueIdle(queue, ['session-a']);
  assert.deepEqual(processed, ['session-a:same-request']);

  let concurrent = 0;
  let maxConcurrent = 0;
  const completionOrder: string[] = [];
  for (const sessionId of ['parallel-a', 'parallel-b']) {
    queue.registerHandler(sessionId, async item => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(resolve => setTimeout(resolve, 20));
      completionOrder.push(`${item.sessionId}:${item.id}`);
      concurrent--;
    });
  }
  queue.enqueue(message('parallel-a', 'first'));
  queue.enqueue(message('parallel-a', 'second'));
  queue.enqueue(message('parallel-b', 'independent'));
  await waitForQueueIdle(queue, ['parallel-a', 'parallel-b']);
  assert.ok(maxConcurrent >= 2);
  assert.ok(completionOrder.indexOf('parallel-a:first') < completionOrder.indexOf('parallel-a:second'));
});

test('hot-resume state is atomically saved and restored after interruption', () => {
  const directory = temporaryDirectory();
  const hotResume = new HotResumeManager({
    sessionsDir: directory,
    provider: 'test-provider',
    model: 'test-model',
    checkpointIntervalMs: 60 * 60 * 1000,
  });
  try {
    hotResume.trackSession({
      sessionId: 'interrupted-turn',
      channelType: 'webchat',
      adapterId: 'webchat',
      chatId: 'conversation',
      wasActive: true,
      provider: 'test-provider',
      model: 'test-model',
    });
    hotResume.save('checkpoint');
    const restored = HotResumeManager.restore(directory);
    assert.equal(restored?.sessions[0]?.sessionId, 'interrupted-turn');
    assert.equal(restored?.sessions[0]?.wasActive, true);
    assert.equal(fs.existsSync(path.join(directory, 'hot-state.json')), false);
  } finally {
    hotResume.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('process cleanup terminates all child processes owned by an interrupted session', async () => {
  const directory = temporaryDirectory();
  const manager = new ProcessManager();
  const command = process.platform === 'win32'
    ? `"${process.execPath}" -e "setInterval(() => {}, 1000)"`
    : `exec "${process.execPath}" -e 'setInterval(() => {}, 1000)'`;
  const shell = process.platform === 'win32' ? 'cmd' : 'bash';
  let managed: ReturnType<ProcessManager['start']> | undefined;
  try {
    managed = manager.start(command, directory, 'interrupted-session', shell);
    assert.ok(managed.pid > 0);
    const closed = once(managed.proc, 'close');
    assert.equal(manager.killSession('interrupted-session'), 1);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Child process did not exit after session cleanup.')), 5_000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    assert.equal(manager.list('interrupted-session')[0]?.running, false);
    assert.equal(manager.cleanup(-1), 1);
    assert.deepEqual(manager.list('interrupted-session'), []);
  } finally {
    if (managed && managed.exitCode === null) manager.kill(managed.id, 'interrupted-session');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('session persistence rejects corrupted data without replacing it', () => {
  const directory = temporaryDirectory();
  const filename = path.join(directory, 'corrupted-session.json');
  try {
    fs.writeFileSync(filename, '{invalid-session-state');
    const manager = new SessionManager(directory);
    assert.throws(() => manager.load('corrupted-session'), /Failed to load session corrupted-session/);
    assert.equal(fs.readFileSync(filename, 'utf8'), '{invalid-session-state');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
