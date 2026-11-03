import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Cloud,
  Code2,
  Compass,
  ExternalLink,
  FileText,
  KeyRound,
  MessageSquare,
  Palette,
  Plug,
  RefreshCw,
  Shield,
  Unplug,
} from 'lucide-react';

type ConnectorPermission = 'read' | 'create' | 'update' | 'delete' | 'execute';
type ConnectorCapability = {
  id: string;
  name: string;
  description: string;
  permission: ConnectorPermission;
};
type ConnectorEntry = {
  manifest: {
    id: string;
    name: string;
    description: string;
    category: string;
    transport: string;
    auth: {
      fields: Array<{ id: string; label: string; description?: string; required: boolean; secret: boolean }>;
    };
    capabilities: ConnectorCapability[];
  };
  configured: boolean;
  connected: boolean;
  health: { state: 'connected' | 'disconnected' | 'error'; message?: string; checkedAt: number };
};
type ConnectorActivity = {
  id: string;
  timestamp: number;
  connectorId: string;
  capabilityId: string;
  agentId: string;
  sessionId?: string;
  success: boolean;
  durationMs: number;
  error?: string;
};
type WorkspaceAgent = { id: string; name?: string; label?: string; projectId?: string };
type ConnectorTab = 'discover' | 'connected' | 'permissions' | 'activity';

interface ConnectorsViewProps {
  request: <T,>(endpoint: string, options?: RequestInit) => Promise<T>;
  onNavigate: (destination: 'integrations') => void;
}

const TABS: Array<{ id: ConnectorTab; label: string; icon: typeof Compass }> = [
  { id: 'discover', label: 'Discover', icon: Compass },
  { id: 'connected', label: 'Connected', icon: Plug },
  { id: 'permissions', label: 'Permissions', icon: Shield },
  { id: 'activity', label: 'Activity', icon: Activity },
];

function categoryIcon(category: string) {
  if (category === 'development') return Code2;
  if (category === 'knowledge') return FileText;
  if (category === 'communication') return MessageSquare;
  if (category === 'design') return Palette;
  return Cloud;
}

function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function ConnectorCard({
  entry,
  onSelect,
  action,
}: {
  entry: ConnectorEntry;
  onSelect?: (entry: ConnectorEntry) => void;
  action?: ReactNode;
}) {
  const Icon = categoryIcon(entry.manifest.category);
  return (
    <article className="connector-card">
      <header className="connector-card-header">
        <span className="connector-card-icon"><Icon size={17} /></span>
        <div className="connector-card-title">
          <div className="connector-card-name"><h2>{entry.manifest.name}</h2><span className={`connector-status connector-status-${entry.connected ? 'online' : entry.configured ? 'error' : 'offline'}`}>{entry.connected ? 'Connected' : entry.configured ? 'Offline' : 'Available'}</span></div>
          <p>{entry.manifest.description}</p>
        </div>
      </header>
      <div className="connector-card-meta">
        <span>{entry.manifest.category}</span><span>{entry.manifest.transport.toUpperCase()}</span><span>{entry.manifest.capabilities.length} capabilities</span>
      </div>
      {entry.health.message && !entry.connected && <p className="connector-health-message"><CircleAlert size={13} />{entry.health.message}</p>}
      <div className="connector-card-actions">
        {onSelect && <button className="button button-secondary" type="button" onClick={() => onSelect(entry)}>{entry.configured ? 'Reconnect' : 'Connect'}<ChevronRight size={13} /></button>}
        {action}
      </div>
    </article>
  );
}

