import type { ToolDefinition } from '../tools/types.js';
import type { IntegrationCredentials } from '../security/credential-vault.js';

export type ConnectorCategory =
  | 'knowledge'
  | 'development'
  | 'communication'
  | 'design'
  | 'finance'
  | 'infrastructure'
  | 'hardware';

export type ConnectorPermission = 'read' | 'create' | 'update' | 'delete' | 'execute';

export interface ConnectorAuthField {
  id: string;
  label: string;
  description?: string;
  required: boolean;
  secret: boolean;
}

export interface ConnectorCapability {
  id: string;
  name: string;
  description: string;
  permission: ConnectorPermission;
  parameters: ToolDefinition['parameters'];
}

export interface ConnectorManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  category: ConnectorCategory;
  transport: 'native' | 'rest' | 'mcp';
  auth: {
    type: 'none' | 'bearer' | 'api_key' | 'oauth2';
    fields: ConnectorAuthField[];
  };
  capabilities: ConnectorCapability[];
}

export interface ConnectorHealth {
  state: 'connected' | 'disconnected' | 'error';
  message?: string;
  checkedAt: number;
}

export interface ConnectorExecutionContext {
  agentId: string;
  sessionId?: string;
  signal?: AbortSignal;
  googleWorkspaceAccessToken?: string;
}

export interface ConnectorAdapter {
  readonly manifest: ConnectorManifest;
  connect?(credentials: IntegrationCredentials): Promise<void>;
  disconnect?(): Promise<void>;
  health(credentials: IntegrationCredentials): Promise<ConnectorHealth>;
  execute(
    capabilityId: string,
    input: Record<string, unknown>,
    credentials: IntegrationCredentials,
    context: ConnectorExecutionContext,
  ): Promise<unknown>;
}

export interface ConnectorCatalogEntry {
  manifest: ConnectorManifest;
  configured: boolean;
  connected: boolean;
  health: ConnectorHealth;
}

export interface ConnectorActivity {
  id: string;
  timestamp: number;
  connectorId: string;
  capabilityId: string;
  agentId: string;
  sessionId?: string;
  success: boolean;
  durationMs: number;
  error?: string;
}
