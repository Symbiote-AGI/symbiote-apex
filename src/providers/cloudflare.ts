import type { Message, Provider, ProviderConfig, StreamEvent, ToolDef } from './types.js';
import { openaiProvider } from './openai.js';

const DEFAULT_BASE_URL = 'https://api.cloudflare.com/client/v4/accounts';
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/i;

async function* streamCloudflare(
  messages: Message[],
  tools: ToolDef[],
  config: ProviderConfig,
): AsyncIterable<StreamEvent> {
  const accountId = config.accountId?.trim() || process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiKey = config.apiKey?.trim() || process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!accountId || !ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error('Cloudflare account ID must be a 32-character hexadecimal ID. Set CLOUDFLARE_ACCOUNT_ID or providers.cloudflare.accountId.');
  }
  if (!apiKey) {
    throw new Error('Cloudflare API token is missing. Set CLOUDFLARE_API_TOKEN or providers.cloudflare.apiKey.');
  }

  const baseUrl = (config.baseUrl ?? `${DEFAULT_BASE_URL}/${accountId}/ai`).replace(/\/+$/, '').replace(/\/v1$/i, '');
  yield* openaiProvider.stream(messages, tools, {
    ...config,
    apiKey,
    baseUrl,
    includeUsage: false,
  });
}

export const cloudflareProvider: Provider = {
  name: 'cloudflare',
  stream: streamCloudflare,
};
