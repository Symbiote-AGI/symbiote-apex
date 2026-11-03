import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (Number(process.versions.node.split('.')[0]) < 20) {
  throw new Error(`Node.js 20 or newer is required to start Symbiote; found ${process.versions.node}.`);
}
const entry = path.join(root, 'dist', 'index.js');
const gatewayEntry = path.join(root, 'dist', 'gateway', 'daemon.js');
const desktopMain = path.join(root, 'desktop', 'main.cjs');
const buildFingerprintPath = path.join(root, 'dist', '.symbiote-build-fingerprint');
const sourceDirectories = [
  'src',
  path.join('webapp', 'src'),
  path.join('webapp', 'public'),
  'desktop',
  'assets',
];
const sourceFiles = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  path.join('webapp', 'package.json'),
  path.join('webapp', 'package-lock.json'),
  path.join('webapp', 'tsconfig.json'),
  path.join('webapp', 'vite.config.ts'),
  path.join('webapp', 'index.html'),
  path.join('scripts', 'clean-build.mjs'),
  path.join('scripts', 'copy-runtime-assets.mjs'),
];

function collectFiles(directory, files = []) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const itemPath = path.join(directory, item.name);
    if (item.isDirectory()) collectFiles(itemPath, files);
    else if (item.isFile()) files.push(itemPath);
  }
  return files;
}

