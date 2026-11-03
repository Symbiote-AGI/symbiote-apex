import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'dotenv';
import { CredentialVault } from '../security/credential-vault.js';
import { Mt5Bridge } from '../markets/mt5-bridge.js';

test('MetaTrader terminal path is validated, saved to the workspace environment, and passed through credential status', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-mt5-'));
  const envPath = path.join(workspace, '.env');
  const terminalPath = path.join(workspace, 'terminal64.exe');
  const vault = new CredentialVault({
    adminEnvPath: path.join(workspace, '.admin', '.env'),
    vaultPath: path.join(workspace, 'vault', 'integrations.enc'),
  });
  const bridge = new Mt5Bridge(vault, envPath);
  try {
    fs.writeFileSync(terminalPath, 'test executable');
    bridge.saveTerminalPath(terminalPath);
    bridge.save({ login: '12345678', password: 'test-password', server: 'Demo-Server' });

    assert.equal(bridge.status().terminalPath, terminalPath);
    assert.equal(bridge.status().configured, true);
    assert.equal(parse(fs.readFileSync(envPath, 'utf8')).MT5_TERMINAL_PATH, terminalPath);
    assert.equal(vault.get('mt5')?.terminalPath, terminalPath);
    assert.throws(() => bridge.saveTerminalPath(path.join(workspace, 'missing.exe')), /does not exist/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
