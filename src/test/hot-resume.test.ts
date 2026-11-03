import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HotResumeManager } from '../sessions/hot-resume.js';

function createManager(sessionsDir: string): HotResumeManager {
  return new HotResumeManager({
    sessionsDir,
    provider: 'test-provider',
    model: 'test-model',
    checkpointIntervalMs: 60 * 60 * 1000,
  });
}

test('hot-resume checkpoints persist atomically and are consumed on restore', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-hot-resume-'));
  const manager = createManager(directory);
  try {
    manager.trackSession({
      sessionId: 'session-one',
      channelType: 'webchat',
      adapterId: 'webchat',
      chatId: 'conversation-one',
      wasActive: true,
      provider: 'test-provider',
      model: 'test-model',
    });
    manager.save('checkpoint');

    const stateFile = path.join(directory, 'hot-state.json');
    assert.ok(fs.existsSync(stateFile));
    const restored = HotResumeManager.restore(directory);
    assert.equal(restored?.sessions[0]?.sessionId, 'session-one');
    assert.equal(fs.existsSync(stateFile), false);
  } finally {
    manager.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('forgetSession removes a deleted session from the persisted checkpoint', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-hot-resume-forget-'));
  const manager = createManager(directory);
  try {
    for (const sessionId of ['removed-session', 'kept-session']) {
      manager.trackSession({
        sessionId,
        channelType: 'discord',
        adapterId: 'discord-main',
        chatId: 'channel-one',
        wasActive: false,
        provider: 'test-provider',
        model: 'test-model',
      });
    }
    manager.save('checkpoint');

    assert.equal(manager.forgetSession('removed-session'), true);
    const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'hot-state.json'), 'utf8')) as {
      sessions: Array<{ sessionId: string }>;
    };
    assert.deepEqual(persisted.sessions.map(session => session.sessionId), ['kept-session']);
    assert.equal(manager.forgetSession('missing-session'), false);
  } finally {
    manager.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('invalid hot-resume state is reported and preserved for diagnosis', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-hot-resume-invalid-'));
  const stateFile = path.join(directory, 'hot-state.json');
  const originalError = console.error;
  const errors: string[] = [];
  try {
    fs.writeFileSync(stateFile, '{invalid');
    console.error = (...values: unknown[]) => errors.push(values.map(String).join(' '));

    assert.equal(HotResumeManager.restore(directory), null);
    assert.ok(errors.some(line => line.includes('Invalid state')));
    assert.equal(fs.readFileSync(stateFile, 'utf8'), '{invalid');
  } finally {
    console.error = originalError;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
