import { CircleAlert, Crosshair, Layers, MapPin, RefreshCw, Search, Satellite, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type {
  VectorEntity,
  VectorSearchResult,
} from '../../../src/resource-aggregator/types.js';
import IntelligenceMapGL from './IntelligenceMapGL';
import ActivityOrb from './ActivityOrb';
import { formatTimestamp, useResourceAggregator } from './useResourceAggregator';

type Request = <T>(endpoint: string, options?: RequestInit) => Promise<T>;
type Props = { request: Request };
type SimilarEntity = VectorEntity & { score: number };
type LayerMode = 'dark' | 'satellite';
type ProjectionMode = 'mercator' | 'globe';

function sourceId(entity: VectorEntity): string {
  const separator = entity.id.indexOf(':');
  return separator < 0 ? entity.id : entity.id.slice(0, separator);
}

function hasCoordinates(entity: VectorEntity): entity is VectorEntity & { latitude: number; longitude: number } {
  return typeof entity.latitude === 'number'
    && Number.isFinite(entity.latitude)
    && entity.latitude >= -90
    && entity.latitude <= 90
    && typeof entity.longitude === 'number'
    && Number.isFinite(entity.longitude)
    && entity.longitude >= -180
    && entity.longitude <= 180;
}

function displayLabel(entity: VectorEntity): string {
  return entity.label?.trim() || entity.recordId || entity.id;
}

export default function IntelligenceView({ request }: Props) {
  const aggregator = useResourceAggregator(request);
  const requestRef = useRef(request);
  requestRef.current = request;

  const [entities, setEntities] = useState<VectorEntity[]>([]);
  const [entitiesLoading, setEntitiesLoading] = useState(true);
  const [entitiesError, setEntitiesError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [similar, setSimilar] = useState<SimilarEntity[]>([]);
  const [similarLoading, setSimilarLoading] = useState(false);
  const [similarError, setSimilarError] = useState('');
  const [query, setQuery] = useState('');
  const [searchMatches, setSearchMatches] = useState<SimilarEntity[] | null>(null);
  const [searchError, setSearchError] = useState('');
  const [searching, setSearching] = useState(false);
  const [layer, setLayer] = useState<LayerMode>('dark');
  const [projection, setProjection] = useState<ProjectionMode>('mercator');
  const [visibleCount, setVisibleCount] = useState(60);
  const [refreshing, setRefreshing] = useState(false);
  const similarityCache = useRef(new Map<string, SimilarEntity[]>());

  const loadEntities = useCallback(async () => {
    try {
      const result = await requestRef.current<{ entities: VectorEntity[] }>('/api/resource-aggregator/entities');
      setEntities(result.entities);
      setEntitiesError('');
    } catch (failure) {
      setEntitiesError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setEntitiesLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      if (!active) return;
      await loadEntities();
      if (active) timer = window.setTimeout(() => void poll(), 60_000 + Math.floor(Math.random() * 8_001));
    };
    void poll();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loadEntities]);

  const selected = useMemo(() =>
    entities.find(entity => entity.id === selectedId)
      ?? searchMatches?.find(entity => entity.id === selectedId)
      ?? null,
  [entities, searchMatches, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setSimilar([]);
      setSimilarError('');
      setSimilarLoading(false);
      return;
    }
    const cached = similarityCache.current.get(selectedId);
    if (cached) {
      setSimilar(cached);
      setSimilarError('');
      return;
    }

    let active = true;
    setSimilarLoading(true);
    setSimilarError('');
    void requestRef.current<{ matches: SimilarEntity[] }>(
      `/api/resource-aggregator/vectors/${encodeURIComponent(selectedId)}/similar?limit=30`,
    ).then(result => {
      if (!active) return;
      const matches = result.matches;
      similarityCache.current.set(selectedId, matches);
      if (similarityCache.current.size > 100) {
        const oldest = similarityCache.current.keys().next().value;
        if (oldest) similarityCache.current.delete(oldest);
      }
      setSimilar(matches);
    }).catch(failure => {
      if (active) setSimilarError(failure instanceof Error ? failure.message : String(failure));
    }).finally(() => {
      if (active) setSimilarLoading(false);
    });

    return () => { active = false; };
  }, [selectedId]);

  const geolocatedCount = useMemo(() => entities.filter(hasCoordinates).length, [entities]);
  const displayedRecords = searchMatches ?? [...entities].sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt));

  const selectRecord = (id: string | null) => {
    setSelectedId(current => current === id ? null : id);
  };

  const submitSearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = query.trim();
    if (!normalized) {
      setSearchMatches(null);
      setSearchError('');
      return;
    }
    setSearching(true);
    setSearchError('');
    try {
      const params = new URLSearchParams({ q: normalized, limit: '30' });
      const result = await requestRef.current<VectorSearchResult>(`/api/resource-aggregator/vectors/search?${params}`);
      setSearchMatches(result.matches);
      setVisibleCount(60);
    } catch (failure) {
      setSearchError(failure instanceof Error ? failure.message : String(failure));
      setSearchMatches(null);
    } finally {
      setSearching(false);
    }
  };

  const refreshAll = async () => {
    setRefreshing(true);
    await aggregator.refresh();
    await loadEntities();
    setRefreshing(false);
  };

  const dashboard = aggregator.dashboard;
  const totalCount = dashboard?.vectors.count ?? entities.length;

  return (
    <div className="page intelligence-view">
      <header className="page-heading intelligence-heading">
        <div>
          <div className="eyebrow">LIVE PUBLIC INTELLIGENCE</div>
          <h1>Intelligence</h1>
          <p>Explore geolocated public records and their vector similarities. Records without upstream coordinates remain searchable, never assigned invented locations.</p>
        </div>
        <button className="button button-secondary" type="button" onClick={() => void refreshAll()} disabled={refreshing || aggregator.refreshing}>
          <RefreshCw size={14} className={refreshing || aggregator.refreshing ? 'resource-spin' : ''} />
          Refresh feeds
        </button>
      </header>

      <section className="intelligence-summary" aria-label="Intelligence index status">
        <article className="surface-card intelligence-stat">
          <span className="intelligence-stat-icon"><Sparkles size={16} /></span>
          <span><small>VECTOR RECORDS</small><strong>{totalCount.toLocaleString()}</strong></span>
        </article>
        <article className="surface-card intelligence-stat">
          <span className="intelligence-stat-icon"><MapPin size={16} /></span>
          <span><small>GEOGRAPHICALLY PLOTTED</small><strong>{geolocatedCount.toLocaleString()}</strong></span>
        </article>
        <article className="surface-card intelligence-stat">
          <span className={`api-registry-status api-registry-status-${dashboard?.status ?? 'unknown'}`} />
          <span><small>AGGREGATOR</small><strong>{dashboard?.status ?? (aggregator.loading ? 'Connecting' : 'Unavailable')}</strong></span>
        </article>
      </section>

      {(aggregator.error || entitiesError || searchError || similarError) && (
        <div className="resource-alert intelligence-alert" role="alert">
          <CircleAlert size={15} />
          <span>{[aggregator.error, entitiesError, searchError, similarError].filter(Boolean).join(' · ')}</span>
        </div>
      )}

      <form className="intelligence-toolbar surface-card" onSubmit={event => void submitSearch(event)}>
        <label className="intelligence-search">
          <Search size={15} />
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search the vector index by meaning or keywords"
            aria-label="Search public intelligence vectors"
          />
        </label>
        <button className="button button-secondary" type="submit" disabled={searching}>
          <Search size={14} />{searching ? 'Searching' : 'Vector search'}
        </button>
        {searchMatches && <button className="button button-quiet" type="button" onClick={() => { setSearchMatches(null); setQuery(''); setSearchError(''); }}>
          Clear results
        </button>}
        <div className="intelligence-map-settings" aria-label="Map controls">
          <div className="intelligence-map-toggle" role="group" aria-label="Map layer">
            <button type="button" className={layer === 'dark' ? 'active' : ''} onClick={() => setLayer('dark')} aria-pressed={layer === 'dark'}><Layers size={13} />Dark</button>
            <button type="button" className={layer === 'satellite' ? 'active' : ''} onClick={() => setLayer('satellite')} aria-pressed={layer === 'satellite'}><Satellite size={13} />Satellite</button>
          </div>
          <div className="intelligence-map-toggle" role="group" aria-label="Map projection">
            <button type="button" className={projection === 'mercator' ? 'active' : ''} onClick={() => setProjection('mercator')} aria-pressed={projection === 'mercator'}>Mercator</button>
            <button type="button" className={projection === 'globe' ? 'active' : ''} onClick={() => setProjection('globe')} aria-pressed={projection === 'globe'}><Crosshair size={13} />Globe</button>
          </div>
        </div>
      </form>

      <div className="intelligence-workspace">
        <section className="surface-card intelligence-map-panel" aria-label="Interactive intelligence map">
          <IntelligenceMapGL
            entities={entities}
            selected={selected}
            similar={similar}
            layer={layer}
            projection={projection}
            onSelect={selectRecord}
          />
          <div className="intelligence-map-footer">
            <span>{geolocatedCount.toLocaleString()} mapped · {Math.max(0, entities.length - geolocatedCount).toLocaleString()} records have no coordinates</span>
            <span>{projection === 'mercator' ? 'Mercator' : 'Globe'} projection · {layer === 'dark' ? 'Dark' : 'Satellite'} tiles</span>
          </div>
        </section>

        <aside className="surface-card intelligence-records-panel">
          <div className="intelligence-records-heading">
            <div><div className="eyebrow">{searchMatches ? 'VECTOR SEARCH' : 'LATEST RECORDS'}</div><h2>{selected ? 'Selected record' : 'Data stream'}</h2></div>
            {entitiesLoading && <ActivityOrb label="Loading records" compact loading />}
          </div>
          {selected ? (
            <section className="intelligence-selected-record">
              <button type="button" className="intelligence-clear-selection" onClick={() => setSelectedId(null)}>Clear selection</button>
              <h3>{displayLabel(selected)}</h3>
              <p className="intelligence-record-source">{sourceId(selected)} · {hasCoordinates(selected) ? `${selected.latitude.toFixed(3)}, ${selected.longitude.toFixed(3)}` : 'No upstream coordinates'}</p>
              <p className="intelligence-record-content">{selected.content || 'No text content was provided by this source.'}</p>
              <small>Captured {formatTimestamp(selected.fetchedAt)}</small>
              {!hasCoordinates(selected) && <p className="intelligence-unlocated-note">This vector is searchable and similarity-linked, but is not plotted because its source provides no coordinates.</p>}
              <div className="intelligence-similar-heading"><Sparkles size={13} /><strong>Closest vectors</strong><span>{similar.length}</span></div>
              {similarLoading && <p className="resource-muted"><ActivityOrb label="Calculating similarities" compact loading /> Calculating similarities…</p>}
              {similar.map(match => (
                <button className="intelligence-similar-row" type="button" key={match.id} onClick={() => setSelectedId(match.id)}>
                  <span><strong>{displayLabel(match)}</strong><small>{sourceId(match)}{hasCoordinates(match) ? ' · mapped' : ' · unlocated'}</small></span>
                  <em>{Math.round(match.score * 100)}%</em>
                </button>
              ))}
              {!similarLoading && !similar.length && !similarError && <p className="resource-muted">No similar records are available yet.</p>}
            </section>
          ) : (
            <div className="intelligence-record-list">
              {displayedRecords.slice(0, visibleCount).map(entity => {
                const score = 'score' in entity ? entity.score : undefined;
                const selectedRecord = entity.id === selectedId;
                return (
                  <button
                    className={`intelligence-record-row${selectedRecord ? ' selected' : ''}`}
                    type="button"
                    key={entity.id}
                    onClick={() => setSelectedId(entity.id)}
                  >
                    <span className={`intelligence-record-dot ${hasCoordinates(entity) ? 'mapped' : 'unmapped'}`} />
                    <span className="intelligence-record-row-copy">
                      <strong>{displayLabel(entity)}</strong>
                      <small>{sourceId(entity)} · {formatTimestamp(entity.fetchedAt)}</small>
                    </span>
                    {typeof score === 'number' && <em>{Math.round(score * 100)}%</em>}
                  </button>
                );
              })}
              {!displayedRecords.length && !entitiesLoading && <p className="resource-muted">{searchMatches ? 'No matching vectors were found.' : 'The aggregator has not indexed any records yet.'}</p>}
              {!displayedRecords.length && entitiesLoading && <p className="resource-muted">Loading public records…</p>}
              {displayedRecords.length > visibleCount && <button className="intelligence-show-more" type="button" onClick={() => setVisibleCount(count => count + 60)}>Show more records</button>}
            </div>
          )}
          <div className="intelligence-source-status">
            <span className={`api-registry-status api-registry-status-${dashboard?.status ?? 'unknown'}`} />
            <span>{dashboard?.sourceHealth.ok ?? 0}/{dashboard?.sourceHealth.enabled ?? 0} feeds online</span>
            <span>{dashboard?.status?.toUpperCase() ?? 'UNKNOWN'}</span>
          </div>
        </aside>
      </div>
    </div>
  );
}
