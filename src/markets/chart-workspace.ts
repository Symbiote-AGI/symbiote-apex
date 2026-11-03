import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MARKET_CHART_SYMBOLS = ['BTC', 'ETH', 'SOL', 'XAU', 'XAG', 'DXY', 'VIX'] as const;
export const MARKET_CHART_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export const MARKET_INDICATOR_KINDS = ['sma', 'ema', 'rsi', 'atr', 'bollinger'] as const;

export type MarketChartSymbol = typeof MARKET_CHART_SYMBOLS[number];
export type MarketChartInterval = typeof MARKET_CHART_INTERVALS[number];
export type MarketIndicatorKind = typeof MARKET_INDICATOR_KINDS[number];
export type MarketDrawingKind = 'horizontal' | 'trendline';

export interface MarketChartIndicator {
  id: string;
  kind: MarketIndicatorKind;
  period: number;
  color: string;
}

export interface MarketChartPoint {
  time: number;
  price: number;
}

export interface MarketChartDrawing {
  id: string;
  kind: MarketDrawingKind;
  points: MarketChartPoint[];
  color: string;
  label: string;
}

export interface MarketChartState {
  symbol: MarketChartSymbol;
  interval: MarketChartInterval;
  indicators: MarketChartIndicator[];
  drawings: MarketChartDrawing[];
  updatedAt: number;
  error?: string;
}

interface StoredChartWorkspace {
  version: 1;
  charts: Record<string, MarketChartState>;
}

const DEFAULT_COLOR = '#77d5bd';
const MAX_INDICATORS = 10;
const MAX_DRAWINGS = 200;
const MAX_LABEL_LENGTH = 80;
const COLOR_PATTERN = /^#[\da-f]{6}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function chartScope(symbol: unknown, interval: unknown): { symbol: MarketChartSymbol; interval: MarketChartInterval; key: string } {
  if (typeof symbol !== 'string' || !MARKET_CHART_SYMBOLS.includes(symbol as MarketChartSymbol)) {
    throw new Error(`Market chart symbol must be one of: ${MARKET_CHART_SYMBOLS.join(', ')}.`);
  }
  if (typeof interval !== 'string' || !MARKET_CHART_INTERVALS.includes(interval as MarketChartInterval)) {
    throw new Error(`Market chart interval must be one of: ${MARKET_CHART_INTERVALS.join(', ')}.`);
  }
  return {
    symbol: symbol as MarketChartSymbol,
    interval: interval as MarketChartInterval,
    key: `${symbol}:${interval}`,
  };
}

function safeId(value: unknown, field: string, create = false): string {
  if (value === undefined && create) return crypto.randomUUID();
  if (typeof value !== 'string' || !/^[\w.-]{1,80}$/.test(value)) {
    throw new Error(`${field} must be 1-80 letters, numbers, periods, underscores or hyphens.`);
  }
  return value;
}

function safeColor(value: unknown): string {
  if (value === undefined) return DEFAULT_COLOR;
  if (typeof value !== 'string' || !COLOR_PATTERN.test(value)) throw new Error('Chart colors must use six-digit hex notation.');
  return value.toLowerCase();
}

function parseIndicator(value: unknown, createId = false): MarketChartIndicator {
  if (!isRecord(value) || typeof value.kind !== 'string'
    || !MARKET_INDICATOR_KINDS.includes(value.kind as MarketIndicatorKind)) {
    throw new Error(`Indicator kind must be one of: ${MARKET_INDICATOR_KINDS.join(', ')}.`);
  }
  const period = value.period === undefined ? 20 : value.period;
  if (typeof period !== 'number' || !Number.isSafeInteger(period) || period < 2 || period > 500) {
    throw new Error('Indicator period must be a whole number from 2 to 500.');
  }
  return {
    id: safeId(value.id, 'Indicator id', createId),
    kind: value.kind as MarketIndicatorKind,
    period,
    color: safeColor(value.color),
  };
}