function getBuildFingerprint() {
  const files = sourceFiles
    .filter(relativePath => fs.existsSync(path.join(root, relativePath)))
    .map(relativePath => path.join(root, relativePath));
  for (const directory of sourceDirectories) {
    const absolutePath = path.join(root, directory);
    if (fs.existsSync(absolutePath)) collectFiles(absolutePath, files);
  }

  const hash = crypto.createHash('sha256');
  for (const file of files.sort()) {
    hash.update(path.relative(root, file).replaceAll(path.sep, '/'));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function hasBuildOutputs() {
  const requiredFiles = [
    entry,
    path.join(root, 'dist', 'gateway', 'daemon.js'),
    path.join(root, 'webapp', 'dist', 'index.html'),
    path.join(root, 'dist', 'webapp', 'dist', 'index.html'),
    path.join(root, 'desktop', 'app-icon.ico'),
  ];
  return requiredFiles.every(file => fs.existsSync(file));
}

function stopPreviousInstances(excludeGateway = false) {
  if (process.platform !== 'win32') return;

  const script = path.join(root, 'scripts', 'windows', 'stop-symbiote.ps1');
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Root',
    root,
  ];
  if (excludeGateway) args.push('-ExcludeGateway');
  const result = spawnSync('powershell.exe', args, {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Could not stop all previous Symbiote desktop and Gateway processes.');
}

function hasInstalledGatewayService() {
  if (process.platform !== 'win32') return false;
  const result = spawnSync('sc.exe', ['query', 'SymbioteGateway'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (/SERVICE_NAME:\s*SymbioteGateway/i.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)) return true;
  if (result.status !== 0 && !/1060|does not exist as an installed service/i.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)) {
    throw new Error(`Could not inspect the SymbioteGateway service: ${result.stderr || result.stdout || result.status}`);
  }
  return false;
}

function getGatewayHealthTarget(configPath) {
  let config = {};
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  const port = Number(config.webPort ?? 3009);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid Gateway web port in ${configPath}: ${config.webPort}`);
  }
  const configuredHost = process.env.SYMBIOTE_WEB_HOST || config.webHost;
  const hosts = [];
  if (configuredHost && !['0.0.0.0', '::', '::0'].includes(configuredHost)) hosts.push(configuredHost);
  hosts.push('127.0.0.1');

  const workspace = path.resolve(path.dirname(configPath), config.workspace || '.');
  const tailscaleSettingsPath = path.join(workspace, '.session', 'tailscale-access.json');
  try {
    const settings = JSON.parse(fs.readFileSync(tailscaleSettingsPath, 'utf8'));
    if (settings?.version === 1 && settings.enabled === true) {
      const executables = [
        'tailscale.exe',
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'),
      ];
      for (const executable of executables) {
        const result = spawnSync(executable, ['status', '--json'], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 3_000,
          maxBuffer: 128 * 1024,
        });
        if (result.error?.code === 'ENOENT') continue;
        if (result.error) throw result.error;
        if (result.status === 0) {
          const status = JSON.parse(result.stdout);
          const address = status.Self?.TailscaleIPs?.find(value => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(value));
          if (address) hosts.unshift(address);
        }
        break;
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const urls = [...new Set(hosts)].map(host => {
    const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return `http://${formattedHost}:${port}/api/status`;
  });
  let accessToken = process.env.SYMBIOTE_WEB_TOKEN?.trim() ?? '';
  if (!accessToken) {
    try {
      const dotenv = createRequire(import.meta.url)('dotenv');
      accessToken = dotenv.parse(fs.readFileSync(path.join(path.dirname(configPath), '.env'), 'utf8')).SYMBIOTE_WEB_TOKEN?.trim() ?? '';
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Could not read the Gateway environment file: ${error.message}`);
    }
  }
  return {
    urls,
    tokenPath: path.join(workspace, '.session', 'web-access-token'),
    accessToken,
  };
}

async function waitForGateway(child, healthTarget) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Gateway exited before becoming ready (code ${child.exitCode}).`);
    let accessToken = healthTarget.accessToken;
    if (!accessToken) {
      try {
        accessToken = fs.readFileSync(healthTarget.tokenPath, 'utf8').trim();
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    for (const healthUrl of healthTarget.urls) {
      try {
        const response = await fetch(healthUrl, {
          headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) {
          const status = await response.json();
          if (status.pid === child.pid && status.startup?.state !== 'pending') return;
        } else {
          await response.arrayBuffer();
        }
      } catch (error) {
        if (error.name !== 'AbortError' && error.name !== 'TimeoutError' && error.cause?.code !== 'ECONNREFUSED') {
          throw error;
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Gateway did not become ready at ${healthTarget.urls.join(' or ')} within 30 seconds.`);
}

const installedGatewayService = hasInstalledGatewayService();
stopPreviousInstances(installedGatewayService);

const hasBuildSource = fs.existsSync(path.join(root, 'src', 'gateway', 'daemon.ts'))
  && fs.existsSync(path.join(root, 'tsconfig.json'));
const currentFingerprint = hasBuildSource ? getBuildFingerprint() : null;
let previousFingerprint = '';
try {
  previousFingerprint = fs.readFileSync(buildFingerprintPath, 'utf8').trim();
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const buildRequired = !hasBuildOutputs()
  || (currentFingerprint !== null && previousFingerprint !== currentFingerprint);
if (buildRequired && hasBuildSource) {
  const buildCommand = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
  const buildArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm run build'] : ['run', 'build'];
  const result = spawnSync(buildCommand, buildArgs, {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (!hasBuildOutputs()) throw new Error('The build completed without producing all required desktop runtime files.');
  fs.writeFileSync(buildFingerprintPath, `${currentFingerprint}\n`, 'utf8');
} else if (buildRequired) {
  throw new Error('The production build is missing and its source files are unavailable; restore the source before launching Symbiote.');
}

const launchLog = path.join(root, '.session', 'desktop-launch.log');
fs.mkdirSync(path.dirname(launchLog), { recursive: true });
const logFd = fs.openSync(launchLog, 'w');
const configPath = path.resolve(process.env.SYMBIOTE_CONFIG || path.join(root, 'symbiote.json'));
const gatewayProcessPath = path.join(root, '.session', 'desktop-gateway-process.json');
fs.rmSync(gatewayProcessPath, { force: true });

const electronExecutable = createRequire(import.meta.url)('electron');
let gatewayChild;
let child;
try {
  if (!installedGatewayService) {
    const gatewayLogFd = fs.openSync(path.join(root, '.session', 'gateway.log'), 'a');
    try {
      gatewayChild = spawn(process.execPath, [gatewayEntry, `--config=${configPath}`], {
        cwd: root,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', gatewayLogFd, gatewayLogFd],
        env: {
          ...process.env,
          SYMBIOTE_CONFIG: configPath,
        },
      });
      await new Promise((resolve, reject) => {
        gatewayChild.once('error', reject);
        gatewayChild.once('spawn', resolve);
      });
      gatewayChild.on('error', error => console.error('The prestarted Symbiote Gateway reported an error:', error));
      const temporaryPath = `${gatewayProcessPath}.${process.pid}.tmp`;
      fs.writeFileSync(temporaryPath, JSON.stringify({
        pid: gatewayChild.pid,
        daemonPath: gatewayEntry,
        configPath,
        owner: 'launcher',
      }), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporaryPath, gatewayProcessPath);
      await waitForGateway(gatewayChild, getGatewayHealthTarget(configPath));
      gatewayChild.unref();
      console.log(`Symbiote Gateway ready (PID ${gatewayChild.pid}); starting the optional desktop.`);
    } catch (error) {
      if (gatewayChild && gatewayChild.exitCode === null) gatewayChild.kill('SIGTERM');
      try {
        const record = JSON.parse(fs.readFileSync(gatewayProcessPath, 'utf8'));
        if (record.pid === gatewayChild?.pid) fs.rmSync(gatewayProcessPath, { force: true });
      } catch (recordError) {
        if (recordError.code !== 'ENOENT') throw recordError;
      }
      throw error;
    } finally {
      fs.closeSync(gatewayLogFd);
    }
  }

  child = spawn(electronExecutable, [desktopMain], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      SYMBIOTE_CONFIG: configPath,
      SYMBIOTE_GATEWAY_PROCESS_PATH: gatewayProcessPath,
      ...(hasBuildSource ? { SYMBIOTE_BUILD_READY: '1' } : {}),
    },
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', resolve);
  });
  child.unref();
} finally {
  fs.closeSync(logFd);
}
console.log(`Symbiote desktop launched (PID ${child.pid}). Gateway startup is monitored by the desktop. Diagnostics: ${path.relative(root, launchLog)}`);
