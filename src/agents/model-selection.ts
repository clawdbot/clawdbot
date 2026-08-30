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
  resolveDefaultModelProviderForAgent,
  resolveSubagentConfiguredModelSelection,
} from "./model-selection-config.js";
import { findNormalizedProviderValue, parseModelRef } from "./model-selection-normalize.js";
import { resolvePersistedOverrideModelRef } from "./model-selection-persisted.js";
import {
  buildConfiguredModelCatalog,
  buildModelAliasIndexCore as buildModelAliasIndex,
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

/**
 * Runtime-first resolver for persisted model metadata.
 * Use this when callers intentionally want the last executed model identity.
 */
export function resolvePersistedModelRef(
  params: Parameters<typeof resolvePersistedOverrideModelRef>[0] & {
    runtimeProvider?: unknown;
    runtimeModel?: unknown;
  },
): ModelRef | null {
  const defaultProvider = normalizeOptionalString(params.defaultProvider) ?? DEFAULT_PROVIDER;
  const runtimeProvider = normalizeOptionalString(params.runtimeProvider);
  const runtimeModel = normalizeOptionalString(params.runtimeModel);
  if (runtimeModel) {
    if (runtimeProvider) {
      return { provider: runtimeProvider, model: runtimeModel };
    }
    return (
      parseModelRef(runtimeModel, defaultProvider, params) ?? {
        provider: defaultProvider,
        model: runtimeModel,
      }
    );
  }
  return resolvePersistedOverrideModelRef({
    ...params,
    defaultProvider,
  });
}

/**
 * Selected-model resolver for persisted model metadata.
 * Use this for control/status/UI surfaces that should honor explicit session
 * overrides before falling back to runtime identity.
 */
export function resolvePersistedSelectedModelRef(
  params: Parameters<typeof resolvePersistedOverrideModelRef>[0] & {
    runtimeProvider?: unknown;
    runtimeModel?: unknown;
  },
): ModelRef | null {
  const override = resolvePersistedOverrideModelRef(params);
  if (override) {
    return override;
  }
  return resolvePersistedModelRef(params);
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
 * Resolve a subagent alias without preparing defaults or aliases for qualified refs.
 * Unknown bare strings stay unchanged; execution owns their final normalization.
 */
function resolveModelThroughAliases(
  value: string,
  params: { cfg: OpenClawConfig; agentId: string; defaultProvider?: string },
): string {
  const { model, profile } = splitTrailingAuthProfile(value);
  if (model.includes("/")) {
    return appendAuthProfileSuffix(model, profile);
  }
  const defaultProvider =
    normalizeOptionalString(params.defaultProvider) ??
    resolveDefaultModelProviderForAgent({
      cfg: params.cfg,
      agentId: params.agentId,
    });
  const aliasIndex = buildModelAliasIndex({ ...params, defaultProvider });
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
  const configured = resolveConfiguredSubagentSpawnModelSelection(params);
  if (configured) {
    return configured;
  }
  const raw = resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model);
  if (raw) {
    return resolveModelThroughAliases(raw, params);
  }
  const runtimeDefault = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  return `${runtimeDefault.provider}/${runtimeDefault.model}`;
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
  return raw ? resolveModelThroughAliases(raw, params) : undefined;
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