function parseDrawing(value: unknown, createId = false): MarketChartDrawing {
  if (!isRecord(value) || (value.kind !== 'horizontal' && value.kind !== 'trendline')) {
    throw new Error('Drawing kind must be horizontal or trendline.');
  }
  const expectedPoints = value.kind === 'horizontal' ? 1 : 2;
  if (!Array.isArray(value.points) || value.points.length !== expectedPoints) {
    throw new Error(`${value.kind} drawings require exactly ${expectedPoints} chart point${expectedPoints === 1 ? '' : 's'}.`);
  }
  const points = value.points.map((point, index): MarketChartPoint => {
    if (!isRecord(point) || typeof point.time !== 'number' || !Number.isSafeInteger(point.time) || point.time <= 0
      || typeof point.price !== 'number' || !Number.isFinite(point.price) || point.price <= 0) {
      throw new Error(`Drawing point ${index + 1} must have a positive timestamp and price.`);
    }
    return { time: point.time, price: point.price };
  });
  if (value.kind === 'trendline' && points[0].time === points[1].time) {
    throw new Error('Trendline points must have different timestamps.');
  }
  const label = value.label === undefined ? (value.kind === 'horizontal' ? 'Horizontal line' : 'Trend line') : value.label;
  if (typeof label !== 'string' || label.length > MAX_LABEL_LENGTH || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new Error(`Drawing labels must be ${MAX_LABEL_LENGTH} characters or fewer and contain no control characters.`);
  }
  return {
    id: safeId(value.id, 'Drawing id', createId),
    kind: value.kind,
    points,
    color: safeColor(value.color),
    label,
  };
}

function parseArray<T>(value: unknown, field: string, maxLength: number, parseItem: (entry: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > maxLength) {
    throw new Error(`${field} must be an array containing no more than ${maxLength} entries.`);
  }
  const parsed = value.map(parseItem);
  const ids = new Set<string>();
  for (const entry of parsed) {
    const id = (entry as { id: string }).id;
    if (ids.has(id)) throw new Error(`${field} cannot contain duplicate IDs.`);
    ids.add(id);
  }
  return parsed;
}

export class MarketChartWorkspaceStore {
  private readonly filename: string;
  private readonly charts = new Map<string, MarketChartState>();
  private loadError?: string;

  constructor(workspace: string) {
    this.filename = path.resolve(workspace, '.symbiote', 'markets', 'chart-state.json');
    this.load();
  }

  get(symbol: unknown, interval: unknown): MarketChartState {
    const scope = chartScope(symbol, interval);
    const saved = this.charts.get(scope.key);
    return saved
      ? structuredClone(saved)
      : {
        symbol: scope.symbol,
        interval: scope.interval,
        indicators: [],
        drawings: [],
        updatedAt: 0,
        ...(this.loadError ? { error: this.loadError } : {}),
      };
  }

  replace(symbol: unknown, interval: unknown, input: unknown): MarketChartState {
    const scope = chartScope(symbol, interval);
    if (this.loadError) throw new Error(`Saved chart state is unavailable and was not overwritten: ${this.loadError}`);
    if (!isRecord(input)) throw new Error('Chart state must be a JSON object.');
    const state: MarketChartState = {
      symbol: scope.symbol,
      interval: scope.interval,
      indicators: parseArray(input.indicators, 'indicators', MAX_INDICATORS, entry => parseIndicator(entry)),
      drawings: parseArray(input.drawings, 'drawings', MAX_DRAWINGS, entry => parseDrawing(entry)),
      updatedAt: Date.now(),
    };
    this.persist(scope.key, state);
    this.charts.set(scope.key, state);
    return structuredClone(state);
  }

  addIndicator(symbol: unknown, interval: unknown, indicator: unknown): MarketChartState {
    const scope = chartScope(symbol, interval);
    const current = this.get(scope.symbol, scope.interval);
    const parsed = parseIndicator(indicator, true);
    if (current.indicators.length >= MAX_INDICATORS) throw new Error(`A chart can have at most ${MAX_INDICATORS} indicators.`);
    if (current.indicators.some(item => item.kind === parsed.kind && item.period === parsed.period)) {
      throw new Error(`A ${parsed.kind.toUpperCase()} ${parsed.period} indicator is already present.`);
    }
    return this.replace(scope.symbol, scope.interval, { ...current, indicators: [...current.indicators, parsed] });
  }

