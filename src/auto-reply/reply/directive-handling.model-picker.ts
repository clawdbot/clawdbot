import { type ModelRef, normalizeProviderId } from "../../agents/model-selection.js";
import type { MoltbotConfig } from "../../config/config.js";

export type ModelPickerCatalogEntry = {
  provider: string;
  id: string;
  name?: string;
};

export type ModelPickerItem = ModelRef;

const MODEL_PICK_PROVIDER_PREFERENCE = [
  "anthropic",
  "openai",
  "openai-codex",
  "minimax",
  "synthetic",
  "google",
  "zai",
  "openrouter",
  "opencode",
  "github-copilot",
  "groq",
  "cerebras",
  "mistral",
  "xai",
  "lmstudio",
] as const;

const PROVIDER_RANK = new Map<string, number>(
  MODEL_PICK_PROVIDER_PREFERENCE.map((provider, idx) => [provider, idx]),
);

function compareProvidersForPicker(a: string, b: string): number {
  const pa = PROVIDER_RANK.get(a);
  const pb = PROVIDER_RANK.get(b);
  if (pa !== undefined && pb !== undefined) return pa - pb;
  if (pa !== undefined) return -1;
  if (pb !== undefined) return 1;
  return a.localeCompare(b);
}

export function buildModelPickerItems(catalog: ModelPickerCatalogEntry[]): ModelPickerItem[] {
  const seen = new Set<string>();
  const out: ModelPickerItem[] = [];

  for (const entry of catalog) {
    const provider = normalizeProviderId(entry.provider);
    const model = entry.id?.trim();
    if (!provider || !model) continue;

    const key = `${provider}/${model}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ model, provider });
  }

  // Sort by provider preference first, then by model name
  out.sort((a, b) => {
    const providerOrder = compareProvidersForPicker(a.provider, b.provider);
    if (providerOrder !== 0) return providerOrder;
    return a.model.toLowerCase().localeCompare(b.model.toLowerCase());
  });

  return out;
}

export function resolveProviderEndpointLabel(
  provider: string,
  cfg: MoltbotConfig,
): { endpoint?: string; api?: string } {
  const normalized = normalizeProviderId(provider);
  const providers = (cfg.models?.providers ?? {}) as Record<
    string,
    { baseUrl?: string; api?: string } | undefined
  >;
  const entry = providers[normalized];
  const endpoint = entry?.baseUrl?.trim();
  const api = entry?.api?.trim();
  return {
    endpoint: endpoint || undefined,
    api: api || undefined,
  };
}
