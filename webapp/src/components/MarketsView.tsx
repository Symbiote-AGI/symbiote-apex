import { CandlestickSeries, ColorType, CrosshairMode, createChart, LineSeries, type IChartApi, type IPriceLine, type ISeriesApi, type Time } from 'lightweight-charts';
import { ArrowDownRight, ArrowUpRight, ChartCandlestick, CircleAlert, Mic, Play, Plus, RefreshCw, Send, Shield, Trash2, TrendingUp } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import type { MarketChartDrawing, MarketChartIndicator, MarketChartState, MarketIndicatorKind, MarketChartPoint } from '../../../src/markets/chart-workspace.js';
import type { MarketHistory, MarketInterval, MarketSymbol } from '../../../src/markets/public-market-data.js';
import { formatTimestamp, sourceStatusLabel, useResourceAggregator, type ResourceSource } from './useResourceAggregator';
import ActivityOrb from './ActivityOrb';
import {
  audioBlobToBase64,
  createPcmWavRecorder,
  disposePcmWavRecorderSetup,
  preparePcmWavRecorder,
  type PcmWavRecorder,
  type PcmWavRecorderSetup,
} from '../lib/voice-recorder';

type StreamApi = <T>(
  endpoint: string,
  body: Record<string, unknown>,
  onEvent: (event: Record<string, unknown>) => void,
) => Promise<{ complete: true; result: T } | { complete: false }>;
type Props = {
  request: <T>(endpoint: string, options?: RequestInit) => Promise<T>;
  stream: StreamApi;
  initialPrompt?: string;
  onInitialPromptConsumed?: () => void;
};
type Quote = { symbol: MarketSymbol; label: string; price?: number; change?: number; source: string; status: string };
type Position = { ticket: number; symbol: string; type: string; volume: number; price_open: number; price_current: number; sl: number; tp: number; profit: number };
type ProtectionLevel = 'stopLoss' | 'takeProfit';
type ActivePriceDrag = { ticket: number; level: ProtectionLevel; y: number; price: number | null };
type Mt5Status = { configured: boolean; connected?: boolean; latencyMs?: number; account?: number; server?: string; error?: string; tick?: { symbol: string; bid: number; ask: number; time: number } };
type MarketChatMessage = { id: string; role: 'user' | 'assistant' | 'system'; content: string; timestamp: number };
type MarketIndicatorSeriesData = Array<Array<{ time: Time; value: number }>>;

const ASSETS: Array<{ symbol: MarketSymbol; label: string; sourceId: string }> = [
  { symbol: 'XAU', label: 'Gold', sourceId: 'gold-spot-price' },
  { symbol: 'XAG', label: 'Silver', sourceId: 'silver-spot-price' },
  { symbol: 'DXY', label: 'Dollar index', sourceId: 'usd-currency-basket' },
  { symbol: 'VIX', label: 'Volatility index', sourceId: 'cboe-volatility-index-history' },
  { symbol: 'BTC', label: 'Bitcoin', sourceId: 'coingecko-public-prices' },
  { symbol: 'ETH', label: 'Ethereum', sourceId: 'coingecko-public-prices' },
  { symbol: 'SOL', label: 'Solana', sourceId: 'coingecko-public-prices' },
];
const INTERVALS: MarketInterval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];
const INDICATOR_COLORS: Record<MarketIndicatorKind, string> = {
  sma: '#f1b85b',
  ema: '#62a8ff',
  rsi: '#b59aff',
  atr: '#f38b62',
  bollinger: '#61cdb6',
};
const DEFAULT_SCRIPT = `//@version=5
strategy("SMA Cross", overlay=true)
fastLength = input.int(9, "Fast SMA")
slowLength = input.int(21, "Slow SMA")
fast = ta.sma(close, fastLength)
slow = ta.sma(close, slowLength)
if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("Long")
plot(fast, color=color.teal)
plot(slow, color=color.orange)`;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function findSource(sources: ResourceSource[], id: string): ResourceSource | undefined {
  return sources.find(source => source.id === id);
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readAssetQuote(symbol: MarketSymbol, sources: ResourceSource[]): Omit<Quote, 'label'> {
  const asset = ASSETS.find(item => item.symbol === symbol)!;
  const source = findSource(sources, asset.sourceId);
  if (symbol === 'BTC' || symbol === 'ETH' || symbol === 'SOL') {
    const data = record(source?.data);
    const key = symbol === 'BTC' ? 'bitcoin' : symbol === 'ETH' ? 'ethereum' : 'solana';
    const quote = record(data?.[key]);
    return { symbol, price: numberField(quote?.usd), change: numberField(quote?.usd_24h_change), source: source?.label ?? 'Public crypto feed', status: source ? sourceStatusLabel(source.status) : 'Waiting' };
  }
  if (symbol === 'XAU' || symbol === 'XAG') {
    const data = record(source?.data);
    return { symbol, price: numberField(data?.price), source: source?.label ?? 'Public spot quote', status: source ? sourceStatusLabel(source.status) : 'Waiting' };
  }
  if (symbol === 'DXY') {
    const rates = record(record(source?.data)?.rates);
    const values = ['EUR', 'JPY', 'GBP', 'CAD', 'SEK', 'CHF'].map(key => numberField(rates?.[key]));
    const price = values.every((value): value is number => value !== undefined)
      ? 50.14348112 * values[0] ** 0.576 * values[1] ** 0.136 * values[2] ** 0.119 * values[3] ** 0.091 * values[4] ** 0.042 * values[5] ** 0.036
      : undefined;
    return { symbol, price, source: source?.label ?? 'ECB reference rates', status: source ? sourceStatusLabel(source.status) : 'Waiting' };
  }
  const csv = typeof source?.data === 'string' ? source.data : '';
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const headers = lines[0]?.split(',').map(value => value.trim().toLowerCase().replaceAll('"', '')) ?? [];
  const closeIndex = headers.findIndex(value => value === 'vix close' || value === 'close');
  const lastLine = lines.at(-1)?.split(',').map(value => value.trim().replaceAll('"', '')) ?? [];
  const price = closeIndex >= 0 ? Number(lastLine[closeIndex]) : undefined;
  return { symbol, price: Number.isFinite(price) ? price : undefined, source: source?.label ?? 'CBOE daily close', status: source ? sourceStatusLabel(source.status) : 'Waiting' };
}

function money(symbol: MarketSymbol, value: number): string {
  if (symbol === 'VIX' || symbol === 'DXY') return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: value < 1 ? 4 : 2 }).format(value);
}

function readMarketChartTheme() {
  const styles = getComputedStyle(document.documentElement);
  return {
    background: styles.getPropertyValue('--paper-raised').trim() || '#f7f6f1',
    text: styles.getPropertyValue('--ink-muted').trim() || '#74766b',
    border: styles.getPropertyValue('--line').trim() || '#deded5',
    primary: styles.getPropertyValue('--appearance-primary').trim() || '#6b8f5e',
  };
}