  removeIndicator(symbol: unknown, interval: unknown, id: unknown): MarketChartState {
    const scope = chartScope(symbol, interval);
    const indicatorId = safeId(id, 'Indicator id');
    const current = this.get(scope.symbol, scope.interval);
    const indicators = current.indicators.filter(item => item.id !== indicatorId);
    if (indicators.length === current.indicators.length) throw new Error(`Indicator "${indicatorId}" was not found.`);
    return this.replace(scope.symbol, scope.interval, { ...current, indicators });
  }

  addDrawing(symbol: unknown, interval: unknown, drawing: unknown): MarketChartState {
    const scope = chartScope(symbol, interval);
    const current = this.get(scope.symbol, scope.interval);
    const parsed = parseDrawing(drawing, true);
    if (current.drawings.length >= MAX_DRAWINGS) throw new Error(`A chart can have at most ${MAX_DRAWINGS} drawings.`);
    return this.replace(scope.symbol, scope.interval, { ...current, drawings: [...current.drawings, parsed] });
  }

  removeDrawing(symbol: unknown, interval: unknown, id: unknown): MarketChartState {
    const scope = chartScope(symbol, interval);
    const drawingId = safeId(id, 'Drawing id');
    const current = this.get(scope.symbol, scope.interval);
    const drawings = current.drawings.filter(item => item.id !== drawingId);
    if (drawings.length === current.drawings.length) throw new Error(`Drawing "${drawingId}" was not found.`);
    return this.replace(scope.symbol, scope.interval, { ...current, drawings });
  }

  private load(): void {
    let contents: string;
    try {
      contents = fs.readFileSync(this.filename, 'utf8');
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.failLoad(`Could not read saved market chart state at ${this.filename}.`, failure);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(contents);
      if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.charts)) {
        throw new Error('Saved market chart state uses an unsupported format.');
      }
      for (const [key, chart] of Object.entries(parsed.charts)) {
        if (!isRecord(chart)) throw new Error(`Saved market chart "${key}" is invalid.`);
        const scope = chartScope(chart.symbol, chart.interval);
        if (scope.key !== key || typeof chart.updatedAt !== 'number' || !Number.isFinite(chart.updatedAt)) {
          throw new Error(`Saved market chart "${key}" has inconsistent metadata.`);
        }
        this.charts.set(key, {
          symbol: scope.symbol,
          interval: scope.interval,
          indicators: parseArray(chart.indicators, 'indicators', MAX_INDICATORS, entry => parseIndicator(entry)),
          drawings: parseArray(chart.drawings, 'drawings', MAX_DRAWINGS, entry => parseDrawing(entry)),
          updatedAt: chart.updatedAt,
        });
      }
    } catch (failure) {
      this.charts.clear();
      this.failLoad(`Saved market chart state at ${this.filename} is invalid and will not be overwritten.`, failure);
    }
  }

  private failLoad(message: string, failure: unknown): void {
    this.loadError = `${message} ${failure instanceof Error ? failure.message : String(failure)}`;
    console.error(`[markets] ${this.loadError}`);
  }

  private persist(key: string, state: MarketChartState): void {
    const charts = Object.fromEntries(this.charts);
    charts[key] = state;
    const temporary = `${this.filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, charts } satisfies StoredChartWorkspace)}\n`, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, this.filename);
    } catch (failure) {
      throw new Error(`Could not persist market chart state at ${this.filename}.`, { cause: failure });
    } finally {
      if (fs.existsSync(temporary)) {
        try {
          fs.unlinkSync(temporary);
        } catch (failure) {
          if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new Error(`Could not remove temporary market chart state at ${temporary}.`, { cause: failure });
          }
        }
      }
    }
  }
}
