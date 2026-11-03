import type { VDBDocument } from './vdb.js';

export const SYMBIOTE_RUNTIME_NAMESPACE = 'symbiote-runtime';

export const SYMBIOTE_RUNTIME_CAPABILITIES = [
  'Symbiote is a standalone agent runtime with a local gateway, web control room, conversation sessions, workspace projects, and agent profiles.',
  'The runtime provides agent tools, scoped collaborative Spaces, scheduled heartbeat and cron workflows, browser controls, and local vector memory.',
  'The built-in resource aggregator collects public intelligence and market feeds, indexes retained records as vectors, and serves map entities and similarity search.',
  'The Intelligence view maps geolocated aggregator records with dark and satellite basemaps, Mercator and globe projections, and selected-record similarity links.',
  'The Markets view provides public market history and charting, strategy editing and local backtesting, MT5 account/terminal workflows, Binance account connectivity, and a locally persisted MT5 trade journal.',
  'Secrets and account credentials are managed by the credential vault; the runtime manifest never includes credential values.',
].join('\n');

export const SYMBIOTE_API_ROUTES = [
  {
    method: 'GET',
    path: '/api/resource-aggregator',
    name: 'Aggregator dashboard',
    description: 'Aggregate health, source snapshots, latest collection report, and vector-index totals.',
    details: 'Returns source health and cached previews for all configured feeds.',
  },
  {
    method: 'GET',
    path: '/api/resource-aggregator/sources/:id',
    name: 'Source snapshot',
    description: 'Retrieve a single source snapshot, including its full cached data and fetch metadata.',
    details: 'Replace :id with a source id shown in the upstream feeds section.',
  },
  {
    method: 'GET',
    path: '/api/resource-aggregator/entities',
    name: 'Indexed public records',
    description: 'List retained record-level vectors and available geographic coordinates without returning the full vector arrays.',
    details: 'Coordinates are provided only when present in the upstream record.',
  },
  {
    method: 'GET',
    path: '/api/resource-aggregator/vectors/:id/similar?limit={limit}',
    name: 'Vector similarities',
    description: 'Find the closest records by cosine similarity for a selected vector.',
    details: 'The result limit is capped at 50.',
  },
  {
    method: 'GET',
    path: '/api/resource-aggregator/vectors/search?q={query}&limit={limit}',
    name: 'Vector similarity search',
    description: 'Rank retained feed vectors against a text query using cosine similarity.',
    details: 'q is required; limit is optional and capped at 50.',
  },
  {
    method: 'POST',
    path: '/api/resource-aggregator/sync',
    name: 'Refresh all feeds',
    description: 'Force a collection run across all enabled public feeds and update the vector index.',
    details: 'Same-origin Control Room request; returns a run summary.',
  },
  {
    method: 'GET',
    path: '/api/resource-aggregator/settings',
    name: 'Collection settings',
    description: 'Read the persisted public-feed collection cadence.',
    details: 'Returns the configured collection interval in milliseconds.',
  },
  {
    method: 'PUT',
    path: '/api/resource-aggregator/settings',
    name: 'Update collection settings',
    description: 'Set the public-feed collection cadence.',
    details: 'Same-origin Control Room request; accepts intervals from 30 seconds to 15 minutes.',
  },
  {
    method: 'GET',
    path: '/api/markets/history?symbol={symbol}&interval={interval}',
    name: 'Public market history',
    description: 'Retrieve keyless public OHLC bars for supported market symbols.',
    details: 'Public provider availability and quote frequency vary by instrument.',
  },
  {
    method: 'GET',
    path: '/api/markets/chart-state?symbol={symbol}&interval={interval}',
    name: 'Saved chart workspace',
    description: 'Load indicators and drawings saved for a market symbol and interval.',
    details: 'Chart state is stored in the workspace and shared by the user-facing chart and market_chart_manage agent tool.',
  },
  {
    method: 'PUT',
    path: '/api/markets/chart-state',
    name: 'Save chart workspace',
    description: 'Persist chart indicators and drawings for a symbol and interval.',
    details: 'Same-origin Control Room request; input is validated and bounded.',
  },
  {
    method: 'POST',
    path: '/api/sessions/markets/ensure',
    name: 'Markets conversation',
    description: 'Create or load the dedicated Markets conversation used by the Markets mini-chat.',
    details: 'The session is persistent and kept out of the general conversation list.',
  },
  {
    method: 'GET',
    path: '/api/runtime/api-routes',
    name: 'API route catalog',
    description: 'Return the route definitions displayed in the API registry.',
    details: 'Uses the same route catalog indexed into Symbiote runtime memory.',
  },
  {
    method: 'GET',
    path: '/api/integrations/mt5',
    name: 'MetaTrader 5 status',
    description: 'Read the configured terminal/account connection status without returning credentials.',
    details: 'Account passwords are held by the local credential vault.',
  },
  {
    method: 'POST',
    path: '/api/integrations/mt5/test',
    name: 'Test MetaTrader 5 connection',
    description: 'Test the configured MT5 terminal and retrieve tick/latency information.',
    details: 'Connects to the account currently configured by the user.',
  },
  {
    method: 'GET',
    path: '/api/integrations/binance',
    name: 'Binance status',
    description: 'Read whether Binance API credentials are configured.',
    details: 'Secret key material is never returned.',
  },
  {
    method: 'POST',
    path: '/api/integrations/binance/test',
    name: 'Test Binance connection',
    description: 'Verify the configured Binance API key and connectivity.',
    details: 'Uses the account credentials configured by the user.',
  },
] as const;

