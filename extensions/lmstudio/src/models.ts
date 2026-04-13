import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
  SELF_HOSTED_DEFAULT_COST,
  SELF_HOSTED_DEFAULT_MAX_TOKENS,
} from "openclaw/plugin-sdk/provider-setup";
import { LMSTUDIO_DEFAULT_BASE_URL, LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH } from "./defaults.js";

export type LmstudioModelWire = {
  type?: "llm" | "embedding";
  key?: string;
  display_name?: string;
  max_context_length?: number;
  format?: "gguf" | "mlx" | null;
  capabilities?: {
    vision?: boolean;
    trained_for_tool_use?: boolean;
    reasoning?: LmstudioReasoningCapabilityWire;
  };
  loaded_instances?: Array<{
    id?: string;
    config?: {
      context_length?: number;
    } | null;
  } | null>;
};

type LmstudioReasoningCapabilityWire = {
  allowed_options?: unknown;
  default?: unknown;
};

type LmstudioConfiguredCatalogEntry = {
  id: string;
  name?: string;
  contextWindow?: number;
  contextTokens?: number;
  reasoning?: boolean;
  input?: ("text" | "image" | "document")[];
};

function normalizeReasoningOption(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function isReasoningEnabledOption(value: unknown): boolean {
  const normalized = normalizeReasoningOption(value);
  if (!normalized) {
    return false;
  }
  return normalized !== "off";
}

/**
 * Resolves LM Studio reasoning support from capabilities payloads.
 * Defaults to false when the server omits reasoning metadata.
 */
export function resolveLmstudioReasoningCapability(
  entry: Pick<LmstudioModelWire, "capabilities">,
): boolean {
  const reasoning = entry.capabilities?.reasoning;
  if (reasoning === undefined || reasoning === null) {
    return false;
  }
  const allowedOptionsRaw = reasoning.allowed_options;
  const allowedOptions = Array.isArray(allowedOptionsRaw)
    ? allowedOptionsRaw
        .map((option) => normalizeReasoningOption(option))
        .filter((option): option is string => option !== null)
    : [];
  if (allowedOptions.length > 0) {
    return allowedOptions.some((option) => isReasoningEnabledOption(option));
  }
  return isReasoningEnabledOption(reasoning.default);
}

/**
 * Reads loaded LM Studio instances and returns the largest valid context window.
 * Returns null when no usable loaded context is present.
 */
export function resolveLoadedContextWindow(
  entry: Pick<LmstudioModelWire, "loaded_instances">,
): number | null {
  const loadedInstances = Array.isArray(entry.loaded_instances) ? entry.loaded_instances : [];
  let contextWindow: number | null = null;
  for (const instance of loadedInstances) {
    // Discovery payload is external JSON, so tolerate malformed entries.
    const length = instance?.config?.context_length;
    if (length === undefined || !Number.isFinite(length) || length <= 0) {
      continue;
    }
    const normalized = Math.floor(length);
    contextWindow = contextWindow === null ? normalized : Math.max(contextWindow, normalized);
  }
  return contextWindow;
}

/**
 * Normalizes a server path by stripping trailing slash and inference suffixes.
 *
 * LM Studio users often copy their inference URL (e.g. "http://localhost:1234/v1") instead
 * of the server root. This function strips a trailing "/v1" or "/api/v1" so the caller always
 * receives a clean root base URL. The expected input is the server root without any API version
 * path (e.g. "http://localhost:1234").
 */
function normalizeUrlPath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/\/api\/v1$/i, "").replace(/\/v1$/i, "");
}

/** Resolves LM Studio server base URL (without /v1 or /api/v1). */
export function resolveLmstudioServerBase(configuredBaseUrl?: string): string {
  // Use configured value when present; otherwise target local LM Studio default.
  const configured = configuredBaseUrl?.trim();
  const resolved = configured && configured.length > 0 ? configured : LMSTUDIO_DEFAULT_BASE_URL;
  try {
    const parsed = new URL(resolved);
    const pathname = normalizeUrlPath(parsed.pathname);
    parsed.pathname = pathname.length > 0 ? pathname : "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    const trimmed = resolved.replace(/\/+$/, "");
    const normalized = normalizeUrlPath(trimmed);
    return normalized.length > 0 ? normalized : LMSTUDIO_DEFAULT_BASE_URL;
  }
}

/** Resolves LM Studio inference base URL and always appends /v1. */
export function resolveLmstudioInferenceBase(configuredBaseUrl?: string): string {
  const serverBase = resolveLmstudioServerBase(configuredBaseUrl);
  return `${serverBase}/v1`;
}

/** Canonicalizes persisted LM Studio provider config to the inference base URL form. */
export function normalizeLmstudioProviderConfig(
  provider: ModelProviderConfig,
): ModelProviderConfig {
  const configuredBaseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl.trim() : "";
  if (!configuredBaseUrl) {
    return provider;
  }
  const normalizedBaseUrl = resolveLmstudioInferenceBase(configuredBaseUrl);
  return normalizedBaseUrl === provider.baseUrl
    ? provider
    : { ...provider, baseUrl: normalizedBaseUrl };
}