export default function ConnectorsView({ request, onNavigate }: ConnectorsViewProps) {
  const [tab, setTab] = useState<ConnectorTab>('discover');
  const [connectors, setConnectors] = useState<ConnectorEntry[]>([]);
  const [agents, setAgents] = useState<WorkspaceAgent[]>([]);
  const [activity, setActivity] = useState<ConnectorActivity[]>([]);
  const [permissions, setPermissions] = useState<Record<string, string[]>>({});
  const [agentId, setAgentId] = useState('main');
  const [selected, setSelected] = useState<ConnectorEntry | null>(null);
  const [credentialDraft, setCredentialDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refreshConnectors = useCallback(async () => {
    const result = await request<{ connectors: ConnectorEntry[] }>('/api/connectors');
    setConnectors(result.connectors);
  }, [request]);

  const refreshPermissions = useCallback(async (targetAgent: string) => {
    const result = await request<{ permissions: Record<string, string[]> }>(
      `/api/connectors/permissions?agentId=${encodeURIComponent(targetAgent)}`,
    );
    setPermissions(result.permissions);
  }, [request]);

  const refreshActivity = useCallback(async () => {
    const result = await request<{ activity: ConnectorActivity[] }>('/api/connectors/activity?limit=100');
    setActivity(result.activity);
  }, [request]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      await Promise.all([refreshConnectors(), refreshActivity()]);
      const agentResult = await request<WorkspaceAgent[]>('/api/workspace-agents');
      setAgents(agentResult.filter(agent => agent && typeof agent.id === 'string'));
      await refreshPermissions(agentId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  }, [agentId, refreshActivity, refreshConnectors, refreshPermissions, request]);

  useEffect(() => { void refresh(); }, [refresh]);

  const connected = useMemo(() => connectors.filter(entry => entry.connected), [connectors]);
  const allCapabilities = useMemo(() => connectors.flatMap(entry =>
    entry.manifest.capabilities.map(capability => ({ connector: entry, capability })),
  ), [connectors]);

  const connect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(selected.manifest.id);
    setError('');
    setNotice('');
    try {
      await request(`/api/connectors/${encodeURIComponent(selected.manifest.id)}/connect`, {
        method: 'POST',
        body: JSON.stringify({ credentials: credentialDraft }),
      });
      setSelected(null);
      setCredentialDraft({});
      setNotice(`${selected.manifest.name} connected. Grant its capabilities to agents in Permissions.`);
      await refreshConnectors();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy('');
    }
  };

  const disconnect = async (entry: ConnectorEntry) => {
    setBusy(entry.manifest.id);
    setError('');
    setNotice('');
    try {
      await request(`/api/connectors/${encodeURIComponent(entry.manifest.id)}/disconnect`, { method: 'POST' });
      setNotice(`${entry.manifest.name} disconnected.`);
      await Promise.all([refreshConnectors(), refreshPermissions(agentId)]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy('');
    }
  };

  const setCapability = async (entry: ConnectorEntry, capabilityId: string, enabled: boolean) => {
    const current = permissions[entry.manifest.id] ?? [];
    const next = enabled
      ? [...new Set([...current, capabilityId])]
      : current.filter(value => value !== capabilityId);
    setBusy(`${entry.manifest.id}:${capabilityId}`);
    setError('');
    try {
      await request(`/api/connectors/${encodeURIComponent(entry.manifest.id)}/permissions/${encodeURIComponent(agentId)}`, {
        method: 'PUT',
        body: JSON.stringify({ capabilities: next }),
      });
      setPermissions(previous => ({ ...previous, [entry.manifest.id]: next }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy('');
    }
  };

  const changeAgent = async (value: string) => {
    setAgentId(value);
    setError('');
    try {
      await refreshPermissions(value);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <section className="connectors-view">
      <header className="connectors-heading">
        <div>
          <span className="eyebrow">SYMBIOTE CONNECT</span>
          <h1>Connectors</h1>
          <p>Discover services, manage credentials, assign capabilities, and review agent activity.</p>
        </div>
        <button className="button button-secondary" type="button" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'spin' : ''} />Refresh
        </button>
      </header>

      <nav className="connector-tabs" aria-label="Connector workspace">
        {TABS.map(item => {
          const Icon = item.icon;
          return <button key={item.id} className={tab === item.id ? 'connector-tab connector-tab-active' : 'connector-tab'} type="button" onClick={() => setTab(item.id)}>
            <Icon size={14} />{item.label}
            {item.id === 'connected' && <span>{connected.length}</span>}
          </button>;
        })}
      </nav>

      {error && <div className="notice notice-error" role="alert">{error}</div>}
      {notice && <div className="notice notice-info" role="status">{notice}</div>}

      {loading ? <div className="connector-empty"><Activity size={18} className="spin" />Loading connector workspace…</div> : <>
        {tab === 'discover' && <>
          <div className="connector-section-heading"><div><h2>Discover</h2><p>Connect once, then authorize specific agent capabilities.</p></div><span>{connectors.length} available</span></div>
          <div className="connector-grid">
            {connectors.map(entry => <ConnectorCard key={entry.manifest.id} entry={entry} onSelect={setSelected} />)}
            <article className="connector-card connector-card-existing">
              <header className="connector-card-header">
                <span className="connector-card-icon"><KeyRound size={17} /></span>
                <div className="connector-card-title"><div className="connector-card-name"><h2>Google Workspace</h2><span className="connector-status connector-status-existing">Existing</span></div><p>Drive, Gmail, Calendar, Docs, Sheets, and other Google APIs use the existing OAuth integration.</p></div>
              </header>
              <div className="connector-card-actions"><button className="button button-secondary" type="button" onClick={() => onNavigate('integrations')}>Manage in Integrations<ExternalLink size={13} /></button></div>
            </article>
          </div>
        </>}

        {tab === 'connected' && <>
          <div className="connector-section-heading"><div><h2>Connected accounts</h2><p>Credentials remain in the encrypted vault and are never returned to the browser.</p></div><span>{connected.length} connected</span></div>
          {connected.length
            ? <div className="connector-grid">{connected.map(entry => <ConnectorCard key={entry.manifest.id} entry={entry} action={<button className="button button-quiet" type="button" disabled={busy === entry.manifest.id} onClick={() => void disconnect(entry)}><Unplug size={13} />Disconnect</button>} />)}</div>
            : <div className="connector-empty"><Plug size={18} /><span>No connected services yet.</span><button className="text-button" type="button" onClick={() => setTab('discover')}>Discover connectors</button></div>}
        </>}

        {tab === 'permissions' && <>
          <div className="connector-section-heading">
            <div><h2>Agent permissions</h2><p>Grant only the capabilities an agent needs. Unchecked tools are hidden from its prompt.</p></div>
            <label className="connector-agent-select"><span>Agent</span><select value={agentId} onChange={event => void changeAgent(event.target.value)}>
              <option value="main">Main agent</option>
              {agents.filter(agent => agent.id !== 'main').map(agent => <option key={agent.id} value={agent.id}>{agent.name ?? agent.label ?? agent.id}</option>)}
            </select></label>
          </div>
          {allCapabilities.length ? <div className="connector-permission-list">
            {allCapabilities.map(({ connector, capability }) => {
              const isGranted = (permissions[connector.manifest.id] ?? []).includes(capability.id);
              const enabled = connector.connected;
              return <label key={`${connector.manifest.id}:${capability.id}`} className={`connector-permission${!enabled ? ' connector-permission-disabled' : ''}`}>
                <span className={`connector-permission-check${isGranted ? ' connector-permission-check-on' : ''}`}>{isGranted && <Check size={12} />}</span>
                <span className="connector-permission-copy"><strong>{connector.manifest.name} · {capability.name}</strong><small>{capability.description}</small></span>
                <span className={`connector-permission-kind connector-permission-${capability.permission}`}>{capability.permission}</span>
                <input type="checkbox" checked={isGranted} disabled={!enabled || busy === `${connector.manifest.id}:${capability.id}`} onChange={event => void setCapability(connector, capability.id, event.target.checked)} />
              </label>;
            })}
          </div> : <div className="connector-empty"><Shield size={18} /><span>No connector capabilities are registered.</span></div>}
        </>}

        {tab === 'activity' && <>
          <div className="connector-section-heading"><div><h2>Execution history</h2><p>Recent connection and agent capability events. Request and response secrets are not stored.</p></div><span>{activity.length} events</span></div>
          {activity.length ? <div className="connector-activity-list">{activity.map(item => <article key={item.id} className="connector-activity-row">
            <span className={`connector-activity-mark${item.success ? ' connector-activity-mark-ok' : ''}`}>{item.success ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}</span>
            <div className="connector-activity-copy"><strong>{connectors.find(entry => entry.manifest.id === item.connectorId)?.manifest.name ?? item.connectorId} · {item.capabilityId.replaceAll('_', ' ')}</strong><small>Agent {item.agentId}{item.sessionId ? ` · session ${item.sessionId}` : ''}{item.error ? ` · ${item.error}` : ''}</small></div>
            <time>{timeLabel(item.timestamp)}</time><span className="connector-activity-duration">{item.durationMs} ms</span>
          </article>)}</div> : <div className="connector-empty"><Activity size={18} /><span>No connector activity yet.</span></div>}
        </>}
      </>}

      {selected && <div className="connector-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) { setSelected(null); setCredentialDraft({}); } }}>
        <section className="connector-modal" role="dialog" aria-modal="true" aria-labelledby="connector-connect-title">
          <header><span className="connector-card-icon"><KeyRound size={17} /></span><div><h2 id="connector-connect-title">Connect {selected.manifest.name}</h2><p>Credentials are encrypted locally and never included in agent prompts.</p></div><button className="icon-button" type="button" aria-label="Close" onClick={() => { setSelected(null); setCredentialDraft({}); }}>×</button></header>
          <form onSubmit={event => void connect(event)}>
            {selected.manifest.auth.fields.map(field => <label key={field.id} className="connector-field">
              <span>{field.label}{field.required && <i>Required</i>}</span>
              <input
                type={field.secret ? 'password' : 'text'}
                autoComplete="off"
                required={field.required}
                value={credentialDraft[field.id] ?? ''}
                placeholder={field.description ?? ''}
                onChange={event => setCredentialDraft(previous => ({ ...previous, [field.id]: event.target.value }))}
              />
            </label>)}
            <p className="connector-modal-note">Use a least-privilege token. Agent access stays disabled until you grant individual capabilities.</p>
            <footer><button className="button button-quiet" type="button" onClick={() => { setSelected(null); setCredentialDraft({}); }}>Cancel</button><button className="button button-primary" type="submit" disabled={busy === selected.manifest.id}>{busy === selected.manifest.id ? 'Testing…' : 'Test & connect'}</button></footer>
          </form>
        </section>
      </div>}
    </section>
  );
}
