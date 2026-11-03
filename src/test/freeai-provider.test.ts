import test from 'node:test';
import assert from 'node:assert/strict';
import { freeaiProvider } from '../providers/freeai.js';

test('FreeAI provider transmits tools and yields streamed tool calls', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  let authorization = '';
  let requestBody: Record<string, unknown> | undefined;
  const stream = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
    '',
  ].join('\n\n');
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    authorization = new Headers(init?.headers).get('authorization') ?? '';
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  try {
    const events = [];
    for await (const event of freeaiProvider.stream(
      [{ role: 'user', content: 'Read the README.' }],
      [{
        name: 'read_file',
        description: 'Read a workspace file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      }],
      { apiKey: 'test-freeai-key', baseUrl: 'https://freeai-test.example/v1', model: 'test-model' },
    )) {
      events.push(event);
    }

    assert.equal(requestUrl, 'https://freeai-test.example/v1/chat/completions');
    assert.equal(authorization, 'Bearer test-freeai-key');
    assert.equal(requestBody?.model, 'test-model');
    assert.deepEqual(
      (requestBody?.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name),
      ['read_file'],
    );
    assert.ok(events.some((event) => event.type === 'tool_use_start' && event.name === 'read_file'));
    assert.ok(events.some((event) => event.type === 'tool_use_delta' && event.input.includes('README.md')));
    assert.ok(events.some((event) => event.type === 'tool_use_end'));
    assert.ok(events.some((event) => event.type === 'done'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('FreeAI provider fails before making a request when its API key is missing', async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount++;
    return new Response(null, { status: 401 });
  };

  try {
    await assert.rejects(async () => {
      for await (const _event of freeaiProvider.stream(
        [{ role: 'user', content: 'Hello.' }],
        [],
        { baseUrl: 'https://freeai-test.example/v1', model: 'test-model' },
      )) {
        // Consume the stream to trigger provider validation.
      }
    }, /FREEAI_API_KEY/);
    assert.equal(requestCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
