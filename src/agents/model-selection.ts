/**
 * Public model-selection facade for persisted, configured, and allowed refs.
 */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentModelFallbacksOverride } from "./agent-scope.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import { findModelInCatalog } from "./model-catalog-lookup.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import {
  resolveDefaultModelForAgent,
  resolveSubagentConfiguredModelSelection,
} from "./model-selection-config.js";
export {
  resolveThinkingDefault,
  resolveThinkingDefaultWithRuntimeCatalog,
} from "./model-thinking-default.js";
import {
  type ModelManifestNormalizationContext,
  type ModelRef,
  findNormalizedProviderKey,
  findNormalizedProviderValue,
  legacyModelKey,
  modelKey,
  normalizeModelRef,
  normalizeProviderId,
  normalizeProviderIdForAuth,
  parseModelRef,
} from "./model-selection-normalize.js";
import {
  buildAllowedModelSetWithFallbacks,
  buildConfiguredAllowlistKeys,
  buildConfiguredModelCatalog,
  buildModelAliasIndex,
  getModelRefStatusWithFallbackModels,
  inferUniqueProviderFromCatalog,
  inferUniqueProviderFromConfiguredModels,
  normalizeModelSelection,
  resolveBareModelDefaultProvider,
  resolveAllowedModelRefFromAliasIndex,
  resolveAllowlistModelKey as resolveAllowlistModelKeyFromShared,
  resolveConfiguredModelRef,
  resolveConfiguredOpenRouterCompatAlias,
  resolveHooksGmailModel,
  resolveModelRefFromString,
  type ModelAliasIndex,
  type ModelRefStatus,
} from "./model-selection-shared.js";

export type { ModelAliasIndex, ModelManifestNormalizationContext, ModelRef, ModelRefStatus };

export type { ThinkLevel } from "../auto-reply/thinking.shared.js";

export { resolveDefaultModelForAgent, resolveSubagentConfiguredModelSelection };

export {
  buildConfiguredAllowlistKeys,
  buildConfiguredModelCatalog,
  buildModelAliasIndex,
  findNormalizedProviderKey,
  findNormalizedProviderValue,
  inferUniqueProviderFromConfiguredModels,
  inferUniqueProviderFromCatalog,
  legacyModelKey,
  modelKey,
  normalizeModelRef,
  normalizeModelSelection,
  normalizeProviderId,
  normalizeProviderIdForAuth,
  parseModelRef,
  resolveBareModelDefaultProvider,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
  resolveModelRefFromString,
};
export { isCliProvider } from "./model-selection-cli.js";

function normalizePersistedDefaultProvider(value: unknown): string {
  return normalizeOptionalString(value) ?? DEFAULT_PROVIDER;
}

export function resolvePersistedOverrideModelRef(params: {
  defaultProvider?: unknown;
  overrideProvider?: unknown;
  overrideModel?: unknown;
  allowManifestNormalization?: boolean;
  allowPluginNormalization?: boolean;
}): ModelRef | null {
  const defaultProvider = normalizePersistedDefaultProvider(params.defaultProvider);
  const overrideProvider = normalizeOptionalString(params.overrideProvider);
  const overrideModel = normalizeOptionalString(params.overrideModel);
  if (!overrideModel) {
    return null;
  }
  const encodedOverride = overrideProvider ? `${overrideProvider}/${overrideModel}` : overrideModel;
  return (
    parseModelRef(encodedOverride, defaultProvider, {
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
    }) ?? {
      provider: overrideProvider || defaultProvider,
      model: overrideModel,
    }
  );
}

/**
 * Runtime-first resolver for persisted model metadata.
 * Use this when callers intentionally want the last executed model identity.
 */
