const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { stopLauncherManagedGateway } = require('./gateway-process.cjs');

async function withRecord(record, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-gateway-'));
  const recordPath = path.join(directory, 'gateway-process.json');
  fs.writeFileSync(recordPath, JSON.stringify(record));
  try {
    await run(recordPath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const gateway = {
  daemonPath: path.resolve('dist/gateway/daemon.js'),
  configPath: path.resolve('symbiote.json'),
  port: 3009,
};

function launcherRecord() {
  return {
    owner: 'launcher',
    pid: 1234,
    daemonPath: gateway.daemonPath,
    configPath: gateway.configPath,
  };
}

test('stops a verified launcher Gateway before allowing recovery', async () => {
  await withRecord(launcherRecord(), async recordPath => {
    const stopped = [];
    const events = [];
    let portInUse = true;
    await stopLauncherManagedGateway({
      recordPath,
      gateway,
      isManagedProcess: pid => pid === 1234,
      stopProcess: async pid => {
        stopped.push(pid);
        portInUse = false;
      },
      isPortInUse: async () => portInUse,
      log: message => events.push(message),
    });

    assert.deepEqual(stopped, [1234]);
    assert.equal(fs.existsSync(recordPath), false);
    assert.match(events[0], /Stopping unresponsive launcher-managed Gateway pid=1234/);
    assert.match(events[1], /port 3009 released/);
  });
});

test('does not stop an unverified process or replace it while the port remains occupied', async () => {
  await withRecord(launcherRecord(), async recordPath => {
    const stopped = [];
    await assert.rejects(stopLauncherManagedGateway({
      recordPath,
      gateway,
      isManagedProcess: () => false,
      stopProcess: async pid => stopped.push(pid),
      isPortInUse: async () => true,
      log: () => {},
      timeoutMs: 1,
    }), /did not release port 3009/);

    assert.deepEqual(stopped, []);
    assert.equal(fs.existsSync(recordPath), true);
  });
});

test('refuses to stop a process record that does not match the Gateway config', async () => {
  await withRecord({ ...launcherRecord(), configPath: path.resolve('other.json') }, async recordPath => {
    let stopped = false;
    await assert.rejects(stopLauncherManagedGateway({
      recordPath,
      gateway,
      isManagedProcess: () => true,
      stopProcess: async () => { stopped = true; },
      isPortInUse: async () => false,
      log: () => {},
    }), /does not match the active Gateway/);

    assert.equal(stopped, false);
    assert.equal(fs.existsSync(recordPath), true);
  });
});
