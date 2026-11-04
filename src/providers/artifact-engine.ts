import { openaiProvider } from './openai.js';
import type { Provider, ProviderConfig } from './types.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8080';

async function* stream(
  messages: Parameters<Provider['stream']>[0],
  tools: Parameters<Provider['stream']>[1],
  config: ProviderConfig,
) {
  const configuredBaseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const isLocalhost = new URL(configuredBaseUrl).hostname === 'localhost';
  const hasV1Suffix = /\/v1$/.test(configuredBaseUrl);
  const baseUrl = isLocalhost
    ? (hasV1Suffix ? configuredBaseUrl : `${configuredBaseUrl}/v1`)
    : (hasV1Suffix ? configuredBaseUrl.replace(/\/v1$/, '') : configuredBaseUrl);
  yield* openaiProvider.stream(messages, tools, {
    ...config,
    baseUrl,
    apiKey: config.apiKey ?? 'artifact-engine',
  });
}

export const artifactEngineProvider: Provider = {
  name: 'artifact-engine',
  stream,
};
