import { normalizeProviderId } from "../agents/model-selection.js";
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

export function mergeConfigPatch<T>(base: T, patch: unknown): T {
  if (!isPlainRecord(base) || !isPlainRecord(patch)) {
    return patch as T;
  }

  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = next[key];
    if (isPlainRecord(existing) && isPlainRecord(value)) {
      next[key] = mergeConfigPatch(existing, value);
    } else {
      next[key] = value;
    }
  }
  return next as T;
}

export function applyProviderAuthConfigPatch(cfg: OpenClawConfig, patch: unknown): OpenClawConfig {
  const merged = mergeConfigPatch(cfg, patch);
  if (!isPlainRecord(patch)) {
    return merged;
  }

  const patchModels = (patch.agents as { defaults?: { models?: unknown } } | undefined)?.defaults
    ?.models;
  if (!isPlainRecord(patchModels)) {
    return merged;
  }

  return {
    ...merged,
    agents: {
      ...merged.agents,
      defaults: {
        ...merged.agents?.defaults,
        // Provider auth migrations can intentionally replace the exact allowlist.
        models: patchModels as NonNullable<
          NonNullable<OpenClawConfig["agents"]>["defaults"]
        >["models"],
      },
    },
  };
}

export function applyDefaultModel(cfg: OpenClawConfig, model: string): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[model] = models[model] ?? {};

  const existingModel = cfg.agents?.defaults?.model;
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
        model: {
          ...(existingModel && typeof existingModel === "object" && "fallbacks" in existingModel
            ? { fallbacks: (existingModel as { fallbacks?: string[] }).fallbacks }
            : undefined),
          primary: model,
        },
      },
    },
  };
}
