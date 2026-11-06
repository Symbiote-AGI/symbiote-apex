import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudflareProvider } from '../providers/cloudflare.js';
import { discoverProviderModels } from '../providers/model-catalog.js';
import type { Message, ProviderConfig } from '../providers/types.js';

const ACCOUNT_ID = '1234567890abcdef1234567890abcdef';

test('Cloudflare provider streams through its account-specific OpenAI-compatible endpoint', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  let authorization = '';
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    authorization = new Headers(init?.headers).get('authorization') ?? '';
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response('data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  try {
    const config: ProviderConfig = {
      accountId: ACCOUNT_ID,
      apiKey: 'cloudflare-test-token',
      baseUrl: 'https://api.cloudflare.com/client/v4/accounts/1234567890abcdef1234567890abcdef/ai/v1',
      model: '@cf/deepseek-ai/deepseek-v4-pro-0813',
    };
    const messages: Message[] = [{ role: 'user', content: 'Say hello.' }];
    const events = [];
    for await (const event of cloudflareProvider.stream(messages, [], config)) events.push(event);

    assert.equal(
      requestUrl,
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1/chat/completions`,
    );
    assert.equal(authorization, 'Bearer cloudflare-test-token');
    assert.equal(requestBody.model, '@cf/deepseek-ai/deepseek-v4-pro-0813');
    assert.equal(requestBody.stream_options, undefined);
    assert.ok(events.some(event => event.type === 'text_delta' && event.text === 'Hello'));
    assert.ok(events.some(event => event.type === 'done'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Cloudflare provider rejects missing account ID or API token before making a request', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const originalApiToken = process.env.CLOUDFLARE_API_TOKEN;
  let requestCount = 0;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
  globalThis.fetch = async () => {
    requestCount++;
    return new Response(null, { status: 500 });
  };
  try {
    const baseConfig: ProviderConfig = { model: '@cf/deepseek-ai/deepseek-v4-pro-0813' };
    await assert.rejects(async () => {
      for await (const _event of cloudflareProvider.stream([], [], baseConfig)) { /* no-op */ }
    }, /CLOUDFLARE_ACCOUNT_ID/);

    await assert.rejects(async () => {
      for await (const _event of cloudflareProvider.stream([], [], {
        ...baseConfig,
        accountId: ACCOUNT_ID,
      })) { /* no-op */ }
    }, /CLOUDFLARE_API_TOKEN/);
    assert.equal(requestCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAccountId === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = originalAccountId;
    if (originalApiToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = originalApiToken;
  }
});

test('Cloudflare model discovery uses the configured account and API token', async () => {
  let requestUrl = '';
  let authorization = '';
  const models = await discoverProviderModels('cloudflare', {
    accountId: ACCOUNT_ID,
    apiKey: 'cloudflare-model-token',
  }, {
    fetcher: async (input, init) => {
      requestUrl = String(input);
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      return new Response(JSON.stringify({ result: [{ name: '@cf/deepseek-ai/deepseek-v4-pro-0813' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(
    requestUrl,
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/models/search?per_page=100&hide_experimental=true`,
  );
  assert.equal(authorization, 'Bearer cloudflare-model-token');
  assert.deepEqual(models, ['@cf/deepseek-ai/deepseek-v4-pro-0813']);
});