function calculateIndicatorData(bars: MarketHistory['bars'], indicator: MarketChartIndicator): MarketIndicatorSeriesData {
  const { kind, period } = indicator;
  const values: Array<number | null> = Array.from({ length: bars.length }, () => null);
  const bands: Array<[number, number] | null> = Array.from({ length: bars.length }, () => null);
  if (kind === 'sma' || kind === 'bollinger') {
    for (let index = period - 1; index < bars.length; index++) {
      const sample = bars.slice(index - period + 1, index + 1).map(bar => bar.close);
      const mean = sample.reduce((sum, value) => sum + value, 0) / period;
      values[index] = mean;
      if (kind === 'bollinger') {
        const deviation = Math.sqrt(sample.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period) * 2;
        bands[index] = [mean + deviation, mean - deviation];
      }
    }
  } else if (kind === 'ema') {
    const multiplier = 2 / (period + 1);
    for (let index = period - 1; index < bars.length; index++) {
      if (index === period - 1) {
        values[index] = bars.slice(0, period).reduce((sum, bar) => sum + bar.close, 0) / period;
      } else {
        values[index] = bars[index].close * multiplier + values[index - 1]! * (1 - multiplier);
      }
    }
  } else if (kind === 'rsi') {
    for (let index = period; index < bars.length; index++) {
      let gain = 0;
      let loss = 0;
      for (let cursor = index - period + 1; cursor <= index; cursor++) {
        const change = bars[cursor].close - bars[cursor - 1].close;
        if (change > 0) gain += change;
        else loss -= change;
      }
      const averageGain = gain / period;
      const averageLoss = loss / period;
      values[index] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
    }
  } else {
    for (let index = period; index < bars.length; index++) {
      let trueRangeSum = 0;
      for (let cursor = index - period + 1; cursor <= index; cursor++) {
        const previousClose = bars[cursor - 1].close;
        trueRangeSum += Math.max(
          bars[cursor].high - bars[cursor].low,
          Math.abs(bars[cursor].high - previousClose),
          Math.abs(bars[cursor].low - previousClose),
        );
      }
      values[index] = trueRangeSum / period;
    }
  }
  const middle = values.flatMap((value, index) => value === null ? [] : [{ time: bars[index].time as Time, value }]);
  if (kind !== 'bollinger') return [middle];
  return [
    middle,
    bands.flatMap((band, index) => band ? [{ time: bars[index].time as Time, value: band[0] }] : []),
    bands.flatMap((band, index) => band ? [{ time: bars[index].time as Time, value: band[1] }] : []),
  ];
}

function toUnixSeconds(time: Time | null): number | undefined {
  if (typeof time === 'number') return Math.floor(time);
  if (typeof time === 'string') {
    const value = Date.parse(`${time}T00:00:00Z`);
    return Number.isFinite(value) ? Math.floor(value / 1_000) : undefined;
  }
  if (time && typeof time === 'object') return Math.floor(Date.UTC(time.year, time.month - 1, time.day) / 1_000);
  return undefined;
}