export interface RuntimeToolInput {
  name: string;
  description: string;
  parameters: unknown;
}

export interface RuntimeSourceInput {
  id: string;
  label: string;
  category: string;
  description: string;
  path: string;
}

export interface RuntimeAgentInput {
  id: string;
  projectId: string;
  projectName: string;
  name: string;
  emoji: string;
  createdAt: number;
}

export interface SymbioteRuntimeInput {
  tools: RuntimeToolInput[];
  sources: RuntimeSourceInput[];
  agents: RuntimeAgentInput[];
}

export function buildSymbioteRuntimeShardContent(input: SymbioteRuntimeInput): Record<string, unknown> {
  return {
    system: {
      name: 'Symbiote',
      type: 'standalone agent runtime',
      capabilities: SYMBIOTE_RUNTIME_CAPABILITIES.split('\n'),
    },
    apiRoutes: SYMBIOTE_API_ROUTES,
    tools: input.tools,
    publicResources: input.sources,
    workspaceAgents: input.agents,
    cognitiveDomains: {
      skills: 'skills:catalog VDB documents',
      procedures: 'workspace operating instructions and heartbeat configuration',
      memories: 'session:* VDB documents and memograph:symbiote_live:live:agent:symbiote',
      experience: 'append-only durable memory records in the Symbiote live graph',
      knowledge: 'project:* documents and public resource-aggregator vectors',
      traits: 'workspace identity files and registered agent profiles',
    },
  };
}

export function buildSymbioteRuntimeDocuments(input: SymbioteRuntimeInput): VDBDocument[] {
  const namespace = SYMBIOTE_RUNTIME_NAMESPACE;
  const documents: VDBDocument[] = [{
    id: `${namespace}:overview`,
    text: [
      'Symbiote runtime manifest',
      SYMBIOTE_RUNTIME_CAPABILITIES,
      'Registered HTTP routes:',
      ...SYMBIOTE_API_ROUTES.map(route => `${route.method} ${route.path} — ${route.description}`),
    ].join('\n\n'),
    source: 'symbiote-runtime',
    role: 'context',
    timestamp: 0,
    namespace,
    metadata: { documentType: 'runtime-overview', system: 'symbiote' },
  }];

  for (const tool of input.tools) {
    documents.push({
      id: `${namespace}:tool:${encodeURIComponent(tool.name)}`,
      text: `Symbiote tool: ${tool.name}\n${tool.description}\nParameters:\n${JSON.stringify(tool.parameters)}`,
      source: 'runtime-tool',
      role: 'context',
      timestamp: 0,
      namespace,
      metadata: { documentType: 'tool', toolName: tool.name },
    });
  }

  for (const source of input.sources) {
    documents.push({
      id: `${namespace}:source:${encodeURIComponent(source.id)}`,
      text: `Public resource source: ${source.label}\nCategory: ${source.category}\nID: ${source.id}\nEndpoint: ${source.path}\n${source.description}`,
      source: 'runtime-source',
      role: 'context',
      timestamp: 0,
      namespace,
      metadata: { documentType: 'resource-source', sourceId: source.id, category: source.category },
    });
  }

  for (const agent of input.agents) {
    documents.push({
      id: `${namespace}:agent:${encodeURIComponent(agent.projectId)}:${encodeURIComponent(agent.id)}`,
      text: `Symbiote workspace agent: ${agent.name} ${agent.emoji}\nProject: ${agent.projectName}\nAgent ID: ${agent.id}`,
      source: 'runtime-agent',
      role: 'context',
      timestamp: agent.createdAt,
      namespace,
      metadata: { documentType: 'agent', agentId: agent.id, projectId: agent.projectId, projectName: agent.projectName },
    });
  }

  return documents;
}
