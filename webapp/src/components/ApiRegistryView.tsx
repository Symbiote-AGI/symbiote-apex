import { useCallback, useEffect, useState } from 'react';
import { Activity, RefreshCw, Server } from 'lucide-react';
import type { ResourceAggregatorDashboard } from '../../../src/resource-aggregator/types.js';
import ActivityOrb from './ActivityOrb';

type ApiRoute = { method: string; path: string; name: string; description: string; details: string };
type Props = { request: <T>(endpoint: string, options?: RequestInit) => Promise<T> };

export default function ApiRegistryView({ request }: Props) {
  const [routes, setRoutes] = useState<ApiRoute[]>([]);
  const [dashboard, setDashboard] = useState<ResourceAggregatorDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const [routeResult, aggregatorResult] = await Promise.allSettled([
      request<{ routes: ApiRoute[] }>('/api/runtime/api-routes'),
      request<ResourceAggregatorDashboard>('/api/resource-aggregator'),
    ]);
    const failures: string[] = [];
    if (routeResult.status === 'fulfilled') setRoutes(routeResult.value.routes);
    else failures.push(`API routes: ${routeResult.reason instanceof Error ? routeResult.reason.message : String(routeResult.reason)}`);
    if (aggregatorResult.status === 'fulfilled') setDashboard(aggregatorResult.value);
    else failures.push(`Resource aggregator: ${aggregatorResult.reason instanceof Error ? aggregatorResult.reason.message : String(aggregatorResult.reason)}`);
    setError(failures.join(' '));
    setLoading(false);
  }, [request]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="page api-registry-view">
      <div className="page-heading">
        <div><div className="eyebrow">LIVE RUNTIME SURFACE</div><h1>API registry</h1><p>Routes exposed by this Symbiote runtime, including public feed collection and vector search.</p></div>
        <button className="button button-secondary" type="button" onClick={() => void load()} disabled={loading}><RefreshCw size={14} className={loading ? 'resource-spin' : ''} />Refresh</button>
      </div>
      <div className="api-registry-stats">
        <section className="surface-card api-registry-stat"><span className="api-registry-stat-icon"><Server size={17} /></span><span><small>REGISTERED ROUTES</small><strong>{routes.length.toLocaleString()}</strong></span></section>
        <section className="surface-card api-registry-stat"><span className="api-registry-stat-icon"><Activity size={17} /></span><span><small>INDEXED DATA POINTS</small><strong>{dashboard?.vectors.count.toLocaleString() ?? '—'}</strong></span></section>
        <section className="surface-card api-registry-stat"><span className={`api-registry-status api-registry-status-${dashboard?.status ?? 'unknown'}`} /><span><small>RESOURCE AGGREGATOR</small><strong>{dashboard?.status ?? (loading ? 'Connecting' : 'Unavailable')}</strong></span></section>
      </div>
      {error && <div className="resource-alert" role="alert">{error}</div>}
      {loading && !routes.length && <div className="loading-state"><ActivityOrb label="Loading runtime routes" loading /><span>Loading runtime routes…</span></div>}
      <section className="surface-card api-registry-panel">
        <div className="section-heading"><div><div className="eyebrow">HTTP ROUTES</div><h2>Registered endpoints</h2></div><span className="subtle-label">{routes.length} ROUTES</span></div>
        {routes.length > 0 ? <div className="api-registry-list">{routes.map(route => (
          <article className="api-registry-row" key={`${route.method}:${route.path}`}>
            <div className={`api-method api-method-${route.method.toLowerCase()}`}>{route.method}</div>
            <div className="api-route-copy"><strong>{route.name}</strong><code>{route.path}</code><p>{route.description}</p><small>{route.details}</small></div>
          </article>
        ))}</div> : !loading && <p className="resource-muted">No API routes were reported by this runtime.</p>}
      </section>
      <p className="api-registry-footnote">The data-point total counts retained vector records, not raw upstream observations or vector dimensions.</p>
    </div>
  );
}
