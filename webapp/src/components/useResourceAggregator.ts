import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResourceAggregatorDashboard, SourceSnapshot, SourceStatus } from '../../../src/resource-aggregator/types.js';

type Request = <T>(endpoint: string, options?: RequestInit) => Promise<T>;

export type ResourceSource = SourceSnapshot;

export function formatTimestamp(value?: string): string {
  if (!value) return 'Not yet collected';
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? 'Unknown time' : timestamp.toLocaleString();
}

export function sourceStatusLabel(status: SourceStatus | string): string {
  switch (status) {
    case 'ok': return 'Online';
    case 'error': return 'Error';
    case 'syncing': return 'Syncing';
    case 'idle': return 'Waiting';
    default: return 'Unknown';
  }
}

export function useResourceAggregator(request: Request) {
  const requestRef = useRef(request);
  requestRef.current = request;
  const [dashboard, setDashboard] = useState<ResourceAggregatorDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const next = await requestRef.current<ResourceAggregatorDashboard>('/api/resource-aggregator');
      setDashboard(next);
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError('');
    try {
      await requestRef.current('/api/resource-aggregator/sync', { method: 'POST' });
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      if (!active) return;
      await load();
      if (active) timer = window.setTimeout(() => void poll(), 60_000 + Math.floor(Math.random() * 8_001));
    };
    void poll();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [load]);

  return { dashboard, loading, refreshing, error, refresh };
}
