import { resolveProviderModernModelRef } from "../plugins/provider-runtime.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { normalizeProviderId } from "./provider-id.js";

export type ModelRef = {
  provider?: string | null;
  id?: string | null;
};

const HIGH_SIGNAL_LIVE_MODEL_PRIORITY = [
  "anthropic/claude-opus-4-7",
  "anthropic/claude-opus-4-6",
  "anthropic/claude-sonnet-4-6",
  "google/gemini-3.1-pro-preview",
  "google/gemini-3-flash-preview",
  "minimax/minimax-m2.7",
  "openai/gpt-5.2",
  "openai-codex/gpt-5.2",
  "opencode-go/glm-5",
  "openrouter/ai21/jamba-large-1.7",
  "xai/grok-4-1-fast-non-reasoning",
  "zai/glm-4.7",
  "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
  "minimax-portal/minimax-m2.7",
] as const;

export const DEFAULT_HIGH_SIGNAL_LIVE_MODEL_LIMIT = HIGH_SIGNAL_LIVE_MODEL_PRIORITY.length;

const HIGH_SIGNAL_LIVE_MODEL_PRIORITY_INDEX = new Map<string, number>(
  HIGH_SIGNAL_LIVE_MODEL_PRIORITY.map((key, index) => [key, index]),
);

function isHighSignalClaudeModelId(id: string): boolean {
  const normalized = id.replace(/[_.]/g, "-");
  if (!/\bclaude\b/i.test(normalized)) {
    return true;
  }
  if (/\bhaiku\b/i.test(normalized)) {
    return false;
  }
  if (/\bclaude-3(?:[-.]5|[-.]7)\b/i.test(normalized)) {
    return false;
  }
  const versionMatch = normalized.match(/\bclaude-[a-z0-9-]*?-(\d+)(?:-(\d+))?(?:\b|[-])/i);
  if (!versionMatch) {
    return false;
  }
  const major = Number.parseInt(versionMatch[1] ?? "0", 10);
  const minor = Number.parseInt(versionMatch[2] ?? "0", 10);
  if (major > 4) {
    return true;
  }
  if (major < 4) {
    return false;
  }
  return minor >= 6;
}

function isPreGemini3ModelId(id: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(id);
  const match = normalized.match(/(?:^|\/)gemini-(\d+)(?:[.-]|$)/);
  if (!match) {
    return false;
  }
  const major = Number.parseInt(match[1] ?? "0", 10);
  return Number.isFinite(major) && major < 3;
}

export function isModernModelRef(ref: ModelRef): boolean {
  const provider = normalizeProviderId(ref.provider ?? "");
  const id = normalizeLowercaseStringOrEmpty(ref.id);
  if (!provider || !id) {
    return false;
  }

  const pluginDecision = resolveProviderModernModelRef({
    provider,
    context: {
      provider,
      modelId: id,
    },
  });
  if (typeof pluginDecision === "boolean") {
    return pluginDecision;
  }
  return false;
}

export function isHighSignalLiveModelRef(ref: ModelRef): boolean {
  const id = normalizeLowercaseStringOrEmpty(ref.id);
  if (!isModernModelRef(ref) || !id) {
    return false;
  }
  if (isPreGemini3ModelId(id)) {
    return false;
  }
  return isHighSignalClaudeModelId(id);
}

function toCanonicalHighSignalLiveModelKey(ref: ModelRef): string | null {
  const provider = normalizeProviderId(ref.provider ?? "");
  const rawId = normalizeLowercaseStringOrEmpty(ref.id);
  if (!provider || !rawId) {
    return null;
  }
  return `${provider}/${rawId}`;
}

function capByProviderSpread<T>(
  items: T[],
  maxItems: number,
  providerOf: (item: T) => string,
): T[] {
  if (maxItems <= 0 || items.length <= maxItems) {
    return items;
  }
  const providerOrder: string[] = [];
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const provider = providerOf(item);
    const bucket = grouped.get(provider);
    if (bucket) {
      bucket.push(item);
      continue;
    }
    providerOrder.push(provider);
    grouped.set(provider, [item]);
  }

  const selected: T[] = [];
  while (selected.length < maxItems && grouped.size > 0) {
    for (const provider of providerOrder) {
      const bucket = grouped.get(provider);
      if (!bucket || bucket.length === 0) {
        continue;
      }
      const item = bucket.shift();
      if (item) {
        selected.push(item);
      }
      if (bucket.length === 0) {
        grouped.delete(provider);
      }
      if (selected.length >= maxItems) {
        break;
      }
    }
  }
  return selected;
}

export function selectHighSignalLiveItems<T>(
  items: T[],
  maxItems: number,
  refOf: (item: T) => ModelRef,
  providerOf: (item: T) => string,
): T[] {
  if (maxItems <= 0 || items.length <= maxItems) {
    return items;
  }

  const remaining = [...items];
  const selected: T[] = [];
  for (const preferredKey of HIGH_SIGNAL_LIVE_MODEL_PRIORITY) {
    if (selected.length >= maxItems) {
      break;
    }
    const preferredIndex = remaining.findIndex(
      (item) => toCanonicalHighSignalLiveModelKey(refOf(item)) === preferredKey,
    );
    if (preferredIndex < 0) {
      continue;
    }
    const [preferred] = remaining.splice(preferredIndex, 1);
    if (preferred) {
      selected.push(preferred);
    }
  }

  if (selected.length >= maxItems || remaining.length === 0) {
    return selected.slice(0, maxItems);
  }

  return [...selected, ...capByProviderSpread(remaining, maxItems - selected.length, providerOf)];
}

export function resolveHighSignalLiveModelLimit(params: {
  rawMaxModels?: string;
  useExplicitModels: boolean;
  defaultLimit?: number;
}): number {
  const trimmed = params.rawMaxModels?.trim();
  if (trimmed) {
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }
  if (params.useExplicitModels) {
    return 0;
  }
  return params.defaultLimit ?? DEFAULT_HIGH_SIGNAL_LIVE_MODEL_LIMIT;
}

export function getHighSignalLiveModelPriorityIndex(ref: ModelRef): number | null {
  const key = toCanonicalHighSignalLiveModelKey(ref);
  if (!key) {
    return null;
  }
  return HIGH_SIGNAL_LIVE_MODEL_PRIORITY_INDEX.get(key) ?? null;
}