export function resolvePersistedModelRef(params: {
  defaultProvider?: unknown;
  runtimeProvider?: unknown;
  runtimeModel?: unknown;
  overrideProvider?: unknown;
  overrideModel?: unknown;
  allowManifestNormalization?: boolean;
  allowPluginNormalization?: boolean;
}): ModelRef | null {
  const defaultProvider = normalizePersistedDefaultProvider(params.defaultProvider);
  const runtimeProvider = normalizeOptionalString(params.runtimeProvider);
  const runtimeModel = normalizeOptionalString(params.runtimeModel);
  if (runtimeModel) {
    if (runtimeProvider) {
      return { provider: runtimeProvider, model: runtimeModel };
    }
    return (
      parseModelRef(runtimeModel, defaultProvider, {
        allowManifestNormalization: params.allowManifestNormalization,
        allowPluginNormalization: params.allowPluginNormalization,
      }) ?? {
        provider: defaultProvider,
        model: runtimeModel,
      }
    );
  }
  return resolvePersistedOverrideModelRef({
    defaultProvider,
    overrideProvider: params.overrideProvider,
    overrideModel: params.overrideModel,
    allowManifestNormalization: params.allowManifestNormalization,
    allowPluginNormalization: params.allowPluginNormalization,
  });
}

/**
 * Selected-model resolver for persisted model metadata.
 * Use this for control/status/UI surfaces that should honor explicit session
 * overrides before falling back to runtime identity.
 */
export function resolvePersistedSelectedModelRef(params: {
  defaultProvider?: unknown;
  runtimeProvider?: unknown;
  runtimeModel?: unknown;
  overrideProvider?: unknown;
  overrideModel?: unknown;
  allowManifestNormalization?: boolean;
  allowPluginNormalization?: boolean;
}): ModelRef | null {
  const override = resolvePersistedOverrideModelRef({
    defaultProvider: params.defaultProvider,
    overrideProvider: params.overrideProvider,
    overrideModel: params.overrideModel,
    allowManifestNormalization: params.allowManifestNormalization,
    allowPluginNormalization: params.allowPluginNormalization,
  });
  if (override) {
    return override;
  }
  return resolvePersistedModelRef({
    defaultProvider: params.defaultProvider,
    runtimeProvider: params.runtimeProvider,
    runtimeModel: params.runtimeModel,
    allowManifestNormalization: params.allowManifestNormalization,
    allowPluginNormalization: params.allowPluginNormalization,
  });
}

export function normalizeStoredOverrideModel(params: {
  providerOverride?: unknown;
  modelOverride?: unknown;
}): { providerOverride?: string; modelOverride?: string } {
  const providerOverride = normalizeOptionalString(params.providerOverride);
  const modelOverride = normalizeOptionalString(params.modelOverride);
  if (!providerOverride || !modelOverride) {
    return {
      providerOverride,
      modelOverride,
    };
  }

  const providerPrefix = `${providerOverride.toLowerCase()}/`;
  return {
    providerOverride,
    modelOverride: modelOverride.toLowerCase().startsWith(providerPrefix)
      ? modelOverride.slice(providerOverride.length + 1).trim() || modelOverride
      : modelOverride,
  };
}

export function resolveAllowlistModelKey(
  raw: string,
  defaultProvider: string,
  cfg?: OpenClawConfig,
  manifestPlugins?: ModelManifestNormalizationContext["manifestPlugins"],
): string | null {
  return resolveAllowlistModelKeyFromShared({ cfg, raw, defaultProvider, manifestPlugins });
}

