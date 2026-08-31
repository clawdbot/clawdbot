/**
 * Public model-selection facade for persisted, configured, and allowed refs.
 */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import { findModelInCatalog } from "./model-catalog-lookup.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import {
  type ModelManifestNormalizationContext,
  type ModelRef,
  findNormalizedProviderKey,
  legacyModelKey,
  modelKey,
  normalizeModelRef,
  normalizeProviderId,
  normalizeProviderIdForAuth,
} from "./model-ref-shared.js";
import {
  resolveDefaultModelForAgent,
  resolveSubagentConfiguredModelSelection,
} from "./model-selection-config.js";
import { findNormalizedProviderValue, parseModelRef } from "./model-selection-normalize.js";
import { resolvePersistedOverrideModelRef } from "./model-selection-persisted.js";
import {
  buildConfiguredModelCatalog,
  buildModelAliasIndex,
  inferUniqueProviderFromConfiguredModels,
  normalizeModelSelection,
  resolveBareModelDefaultProvider,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
  resolveModelAliasFromPair,
  resolveModelRefFromString,
  type ModelAliasIndex,
} from "./model-selection-shared.js";
export { resolveAllowedModelRefCore as resolveAllowedModelRef } from "./model-selection-resolve.js";
export { buildAllowedModelSet } from "./model-selection-shared.js";
export {
  resolveThinkingDefault,
  resolveThinkingDefaultWithRuntimeCatalog,
} from "./model-thinking-default.js";

export type { ModelAliasIndex, ModelManifestNormalizationContext, ModelRef };

export { resolveDefaultModelForAgent, resolveSubagentConfiguredModelSelection };

export {
  normalizeStoredOverrideModel,
  resolvePersistedOverrideModelRef,
} from "./model-selection-persisted.js";

export {
  buildConfiguredModelCatalog,
  buildModelAliasIndex,
  findNormalizedProviderKey,
  findNormalizedProviderValue,
  inferUniqueProviderFromConfiguredModels,
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
  resolveModelAliasFromPair,
  resolveModelRefFromString,
};
export {
  isCliProvider,
  prepareCliProviderClassifier,
  type CliProviderClassifier,
} from "./model-selection-cli.js";
// Cron imports this narrow owner directly; the public facade must not fork its policy.
export { getModelRefStatus } from "./model-selection-resolve.js";

function normalizePersistedDefaultProvider(value: unknown): string {
  return normalizeOptionalString(value) ?? DEFAULT_PROVIDER;
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

/**
 * Resolve a normalized model string through a pre-built alias index, returning
 * a fully qualified `provider/model` string.  If the value is already qualified
 * or not a known alias, returns it unchanged.
 */
function resolveModelThroughAliases(value: string, aliasIndex: ModelAliasIndex): string {
  const { model, profile } = splitTrailingAuthProfile(value);
  // Already a provider/model ref — no alias resolution needed.
  if (model.includes("/")) {
    return appendAuthProfileSuffix(model, profile);
  }
  // Check if the value is a known alias; if so, resolve to provider/model.
  // Unknown bare strings are returned as-is (don't guess the provider).
  const aliasKey = normalizeLowercaseStringOrEmpty(model);
  const aliasMatch = aliasIndex.byAlias.get(aliasKey);
  if (aliasMatch) {
    return appendAuthProfileSuffix(`${aliasMatch.ref.provider}/${aliasMatch.ref.model}`, profile);
  }
  return appendAuthProfileSuffix(model, profile);
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
    resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model) ??
    `${runtimeDefault.provider}/${runtimeDefault.model}`;
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    agentId: params.agentId,
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
    agentId: params.agentId,
    defaultProvider,
  });
  return resolveModelThroughAliases(raw, aliasIndex);
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
