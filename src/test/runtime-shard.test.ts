import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSymbioteRuntimeDocuments, SYMBIOTE_API_ROUTES, SYMBIOTE_RUNTIME_NAMESPACE } from '../memory/runtime-shard.js';

test('runtime shard indexes system routes, tools, public sources, and agent identities separately', () => {
  const documents = buildSymbioteRuntimeDocuments({
    tools: [{ name: 'threads_manage', description: 'Manage scoped agent Spaces.', parameters: { type: 'object' } }],
    sources: [{
      id: 'public-quakes',
      label: 'Earthquakes',
      category: 'intelligence',
      description: 'Public earthquake events.',
      path: 'https://example.test/earthquakes',
    }],
    agents: [{
      id: 'researcher',
      projectId: 'project-one',
      projectName: 'Research',
      name: 'Research Agent',
      emoji: 'R',
      createdAt: 123,
    }],
  });

  assert.ok(documents.every(document => document.namespace === SYMBIOTE_RUNTIME_NAMESPACE));
  assert.ok(documents.some(document => document.id === `${SYMBIOTE_RUNTIME_NAMESPACE}:overview` && document.text.includes('GET /api/resource-aggregator/entities')));
  assert.ok(documents.some(document => document.source === 'runtime-tool' && document.text.includes('threads_manage')));
  assert.ok(documents.some(document => document.source === 'runtime-source' && document.text.includes('public-quakes')));
  assert.ok(documents.some(document => document.source === 'runtime-agent' && document.text.includes('Research Agent')));
  assert.ok(SYMBIOTE_API_ROUTES.some(route => route.method === 'PUT' && route.path === '/api/resource-aggregator/settings'));
});