export async function canonicalizeCaseOnlyCatalogModelRef(params: {
  raw: string | undefined;
  cfg?: OpenClawConfig;
  defaultProvider: string;
  loadCatalog: () => Promise<ModelCatalogEntry[]>;
  aliasIndex?: ModelAliasIndex;
  allowManifestNormalization?: boolean;
  allowPluginNormalization?: boolean;
  preserveAuthProfile?: boolean;
}): Promise<string | undefined> {
  const rawModel = normalizeOptionalString(params.raw);
  if (!rawModel) {
    return undefined;
  }
  const split = splitTrailingAuthProfile(rawModel);
  if (shouldKeepProfileQualifiedModelRefRaw(split.profile, params.preserveAuthProfile)) {
    return rawModel;
  }
  if (!isCaseOnlyProviderModelRef(split.model)) {
    return rawModel;
  }
  const resolved = resolveModelRefFromString({
    cfg: params.cfg,
    raw: split.model,
    defaultProvider: params.defaultProvider,
    aliasIndex: params.aliasIndex,
    allowManifestNormalization: params.allowManifestNormalization,
    allowPluginNormalization: params.allowPluginNormalization,
  });
  if (!resolved) {
    return rawModel;
  }
  const entry = findModelInCatalog(
    await params.loadCatalog(),
    resolved.ref.provider,
    resolved.ref.model,
  );
  return entry ? formatCatalogModelRef(entry, split.profile) : rawModel;
}

function hasExplicitProviderModelRef(raw: string): boolean {
  const slash = raw.indexOf("/");
  return slash > 0 && slash < raw.length - 1;
}

function isCaseOnlyProviderModelRef(raw: string): boolean {
  return hasExplicitProviderModelRef(raw) && raw !== raw.toLowerCase();
}

function shouldKeepProfileQualifiedModelRefRaw(
  profile: string | undefined,
  preserveAuthProfile: boolean | undefined,
): boolean {
  return Boolean(profile && preserveAuthProfile === false);
}

function formatCatalogModelRef(entry: ModelCatalogEntry, profile: string | undefined): string {
  return appendAuthProfileSuffix(`${entry.provider}/${entry.id}`, profile);
}

function appendAuthProfileSuffix(modelRef: string, profile: string | undefined): string {
  return profile ? `${modelRef}@${profile}` : modelRef;
}

function resolveAllowedFallbacks(params: { cfg: OpenClawConfig; agentId?: string }): string[] {
  if (params.agentId) {
    const override = resolveAgentModelFallbacksOverride(params.cfg, params.agentId);
    if (override !== undefined) {
      return override;
    }
  }
  return resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
}

/**
 * Resolve a normalized model string through a pre-built alias index, returning
 * a fully qualified `provider/model` string.  If the value is already qualified
 * or not a known alias, returns it unchanged.
 */
function resolveModelThroughAliases(value: string, aliasIndex: ModelAliasIndex): string {
  // Already a provider/model ref — no alias resolution needed.
  if (value.includes("/")) {
    return value;
  }
  // Check if the value is a known alias; if so, resolve to provider/model.
  // Unknown bare strings are returned as-is (don't guess the provider).
  const aliasKey = normalizeLowercaseStringOrEmpty(value);
  const aliasMatch = aliasIndex.byAlias.get(aliasKey);
  if (aliasMatch) {
    return `${aliasMatch.ref.provider}/${aliasMatch.ref.model}`;
  }
  return value;
}

export function resolveSubagentSpawnModelSelection(params: {
  cfg: OpenClawConfig;
  agentId: string;
  modelOverride?: unknown;
}): string {
  const runtimeDefault = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const configured = resolveConfiguredSubagentSpawnModelSelection({
    cfg: params.cfg,
    agentId: params.agentId,
    modelOverride: params.modelOverride,
    defaultProvider: runtimeDefault.provider,
  });
  if (configured) {
    return configured;
  }
  const raw =
    normalizeModelSelection(resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model)) ??
    `${runtimeDefault.provider}/${runtimeDefault.model}`;
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: runtimeDefault.provider,
  });
  return resolveModelThroughAliases(raw, aliasIndex);
}

