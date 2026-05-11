import { normalizeConfiguredProviderCatalogModelId } from "../agents/model-ref-shared.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import {
  normalizeAgentModelMapForConfig,
  normalizeAgentModelRefForConfig,
} from "../config/model-input.js";
import { normalizeProviderConfigForConfigDefaults } from "../config/provider-policy.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import type { ProviderAuthMethod, ProviderPlugin } from "./types.js";

export function resolveProviderMatch(
  providers: ProviderPlugin[],
  rawProvider?: string,
): ProviderPlugin | null {
  const raw = normalizeOptionalString(rawProvider);
  if (!raw) {
    return null;
  }
  const normalized = normalizeProviderId(raw);
  return (
    providers.find((provider) => normalizeProviderId(provider.id) === normalized) ??
    providers.find(
      (provider) =>
        provider.aliases?.some((alias) => normalizeProviderId(alias) === normalized) ?? false,
    ) ??
    null
  );
}

export function pickAuthMethod(
  provider: ProviderPlugin,
  rawMethod?: string,
): ProviderAuthMethod | null {
  const raw = normalizeOptionalString(rawMethod);
  if (!raw) {
    return null;
  }
  const normalized = normalizeOptionalLowercaseString(raw);
  return (
    provider.auth.find((method) => normalizeLowercaseStringOrEmpty(method.id) === normalized) ??
    provider.auth.find((method) => normalizeLowercaseStringOrEmpty(method.label) === normalized) ??
    null
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// Guard config patches against prototype-pollution payloads if a patch ever
// arrives from a JSON-parsed source that preserves these keys.
const BLOCKED_MERGE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function sanitizeConfigPatchValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeConfigPatchValue(entry));
  }
  if (!isPlainRecord(value)) {
    return value;
  }

  const next: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (BLOCKED_MERGE_KEYS.has(key)) {
      continue;
    }
    next[key] = sanitizeConfigPatchValue(nestedValue);
  }
  return next;
}

function mergeConfigPatch<T>(base: T, patch: unknown): T {
  if (!isPlainRecord(base) || !isPlainRecord(patch)) {
    return sanitizeConfigPatchValue(patch) as T;
  }

  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (BLOCKED_MERGE_KEYS.has(key)) {
      continue;
    }
    const existing = next[key];
    if (isPlainRecord(existing) && isPlainRecord(value)) {
      next[key] = mergeConfigPatch(existing, value);
    } else {
      next[key] = sanitizeConfigPatchValue(value);
    }
  }
  return next as T;
}

function normalizeAgentModelConfigForWrite(value: unknown): unknown {
  if (typeof value === "string") {
    return normalizeAgentModelRefForConfig(value);
  }
  if (!isPlainRecord(value)) {
    return value;
  }

  const next: Record<string, unknown> = { ...value };
  if (typeof next.primary === "string") {
    next.primary = normalizeAgentModelRefForConfig(next.primary);
  }
  if (Array.isArray(next.fallbacks)) {
    next.fallbacks = next.fallbacks.map((fallback) =>
      typeof fallback === "string" ? normalizeAgentModelRefForConfig(fallback) : fallback,
    );
  }
  return next;
}

function normalizeAgentModelMapForWrite(value: unknown): unknown {
  if (!isPlainRecord(value)) {
    return value;
  }
  return normalizeAgentModelMapForConfig(value);
}

function normalizeProviderCatalogModelIdForWrite(provider: string, modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return trimmed;
  }
  return normalizeConfiguredProviderCatalogModelId(normalizeProviderId(provider), trimmed);
}

function normalizeProviderCatalogModelIdsForWrite(
  provider: string,
  providerConfig: ModelProviderConfig,
): ModelProviderConfig {
  const models = providerConfig.models;
  if (!Array.isArray(models) || models.length === 0) {
    return providerConfig;
  }

  let mutated = false;
  const nextModels = models.map((model) => {
    const nextId = normalizeProviderCatalogModelIdForWrite(provider, model.id);
    if (nextId === model.id) {
      return model;
    }
    mutated = true;
    return Object.assign({}, model, { id: nextId });
  });

  return mutated ? { ...providerConfig, models: nextModels } : providerConfig;
}

