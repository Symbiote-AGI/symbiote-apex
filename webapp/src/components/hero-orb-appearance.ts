import type { HeroOrbState } from './activity-orb-state';

export const HERO_ORB_APPEARANCE_STORAGE_KEY = 'symbiote.hero-orb-appearance.v1';

export const HERO_ORB_STATES = [
  { id: 'idle', label: 'Idle' },
  { id: 'thinking', label: 'Thinking' },
  { id: 'executing', label: 'Executing' },
  { id: 'responding', label: 'Responding' },
] as const satisfies readonly { id: HeroOrbState; label: string }[];

export interface HeroOrbAppearance {
  brightness: number;
  hues: Record<HeroOrbState, number>;
}

export function createDefaultHeroOrbAppearance(): HeroOrbAppearance {
  return {
    brightness: 0,
    hues: {
      idle: 205,
      thinking: 275,
      executing: 150,
      responding: 28,
    },
  };
}

export function parseHeroOrbAppearance(value: unknown): HeroOrbAppearance | null {
  if (!isRecord(value)
    || !isInRange(value.brightness, 0, 1)
    || !isRecord(value.hues)
    || !hasValidHues(value.hues)) return null;

  return {
    brightness: value.brightness,
    hues: {
      idle: value.hues.idle,
      thinking: value.hues.thinking,
      executing: value.hues.executing,
      responding: value.hues.responding,
    },
  };
}

export function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  if (saturation === 0) return [lightness, lightness, lightness];

  const normalizedHue = ((hue % 360) + 360) % 360 / 360;
  const q = lightness < 0.5
    ? lightness * (1 + saturation)
    : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  const channel = (offset: number) => {
    let value = normalizedHue + offset;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };

  return [channel(1 / 3), channel(0), channel(-1 / 3)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function hasValidHues(value: Record<string, unknown>): value is Record<HeroOrbState, number> {
  return HERO_ORB_STATES.every(({ id }) => isInRange(value[id], 0, 360));
}
