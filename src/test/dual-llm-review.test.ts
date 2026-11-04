import test from 'node:test';
import assert from 'node:assert/strict';
import { DualLLMOrchestrator } from '../orchestrator/dual-llm.js';
import type { Provider, StreamEvent } from '../providers/types.js';
import type { ToolRegistry } from '../tools/registry.js';

test('a review-driven tool call does not start another internal review cycle', async () => {
  let cloudCalls = 0;
  const cloudProvider: Provider = {
    name: 'cloud',
    async *stream(): AsyncGenerator<StreamEvent> {
      cloudCalls++;
      if (cloudCalls === 1) {
        yield {
          type: 'text_delta',
          text: '{"nodes":[{"id":"work","task":"Perform the assigned project work and verify the result.","model":"local","dependencies":[]}]}',
        };
      } else {
        yield { type: 'text_delta', text: 'The task is complete.' };
      }
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };

  let localCalls = 0;
  const localMessages: unknown[][] = [];
  const localProvider: Provider = {
    name: 'local',
    async *stream(messages): AsyncGenerator<StreamEvent> {
      localCalls++;
      localMessages.push(JSON.parse(JSON.stringify(messages)));
      if (localCalls === 1) {
        yield { type: 'text_delta', text: 'Initial work is ready for verification.' };
      } else if (localCalls === 2) {
        yield { type: 'tool_use_start', id: 'verify-1', name: 'verify' };
        yield { type: 'tool_use_delta', id: 'verify-1', input: '{}' };
        yield { type: 'tool_use_end', id: 'verify-1' };
      } else {
        yield { type: 'text_delta', text: 'The assigned work is complete and verified.' };
      }
      yield { type: 'done', stopReason: localCalls === 2 ? 'tool_use' : 'end_turn' };
    },
  };

  const toolRegistry = {
    executeWithImages: async () => 'verified',
  } as unknown as ToolRegistry;
  const orchestrator = new DualLLMOrchestrator(
    cloudProvider,
    new Map([['local', localProvider]]),
    {
      enabled: true,
      cloudProvider: 'cloud',
      cloudModel: 'cloud-model',
      localModels: { local: 'local-model' },
      maxParallel: 1,
      taskTimeoutMs: 5_000,
    },
    toolRegistry,
  );

  const events: StreamEvent[] = [];
  for await (const event of orchestrator.stream(
    [{ role: 'user', content: 'Implement, test, and verify a change across multiple project modules, then summarize the results and explain any remaining blockers.' }],
    [],
    { model: 'cloud-model' },
  )) {
    events.push(event);
  }

  assert.equal(localCalls, 3);
  assert.deepEqual(
    localMessages.map(messages => (JSON.stringify(messages).match(/Internal completion review:/g) ?? []).length),
    [0, 1, 1],
  );
  assert.ok(events.some(event => event.type === 'text_delta' && event.text === 'The task is complete.'));
});
