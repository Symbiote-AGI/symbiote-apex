import assert from 'node:assert/strict';
import test from 'node:test';
import { artifactEngineProvider } from '../providers/artifact-engine.js';

test('Artifact Engine provider streams OpenAI-compatible tool calls from the local API', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  let requestBody: Record<string, unknown> | undefined;
  let authorization: string | null = null;
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestBody = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    authorization = new Headers(init?.headers).get('authorization');
    const first = {
      choices: [{ delta: { tool_calls: [{
        index: 0,
        id: 'call-1',
        type: 'function',
        function: { name: 'lookup', arguments: '{"q":' },
      }] }, finish_reason: null }],
    };
    const second = {
      choices: [{ delta: { tool_calls: [{
        index: 0,
        function: { arguments: '"value"}' },
      }] }, finish_reason: 'tool_calls' }],
    };
    const reasoning = { choices: [{ delta: { reasoning_content: 'I should search first.' }, finish_reason: null }] };
    return new Response([
      `data: ${JSON.stringify(reasoning)}`,
      `data: ${JSON.stringify(first)}`,
      `data: ${JSON.stringify(second)}`,
      'data: [DONE]',
      '',
    ].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } });
  };

  try {
    const events = [];
    for await (const event of artifactEngineProvider.stream(
      [{ role: 'user', content: 'search' }],
      [{ name: 'lookup', description: 'Look up a value', parameters: { type: 'object' } }],
      { model: 'test-model', baseUrl: 'http://127.0.0.1:8080/v1' },
    )) {
      events.push(event);
    }

    assert.equal(requestUrl, 'http://127.0.0.1:8080/v1/chat/completions');
    assert.equal(authorization, 'Bearer artifact-engine');
    assert.equal(requestBody?.model, 'test-model');
    assert.deepEqual(events.map(event => event.type), [
      'thinking_delta',
      'tool_use_start',
      'tool_use_delta',
      'tool_use_delta',
      'tool_use_end',
      'done',
    ]);

    const localhostEvents = [];
    for await (const event of artifactEngineProvider.stream(
      [{ role: 'user', content: 'search' }],
      [],
      { model: 'test-model', baseUrl: 'http://localhost:8080/v1' },
    )) {
      localhostEvents.push(event);
    }
    assert.equal(requestUrl, 'http://localhost:8080/v1/chat/completions');
    assert.equal(localhostEvents.at(-1)?.type, 'done');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
