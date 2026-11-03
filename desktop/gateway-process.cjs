const fs = require('node:fs');
const path = require('node:path');

async function stopLauncherManagedGateway({
  recordPath,
  gateway,
  isManagedProcess,
  stopProcess,
  isPortInUse,
  log,
  timeoutMs = 10_000,
}) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('The launcher-managed Gateway process record is missing; refusing to start a replacement blindly.');
    }
    throw new Error(`Could not read the launcher-managed Gateway process record: ${error.message}`);
  }

  if (record?.owner !== 'launcher'
    || !Number.isInteger(record.pid)
    || record.pid < 1
    || typeof record.daemonPath !== 'string'
    || typeof record.configPath !== 'string'
    || path.resolve(record.daemonPath) !== path.resolve(gateway.daemonPath)
    || path.resolve(record.configPath) !== path.resolve(gateway.configPath)) {
    throw new Error('The launcher-managed Gateway process record does not match the active Gateway; refusing to stop an unverified process.');
  }

  if (isManagedProcess(record.pid, gateway)) {
    log(`Stopping unresponsive launcher-managed Gateway pid=${record.pid}.`);
    await stopProcess(record.pid, gateway);
  }

  const deadline = Date.now() + timeoutMs;
  while (await isPortInUse(gateway)) {
    if (Date.now() >= deadline) {
      throw new Error(`The launcher-managed Gateway did not release port ${gateway.port}; no replacement process was started.`);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  try {
    const current = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    if (current?.owner === 'launcher' && current.pid === record.pid) {
      fs.rmSync(recordPath, { force: true });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Could not clear the stopped Gateway process record: ${error.message}`);
  }
  log(`Launcher-managed Gateway pid=${record.pid} stopped and port ${gateway.port} released.`);
}

module.exports = { stopLauncherManagedGateway };
