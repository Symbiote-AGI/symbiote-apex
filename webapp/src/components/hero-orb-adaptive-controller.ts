import type { HeroOrbState } from './activity-orb-state';

const STORAGE_KEY = 'symbiote.hero-orb-calibration.v1';
const STATES: HeroOrbState[] = ['idle', 'thinking', 'executing', 'responding'];
const TARGET_SETTLE_SECONDS = 1;
const MIN_TRANSITION_RATE = 2.4;
const MAX_TRANSITION_RATE = 4.8;
const MIN_RENDER_SCALE = 0.7;

interface PersistedCalibration {
  version: 1;
  transitionRates: Record<HeroOrbState, number>;
  renderScale: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isTransitionRateRecord(value: Record<string, unknown>): value is Record<HeroOrbState, number> {
  return STATES.every(state => isInRange(value[state], MIN_TRANSITION_RATE, MAX_TRANSITION_RATE));
}

export default class HeroOrbAdaptiveController {
  private transitionRates: Record<HeroOrbState, number> = {
    idle: 3.2,
    thinking: 3.2,
    executing: 3.2,
    responding: 3.2,
  };
  private renderScale = 1;
  private frameTimeEma = 1000 / 60;
  private frameSamples = 0;
  private slowFrameSamples = 0;
  private persistenceUnavailable = false;

  constructor() {
    this.loadCalibration();
  }

  getTransitionRate(state: HeroOrbState): number {
    return this.transitionRates[state];
  }

  getPixelRatio(basePixelRatio: number): number {
    return clamp(basePixelRatio, 0.5, 2) * this.renderScale;
  }

  recordTransition(state: HeroOrbState, settleTimeSeconds: number): void {
    if (!Number.isFinite(settleTimeSeconds) || settleTimeSeconds < 0.2 || settleTimeSeconds > 5) return;

    const relativeError = Math.log(settleTimeSeconds / TARGET_SETTLE_SECONDS);
    const adjustment = clamp(relativeError * 0.12, -0.04, 0.04);
    const currentRate = this.transitionRates[state];
    const nextRate = clamp(currentRate * Math.exp(adjustment), MIN_TRANSITION_RATE, MAX_TRANSITION_RATE);
    if (Math.abs(nextRate - currentRate) < 0.002) return;

    this.transitionRates[state] = nextRate;
    this.persistCalibration();
  }

  observeFrame(frameTimeMs: number): boolean {
    if (!Number.isFinite(frameTimeMs) || frameTimeMs < 0) return false;

    const boundedFrameTime = clamp(frameTimeMs, 0, 100);
    this.frameTimeEma += (boundedFrameTime - this.frameTimeEma) * 0.04;
    this.frameSamples++;
    if (boundedFrameTime > 22) this.slowFrameSamples++;
    if (this.frameSamples < 90) return false;

    const slowFrameRatio = this.slowFrameSamples / this.frameSamples;
    const nextRenderScale = this.frameTimeEma > 20 && slowFrameRatio > 0.1
      ? Math.max(MIN_RENDER_SCALE, this.renderScale * 0.9)
      : this.frameTimeEma < 16.5 && slowFrameRatio < 0.05
        ? Math.min(1, this.renderScale + 0.02)
        : this.renderScale;
    this.frameSamples = 0;
    this.slowFrameSamples = 0;

    if (Math.abs(nextRenderScale - this.renderScale) < 0.001) return false;
    this.renderScale = nextRenderScale;
    this.persistCalibration();
    return true;
  }

  private loadCalibration(): void {
    if (typeof window === 'undefined') return;

    let serialized: string | null;
    try {
      serialized = window.localStorage.getItem(STORAGE_KEY);
    } catch (failure) {
      this.warnPersistence('Calibration could not be read:', failure);
      return;
    }
    if (!serialized) return;

    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch (failure) {
      console.warn('[hero-orb] Saved calibration is invalid JSON:', failure);
      return;
    }
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.transitionRates)) {
      console.warn('[hero-orb] Saved calibration has an unsupported format.');
      return;
    }

    const rates = value.transitionRates;
    const renderScale = value.renderScale;
    if (!isTransitionRateRecord(rates) || !isInRange(renderScale, MIN_RENDER_SCALE, 1)) {
      console.warn('[hero-orb] Saved calibration values are outside safe limits.');
      return;
    }

    this.transitionRates = {
      idle: rates.idle,
      thinking: rates.thinking,
      executing: rates.executing,
      responding: rates.responding,
    };
    this.renderScale = renderScale;
  }

  private persistCalibration(): void {
    if (typeof window === 'undefined' || this.persistenceUnavailable) return;

    const calibration: PersistedCalibration = {
      version: 1,
      transitionRates: this.transitionRates,
      renderScale: this.renderScale,
    };
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(calibration));
    } catch (failure) {
      this.warnPersistence('Calibration could not be saved:', failure);
    }
  }

  private warnPersistence(message: string, failure: unknown): void {
    if (this.persistenceUnavailable) return;
    this.persistenceUnavailable = true;
    console.warn(`[hero-orb] ${message}`, failure);
  }
}