export function resolveConfiguredSubagentSpawnModelSelection(params: {
  cfg: OpenClawConfig;
  agentId: string;
  modelOverride?: unknown;
  defaultProvider?: string;
  includeAgentPrimary?: boolean;
}): string | undefined {
  const raw =
    normalizeModelSelection(params.modelOverride) ??
    resolveSubagentConfiguredModelSelection({
      cfg: params.cfg,
      agentId: params.agentId,
      includeAgentPrimary: params.includeAgentPrimary,
    });
  if (!raw) {
    return undefined;
  }
  const defaultProvider =
    normalizeOptionalString(params.defaultProvider) ??
    resolveDefaultModelForAgent({
      cfg: params.cfg,
      agentId: params.agentId,
    }).provider;
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider,
  });
  return resolveModelThroughAliases(raw, aliasIndex);
}

export function buildAllowedModelSet(
  params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    defaultProvider: string;
    defaultModel?: string;
    agentId?: string;
  } & ModelManifestNormalizationContext,
): {
  allowAny: boolean;
  allowedCatalog: ModelCatalogEntry[];
  allowedKeys: Set<string>;
  automaticFallbackKeys: Set<string>;
} {
  return buildAllowedModelSetWithFallbacks({
    cfg: params.cfg,
    catalog: params.catalog,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    agentId: params.agentId,
    fallbackModels: resolveAllowedFallbacks({
      cfg: params.cfg,
      agentId: params.agentId,
    }),
    manifestPlugins: params.manifestPlugins,
  });
}

export function getModelRefStatus(
  params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    ref: ModelRef;
    defaultProvider: string;
    defaultModel?: string;
  } & ModelManifestNormalizationContext,
): ModelRefStatus {
  return getModelRefStatusWithFallbackModels({
    cfg: params.cfg,
    catalog: params.catalog,
    ref: params.ref,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    fallbackModels: resolveAllowedFallbacks({
      cfg: params.cfg,
    }),
    manifestPlugins: params.manifestPlugins,
  });
}

function getModelRefStatusForResolve(
  params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    defaultProvider: string;
    defaultModel?: string;
  } & ModelManifestNormalizationContext,
  ref: ModelRef,
): ModelRefStatus {
  return getModelRefStatus({
    cfg: params.cfg,
    catalog: params.catalog,
    ref,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    manifestPlugins: params.manifestPlugins,
  });
}

export function resolveAllowedModelRef(
  params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    raw: string;
    defaultProvider: string;
    defaultModel?: string;
  } & ModelManifestNormalizationContext,
):
  | { ref: ModelRef; key: string }
  | {
      error: string;
    } {
  const trimmed = params.raw.trim();
  if (!trimmed) {
    return { error: "invalid model: empty" };
  }

  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
    manifestPlugins: params.manifestPlugins,
  });

  const openrouterCompatRef = resolveConfiguredOpenRouterCompatAlias({
    cfg: params.cfg,
    raw: trimmed,
    defaultProvider: params.defaultProvider,
    manifestPlugins: params.manifestPlugins,
  });
  if (openrouterCompatRef) {
    const status = getModelRefStatusForResolve(params, openrouterCompatRef);
    if (!status.allowed) {
      return { error: `model not allowed: ${status.key}` };
    }
    return { ref: openrouterCompatRef, key: status.key };
  }

  return resolveAllowedModelRefFromAliasIndex({
    cfg: params.cfg,
    raw: params.raw,
    defaultProvider: params.defaultProvider,
    aliasIndex,
    manifestPlugins: params.manifestPlugins,
    getStatus: (ref) => getModelRefStatusForResolve(params, ref),
  });
}

/** Default reasoning level when session/directive do not set it: "on" if model supports reasoning, else "off". */
export function resolveReasoningDefault(params: {
  provider: string;
  model: string;
  catalog?: ModelCatalogEntry[];
}): "on" | "off" {
  const key = modelKey(params.provider, params.model);
  const candidate = params.catalog?.find(
    (entry) =>
      (entry.provider === params.provider && entry.id === params.model) ||
      (entry.provider === key && entry.id === params.model),
  );
  return candidate?.reasoning === true ? "on" : "off";
}