export default function MarketsView({ request, stream, initialPrompt = '', onInitialPromptConsumed }: Props) {
  const { dashboard, loading, refreshing, error, refresh } = useResourceAggregator(request);
  const sources = dashboard?.sources ?? [];
  const [selectedSymbol, setSelectedSymbol] = useState<MarketSymbol>('BTC');
  const [interval, setInterval] = useState<MarketInterval>('1m');
  const [history, setHistory] = useState<MarketHistory | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [chartWorkspace, setChartWorkspace] = useState<MarketChartState | null>(null);
  const [chartWorkspaceLoading, setChartWorkspaceLoading] = useState(true);
  const [chartWorkspaceSaving, setChartWorkspaceSaving] = useState(false);
  const [chartWorkspaceError, setChartWorkspaceError] = useState('');
  const [indicatorKind, setIndicatorKind] = useState<MarketIndicatorKind>('sma');
  const [indicatorPeriod, setIndicatorPeriod] = useState('20');
  const [drawingMode, setDrawingMode] = useState<MarketChartDrawing['kind'] | null>(null);
  const [pendingTrendPoint, setPendingTrendPoint] = useState<MarketChartPoint | null>(null);
  const [marketSessionId, setMarketSessionId] = useState('');
  const [marketMessages, setMarketMessages] = useState<MarketChatMessage[]>([]);
  const [marketDraft, setMarketDraft] = useState('');
  const [marketChatLoading, setMarketChatLoading] = useState(true);
  const [marketChatBusy, setMarketChatBusy] = useState(false);
  const [marketChatError, setMarketChatError] = useState('');
  const [marketRecording, setMarketRecording] = useState(false);
  const [script, setScript] = useState(DEFAULT_SCRIPT);
  const [backtest, setBacktest] = useState<{ trades: number; returnPct: number; equity: number; message: string; equityCurve: Array<{ time: Time; value: number }> } | null>(null);
  const [mt5, setMt5] = useState<Mt5Status | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [positionProtections, setPositionProtections] = useState<Record<number, { stopLoss: string; takeProfit: string }>>({});
  const [activePriceDrag, setActivePriceDrag] = useState<ActivePriceDrag | null>(null);
  const [mt5Error, setMt5Error] = useState('');
  const [mt5Busy, setMt5Busy] = useState(false);
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [volume, setVolume] = useState('0.01');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [symbol, setSymbol] = useState('XAUUSD');
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | ISeriesApi<'Line'> | null>(null);
  const indicatorSeriesRef = useRef<ISeriesApi<'Line'>[]>([]);
  const drawingSeriesRef = useRef<ISeriesApi<'Line'>[]>([]);
  const drawingPriceLinesRef = useRef<Array<{ series: ISeriesApi<'Candlestick'> | ISeriesApi<'Line'>; line: IPriceLine }>>([]);
  const marketChatEndRef = useRef<HTMLDivElement>(null);
  const consumedInitialPromptRef = useRef('');
  const audioRecorderRef = useRef<PcmWavRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const marketRecordingRequestRef = useRef(0);
  const backtestChartContainerRef = useRef<HTMLDivElement>(null);
  const backtestChartRef = useRef<IChartApi | null>(null);
  const equitySeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const positionLinesRef = useRef<Array<{ series: ISeriesApi<'Candlestick'> | ISeriesApi<'Line'>; line: IPriceLine }>>([]);
  const [chartMarkerEpoch, setChartMarkerEpoch] = useState(0);

  const quotes = useMemo(() => ASSETS.map(asset => ({
    ...asset,
    ...readAssetQuote(asset.symbol, sources),
  })), [sources]);
  const selectedQuote = quotes.find(quote => quote.symbol === selectedSymbol);
  const currentBars = history?.bars ?? [];
  const activeChartState = chartWorkspace?.symbol === selectedSymbol && chartWorkspace.interval === interval ? chartWorkspace : null;
  const hasExchangeIntervals = ['BTC', 'ETH', 'SOL'].includes(selectedSymbol);
  const dailyReference = selectedSymbol === 'DXY' || selectedSymbol === 'VIX';

  async function loadHistory() {
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const params = new URLSearchParams({ symbol: selectedSymbol, interval, limit: '500' });
      const next = await request<MarketHistory>(`/api/markets/history?${params}`);
      setHistory(previous => {
        if (!previous || previous.symbol !== next.symbol || previous.interval !== next.interval) return next;
        const byTime = new Map(previous.bars.map(bar => [bar.time, bar]));
        for (const bar of next.bars) {
          const previousBar = byTime.get(bar.time);
          byTime.set(bar.time, previousBar ? {
            time: bar.time,
            open: previousBar.open,
            high: Math.max(previousBar.high, bar.high),
            low: Math.min(previousBar.low, bar.low),
            close: bar.close,
          } : bar);
        }
        return { ...next, bars: [...byTime.values()].sort((a, b) => a.time - b.time).slice(-1_000) };
      });
    } catch (failure) {
      setHistoryError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setHistoryLoading(false);
    }
  }

  async function saveChartWorkspace(indicators: MarketChartIndicator[], drawings: MarketChartDrawing[]) {
    if (chartWorkspaceLoading || chartWorkspaceSaving) return;
    setChartWorkspaceSaving(true);
    setChartWorkspaceError('');
    try {
      const saved = await request<MarketChartState>('/api/markets/chart-state', {
        method: 'PUT',
        body: JSON.stringify({ symbol: selectedSymbol, interval, state: { indicators, drawings } }),
      });
      setChartWorkspace(saved);
      setChartWorkspaceError(saved.error ?? '');
    } catch (failure) {
      setChartWorkspaceError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setChartWorkspaceSaving(false);
    }
  }

  async function addIndicator() {
    const period = Number(indicatorPeriod);
    if (!chartWorkspace || !Number.isSafeInteger(period) || period < 2 || period > 500) {
      setChartWorkspaceError('Indicator periods must be whole numbers from 2 to 500.');
      return;
    }
    if (chartWorkspace.indicators.some(item => item.kind === indicatorKind && item.period === period)) {
      setChartWorkspaceError(`${indicatorKind.toUpperCase()} ${period} is already on this chart.`);
      return;
    }
    await saveChartWorkspace(
      [...chartWorkspace.indicators, { id: crypto.randomUUID(), kind: indicatorKind, period, color: INDICATOR_COLORS[indicatorKind] }],
      chartWorkspace.drawings,
    );
  }

  async function removeIndicator(id: string) {
    if (!chartWorkspace) return;
    await saveChartWorkspace(chartWorkspace.indicators.filter(item => item.id !== id), chartWorkspace.drawings);
  }

  async function addDrawing(drawing: MarketChartDrawing) {
    if (!chartWorkspace) return;
    await saveChartWorkspace(chartWorkspace.indicators, [...chartWorkspace.drawings, drawing]);
  }

  async function removeDrawing(id: string) {
    if (!chartWorkspace) return;
    await saveChartWorkspace(chartWorkspace.indicators, chartWorkspace.drawings.filter(item => item.id !== id));
  }

  const loadMarketMessages = useCallback(async (sessionId: string) => {
    const messages = await request<MarketChatMessage[]>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`);
    setMarketMessages(messages.filter(message => ['user', 'assistant', 'system'].includes(message.role)).slice(-40));
  }, [request]);

  async function sendMarketMessage(event?: React.FormEvent<HTMLFormElement>, overrideText?: string) {
    event?.preventDefault();
    const text = (overrideText ?? marketDraft).trim();
    if (!text || !marketSessionId || marketChatBusy) return;
    setMarketDraft('');
    setMarketChatError('');
    setMarketChatBusy(true);
    const userMessage: MarketChatMessage = { id: crypto.randomUUID(), role: 'user', content: text, timestamp: Date.now() };
    const assistantId = crypto.randomUUID();
    const assistantMessage: MarketChatMessage = { id: assistantId, role: 'assistant', content: '', timestamp: Date.now() };
    setMarketMessages(current => [...current, userMessage, assistantMessage].slice(-40));
    try {
      const outcome = await stream<{ text: string }>('/api/chat', { text, sessionId: marketSessionId }, event => {
        if (event.type !== 'text_delta') return;
        const delta = typeof event.text === 'string' ? event.text : '';
        setMarketMessages(current => current.map(message => message.id === assistantId
          ? { ...message, content: message.content + delta }
          : message));
      });
      await loadMarketMessages(marketSessionId);
      if (!outcome.complete) setMarketChatError('The Markets conversation ended before a final response was received.');
    } catch (failure) {
      setMarketChatError(failure instanceof Error ? failure.message : 'The Markets conversation failed.');
      setMarketMessages(current => current.filter(message => message.id !== assistantId || message.content));
    } finally {
      setMarketChatBusy(false);
    }
  }

  async function startMarketRecording() {
    if (audioRecorderRef.current || marketRecording || marketChatBusy) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof window.AudioContext === 'undefined') {
      setMarketChatError('Microphone access requires HTTPS or localhost and a supported browser.');
      return;
    }
    const requestId = ++marketRecordingRequestRef.current;
    let mediaStream: MediaStream | null = null;
    let recorderSetup: PcmWavRecorderSetup | null = null;
    try {
      recorderSetup = preparePcmWavRecorder();
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (requestId !== marketRecordingRequestRef.current) {
        mediaStream.getTracks().forEach(track => track.stop());
        return;
      }
      const recorder = await createPcmWavRecorder(mediaStream, recorderSetup);
      recorderSetup = null;
      if (requestId !== marketRecordingRequestRef.current) {
        await recorder.stop();
        mediaStream.getTracks().forEach(track => track.stop());
        return;
      }
      mediaStreamRef.current = mediaStream;
      audioRecorderRef.current = recorder;
      setMarketChatError('');
      setMarketRecording(true);
    } catch (failure) {
      mediaStream?.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
      audioRecorderRef.current = null;
      setMarketChatError(failure instanceof Error ? failure.message : 'Microphone access was not available.');
    } finally {
      if (recorderSetup) {
        try {
          await disposePcmWavRecorderSetup(recorderSetup);
        } catch (failure) {
          console.warn('[voice] Markets dictation audio context cleanup failed:', failure);
        }
      }
    }
  }

  function stopMarketRecording() {
    marketRecordingRequestRef.current++;
    const recorder = audioRecorderRef.current;
    audioRecorderRef.current = null;
    mediaStreamRef.current?.getTracks().forEach(track => track.stop());
    mediaStreamRef.current = null;
    setMarketRecording(false);
    if (!recorder) return;
    setMarketChatBusy(true);
    setMarketChatError('');
    void (async () => {
      try {
        const audio = await recorder.stop();
        if (audio.size <= 44) throw new Error('No speech was detected in the recording.');
        if (audio.size > 8 * 1024 * 1024) throw new Error('Keep recordings under 8 MB, then try again.');
        const result = await request<{ text: string }>('/api/voice/transcribe', {
          method: 'POST',
          body: JSON.stringify({ audioBase64: await audioBlobToBase64(audio), mimeType: 'audio/wav' }),
        });
        setMarketDraft(current => current.trim() ? `${current.trim()} ${result.text}` : result.text);
      } catch (failure) {
        setMarketChatError(failure instanceof Error ? failure.message : 'Voice transcription failed.');
      } finally {
        setMarketChatBusy(false);
      }
    })();
  }

  async function loadMt5() {
    try {
      const configured = await request<Mt5Status>('/api/integrations/mt5');
      if (!configured.configured) {
        setMt5(configured);
        setPositions([]);
        setMt5Error('');
        return;
      }
      const connection = await request<Mt5Status>('/api/integrations/mt5/test', {
        method: 'POST',
        body: JSON.stringify({ symbol }),
      });
      setMt5({ ...configured, ...connection });
      setMt5Error('');
      if (connection.connected) await loadPositions();
    } catch (failure) {
      setMt5Error(failure instanceof Error ? failure.message : String(failure));
    }
  }

  async function loadPositions() {
    try {
      const result = await request<{ positions: Position[] }>('/api/integrations/mt5/positions');
      setPositions(result.positions);
      setPositionProtections(Object.fromEntries(result.positions.map(position => [
        position.ticket,
        { stopLoss: position.sl > 0 ? String(position.sl) : '', takeProfit: position.tp > 0 ? String(position.tp) : '' },
      ])));
      setMt5Error('');
    } catch (failure) {
      setMt5Error(failure instanceof Error ? failure.message : String(failure));
    }
  }

  useEffect(() => {
    void loadHistory();
    const timer = window.setInterval(() => { void loadHistory(); }, 20_000);
    return () => window.clearInterval(timer);
  }, [selectedSymbol, interval]);

  useEffect(() => {
    let active = true;
    setChartWorkspace(null);
    setChartWorkspaceLoading(true);
    setChartWorkspaceError('');
    const params = new URLSearchParams({ symbol: selectedSymbol, interval });
    void request<MarketChartState>(`/api/markets/chart-state?${params}`)
      .then(state => {
        if (!active) return;
        setChartWorkspace(state);
        setChartWorkspaceError(state.error ?? '');
      })
      .catch(failure => {
        if (active) setChartWorkspaceError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => { if (active) setChartWorkspaceLoading(false); });
    return () => { active = false; };
  }, [selectedSymbol, interval, request]);

  useEffect(() => {
    let active = true;
    setMarketChatLoading(true);
    void request<{ id: string }>('/api/sessions/markets/ensure', { method: 'POST', body: '{}' })
      .then(session => { if (active) setMarketSessionId(session.id); })
      .catch(failure => { if (active) setMarketChatError(failure instanceof Error ? failure.message : 'Markets conversation could not be opened.'); })
      .finally(() => { if (active) setMarketChatLoading(false); });
    return () => { active = false; };
  }, [request]);

  useEffect(() => {
    if (!marketSessionId) return;
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        await loadMarketMessages(marketSessionId);
      } catch (failure) {
        if (active) setMarketChatError(failure instanceof Error ? failure.message : 'Markets conversation could not be refreshed.');
      }
      if (active) timer = window.setTimeout(() => void poll(), 60_000 + Math.floor(Math.random() * 8_001));
    };
    void poll();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loadMarketMessages, marketSessionId]);

  useEffect(() => {
    const prompt = initialPrompt.trim();
    if (!prompt) {
      consumedInitialPromptRef.current = '';
      return;
    }
    if (!marketSessionId || marketChatLoading || marketChatBusy || consumedInitialPromptRef.current === prompt) return;
    consumedInitialPromptRef.current = prompt;
    void sendMarketMessage(undefined, prompt);
    onInitialPromptConsumed?.();
  }, [initialPrompt, marketChatBusy, marketChatLoading, marketSessionId, onInitialPromptConsumed]);

  useEffect(() => {
    marketChatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [marketMessages]);

  useEffect(() => () => {
    marketRecordingRequestRef.current++;
    const recorder = audioRecorderRef.current;
    audioRecorderRef.current = null;
    if (recorder) void recorder.stop().catch(failure => console.warn('[markets] Audio recorder cleanup failed:', failure));
    mediaStreamRef.current?.getTracks().forEach(track => track.stop());
    mediaStreamRef.current = null;
  }, []);

  useEffect(() => { void loadMt5(); }, []);

  useEffect(() => {
    if (!chartContainerRef.current || chartRef.current) return;
    const theme = readMarketChartTheme();
    const chart = createChart(chartContainerRef.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: theme.background }, textColor: theme.text, fontFamily: 'Inter, sans-serif' },
      grid: { vertLines: { color: 'rgba(255,255,255,0.045)' }, horzLines: { color: 'rgba(255,255,255,0.045)' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: theme.border },
      timeScale: { borderColor: theme.border, timeVisible: true, secondsVisible: false },
    });
    chartRef.current = chart;
    const resizeObserver = new ResizeObserver(() => {
      chart.timeScale().fitContent();
      setChartMarkerEpoch(value => value + 1);
    });
    resizeObserver.observe(chartContainerRef.current);
    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const item of positionLinesRef.current) item.series.removePriceLine(item.line);
    positionLinesRef.current = [];
    for (const item of drawingPriceLinesRef.current) item.series.removePriceLine(item.line);
    drawingPriceLinesRef.current = [];
    for (const series of indicatorSeriesRef.current) chart.removeSeries(series);
    indicatorSeriesRef.current = [];
    for (const series of drawingSeriesRef.current) chart.removeSeries(series);
    drawingSeriesRef.current = [];
    const previousSeries = seriesRef.current;
    seriesRef.current = null;
    if (previousSeries) chart.removeSeries(previousSeries);
    while (chart.panes().length > 1) chart.removePane(chart.panes().length - 1);
    if (selectedSymbol === 'BTC' || selectedSymbol === 'ETH' || selectedSymbol === 'SOL' || selectedSymbol === 'VIX') {
      const series = chart.addSeries(CandlestickSeries, {
        upColor: '#72c7a2',
        downColor: '#e57769',
        borderVisible: false,
        wickUpColor: '#72c7a2',
        wickDownColor: '#e57769',
      });
      seriesRef.current = series;
    } else {
      const series = chart.addSeries(LineSeries, { color: '#77d5bd', lineWidth: 2 });
      seriesRef.current = series;
    }
  }, [selectedSymbol]);

  useEffect(() => {
    const applyTheme = () => {
      const theme = readMarketChartTheme();
      const options = {
        layout: { background: { type: ColorType.Solid, color: theme.background }, textColor: theme.text },
        rightPriceScale: { borderColor: theme.border },
        timeScale: { borderColor: theme.border },
      };
      chartRef.current?.applyOptions(options);
      backtestChartRef.current?.applyOptions(options);
      if (!['BTC', 'ETH', 'SOL', 'VIX'].includes(selectedSymbol) && seriesRef.current) {
        (seriesRef.current as ISeriesApi<'Line'>).applyOptions({ color: theme.primary });
      }
      equitySeriesRef.current?.applyOptions({ color: theme.primary });
    };
    const observer = new MutationObserver(applyTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] });
    applyTheme();
    return () => observer.disconnect();
  }, [selectedSymbol]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !history || history.symbol !== selectedSymbol) return;
    if (selectedSymbol === 'BTC' || selectedSymbol === 'ETH' || selectedSymbol === 'SOL' || selectedSymbol === 'VIX') {
      (series as ISeriesApi<'Candlestick'>).setData(currentBars.map(bar => ({ ...bar, time: bar.time as Time })));
    } else {
      (series as ISeriesApi<'Line'>).setData(currentBars.map(bar => ({ time: bar.time as Time, value: bar.close })));
    }
    chartRef.current?.timeScale().fitContent();
    setChartMarkerEpoch(value => value + 1);
  }, [history, currentBars, selectedSymbol]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const item of drawingPriceLinesRef.current) item.series.removePriceLine(item.line);
    drawingPriceLinesRef.current = [];
    for (const series of indicatorSeriesRef.current) chart.removeSeries(series);
    indicatorSeriesRef.current = [];
    for (const series of drawingSeriesRef.current) chart.removeSeries(series);
    drawingSeriesRef.current = [];
    while (chart.panes().length > 1) chart.removePane(chart.panes().length - 1);

    if (!activeChartState || !history || history.symbol !== selectedSymbol || history.interval !== interval || !seriesRef.current) return;

    let paneIndex = 0;
    for (const indicator of activeChartState.indicators) {
      const oscillator = indicator.kind === 'rsi' || indicator.kind === 'atr';
      if (oscillator) {
        paneIndex++;
        if (paneIndex >= chart.panes().length) chart.addPane();
        chart.panes()[paneIndex].setStretchFactor(0.28);
      }
      const datasets = calculateIndicatorData(history.bars, indicator);
      const colors = indicator.kind === 'bollinger'
        ? [indicator.color, `${indicator.color}99`, `${indicator.color}99`]
        : [indicator.color];
      for (let index = 0; index < datasets.length; index++) {
        const indicatorSeries = chart.addSeries(LineSeries, {
          color: colors[index] ?? indicator.color,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        }, oscillator ? paneIndex : 0);
        indicatorSeries.setData(datasets[index]);
        indicatorSeriesRef.current.push(indicatorSeries);
      }
    }

    const priceSeries = seriesRef.current;
    for (const drawing of activeChartState.drawings) {
      if (drawing.kind === 'horizontal') {
        const line = priceSeries.createPriceLine({
          price: drawing.points[0].price,
          color: drawing.color,
          title: drawing.label,
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
        });
        drawingPriceLinesRef.current.push({ series: priceSeries, line });
      } else {
        const lineSeries = chart.addSeries(LineSeries, {
          color: drawing.color,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        }, 0);
        lineSeries.setData(drawing.points.map(point => ({ time: point.time as Time, value: point.price })));
        drawingSeriesRef.current.push(lineSeries);
      }
    }
  }, [activeChartState, history, interval, selectedSymbol]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series || !drawingMode || !activeChartState || chartWorkspaceSaving) return;
    const handleClick = (param: { point?: { x: number; y: number }; time?: Time }) => {
      if (!param.point || param.time === undefined) return;
      const time = toUnixSeconds(param.time);
      const price = series.coordinateToPrice(param.point.y);
      if (time === undefined || price === null || !Number.isFinite(price) || price <= 0) return;
      const point = { time, price };
      if (drawingMode === 'horizontal') {
        void addDrawing({ id: crypto.randomUUID(), kind: 'horizontal', points: [point], color: INDICATOR_COLORS.sma, label: 'Horizontal line' });
        setDrawingMode(null);
        return;
      }
      if (!pendingTrendPoint) {
        setPendingTrendPoint(point);
        return;
      }
      if (pendingTrendPoint.time === point.time) {
        setChartWorkspaceError('Trendline points must use different times.');
        setPendingTrendPoint(null);
        return;
      }
      void addDrawing({ id: crypto.randomUUID(), kind: 'trendline', points: [pendingTrendPoint, point], color: INDICATOR_COLORS.ema, label: 'Trend line' });
      setPendingTrendPoint(null);
      setDrawingMode(null);
    };
    chart.subscribeClick(handleClick);
    return () => chart.unsubscribeClick(handleClick);
  }, [activeChartState, chartWorkspaceSaving, drawingMode, pendingTrendPoint, selectedSymbol, interval]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    for (const item of positionLinesRef.current) item.series.removePriceLine(item.line);
    positionLinesRef.current = [];
    if (!chart || !series) return;
    const prefix = selectedSymbol === 'XAU' || selectedSymbol === 'XAG'
      ? selectedSymbol
      : ['BTC', 'ETH', 'SOL'].includes(selectedSymbol) ? selectedSymbol : '';
    if (!prefix) return;
    for (const position of positions) {
      if (!position.symbol.toUpperCase().startsWith(prefix)) continue;
      const color = position.type === 'buy' ? '#72c7a2' : '#e57769';
      const lines: Array<{ price: number; color: string; title: string }> = [
        { price: position.price_open, color, title: `${position.type.toUpperCase()} ${position.symbol} · ${position.volume} lots` },
        ...(position.sl > 0 ? [{ price: position.sl, color: '#e57769', title: `Stop loss · #${position.ticket}` }] : []),
        ...(position.tp > 0 ? [{ price: position.tp, color: '#72c7a2', title: `Take profit · #${position.ticket}` }] : []),
      ];
      for (const item of lines) {
        positionLinesRef.current.push({
          series,
          line: series.createPriceLine({ price: item.price, color: item.color, title: item.title, lineWidth: 1, lineStyle: 2, axisLabelVisible: true }),
        });
      }
    }
  }, [positions, selectedSymbol, history]);

  const priceLevelMarkers = useMemo(() => {
    const markers: Array<{ key: string; ticket: number; level: ProtectionLevel; price: number; y: number }> = [];
    const prefix = selectedSymbol === 'XAU' || selectedSymbol === 'XAG'
      ? selectedSymbol
      : ['BTC', 'ETH', 'SOL'].includes(selectedSymbol) ? selectedSymbol : '';
    if (!prefix) return markers;
    for (const position of positions) {
      if (!position.symbol.toUpperCase().startsWith(prefix)) continue;
      for (const level of ['stopLoss', 'takeProfit'] as const) {
      const key = `${position.ticket}:${level}`;
      const protection = positionProtections[position.ticket];
      const storedPrice = Number(protection?.[level]);
      const drag = activePriceDrag?.ticket === position.ticket && activePriceDrag.level === level ? activePriceDrag : null;
      const price = drag && drag.price !== null ? drag.price : storedPrice;
      const y = drag ? drag.y : seriesRef.current?.priceToCoordinate(price);
      if (!Number.isFinite(price) || price <= 0 || y === null || y === undefined) continue;
      markers.push({ key, ticket: position.ticket, level, price, y });
      }
    }
    return markers;
  }, [activePriceDrag, chartMarkerEpoch, positionProtections, positions, selectedSymbol]);

  useEffect(() => {
    if (!backtestChartContainerRef.current || backtestChartRef.current) return;
    const theme = readMarketChartTheme();
    const chart = createChart(backtestChartContainerRef.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: theme.background }, textColor: theme.text, fontFamily: 'Inter, sans-serif' },
      grid: { vertLines: { color: 'rgba(255,255,255,0.045)' }, horzLines: { color: 'rgba(255,255,255,0.045)' } },
      rightPriceScale: { borderColor: theme.border },
      timeScale: { borderColor: theme.border, timeVisible: true, secondsVisible: false },
    });
    const series = chart.addSeries(LineSeries, { color: theme.primary, lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
    backtestChartRef.current = chart;
    equitySeriesRef.current = series;
    const resizeObserver = new ResizeObserver(() => chart.timeScale().fitContent());
    resizeObserver.observe(backtestChartContainerRef.current);
    return () => {
      resizeObserver.disconnect();
      chart.remove();
      backtestChartRef.current = null;
      equitySeriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!backtest?.equityCurve.length) {
      equitySeriesRef.current?.setData([]);
      return;
    }
    equitySeriesRef.current?.setData(backtest.equityCurve);
    backtestChartRef.current?.timeScale().fitContent();
  }, [backtest]);

  async function runBacktest() {
    if (!history || history.symbol !== selectedSymbol) {
      setBacktest({ trades: 0, returnPct: 0, equity: 1, message: 'Load chart history before running the backtest.', equityCurve: [] });
      return;
    }
    const fastMatch = script.match(/fastLength\s*=\s*(?:input\.int\()?(\d+)/);
    const slowMatch = script.match(/slowLength\s*=\s*(?:input\.int\()?(\d+)/);
    const fastLength = Math.max(2, Math.min(200, Number(fastMatch?.[1] ?? 9)));
    const slowLength = Math.max(fastLength + 1, Math.min(500, Number(slowMatch?.[1] ?? 21)));
    const bars = history.bars;
    if (!script.includes('ta.crossover') || !script.includes('ta.crossunder') || bars.length < slowLength + 2) {
      setBacktest({ trades: 0, returnPct: 0, equity: 1, message: `Supported strategy subset: SMA crossover/crossunder with fastLength and slowLength inputs. Need at least ${slowLength + 2} bars.`, equityCurve: [] });
      return;
    }
    let position: number | null = null;
    let equity = 1;
    let trades = 0;
    const equityCurve: Array<{ time: Time; value: number }> = [{ time: bars[slowLength - 1].time as Time, value: equity }];
    const average = (end: number, length: number) => bars.slice(end - length + 1, end + 1).reduce((sum, bar) => sum + bar.close, 0) / length;
    for (let index = slowLength; index < bars.length; index++) {
      const previousFast = average(index - 1, fastLength);
      const previousSlow = average(index - 1, slowLength);
      const fast = average(index, fastLength);
      const slow = average(index, slowLength);
      if (position === null && previousFast <= previousSlow && fast > slow) position = bars[index].close;
      else if (position !== null && previousFast >= previousSlow && fast < slow) {
        equity *= bars[index].close / position;
        position = null;
        trades++;
      }
      const markedEquity = position === null ? equity : equity * bars[index].close / position;
      equityCurve.push({ time: bars[index].time as Time, value: markedEquity });
    }
    if (position !== null) {
      equity *= bars.at(-1)!.close / position;
      trades++;
    }
    setBacktest({
      trades,
      returnPct: (equity - 1) * 100,
      equity,
      message: `SMA crossover subset · ${bars.length} bars · ${fastLength}/${slowLength} periods. Fees, slippage and broker execution are not modeled.`,
      equityCurve,
    });
  }

  async function sendOrder(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMt5Busy(true);
    setMt5Error('');
    try {
      await request('/api/integrations/mt5/order', {
        method: 'POST',
        body: JSON.stringify({ symbol, side, volume: Number(volume), stopLoss: stopLoss ? Number(stopLoss) : undefined, takeProfit: takeProfit ? Number(takeProfit) : undefined }),
      });
      await loadPositions();
      await loadMt5();
    } catch (failure) {
      setMt5Error(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setMt5Busy(false);
    }
  }

  async function closePosition(ticket: number) {
    setMt5Busy(true);
    setMt5Error('');
    try {
      await request(`/api/integrations/mt5/positions/${ticket}/close`, { method: 'POST', body: '{}' });
      await loadPositions();
    } catch (failure) {
      setMt5Error(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setMt5Busy(false);
    }
  }

  async function modifyPosition(ticket: number, override?: { stopLoss: string; takeProfit: string }) {
    const protection = override ?? positionProtections[ticket];
    if (!protection) return;
    setMt5Busy(true);
    setMt5Error('');
    try {
      await request(`/api/integrations/mt5/positions/${ticket}`, {
        method: 'PATCH',
        body: JSON.stringify({
          stopLoss: protection.stopLoss ? Number(protection.stopLoss) : 0,
          takeProfit: protection.takeProfit ? Number(protection.takeProfit) : 0,
        }),
      });
      await loadPositions();
    } catch (failure) {
      setMt5Error(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setMt5Busy(false);
    }
  }

  function dragPriceLevel(event: React.PointerEvent<HTMLButtonElement>, ticket: number, level: ProtectionLevel, phase: 'start' | 'move' | 'finish') {
    event.preventDefault();
    event.stopPropagation();
    if (phase === 'start') {
      event.currentTarget.setPointerCapture(event.pointerId);
      const bounds = chartContainerRef.current?.getBoundingClientRect();
      setActivePriceDrag({ ticket, level, y: bounds ? event.clientY - bounds.top : 0, price: null });
      return;
    }
    if (phase === 'move') {
      const bounds = chartContainerRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const y = Math.max(0, Math.min(bounds.height, event.clientY - bounds.top));
      const price = seriesRef.current?.coordinateToPrice(y) ?? null;
      setActivePriceDrag(current => current ? { ...current, y, price } : null);
      return;
    }
    if (!activePriceDrag || activePriceDrag.ticket !== ticket || activePriceDrag.level !== level) return;
    const position = positionProtections[ticket] ?? { stopLoss: '', takeProfit: '' };
    const next = {
      ...position,
      [level]: activePriceDrag.price && activePriceDrag.price > 0
        ? String(Number(activePriceDrag.price.toPrecision(8)))
        : position[level],
    };
    setActivePriceDrag(null);
    if (next[level] !== position[level]) void modifyPosition(ticket, next);
  }

  const priceFormat = selectedQuote?.price !== undefined ? money(selectedSymbol, selectedQuote.price) : '—';

  return (
    <div className="resource-view markets-view">
      <header className="resource-header">
        <div>
          <div className="eyebrow">PUBLIC MARKET DATA</div>
          <h1>Markets</h1>
          <p>Keyless public quotes, broker-linked execution, and a responsive research workspace.</p>
        </div>
        <button className="button button-secondary" onClick={() => { void refresh(); void loadHistory(); void loadMt5(); }} disabled={refreshing}>
          <RefreshCw size={14} className={refreshing ? 'resource-spin' : ''} />{refreshing ? 'Refreshing' : 'Refresh'}
        </button>
      </header>
      {error && <div className="resource-alert" role="status">{error}</div>}
      {loading && !dashboard && <div className="loading-state"><ActivityOrb label="Connecting to public feeds" loading /><span>Connecting to public feeds…</span></div>}
      {dashboard && <>
        <div className="resource-summary">
          <span className={`resource-status resource-status-${dashboard.status}`}>{dashboard.status}</span>
          <span>{dashboard.sourceHealth.ok}/{dashboard.sourceHealth.enabled} feeds live</span>
          <span>{dashboard.vectors.count.toLocaleString()} vector records</span>
          <span>Updated {formatTimestamp(dashboard.lastRun?.completedAt ?? dashboard.timestamp)}</span>
        </div>

        <section className="resource-market-grid resource-market-grid-seven">
          {quotes.map(quote => (
            <button type="button" className={`surface-card resource-market-card${selectedSymbol === quote.symbol ? ' resource-market-card-selected' : ''}`} key={quote.symbol} onClick={() => setSelectedSymbol(quote.symbol)}>
              <span className="resource-market-top"><span className="eyebrow">{quote.symbol} · USD</span><span>{quote.status}</span></span>
              <strong>{quote.price !== undefined ? money(quote.symbol, quote.price) : '—'}</strong>
              <span className={quote.change !== undefined ? quote.change < 0 ? 'resource-negative' : 'resource-positive' : 'resource-muted'}>
                {quote.change !== undefined ? <>{quote.change < 0 ? <ArrowDownRight size={13} /> : <ArrowUpRight size={13} />}{quote.change.toFixed(2)}%</> : quote.label}
              </span>
            </button>
          ))}
        </section>

        <div className="markets-workspace">
          <section className="surface-card markets-chart-panel">
            <div className="markets-chart-heading">
              <div><div className="eyebrow">{selectedSymbol} · {selectedQuote?.label}</div><h2>{priceFormat}</h2></div>
              <div className="markets-chart-actions">
                <span className="markets-live-indicator"><i />{historyLoading ? 'Updating' : 'Public feed'}</span>
                <ChartCandlestick size={17} />
              </div>
            </div>
            <div className="markets-intervals">{hasExchangeIntervals
              ? INTERVALS.map(value => <button type="button" key={value} className={interval === value ? 'active' : ''} onClick={() => setInterval(value)}>{value}</button>)
              : <span className="markets-data-frequency">{dailyReference ? 'Daily reference data' : 'Live spot samples · no historical candles'}</span>}</div>
            <div className="markets-chart-tools">
              <div className="markets-chart-tool-group">
                <select aria-label="Indicator" value={indicatorKind} onChange={event => setIndicatorKind(event.target.value as MarketIndicatorKind)}>
                  <option value="sma">SMA</option><option value="ema">EMA</option><option value="rsi">RSI</option><option value="atr">ATR</option><option value="bollinger">Bollinger</option>
                </select>
                <input aria-label="Indicator period" type="number" min="2" max="500" step="1" value={indicatorPeriod} onChange={event => setIndicatorPeriod(event.target.value)} />
                <button type="button" className="button button-secondary" onClick={() => void addIndicator()} disabled={!activeChartState || chartWorkspaceLoading || chartWorkspaceSaving || Boolean(activeChartState.error)}>
                  <Plus size={13} />Add indicator
                </button>
              </div>
              <div className="markets-chart-tool-group">
                <button type="button" className={`button button-secondary${drawingMode === 'horizontal' ? ' active' : ''}`} onClick={() => { setDrawingMode(drawingMode === 'horizontal' ? null : 'horizontal'); setPendingTrendPoint(null); }} disabled={!activeChartState || chartWorkspaceLoading || Boolean(activeChartState.error)}>Horizontal line</button>
                <button type="button" className={`button button-secondary${drawingMode === 'trendline' ? ' active' : ''}`} onClick={() => { setDrawingMode(drawingMode === 'trendline' ? null : 'trendline'); setPendingTrendPoint(null); }} disabled={!activeChartState || chartWorkspaceLoading || Boolean(activeChartState.error)}>Trend line</button>
                {drawingMode && <span className="markets-data-frequency">{drawingMode === 'trendline' && pendingTrendPoint ? 'Choose the second point' : 'Click the chart to draw'}</span>}
              </div>
            </div>
            {(chartWorkspaceLoading || chartWorkspaceSaving) && <p className="markets-data-frequency">{chartWorkspaceSaving ? 'Saving chart workspace…' : 'Loading saved chart workspace…'}</p>}
            {chartWorkspaceError && <p className="resource-alert" role="alert">{chartWorkspaceError}</p>}
            {activeChartState && (activeChartState.indicators.length > 0 || activeChartState.drawings.length > 0) && <div className="markets-chart-items">
              {activeChartState.indicators.map(item => <span className="markets-chart-item" key={item.id}>
                {item.kind.toUpperCase()} {item.period}
                <button type="button" onClick={() => void removeIndicator(item.id)} disabled={chartWorkspaceSaving} aria-label={`Remove ${item.kind.toUpperCase()} ${item.period}`}><Trash2 size={12} /></button>
              </span>)}
              {activeChartState.drawings.map(item => <span className="markets-chart-item" key={item.id}>
                {item.label}
                <button type="button" onClick={() => void removeDrawing(item.id)} disabled={chartWorkspaceSaving} aria-label={`Remove ${item.label}`}><Trash2 size={12} /></button>
              </span>)}
            </div>}
            <div ref={chartContainerRef} className="markets-chart" aria-label={`${selectedSymbol} price chart`}>
              <div className="markets-price-level-overlay">
                {priceLevelMarkers.map(marker => <button
                  type="button"
                  key={marker.key}
                  className={`markets-price-level markets-price-level-${marker.level}`}
                  style={{ top: `${marker.y}px` }}
                  aria-label={`Drag ${marker.level === 'stopLoss' ? 'stop loss' : 'take profit'} for position ${marker.ticket}; current price ${marker.price}`}
                  onPointerDown={event => dragPriceLevel(event, marker.ticket, marker.level, 'start')}
                  onPointerMove={event => dragPriceLevel(event, marker.ticket, marker.level, 'move')}
                  onPointerUp={event => dragPriceLevel(event, marker.ticket, marker.level, 'finish')}
                  onPointerCancel={() => setActivePriceDrag(null)}
                >{marker.level === 'stopLoss' ? 'SL' : 'TP'} · #{marker.ticket}</button>)}
              </div>
            </div>
            {historyError && <p className="resource-alert" role="alert">{historyError}</p>}
            {history?.note && <p className="markets-data-note"><CircleAlert size={13} />{history.note}</p>}
            {priceLevelMarkers.length > 0 && <p className="markets-data-note">Drag an SL or TP line to update that protection level on the configured MT5 account.</p>}
            {history && <div className="markets-chart-source">{history.source} · Updated {formatTimestamp(history.updatedAt)}</div>}
          </section>

          <aside className="surface-card mt5-actionbar">
            <div className="mt5-actionbar-heading"><div><div className="eyebrow">BROKER ACTIONS</div><h2>MetaTrader 5</h2></div><Shield size={16} /></div>
            <div className={`mt5-connection-state${mt5?.connected ? ' connected' : ''}`}><i />{mt5?.connected ? `Connected · ${mt5.latencyMs} ms` : mt5?.configured ? 'Not connected' : 'Configure account in Integrations'}</div>
            {mt5?.tick && <small className="mt5-tick-reading">{mt5.tick.symbol} · bid {mt5.tick.bid} · ask {mt5.tick.ask}</small>}
            <form className="mt5-order-form" onSubmit={event => void sendOrder(event)}>
              <label>Instrument<input value={symbol} onChange={event => setSymbol(event.target.value.toUpperCase())} maxLength={24} required /></label>
              <div className="mt5-side-switch"><button type="button" className={side === 'buy' ? 'active' : ''} onClick={() => setSide('buy')}>Buy</button><button type="button" className={side === 'sell' ? 'active sell' : ''} onClick={() => setSide('sell')}>Sell</button></div>
              <label>Volume (lots)<input type="number" step="0.01" min="0.01" max="100" value={volume} onChange={event => setVolume(event.target.value)} required /></label>
              <div className="mt5-risk-fields"><label>Stop loss<input type="number" step="any" min="0" value={stopLoss} onChange={event => setStopLoss(event.target.value)} placeholder="Optional" /></label><label>Take profit<input type="number" step="any" min="0" value={takeProfit} onChange={event => setTakeProfit(event.target.value)} placeholder="Optional" /></label></div>
              <button type="submit" className="button button-primary mt5-submit" disabled={!mt5?.connected || mt5Busy}><TrendingUp size={14} />{mt5Busy ? 'Sending…' : `${side === 'buy' ? 'Buy' : 'Sell'} ${symbol}`}</button>
            </form>
            {mt5Error && <p className="cloud-provider-error" role="alert">{mt5Error}</p>}
            <div className="mt5-open-positions-heading">Open positions <button type="button" onClick={() => void loadPositions()} aria-label="Refresh open positions"><RefreshCw size={12} /></button></div>
            <div className="mt5-open-positions">
              {positions.map(position => <div className="mt5-position-row" key={position.ticket}>
                <span><strong>{position.symbol}</strong><small>{position.type} · {position.volume} lots · #{position.ticket}</small></span>
                <span className={position.profit < 0 ? 'resource-negative' : 'resource-positive'}>{position.profit.toFixed(2)}<button type="button" onClick={() => void closePosition(position.ticket)} disabled={mt5Busy}>Close</button></span>
                <div className="mt5-position-protection">
                  <label>SL<input type="number" step="any" min="0" value={positionProtections[position.ticket]?.stopLoss ?? ''} onChange={event => setPositionProtections(current => ({ ...current, [position.ticket]: { ...current[position.ticket], stopLoss: event.target.value, takeProfit: current[position.ticket]?.takeProfit ?? '' } }))} /></label>
                  <label>TP<input type="number" step="any" min="0" value={positionProtections[position.ticket]?.takeProfit ?? ''} onChange={event => setPositionProtections(current => ({ ...current, [position.ticket]: { ...current[position.ticket], stopLoss: current[position.ticket]?.stopLoss ?? '', takeProfit: event.target.value } }))} /></label>
                  <button type="button" onClick={() => void modifyPosition(position.ticket)} disabled={mt5Busy}>Update risk</button>
                </div>
              </div>)}
              {!positions.length && <small className="resource-muted">No open positions reported.</small>}
            </div>
            <small className="mt5-trading-disclaimer">Orders execute on the currently configured MT5 account. Check the symbol, volume and risk levels before submitting.</small>
          </aside>
        </div>

        <section className="surface-card markets-lab">
          <div className="section-heading"><div><div className="eyebrow">STRATEGY RESEARCH</div><h2>Script editor & backtest</h2></div><span className="subtle-label">OFFLINE · HISTORICAL BARS</span></div>
          <p className="resource-muted">Pine-style editor with a deliberately bounded, non-evaluating SMA crossover strategy subset. It does not execute arbitrary code or submit broker orders.</p>
          <div className="markets-editor"><Editor height="320px" defaultLanguage="javascript" language="javascript" theme="vs-dark" value={script} onChange={value => setScript(value ?? '')} options={{ minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, automaticLayout: true, wordWrap: 'on', lineNumbers: 'on' }} /></div>
          <div className="markets-backtest-controls"><button className="button button-primary" type="button" onClick={() => void runBacktest()}><Play size={14} />Run backtest on {selectedSymbol}</button><span>{currentBars.length.toLocaleString()} bars · {history?.source ?? 'No history loaded'}</span></div>
          {backtest && <div className="markets-backtest-result"><div><small>Net return</small><strong className={backtest.returnPct < 0 ? 'resource-negative' : 'resource-positive'}>{backtest.returnPct.toFixed(2)}%</strong></div><div><small>Trades</small><strong>{backtest.trades}</strong></div><div><small>Equity multiple</small><strong>{backtest.equity.toFixed(3)}×</strong></div><p>{backtest.message}</p></div>}
          <div className="markets-backtest-chart-heading"><span className="eyebrow">STRATEGY EQUITY CURVE</span><span>Starting equity = 1.0×</span></div>
          <div ref={backtestChartContainerRef} className="markets-backtest-chart" aria-label="Strategy backtest equity curve" />
        </section>

        <section className="surface-card markets-chat">
          <div className="section-heading"><div><div className="eyebrow">MARKETS CONVERSATION</div><h2>Ask the agent</h2></div><span className="subtle-label">{marketChatBusy ? 'RESPONDING' : marketChatLoading ? 'CONNECTING' : 'DEDICATED SESSION'}</span></div>
          <div className="markets-chat-history" aria-live="polite" aria-label="Markets conversation">
            {marketMessages.slice(-20).map(message => <article className={`markets-chat-message markets-chat-message-${message.role}`} key={message.id}>
              <span>{message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Agent' : 'System'}</span>
              <p>{message.content || (marketChatBusy && message.role === 'assistant' ? 'Thinking…' : '')}</p>
            </article>)}
            <div ref={marketChatEndRef} />
            {!marketMessages.length && !marketChatLoading && <p className="resource-muted">Ask about this chart, market data, or connected trading accounts.</p>}
          </div>
          {marketChatError && <p className="resource-alert" role="alert">{marketChatError}</p>}
          <form className="markets-chat-composer" onSubmit={event => void sendMarketMessage(event)}>
            <textarea value={marketDraft} onChange={event => setMarketDraft(event.target.value)} placeholder="Ask about the selected market…" rows={2} aria-label="Message the Markets agent" disabled={!marketSessionId || marketChatLoading} />
            <button type="button" className={`markets-chat-mic${marketRecording ? ' recording' : ''}`} aria-label={marketRecording ? 'Release to transcribe' : 'Hold to dictate'} aria-pressed={marketRecording}
              onPointerDown={event => { event.preventDefault(); void startMarketRecording(); }}
              onPointerUp={stopMarketRecording}
              onPointerLeave={() => { if (marketRecording) stopMarketRecording(); }}
              onPointerCancel={stopMarketRecording}
              onKeyDown={event => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); void startMarketRecording(); } }}
              onKeyUp={event => { if (event.key === ' ' || event.key === 'Enter') stopMarketRecording(); }}
              disabled={marketChatBusy || marketChatLoading}>
              <Mic size={16} />
            </button>
            <button type="submit" className="button button-primary markets-chat-send" aria-label="Send Markets message" disabled={marketChatBusy || !marketSessionId || !marketDraft.trim()}>
              <Send size={15} />
            </button>
          </form>
          <small className="resource-muted">Hold the microphone button to dictate. Audio is transcribed locally by Symbiote’s speech-to-text service.</small>
        </section>

        <details className="surface-card resource-source-list markets-provenance">
          <summary className="markets-provenance-summary"><span><span className="eyebrow">DATA PROVENANCE</span><strong>Market sources & limitations</strong></span><span>{sources.filter(source => source.category === 'markets').length} sources</span></summary>
          {sources.filter(source => source.category === 'markets').map(source => (
            <div className="resource-source-row" key={source.id}>
              <div><strong>{source.label}</strong><p>{source.description}</p></div>
              <div className="resource-source-meta"><span className={`resource-status resource-status-${source.status}`}>{sourceStatusLabel(source.status)}</span><span>{formatTimestamp(source.fetchedAt)}</span></div>
            </div>
          ))}
          <p className="markets-data-note">Crypto: public exchange candles. Gold/silver: public spot quotes (chart samples while open, no historical series from this source). DXY: calculated reference-rate estimate, not the exchange index. VIX: CBOE daily history; not intraday. Public providers may rate-limit or change availability.</p>
        </details>
      </>}
    </div>
  );
}
