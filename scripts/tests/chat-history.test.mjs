import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreConversationMessages } from '../../webapp/src/chat-history.ts';

test('conversation restore hides intermediate tool reasoning and retains safe tool names', () => {
  const messages = restoreConversationMessages([
    { role: 'system', content: 'Internal prompt' },
    { role: 'user', content: 'Inspect the project.' },
    {
      role: 'assistant',
      content: 'I should inspect the project before answering.',
      tool_calls: [
        { id: 'call-1', function: { name: 'read', arguments: '{"path":".env"}' } },
        { id: 'call-2', name: 'exec', input: { command: 'secret command' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'secret tool output' },
    { role: 'assistant', content: 'The project is configured.' },
  ]);

  assert.deepEqual(messages.map(message => [message.role, message.content]), [
    ['user', 'Inspect the project.'],
    ['assistant', 'The project is configured.'],
  ]);
  assert.deepEqual(messages[1].toolCalls?.map(call => call.name), ['read', 'exec']);
  assert.ok(messages[1].toolCalls?.every(call => Object.keys(call.input).length === 0 && !call.result));
});

test('conversation restore records completed tool steps even when no final assistant message exists', () => {
  const messages = restoreConversationMessages([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'browser', input: { url: 'https://example.com' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: 'page loaded' },
  ]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, '');
  assert.deepEqual(messages[0].toolCalls?.map(call => call.name), ['browser']);
});
