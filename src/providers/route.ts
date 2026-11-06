import type { Provider } from './types.js';

const PROVIDER_API_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  cloudflare: 'CLOUDFLARE_API_TOKEN',
};

export interface ProviderRouteChoice {
  name: string;
  provider: Provider;
  model: string;
  routed: boolean;
}

export function selectProviderRoute(
  decision: { provider: string; model: string },
  registry: ReadonlyMap<string, Provider>,
  providerConfigs: Record<string, { apiKey?: string; model?: string; models?: readonly string[] } | undefined>,
  fallback: Omit<ProviderRouteChoice, 'routed'>,
  explicitlyAllowedProviders: readonly string[] = [],
): ProviderRouteChoice {
  const provider = registry.get(decision.provider);
  if (!provider) return { ...fallback, routed: false };

  const isFallbackProvider = decision.provider === fallback.name;
  const isExplicitlyAllowed = explicitlyAllowedProviders.includes(decision.provider);
  const configuredModel = isFallbackProvider
    ? fallback.model
    : providerConfigs[decision.provider]?.model;
  const allowedModels = providerConfigs[decision.provider]?.models ?? [];
  const isConfiguredModel = decision.model === configuredModel || allowedModels.includes(decision.model);
  if ((!isFallbackProvider && !isExplicitlyAllowed) || !isConfiguredModel) {
    return { ...fallback, routed: false };
  }

  const envKey = PROVIDER_API_KEYS[decision.provider];
  const hasApiKey = Boolean(providerConfigs[decision.provider]?.apiKey || (envKey && process.env[envKey]));
  if (!isFallbackProvider && !hasApiKey) {
    return { ...fallback, routed: false };
  }

  return {
    name: decision.provider,
    provider,
    model: decision.model,
    routed: true,
  };
}