export function normalizeLmstudioConfiguredCatalogEntry(
  entry: unknown,
): LmstudioConfiguredCatalogEntry | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.trim().length === 0) {
    return null;
  }
  const id = record.id.trim();
  const name = typeof record.name === "string" && record.name.trim().length > 0 ? record.name : id;
  const contextWindow =
    typeof record.contextWindow === "number" && record.contextWindow > 0
      ? record.contextWindow
      : undefined;
  const contextTokens =
    typeof record.contextTokens === "number" && record.contextTokens > 0
      ? record.contextTokens
      : undefined;
  const reasoning = typeof record.reasoning === "boolean" ? record.reasoning : undefined;
  const input = Array.isArray(record.input)
    ? record.input.filter(
        (item): item is "text" | "image" | "document" =>
          item === "text" || item === "image" || item === "document",
      )
    : undefined;
  return {
    id,
    name,
    contextWindow,
    contextTokens,
    reasoning,
    input: input && input.length > 0 ? input : undefined,
  };
}

export function normalizeLmstudioConfiguredCatalogEntries(
  models: unknown,
): LmstudioConfiguredCatalogEntry[] {
  if (!Array.isArray(models)) {
    return [];
  }
  return models
    .map((entry) => normalizeLmstudioConfiguredCatalogEntry(entry))
    .filter((entry): entry is LmstudioConfiguredCatalogEntry => entry !== null);
}

export function buildLmstudioModelName(model: {
  displayName: string;
  format: "gguf" | "mlx" | null;
  vision: boolean;
  trainedForToolUse: boolean;
  loaded: boolean;
}): string {
  const tags: string[] = [];
  if (model.format === "mlx") {
    tags.push("MLX");
  } else if (model.format === "gguf") {
    tags.push("GGUF");
  }
  if (model.vision) {
    tags.push("vision");
  }
  if (model.trainedForToolUse) {
    tags.push("tool-use");
  }
  if (model.loaded) {
    tags.push("loaded");
  }
  if (tags.length === 0) {
    return model.displayName;
  }
  return `${model.displayName} (${tags.join(", ")})`;
}

/**
 * Base model fields extracted from a single LM Studio wire entry.
 * Shared by the setup layer (persists simple names to config) and the runtime
 * discovery path (which enriches the name with format/state tags).
 */
export type LmstudioModelBase = {
  id: string;
  displayName: string;
  format: "gguf" | "mlx" | null;
  vision: boolean;
  trainedForToolUse: boolean;
  loaded: boolean;
  reasoning: boolean;
  input: ModelDefinitionConfig["input"];
  cost: ModelDefinitionConfig["cost"];
  contextWindow: number;
  contextTokens: number;
  maxTokens: number;
};

/**
 * Maps a single LM Studio wire entry to its base model fields.
 * Returns null for non-LLM entries or entries with no usable key.
 *
 * Shared by both the setup layer (persists simple names to config) and the
 * runtime discovery path (which enriches the name with format/state tags via
 * buildLmstudioModelName).
 */
export function mapLmstudioWireEntry(entry: LmstudioModelWire): LmstudioModelBase | null {
  if (entry.type !== "llm") {
    return null;
  }
  const id = entry.key?.trim() ?? "";
  if (!id) {
    return null;
  }
  const loadedContextWindow = resolveLoadedContextWindow(entry);
  const advertisedContextWindow =
    entry.max_context_length !== undefined &&
    Number.isFinite(entry.max_context_length) &&
    entry.max_context_length > 0
      ? Math.floor(entry.max_context_length)
      : null;
  const contextWindow = advertisedContextWindow ?? SELF_HOSTED_DEFAULT_CONTEXT_WINDOW;
  // Keep native/advertised context window metadata in catalog, but use a practical
  // default target for model loading unless callers explicitly override it.
  const contextTokens = Math.min(contextWindow, LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH);
  const rawDisplayName = entry.display_name?.trim();
  return {
    id,
    displayName: rawDisplayName && rawDisplayName.length > 0 ? rawDisplayName : id,
    format: entry.format ?? null,
    vision: entry.capabilities?.vision === true,
    trainedForToolUse: entry.capabilities?.trained_for_tool_use === true,
    // Use the same validity check as resolveLoadedContextWindow so malformed entries
    // like [null, {}] don't produce a false positive "loaded" tag.
    loaded: loadedContextWindow !== null,
    reasoning: resolveLmstudioReasoningCapability(entry),
    input: entry.capabilities?.vision ? ["text", "image"] : ["text"],
    cost: SELF_HOSTED_DEFAULT_COST,
    contextWindow,
    contextTokens,
    maxTokens: Math.max(1, Math.min(contextWindow, SELF_HOSTED_DEFAULT_MAX_TOKENS)),
  };
}

/**
 * Maps LM Studio wire models to config entries using plain display names.
 * Use this for config persistence where runtime format/state tags are not needed.
 * For runtime discovery with enriched names, use discoverLmstudioModels from models.fetch.ts.
 */
export function mapLmstudioWireModelsToConfig(
  models: LmstudioModelWire[],
): ModelDefinitionConfig[] {
  return models
    .map((entry): ModelDefinitionConfig | null => {
      const base = mapLmstudioWireEntry(entry);
      if (!base) {
        return null;
      }
      return {
        id: base.id,
        name: base.displayName,
        reasoning: base.reasoning,
        input: base.input,
        cost: base.cost,
        contextWindow: base.contextWindow,
        contextTokens: base.contextTokens,
        maxTokens: base.maxTokens,
      };
    })
    .filter((entry): entry is ModelDefinitionConfig => entry !== null);
}
