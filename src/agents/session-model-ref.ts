// Resolves persisted session model metadata without loading Gateway projections.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import {
  inferUniqueProviderFromConfiguredModels,
  normalizeStoredOverrideModel,
  parseModelRef,
  resolveConfiguredModelRef,
  resolveDefaultModelForAgent,
  resolvePersistedSelectedModelRef,
} from "./model-selection.js";

type SessionModelEntry =
  | SessionEntry
  | Pick<SessionEntry, "model" | "modelProvider" | "modelOverride" | "providerOverride">;

export function resolveSessionModelRef(
  cfg: OpenClawConfig,
  entry?: SessionModelEntry,
  agentId?: string,
  options?: { allowPluginNormalization?: boolean },
): { provider: string; model: string } {
  const normalizedOverride = normalizeStoredOverrideModel({
    providerOverride: entry?.providerOverride,
    modelOverride: entry?.modelOverride,
  });
  if (normalizedOverride.providerOverride && normalizedOverride.modelOverride) {
    return resolvePersistedSelectedModelRef({
      defaultProvider: normalizedOverride.providerOverride,
      overrideProvider: normalizedOverride.providerOverride,
      overrideModel: normalizedOverride.modelOverride,
      allowPluginNormalization: options?.allowPluginNormalization,
    })!;
  }
  const runtimeProvider = normalizeOptionalString(entry?.modelProvider);
  const runtimeModel = normalizeOptionalString(entry?.model);
  if (runtimeProvider && runtimeModel) {
    return { provider: runtimeProvider, model: runtimeModel };
  }

  const resolved = agentId
    ? resolveDefaultModelForAgent({
        cfg,
        agentId,
        allowPluginNormalization: options?.allowPluginNormalization,
      })
    : resolveConfiguredModelRef({
        cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
        allowPluginNormalization: options?.allowPluginNormalization,
      });

  const persisted = resolvePersistedSelectedModelRef({
    defaultProvider: resolved.provider || DEFAULT_PROVIDER,
    runtimeProvider,
    runtimeModel,
    overrideProvider: normalizedOverride.providerOverride,
    overrideModel: normalizedOverride.modelOverride,
    allowPluginNormalization: options?.allowPluginNormalization,
  });
  if (persisted) {
    return persisted;
  }
  return resolved;
}

export function resolveSessionModelIdentityRef(
  cfg: OpenClawConfig,
  entry?: SessionModelEntry,
  agentId?: string,
  fallbackModelRef?: string,
  options?: { allowPluginNormalization?: boolean },
): { provider?: string; model: string } {
  const runtimeModel = entry?.model?.trim();
  const runtimeProvider = entry?.modelProvider?.trim();
  if (runtimeModel) {
    if (runtimeProvider) {
      return { provider: runtimeProvider, model: runtimeModel };
    }
    const inferredProvider = inferUniqueProviderFromConfiguredModels({
      cfg,
      model: runtimeModel,
    });
    if (inferredProvider) {
      return { provider: inferredProvider, model: runtimeModel };
    }
    if (runtimeModel.includes("/")) {
      const parsedRuntime = parseModelRef(runtimeModel, DEFAULT_PROVIDER, {
        allowPluginNormalization: options?.allowPluginNormalization,
      });
      if (parsedRuntime) {
        return { provider: parsedRuntime.provider, model: parsedRuntime.model };
      }
      return { model: runtimeModel };
    }
    return { model: runtimeModel };
  }
  const fallbackRef = fallbackModelRef?.trim();
  if (fallbackRef) {
    const parsedFallback = parseModelRef(fallbackRef, DEFAULT_PROVIDER, {
      allowPluginNormalization: options?.allowPluginNormalization,
    });
    if (parsedFallback) {
      return { provider: parsedFallback.provider, model: parsedFallback.model };
    }
    const inferredProvider = inferUniqueProviderFromConfiguredModels({
      cfg,
      model: fallbackRef,
    });
    if (inferredProvider) {
      return { provider: inferredProvider, model: fallbackRef };
    }
    return { model: fallbackRef };
  }
  const resolved = resolveSessionModelRef(cfg, entry, agentId, {
    allowPluginNormalization: options?.allowPluginNormalization,
  });
  return { provider: resolved.provider, model: resolved.model };
}
