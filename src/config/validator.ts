// Symbiote — Config Validation

import fs from 'node:fs';
import path from 'node:path';
import type { SymbioteConfig } from './config.js';

export interface ValidationError {
  field: string;
  message: string;
  suggestion?: string;
  severity: 'error' | 'warning';
}

function isLoopbackHost(host?: string): boolean {
  if (!host) return true;
  return ['127.0.0.1', 'localhost', '::1'].includes(host);
}

function validPort(port: number | undefined): boolean {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;
}

function nearestExistingParent(targetPath: string): string | undefined {
  let current = targetPath;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return current;
}

export function validateConfig(config: SymbioteConfig): ValidationError[] {
  const issues: ValidationError[] = [];

  if (!config.defaultProvider) {
    issues.push({ field: 'defaultProvider', message: 'No default provider set', severity: 'error', suggestion: 'Set defaultProvider to a configured provider.' });
  }

  if (!config.defaultModel) {
    issues.push({ field: 'defaultModel', message: 'No default model set', severity: 'error', suggestion: 'Set defaultModel (for example, claude-sonnet-4).' });
  }

  if (!config.workspace) {
    issues.push({ field: 'workspace', message: 'Workspace is required', severity: 'error' });
  } else {
    const resolvedWorkspace = path.resolve(config.workspace);
    try {
      if (fs.existsSync(resolvedWorkspace)) {
        if (!fs.statSync(resolvedWorkspace).isDirectory()) {
          throw new Error('Workspace path is not a directory');
        }
        fs.accessSync(resolvedWorkspace, fs.constants.W_OK);
      } else {
        const parentDir = nearestExistingParent(resolvedWorkspace);
        if (!parentDir) {
          throw new Error('Workspace parent directory does not exist');
        }
        fs.accessSync(parentDir, fs.constants.W_OK);
      }
    } catch (err) {
      issues.push({ field: 'workspace', message: `Workspace is not writable: ${err instanceof Error ? err.message : err}`, severity: 'error' });
    }
  }

  if (config.providers.anthropic?.apiKey && config.providers.anthropic.apiKey.length < 10) {
    issues.push({ field: 'providers.anthropic.apiKey', message: 'API key looks too short', severity: 'warning', suggestion: 'Anthropic keys usually start with sk-ant- and are much longer.' });
  }

  if (config.temperature < 0 || config.temperature > 2) {
    issues.push({ field: 'temperature', message: `Temperature ${config.temperature} is out of range`, severity: 'error', suggestion: 'Use a value between 0.0 and 2.0.' });
  }

  if (config.maxTokens < 1 || config.maxTokens > 1_000_000) {
    issues.push({ field: 'maxTokens', message: `maxTokens ${config.maxTokens} seems wrong`, severity: 'warning', suggestion: 'Typical values are between 4096 and 16384.' });
  }

  if (config.maxIterations !== undefined && config.maxIterations < 1) {
    issues.push({ field: 'maxIterations', message: 'maxIterations must be at least 1', severity: 'error' });
  }

  if (!validPort(config.apiPort)) {
    issues.push({ field: 'apiPort', message: `Invalid API port: ${config.apiPort}`, severity: 'error' });
  }

  if (!validPort(config.webPort)) {
    issues.push({ field: 'webPort', message: `Invalid web UI port: ${config.webPort}`, severity: 'error' });
  }

  if (!validPort(config.xmcpPort)) {
    issues.push({ field: 'xmcpPort', message: `Invalid xMCP port: ${config.xmcpPort}`, severity: 'error' });
  }

  const ports = [
    ['apiPort', config.apiPort],
    ['webPort', config.webPort],
    ['xmcpPort', config.xmcpPort],
  ] as const;
  for (let index = 0; index < ports.length; index++) {
    const [field, port] = ports[index];
    if (!port) continue;
    const duplicate = ports.slice(0, index).find(([, previousPort]) => previousPort === port);
    if (duplicate) {
      issues.push({
        field,
        message: `${field} and ${duplicate[0]} must use different ports`,
        severity: 'error',
      });
    }
  }

  if (config.allowedOrigins?.includes('*') && !isLoopbackHost(config.apiHost)) {
    issues.push({
      field: 'allowedOrigins',
      message: 'Wildcard CORS is not allowed when the HTTP API listens on a non-loopback host',
      severity: 'error',
      suggestion: 'Set allowedOrigins to explicit trusted origins or bind apiHost to 127.0.0.1.',
    });
  }

  if (!isLoopbackHost(config.apiHost) && !process.env.SYMBIOTE_API_KEY && !process.env.API_KEY) {
    issues.push({
      field: 'apiHost',
      message: 'HTTP API is exposed beyond localhost but SYMBIOTE_API_KEY is not configured',
      severity: 'error',
      suggestion: 'Set SYMBIOTE_API_KEY before binding the API to a non-loopback host.',
    });
  }

  if (config.heartbeat) {
    const hb = config.heartbeat;
    for (const [field, interval] of [
      ['activeIntervalMin', hb.activeIntervalMin],
      ['idleIntervalMin', hb.idleIntervalMin],
      ['sleepingIntervalMin', hb.sleepingIntervalMin],
    ] as const) {
      if (interval !== undefined && (!Number.isInteger(interval) || interval < 1)) {
        issues.push({ field: `heartbeat.${field}`, message: 'Heartbeat intervals must be positive whole minutes.', severity: 'error' });
      }
    }
    for (const [field, hour] of [
      ['quietHoursStart', hb.quietHoursStart],
      ['quietHoursEnd', hb.quietHoursEnd],
    ] as const) {
      if (hour !== undefined && (!Number.isInteger(hour) || hour < 0 || hour > 23)) {
        issues.push({ field: `heartbeat.${field}`, message: 'Quiet hours must be whole hours from 0 through 23.', severity: 'error' });
      }
    }
  }

  const neuralMemory = config.memory?.neural;
  if (neuralMemory) {
    if (neuralMemory.enabled && !neuralMemory.model?.trim()) {
      issues.push({
        field: 'memory.neural.model',
        message: 'An embedding model is required when neural memory is enabled.',
        severity: 'error',
        suggestion: 'Configure an embedding-capable Ollama or Artifact Engine model and set its exact configured model name.',
      });
    }
    if (neuralMemory.provider && neuralMemory.provider !== 'ollama' && neuralMemory.provider !== 'artifact-engine') {
      issues.push({
        field: 'memory.neural.provider',
        message: `Unsupported neural memory provider: ${neuralMemory.provider}`,
        severity: 'error',
      });
    }
    if (neuralMemory.baseUrl) {
      try {
        const url = new URL(neuralMemory.baseUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
          throw new Error('Use an HTTP(S) URL without credentials, query, or fragment.');
        }
      } catch (error) {
        issues.push({
          field: 'memory.neural.baseUrl',
          message: `Invalid embedding service URL: ${error instanceof Error ? error.message : String(error)}`,
          severity: 'error',
        });
      }
    }
    if (neuralMemory.timeoutMs !== undefined
      && (!Number.isInteger(neuralMemory.timeoutMs) || neuralMemory.timeoutMs < 1_000 || neuralMemory.timeoutMs > 300_000)) {
      issues.push({
        field: 'memory.neural.timeoutMs',
        message: 'Embedding timeout must be a whole number from 1000 to 300000 milliseconds.',
        severity: 'error',
      });
    }
    const lexicalWeight = neuralMemory.lexicalWeight ?? 0.4;
    const denseWeight = neuralMemory.denseWeight ?? 0.6;
    if (![lexicalWeight, denseWeight].every(weight => Number.isFinite(weight) && weight >= 0)
      || lexicalWeight + denseWeight === 0) {
      issues.push({
        field: 'memory.neural',
        message: 'Neural memory weights must be non-negative and not both zero.',
        severity: 'error',
      });
    }
    if (neuralMemory.temporalHalfLifeDays !== undefined
      && (!Number.isFinite(neuralMemory.temporalHalfLifeDays) || neuralMemory.temporalHalfLifeDays <= 0)) {
      issues.push({
        field: 'memory.neural.temporalHalfLifeDays',
        message: 'Temporal half-life must be a positive number of days.',
        severity: 'error',
      });
    }
  }

  if (config.timeouts) {
    for (const [key, val] of Object.entries(config.timeouts)) {
      if (typeof val === 'number' && val < 1000) {
        issues.push({ field: `timeouts.${key}`, message: `Timeout ${val}ms is very low`, severity: 'warning', suggestion: 'Timeouts are in milliseconds. Did you mean seconds?' });
      }
    }
  }

  if (config.channels) {
    for (const [name, ch] of Object.entries(config.channels)) {
      if (ch.accountKey && /^\d{10}$/.test(ch.accountKey)) {
        issues.push({
          field: `channels.${name}.accountKey`,
          message: `Account key "${ch.accountKey}" looks like a phone number without country code`,
          severity: 'warning',
          suggestion: `Include the country code (for example, ${ch.countryCode ?? '1'}${ch.accountKey}).`,
        });
      }
    }
  }

  if (config.budgets) {
    for (const [resource, budget] of Object.entries(config.budgets)) {
      if (budget.dailyLimit !== undefined && budget.dailyLimit < 1) {
        issues.push({ field: `budgets.${resource}.dailyLimit`, message: 'Daily limit must be >= 1', severity: 'error' });
      }
    }
  }

  if (config.discord?.enabled && !config.discord.token && !process.env.DISCORD_BOT_TOKEN) {
    issues.push({ field: 'discord.token', message: 'Discord is enabled but no bot token is configured', severity: 'error', suggestion: 'Set discord.token or DISCORD_BOT_TOKEN.' });
  }

  if (config.whatsapp?.enabled && !config.whatsapp.authDir) {
    issues.push({ field: 'whatsapp.authDir', message: 'WhatsApp is enabled but authDir is missing', severity: 'error' });
  }

  if ((config.ownerIds?.length ?? 0) === 0) {
    issues.push({ field: 'ownerIds', message: 'No ownerIds configured', severity: 'warning', suggestion: 'Set ownerIds to restrict privileged access.' });
  }

  return issues;
}

export function validateAndReport(config: SymbioteConfig): boolean {
  const issues = validateConfig(config);
  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');

  for (const w of warnings) {
    console.warn(`Config warning [${w.field}]: ${w.message}${w.suggestion ? `\n   Suggestion: ${w.suggestion}` : ''}`);
  }

  if (errors.length > 0) {
    console.error('\nConfig validation failed:\n');
    for (const e of errors) {
      console.error(`  [${e.field}]: ${e.message}${e.suggestion ? `\n   → ${e.suggestion}` : ''}`);
    }
    console.error(`\n${errors.length} error(s) found. Fix config and retry.\n`);
    return false;
  }

  return true;
}