function normalizeModelProviderConfigsForWrite(cfg: OpenClawConfig): OpenClawConfig {
  const providers = cfg.models?.providers;
  if (!providers) {
    return cfg;
  }

  let mutated = false;
  const nextProviders = { ...providers };
  for (const [provider, providerConfig] of Object.entries(providers)) {
    const normalizedProviderConfig = normalizeProviderCatalogModelIdsForWrite(
      provider,
      normalizeProviderConfigForConfigDefaults({
        provider,
        providerConfig,
      }),
    );
    if (normalizedProviderConfig === providerConfig) {
      continue;
    }
    nextProviders[provider] = normalizedProviderConfig;
    mutated = true;
  }

  if (!mutated) {
    return cfg;
  }

  return {
    ...cfg,
    models: {
      ...cfg.models,
      providers: nextProviders,
    },
  };
}

function normalizeConfigModelRefsForWrite(cfg: OpenClawConfig): OpenClawConfig {
  const providerNormalized = normalizeModelProviderConfigsForWrite(cfg);
  const defaults = providerNormalized.agents?.defaults;
  if (!defaults) {
    return providerNormalized;
  }

  const nextDefaults: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> = {
    ...defaults,
  };
  if (defaults.model !== undefined) {
    nextDefaults.model = normalizeAgentModelConfigForWrite(defaults.model) as typeof defaults.model;
  }
  if (defaults.models !== undefined) {
    nextDefaults.models = normalizeAgentModelMapForWrite(defaults.models) as typeof defaults.models;
  }

  return {
    ...providerNormalized,
    agents: {
      ...providerNormalized.agents,
      defaults: nextDefaults,
    },
  };
}

export function applyProviderAuthConfigPatch(
  cfg: OpenClawConfig,
  patch: unknown,
  options?: { replaceDefaultModels?: boolean },
): OpenClawConfig {
  const merged = normalizeConfigModelRefsForWrite(mergeConfigPatch(cfg, patch));
  if (!options?.replaceDefaultModels || !isPlainRecord(patch)) {
    return merged;
  }

  const patchModels = (patch.agents as { defaults?: { models?: unknown } } | undefined)?.defaults
    ?.models;
  if (!isPlainRecord(patchModels)) {
    return merged;
  }

  return normalizeConfigModelRefsForWrite({
    ...merged,
    agents: {
      ...merged.agents,
      defaults: {
        ...merged.agents?.defaults,
        // Opt-in replacement for migrations that rename/remove model keys.
        models: sanitizeConfigPatchValue(patchModels) as NonNullable<
          NonNullable<OpenClawConfig["agents"]>["defaults"]
        >["models"],
      },
    },
  });
}

export function applyDefaultModel(
  cfg: OpenClawConfig,
  model: string,
  opts?: { preserveExistingPrimary?: boolean },
): OpenClawConfig {
  const normalizedModel = normalizeAgentModelRefForConfig(model);
  const models = {
    ...normalizeAgentModelMapForConfig(cfg.agents?.defaults?.models ?? {}),
  };
  models[normalizedModel] = models[normalizedModel] ?? {};

  const existingModel = cfg.agents?.defaults?.model;
  const existingPrimary =
    typeof existingModel === "string"
      ? existingModel
      : existingModel && typeof existingModel === "object"
        ? (existingModel as { primary?: string }).primary
        : undefined;
  const normalizedExistingPrimary = existingPrimary
    ? normalizeAgentModelRefForConfig(existingPrimary)
    : undefined;
  const existingFallbacks =
    existingModel && typeof existingModel === "object" && "fallbacks" in existingModel
      ? (existingModel as { fallbacks?: string[] }).fallbacks?.map((fallback) =>
          normalizeAgentModelRefForConfig(fallback),
        )
      : undefined;
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
        model: {
          ...(existingFallbacks ? { fallbacks: existingFallbacks } : undefined),
          primary:
            opts?.preserveExistingPrimary === true
              ? (normalizedExistingPrimary ?? normalizedModel)
              : normalizedModel,
        },
      },
    },
  };
}
