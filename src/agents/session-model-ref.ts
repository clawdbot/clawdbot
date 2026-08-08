// Resolves persisted session model metadata without loading Gateway projections.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import { findModelInCatalog } from "./model-catalog-lookup.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import {
  findNormalizedProviderKey,
  inferUniqueProviderFromConfiguredModels,
  normalizeProviderId,
  normalizeStoredOverrideModel,
  parseModelRef,
  resolveConfiguredModelRef,
  resolveDefaultModelForAgent,
  resolvePersistedSelectedModelRef,
} from "./model-selection.js";

type SessionModelEntry =
  | SessionEntry
  | Pick<SessionEntry, "model" | "modelProvider" | "modelOverride" | "providerOverride">;

function hasCatalogModelRef(
  catalog: ModelCatalogEntry[] | undefined,
  ref: { provider: string; model: string },
): boolean {
  return Boolean(catalog && findModelInCatalog(catalog, ref.provider, ref.model));
}

function currentConfigAllowsPersistedModelRef(params: {
  cfg: OpenClawConfig;
  ref: { provider: string; model: string };
  defaultRef: { provider: string; model: string };
  modelCatalog?: ModelCatalogEntry[];
}): boolean {
  const provider = normalizeProviderId(params.ref.provider);
  if (!provider) {
    return true;
  }
  if (provider === normalizeProviderId(params.defaultRef.provider)) {
    return true;
  }
  if (findNormalizedProviderKey(params.cfg.models?.providers, provider)) {
    return true;
  }
  if (hasCatalogModelRef(params.modelCatalog, params.ref)) {
    return true;
  }
  if (params.modelCatalog) {
    return false;
  }
  if (params.cfg.models?.mode === "replace") {
    return false;
  }
  return true;
}

function persistedModelRefNeedsCatalogValidation(params: {
  cfg: OpenClawConfig;
  ref: { provider: string; model: string };
  defaultRef: { provider: string; model: string };
}): boolean {
  const provider = normalizeProviderId(params.ref.provider);
  if (!provider) {
    return false;
  }
  if (provider === normalizeProviderId(params.defaultRef.provider)) {
    return false;
  }
  return !findNormalizedProviderKey(params.cfg.models?.providers, provider);
}

export function shouldLoadModelCatalogForSessionModelResolution(
  cfg: OpenClawConfig,
  entry?: SessionModelEntry,
  agentId?: string,
  options?: { allowPluginNormalization?: boolean },
): boolean {
  if (!entry) {
    return false;
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
  const normalizedOverride = normalizeStoredOverrideModel({
    providerOverride: entry.providerOverride,
    modelOverride: entry.modelOverride,
  });
  const runtimeProvider = normalizeOptionalString(entry.modelProvider);
  const runtimeModel = normalizeOptionalString(entry.model);
  const refs: Array<{ provider: string; model: string }> = [];

  if (normalizedOverride.providerOverride && normalizedOverride.modelOverride) {
    const override = resolvePersistedSelectedModelRef({
      defaultProvider: normalizedOverride.providerOverride,
      overrideProvider: normalizedOverride.providerOverride,
      overrideModel: normalizedOverride.modelOverride,
      allowPluginNormalization: options?.allowPluginNormalization,
    });
    if (override) {
      refs.push(override);
    }
  }
  if (runtimeProvider && runtimeModel) {
    refs.push({ provider: runtimeProvider, model: runtimeModel });
  }

  return refs.some((ref) =>
    persistedModelRefNeedsCatalogValidation({
      cfg,
      ref,
      defaultRef: resolved,
    }),
  );
}

export function resolveSessionModelRef(
  cfg: OpenClawConfig,
  entry?: SessionModelEntry,
  agentId?: string,
  options?: { allowPluginNormalization?: boolean; modelCatalog?: ModelCatalogEntry[] },
): { provider: string; model: string } {
  const normalizedOverride = normalizeStoredOverrideModel({
    providerOverride: entry?.providerOverride,
    modelOverride: entry?.modelOverride,
  });
  const runtimeProvider = normalizeOptionalString(entry?.modelProvider);
  const runtimeModel = normalizeOptionalString(entry?.model);

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
  if (normalizedOverride.providerOverride && normalizedOverride.modelOverride) {
    const override = resolvePersistedSelectedModelRef({
      defaultProvider: normalizedOverride.providerOverride,
      overrideProvider: normalizedOverride.providerOverride,
      overrideModel: normalizedOverride.modelOverride,
      allowPluginNormalization: options?.allowPluginNormalization,
    });
    if (
      override &&
      currentConfigAllowsPersistedModelRef({
        cfg,
        ref: override,
        defaultRef: resolved,
        modelCatalog: options?.modelCatalog,
      })
    ) {
      return override;
    }
  }
  if (runtimeProvider && runtimeModel) {
    const runtimeRef = { provider: runtimeProvider, model: runtimeModel };
    if (
      currentConfigAllowsPersistedModelRef({
        cfg,
        ref: runtimeRef,
        defaultRef: resolved,
        modelCatalog: options?.modelCatalog,
      })
    ) {
      return runtimeRef;
    }
  }

  const persisted = resolvePersistedSelectedModelRef({
    defaultProvider: resolved.provider || DEFAULT_PROVIDER,
    // Runtime fields record the previous run. Agent-scoped selection must use
    // current config or an explicit override; legacy callers without an agent
    // still use the persisted pair as their fallback selection context.
    runtimeProvider: agentId ? undefined : runtimeProvider,
    runtimeModel: agentId ? undefined : runtimeModel,
    overrideProvider: normalizedOverride.providerOverride,
    overrideModel: normalizedOverride.modelOverride,
    allowPluginNormalization: options?.allowPluginNormalization,
  });
  if (
    persisted &&
    currentConfigAllowsPersistedModelRef({
      cfg,
      ref: persisted,
      defaultRef: resolved,
      modelCatalog: options?.modelCatalog,
    })
  ) {
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
