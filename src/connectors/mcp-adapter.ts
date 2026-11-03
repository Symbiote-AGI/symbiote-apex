import type { ToolDefinition } from '../tools/types.js';
import type { ConnectorAdapter, ConnectorCapability, ConnectorExecutionContext, ConnectorHealth, ConnectorManifest } from './types.js';
import type { IntegrationCredentials } from '../security/credential-vault.js';

interface McpTransport {
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  getTools(): ToolDefinition[];
}

function capabilityId(value: string, used: Set<string>): string {
  const base = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'tool';
  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    id = `${base.slice(0, 56 - String(suffix).length)}-${suffix++}`;
  }
  used.add(id);
  return id;
}

export class McpConnectorAdapter implements ConnectorAdapter {
  readonly manifest: ConnectorManifest;
  private readonly toolsByCapability = new Map<string, ToolDefinition>();

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly transport: McpTransport,
  ) {
    const tools = transport.getTools();
    const usedIds = new Set<string>();
    const capabilities: ConnectorCapability[] = tools.map(tool => {
      const id = capabilityId(tool.name, usedIds);
      this.toolsByCapability.set(id, tool);
      return {
        id,
        name: tool.name,
        description: tool.description,
        permission: 'execute',
        parameters: tool.parameters,
      };
    });
    this.manifest = {
      id,
      name,
      description: `Tools discovered from the ${name} MCP server.`,
      version: '1.0.0',
      category: 'development',
      transport: 'mcp',
      auth: { type: 'none', fields: [] },
      capabilities,
    };
  }

  async connect(): Promise<void> {
    if (!this.transport.isConnected()) await this.transport.connect();
  }

  async disconnect(): Promise<void> {
    this.transport.disconnect();
  }

  async health(_credentials: IntegrationCredentials): Promise<ConnectorHealth> {
    const connected = this.transport.isConnected();
    return {
      state: connected ? 'connected' : 'disconnected',
      checkedAt: Date.now(),
      ...(!connected ? { message: 'The MCP server process is not connected.' } : {}),
    };
  }

  async execute(
    capabilityId: string,
    input: Record<string, unknown>,
    _credentials: IntegrationCredentials,
    _context: ConnectorExecutionContext,
  ): Promise<unknown> {
    const tool = this.toolsByCapability.get(capabilityId);
    if (!tool) throw new Error(`Unknown MCP capability: ${this.id}/${capabilityId}`);
    const result = await tool.execute(input);
    if (typeof result === 'string') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(result) as unknown;
      } catch (failure) {
        if (failure instanceof SyntaxError) return result;
        throw failure;
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && typeof (parsed as { error?: unknown }).error === 'string') {
        throw new Error((parsed as { error: string }).error);
      }
    }
    return result;
  }
}
