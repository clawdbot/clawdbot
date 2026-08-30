/**
 * Shared model-selection resolution, alias, allowlist, and visibility logic.
 */
import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog, stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import {
  computeModelPolicyAllowlist,
  hasExplicitModelPolicyAllow,
} from "../config/model-policy-allowlist-migration.js";
import { parseModelPolicyWildcardRef } from "../config/model-policy-ref.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  getCurrentPluginMetadataSnapshot,
  isScopedPluginMetadataSnapshotRuntimeGeneration,
} from "../plugins/current-plugin-metadata-snapshot.js";
import { loadManifestMetadataSnapshot } from "../plugins/manifest-contract-eligibility.js";
import {
  getCurrentPluginMetadataOwner,
  getPluginMetadataWorkspaceSnapshot,
  getScopedPluginMetadata,
} from "../plugins/plugin-metadata-collection.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "../plugins/runtime-state.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-state.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveAgentConfig } from "./agent-scope-config.js";
import { resolveConfiguredProviderFallback } from "./configured-provider-fallback.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import { findModelCatalogEntry } from "./model-catalog-lookup.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { resolveCatalogOwnedModelCompat } from "./model-compat-catalog.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import {
  createConfiguredProviderCatalogModelIdNormalizer,
  normalizeConfiguredProviderCatalogModelId,
  type ModelManifestNormalizationContext,
  type ModelRef,
  modelKey,
  normalizeModelRef,
  normalizeProviderId,
} from "./model-ref-shared.js";
import { findNormalizedProviderValue, parseModelRef } from "./model-selection-normalize.js";

export { resolvePrimaryStringValue as normalizeModelSelection } from "@openclaw/normalization-core/string-coerce";

// Shared model-selection helpers for config aliases, allowlists, provider
// inference, and configured catalog rows used by CLI and runtime selectors.
let log: ReturnType<typeof createSubsystemLogger> | null = null;

function getLog(): ReturnType<typeof createSubsystemLogger> {
  log ??= createSubsystemLogger("model-selection");
  return log;
}

const OPENROUTER_COMPAT_FREE_ALIAS = "openrouter:free";
type ModelManifestPlugins = ModelManifestNormalizationContext["manifestPlugins"];

export type ModelAliasIndex = {
  byAlias: Map<string, { alias: string; ref: ModelRef }>;
  byProviderAlias?: Map<string, { alias: string; ref: ModelRef }>;
  byKey: Map<string, string[]>;
  disabledKeys?: Set<string>;
};

export type ModelManifestPluginContext = {
  peek: () => ModelManifestPlugins;
  getContext: () => ModelManifestNormalizationContext;
};

/** Internal handoff after an operation has selected its metadata scope. */
export type ModelSelectionNormalizationContext = ModelManifestNormalizationContext & {
  manifestPluginContext?: ModelManifestPluginContext;
};

type ModelAliasCandidate = {
  keyRaw: string;
  alias: string;
};

type EffectiveModelAlias = ModelAliasCandidate & {
  ref: ModelRef;
};

function isStaticDefaultProviderAliasCandidate(
  candidate: ModelAliasCandidate,
  cfg: OpenClawConfig,
): boolean {
  const raw = candidate.keyRaw.trim();
  const slash = raw.indexOf("/");
  return (
    slash > 0 &&
    slash < raw.length - 1 &&
    normalizeProviderId(raw.slice(0, slash)) === normalizeProviderId(DEFAULT_PROVIDER) &&
    !findExactConfiguredProviderRefParts({ cfg, raw })
  );
}

type ExactConfiguredProviderRefParts = {
  configuredProvider: string;
  modelRaw: string;
};

function providerAliasKey(provider: string, alias: string): string {
  return `${normalizeProviderId(provider)}/${normalizeLowercaseStringOrEmpty(alias)}`;
}

function hasSlashFormModelRef(raw: string): boolean {
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  return slash > 0 && slash < trimmed.length - 1;
}

function resolveModelManifestNormalizationContext(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    workspaceDir?: string;
    manifestPlugins?: ModelManifestPlugins;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelManifestNormalizationContext {
  const context = {
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    manifestPlugins: params.manifestPlugins,
    pluginMetadataSnapshot: params.pluginMetadataSnapshot,
  };
  if (params.allowManifestNormalization === false && params.allowPluginNormalization === false) {
    return context;
  }
  const owner = getCurrentPluginMetadataOwner();
  const scoped = getScopedPluginMetadata();
  const runtimeGeneration = getPluginRuntimeGenerationRegistry();
  if (!owner && !scoped && !runtimeGeneration && params.allowManifestNormalization === false) {
    return context;
  }
  const current =
    !owner &&
    !scoped &&
    !runtimeGeneration &&
    (params.workspaceDir || params.manifestPlugins !== undefined || params.pluginMetadataSnapshot)
      ? undefined
      : getCurrentPluginMetadataSnapshot({
          config: params.cfg,
          allowWorkspaceScopedSnapshot: true,
        });
  if (current && isScopedPluginMetadataSnapshotRuntimeGeneration(current)) {
    return {
      config: params.cfg,
      workspaceDir: current.workspaceDir,
      manifestPlugins: current.plugins,
      pluginMetadataSnapshot: current,
    };
  }
  if (params.pluginMetadataSnapshot && !runtimeGeneration) {
    // Operation preparation may own an auxiliary workspace outside the published
    // collection. A retained runtime generation above still owns its exact graph.
    const snapshot = params.pluginMetadataSnapshot;
    return {
      config: params.cfg,
      workspaceDir: snapshot.workspaceDir ?? params.workspaceDir,
      manifestPlugins: params.manifestPlugins ?? snapshot.manifestRegistry.plugins,
      pluginMetadataSnapshot: snapshot,
    };
  }
  const prepared = scoped
    ? current && [...scoped.workspaces.values()].includes(current)
      ? scoped
      : undefined
    : runtimeGeneration
      ? undefined
      : owner?.readConfigWide({ config: params.cfg, env: process.env });
  if (prepared) {
    // Agent paths belong to preparation. Retired session owners use the current
    // control-plane policy without inventing or scanning another workspace.
    const workspaceDir =
      params.workspaceDir ??
      (params.agentId
        ? prepared.agentWorkspaceDirs.get(normalizeAgentId(params.agentId))
        : undefined) ??
      prepared.selectedSnapshot.workspaceDir;
    const snapshot = getPluginMetadataWorkspaceSnapshot(prepared, { workspaceDir });
    return {
      config: params.cfg,
      workspaceDir: snapshot.workspaceDir,
      manifestPlugins: params.manifestPlugins ?? snapshot.plugins,
      pluginMetadataSnapshot: snapshot,
    };
  }
  if (runtimeGeneration) {
    throw new Error("Model normalization escaped its prepared runtime generation");
  }
  if (params.manifestPlugins !== undefined && !scoped) {
    return context;
  }
  if (owner?.getActive() || scoped) {
    throw new Error("Config plugin metadata must be prepared before model normalization");
  }
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  if (!workspaceDir) {
    const currentManifestPlugins =
      current?.workspaceDir === undefined ? current?.plugins : undefined;
    if (currentManifestPlugins) {
      return {
        ...context,
        manifestPlugins: currentManifestPlugins,
        pluginMetadataSnapshot: current,
      };
    }
  }
  const snapshot = loadManifestMetadataSnapshot({
    config: params.cfg,
    env: process.env,
    ...(workspaceDir ? { workspaceDir } : {}),
  });
  return {
    config: params.cfg,
    workspaceDir: snapshot.workspaceDir,
    manifestPlugins: snapshot.plugins,
    pluginMetadataSnapshot: snapshot,
  };
}

export function createModelManifestPluginContext(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    workspaceDir?: string;
    manifestPlugins?: ModelManifestPlugins;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelManifestPluginContext {
  let context: ModelManifestNormalizationContext | undefined;
  const getContext = () =>
    (context ??= {
      ...resolveModelManifestNormalizationContext(params),
      ...(params.providerPlugin ? { providerPlugin: params.providerPlugin } : {}),
    });
  return {
    peek: () =>
      context?.manifestPlugins ??
      params.manifestPlugins ??
      params.pluginMetadataSnapshot?.manifestRegistry.plugins,
    // Empty/default model paths never resolve metadata; parsing and hooks share
    // the same prepared config, workspace, and manifest facts once needed.
    getContext,
  };
}

function listConfiguredModelMaps(cfg: OpenClawConfig, agentId?: string) {
  return [
    { models: cfg.agents?.defaults?.models },
    ...(agentId ? [{ models: resolveAgentConfig(cfg, agentId)?.models }] : []),
  ];
}

export function listModelAliasCandidates(cfg: OpenClawConfig, agentId?: string) {
  return listConfiguredModelMaps(cfg, agentId).flatMap(({ models }) =>
    Object.entries(models ?? {}).flatMap(([keyRaw, entryRaw]) => {
      if (parseModelPolicyWildcardRef(keyRaw)) {
        return [];
      }
      if (!entryRaw || typeof entryRaw !== "object" || !Object.hasOwn(entryRaw, "alias")) {
        return [];
      }
      const alias = normalizeOptionalString((entryRaw as { alias?: unknown }).alias) ?? "";
      return [{ keyRaw, alias }];
    }),
  );
}

function buildEffectiveModelAliases(
  params: Omit<BuildModelAliasIndexParams, "manifestPlugins"> & {
    manifestPluginContext: ModelManifestPluginContext;
  },
  candidates = listModelAliasCandidates(params.cfg, params.agentId),
): { aliases: EffectiveModelAlias[]; disabledKeys: Set<string> } {
  const aliasesByKey = new Map<string, EffectiveModelAlias | null>();
  if (candidates.length === 0) {
    return { aliases: [], disabledKeys: new Set() };
  }
  // One alias index must use one manifest generation. Skip discovery only when
  // every candidate is a default-provider identity transform.
  const useStaticDefaultProviderAliases =
    params.allowManifestNormalization !== false &&
    candidates.every((candidate) => isStaticDefaultProviderAliasCandidate(candidate, params.cfg)) &&
    params.manifestPluginContext.peek() === undefined &&
    !getCurrentPluginMetadataOwner() &&
    !getScopedPluginMetadata() &&
    !getPluginRuntimeGenerationRegistry() &&
    !getActivePluginRegistryWorkspaceDirFromState() &&
    !getCurrentPluginMetadataSnapshot({ config: params.cfg, env: process.env });
  const normalization = useStaticDefaultProviderAliases
    ? undefined
    : params.manifestPluginContext.getContext();
  for (const candidate of candidates) {
    const ref = parseModelRefWithCompatAlias({
      ...normalization,
      cfg: params.cfg,
      agentId: params.agentId,
      raw: candidate.keyRaw,
      defaultProvider: params.defaultProvider,
      allowManifestNormalization: useStaticDefaultProviderAliases
        ? false
        : params.allowManifestNormalization,
      allowPluginNormalization: useStaticDefaultProviderAliases
        ? false
        : params.allowPluginNormalization,
    });
    if (!ref) {
      continue;
    }
    const key = buildModelCatalogRef(ref.provider, ref.model);
    // Reinsert replacements so agent-owned aliases win duplicate-alias lookup
    // while an omitted agent alias leaves the inherited record untouched.
    aliasesByKey.delete(key);
    aliasesByKey.set(key, candidate.alias ? { ...candidate, ref } : null);
  }
  return {
    aliases: [...aliasesByKey.values()].filter(
      (alias): alias is EffectiveModelAlias => alias !== null,
    ),
    disabledKeys: new Set(
      [...aliasesByKey].flatMap(([key, alias]) => (alias === null ? [key] : [])),
    ),
  };
}

function findModelAliasCandidate(
  candidates: readonly EffectiveModelAlias[],
  raw: string,
): EffectiveModelAlias | undefined {
  const aliasKey = normalizeLowercaseStringOrEmpty(raw);
  let match: EffectiveModelAlias | undefined;
  for (const candidate of candidates) {
    if (normalizeLowercaseStringOrEmpty(candidate.alias) === aliasKey) {
      match = candidate;
    }
  }
  return match;
}

function sanitizeModelWarningValue(value: string): string {
  const stripped = value ? stripAnsi(value) : "";
  let controlBoundary = -1;
  for (let index = 0; index < stripped.length; index += 1) {
    const code = stripped.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      controlBoundary = index;
      break;
    }
  }
  if (controlBoundary === -1) {
    return sanitizeForLog(stripped);
  }
  return sanitizeForLog(stripped.slice(0, controlBoundary));
}

function mergeModelCatalogEntries(params: {
  primary: readonly ModelCatalogEntry[];
  secondary: readonly ModelCatalogEntry[];
}): ModelCatalogEntry[] {
  const merged = [...params.primary];
  const seen = new Set(merged.map((entry) => buildModelCatalogRef(entry.provider, entry.id)));
  for (const entry of params.secondary) {
    const key = buildModelCatalogRef(entry.provider, entry.id);
    if (seen.has(key)) {
      continue;
    }
    merged.push(entry);
    seen.add(key);
  }
  return merged;
}

/** Infer a unique provider for a bare model from configured model rows. */
export function inferUniqueProviderFromConfiguredModels(
  params: {
    cfg: OpenClawConfig;
    model: string;
    agentId?: string;
    allowManifestNormalization?: boolean;
  } & ModelSelectionNormalizationContext,
): string | undefined {
  const model = params.model.trim();
  if (!model) {
    return undefined;
  }
  const normalized = normalizeLowercaseStringOrEmpty(model);
  const manifestContext =
    params.manifestPluginContext ??
    createModelManifestPluginContext({
      ...params,
      allowPluginNormalization: false,
    });
  const collectModelMapProviders = (models: Record<string, unknown> | undefined) => {
    const providers = new Set<string>();
    for (const key of Object.keys(models ?? {})) {
      const ref = key.trim();
      if (!ref || !ref.includes("/") || ref.endsWith("/*")) {
        continue;
      }
      const parsed = parseModelRef(ref, DEFAULT_PROVIDER, {
        ...manifestContext.getContext(),
        allowManifestNormalization: params.allowManifestNormalization,
        allowPluginNormalization: false,
      });
      if (
        parsed &&
        (parsed.model === model || normalizeLowercaseStringOrEmpty(parsed.model) === normalized)
      ) {
        providers.add(normalizeProviderId(parsed.provider));
      }
    }
    return providers;
  };
  const agentProviders = params.agentId
    ? collectModelMapProviders(resolveAgentConfig(params.cfg, params.agentId)?.models)
    : new Set<string>();
  if (agentProviders.size > 0) {
    return agentProviders.size === 1 ? agentProviders.values().next().value : undefined;
  }

  const providers = collectModelMapProviders(params.cfg.agents?.defaults?.models);
  const addProvider = (provider: string) => {
    const normalizedProvider = normalizeProviderId(provider);
    if (!normalizedProvider) {
      return;
    }
    providers.add(normalizedProvider);
  };
  const configuredProviders = params.cfg.models?.providers;
  if (configuredProviders) {
    let normalizeModelId:
      | ReturnType<typeof createConfiguredProviderCatalogModelIdNormalizer>
      | undefined;
    for (const [providerId, providerConfig] of Object.entries(configuredProviders)) {
      const models = providerConfig?.models;
      if (!Array.isArray(models)) {
        continue;
      }
      for (const entry of models) {
        const modelId = entry?.id?.trim();
        if (!modelId) {
          continue;
        }
        normalizeModelId ??= createConfiguredProviderCatalogModelIdNormalizer({
          ...manifestContext.getContext(),
          allowManifestNormalization: params.allowManifestNormalization,
        });
        const normalizedModelId = normalizeModelId(providerId, modelId);
        if (
          modelId === model ||
          normalizeLowercaseStringOrEmpty(modelId) === normalized ||
          normalizedModelId === model ||
          normalizeLowercaseStringOrEmpty(normalizedModelId) === normalized
        ) {
          addProvider(providerId);
        }
      }
      if (providers.size > 1) {
        return undefined;
      }
    }
  }
  if (providers.size !== 1) {
    return undefined;
  }
  return providers.values().next().value;
}

/** Infer a unique provider for a bare model from a provider catalog. */
function inferUniqueProviderFromCatalog(params: {
  catalog: readonly ModelCatalogEntry[];
  model: string;
}): string | undefined {
  const model = params.model.trim();
  if (!model) {
    return undefined;
  }
  const normalized = normalizeLowercaseStringOrEmpty(model);
  const providers = new Set<string>();
  for (const entry of params.catalog) {
    const entryId = entry.id.trim();
    if (!entryId) {
      continue;
    }
    if (entryId !== model && normalizeLowercaseStringOrEmpty(entryId) !== normalized) {
      continue;
    }
    const provider = normalizeProviderId(entry.provider);
    if (provider) {
      providers.add(provider);
    }
    if (providers.size > 1) {
      return undefined;
    }
  }
  return providers.size === 1 ? providers.values().next().value : undefined;
}

/** Resolve the provider used when a model string omits provider/id syntax. */
export function resolveBareModelDefaultProvider(
  params: {
    cfg: OpenClawConfig;
    catalog: readonly ModelCatalogEntry[];
    model: string;
    defaultProvider: string;
    agentId?: string;
  } & ModelSelectionNormalizationContext,
): string {
  return (
    inferUniqueProviderFromConfiguredModels({
      ...params,
    }) ??
    inferUniqueProviderFromCatalog({ catalog: params.catalog, model: params.model }) ??
    params.defaultProvider
  );
}

function isConcreteOpenRouterFreeModelRef(ref: ModelRef): boolean {
  return ref.provider === "openrouter" && ref.model.includes("/") && ref.model.endsWith(":free");
}

function resolveConfiguredOpenRouterCompatFreeRef(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    defaultProvider: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelRef | null {
  const agentModels = params.agentId
    ? resolveAgentConfig(params.cfg, params.agentId)?.models
    : undefined;
  for (const models of [agentModels, params.cfg.agents?.defaults?.models]) {
    for (const raw of Object.keys(models ?? {})) {
      if (!raw.includes("/")) {
        continue;
      }
      const parsed = parseModelRef(raw, params.defaultProvider, {
        ...params,
        allowManifestNormalization: params.allowManifestNormalization,
        allowPluginNormalization: params.allowPluginNormalization,
      });
      if (parsed && isConcreteOpenRouterFreeModelRef(parsed)) {
        return parsed;
      }
    }
  }

  const openrouterProviderConfig = findNormalizedProviderValue(
    params.cfg.models?.providers,
    "openrouter",
  );
  for (const entry of openrouterProviderConfig?.models ?? []) {
    const modelId = entry?.id?.trim();
    if (!modelId || !modelId.includes("/") || !modelId.endsWith(":free")) {
      continue;
    }
    return normalizeModelRef("openrouter", modelId, {
      ...params,
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
    });
  }

  return null;
}

/** Resolve OpenRouter compatibility aliases such as openrouter:auto/free. */
function resolveConfiguredOpenRouterCompatAlias(
  params: {
    cfg?: OpenClawConfig;
    agentId?: string;
    raw: string;
    defaultProvider: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelRef | null {
  const normalized = normalizeLowercaseStringOrEmpty(params.raw);
  if (normalized === "openrouter:auto") {
    return normalizeModelRef("openrouter", "auto", {
      ...params,
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
    });
  }
  if (normalized !== OPENROUTER_COMPAT_FREE_ALIAS || !params.cfg) {
    return null;
  }
  return resolveConfiguredOpenRouterCompatFreeRef({
    ...params,
    cfg: params.cfg,
  });
}

function parseModelRefWithCompatAlias(
  params: {
    cfg?: OpenClawConfig;
    agentId?: string;
    raw: string;
    defaultProvider: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelRef | null {
  const exactConfiguredProviderRef = resolveExactConfiguredProviderRef(params);
  const exactDefaultProviderRef = hasSlashFormModelRef(params.raw)
    ? null
    : resolveExactConfiguredProviderRef({
        ...params,
        raw: `${params.defaultProvider}/${params.raw}`,
      });
  return (
    resolveConfiguredOpenRouterCompatAlias(params) ??
    exactConfiguredProviderRef ??
    exactDefaultProviderRef ??
    parseModelRef(params.raw, params.defaultProvider, {
      ...params,
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
    })
  );
}

function findExactConfiguredProviderRefParts(params: {
  cfg?: OpenClawConfig;
  raw: string;
}): ExactConfiguredProviderRefParts | null {
  const slash = params.raw.indexOf("/");
  if (slash <= 0 || !params.cfg?.models?.providers) {
    return null;
  }
  const providerRaw = params.raw.slice(0, slash).trim();
  const modelRaw = params.raw.slice(slash + 1).trim();
  if (!providerRaw || !modelRaw) {
    return null;
  }
  const providerKey = normalizeLowercaseStringOrEmpty(providerRaw);
  const exactConfigured = Object.entries(params.cfg.models.providers).find(
    ([key]) => normalizeLowercaseStringOrEmpty(key) === providerKey,
  );
  if (!exactConfigured) {
    return null;
  }
  const [configuredProvider, providerConfig] = exactConfigured;
  const normalizedConfiguredProvider = normalizeProviderId(configuredProvider);
  const apiOwner =
    typeof providerConfig?.api === "string" ? normalizeProviderId(providerConfig.api) : "";
  if (
    (!apiOwner || apiOwner === normalizedConfiguredProvider) &&
    !providerConfig.models?.some((entry) => entry.id.trim() === modelRaw)
  ) {
    return null;
  }
  return { configuredProvider, modelRaw };
}

function normalizeExactConfiguredProviderRef(
  parts: ExactConfiguredProviderRefParts,
  params: {
    allowManifestNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelRef {
  const { configuredProvider, modelRaw } = parts;
  const provider = normalizeLowercaseStringOrEmpty(configuredProvider);
  return {
    provider,
    model: normalizeConfiguredProviderCatalogModelId(provider, modelRaw, params),
  };
}

function resolveExactConfiguredProviderRef(
  params: {
    cfg?: OpenClawConfig;
    raw: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelRef | null {
  const exactConfigured = findExactConfiguredProviderRefParts({
    cfg: params.cfg,
    raw: params.raw,
  });
  if (!exactConfigured) {
    return null;
  }
  return normalizeExactConfiguredProviderRef(exactConfigured, params);
}

/** Preserve shipped short spellings only when they select the same exact model. */
export function formatModelRefForConfig(
  ref: ModelRef,
  params: { cfg: OpenClawConfig; manifestPlugins: NonNullable<ModelManifestPlugins> },
): string {
  const key = modelKey(ref.provider, ref.model);
  const exactKey = buildModelCatalogRef(ref.provider, ref.model);
  if (key === exactKey) {
    return key;
  }
  const parsed = parseModelRefWithCompatAlias({
    ...params,
    raw: key,
    defaultProvider: ref.provider,
    allowPluginNormalization: false,
  });
  return parsed?.provider === ref.provider && parsed.model === ref.model ? key : exactKey;
}

type BuildModelAliasIndexParams = {
  cfg: OpenClawConfig;
  defaultProvider: string;
  agentId?: string;
  allowManifestNormalization?: boolean;
  allowPluginNormalization?: boolean;
} & ModelSelectionNormalizationContext;

function indexModelAliases(
  aliases: readonly { alias: string; ref: ModelRef }[],
  disabledKeys: Set<string>,
): ModelAliasIndex {
  const byAlias: ModelAliasIndex["byAlias"] = new Map();
  const byProviderAlias: NonNullable<ModelAliasIndex["byProviderAlias"]> = new Map();
  const byKey = new Map<string, string[]>();

  for (const { alias, ref } of aliases) {
    const match = { alias, ref };
    const aliasKey = normalizeLowercaseStringOrEmpty(alias);
    const key = buildModelCatalogRef(ref.provider, ref.model);
    byAlias.set(aliasKey, match);
    // Bare aliases retain their existing last-wins behavior. Provider-qualified
    // aliases stay scoped so duplicate display names cannot select another provider.
    byProviderAlias.set(providerAliasKey(ref.provider, alias), match);
    byKey.set(key, [alias]);
  }

  return { byAlias, byProviderAlias, byKey, disabledKeys };
}

/** Build lookup maps from user-facing aliases to normalized model refs. */
export function buildModelAliasIndexCore(params: BuildModelAliasIndexParams): ModelAliasIndex {
  const { aliases, disabledKeys } = buildEffectiveModelAliases({
    ...params,
    manifestPluginContext: params.manifestPluginContext ?? createModelManifestPluginContext(params),
  });
  return indexModelAliases(aliases, disabledKeys);
}

type ModelCatalogMetadata = {
  configuredByKey: Map<string, ModelCatalogEntry>;
  aliasByKey: Map<string, string>;
};

function buildModelCatalogMetadata(params: {
  configuredCatalog: readonly ModelCatalogEntry[];
  aliasIndex: ModelAliasIndex;
}): ModelCatalogMetadata {
  const configuredByKey = new Map<string, ModelCatalogEntry>();
  for (const entry of params.configuredCatalog) {
    configuredByKey.set(buildModelCatalogRef(entry.provider, entry.id), entry);
  }

  const aliasByKey = new Map(
    [...params.aliasIndex.byKey].flatMap(([key, aliases]) => {
      const alias = aliases.at(-1);
      return alias ? [[key, alias] as const] : [];
    }),
  );

  return { configuredByKey, aliasByKey };
}

function applyModelCatalogMetadata(params: {
  entry: ModelCatalogEntry;
  metadata: ModelCatalogMetadata;
}): ModelCatalogEntry {
  const key = buildModelCatalogRef(params.entry.provider, params.entry.id);
  const configuredEntry = params.metadata.configuredByKey.get(key);
  const alias = params.metadata.aliasByKey.get(key);
  if (!configuredEntry && !alias) {
    return params.entry;
  }
  const nextAlias = alias ?? params.entry.alias;
  const nextContextWindow = configuredEntry?.contextWindow ?? params.entry.contextWindow;
  const nextContextTokens = configuredEntry?.contextTokens ?? params.entry.contextTokens;
  const nextReasoning = configuredEntry?.reasoning ?? params.entry.reasoning;
  const configuredReasoning = configuredEntry?.configuredReasoning;
  const nextInput = configuredEntry?.input ?? params.entry.input;
  const nextParams =
    params.entry.params || configuredEntry?.params
      ? { ...params.entry.params, ...configuredEntry?.params }
      : undefined;
  const nextCompat = resolveCatalogOwnedModelCompat({
    catalogRoute: params.entry,
    catalogCompat: params.entry.compat,
    configuredRoute: configuredEntry,
    configuredCompat: configuredEntry?.compat,
  });

  return {
    ...params.entry,
    name: configuredEntry?.name ?? params.entry.name,
    ...(nextAlias ? { alias: nextAlias } : {}),
    ...(nextContextWindow !== undefined ? { contextWindow: nextContextWindow } : {}),
    ...(nextContextTokens !== undefined ? { contextTokens: nextContextTokens } : {}),
    ...(nextReasoning !== undefined ? { reasoning: nextReasoning } : {}),
    ...(configuredReasoning !== undefined ? { configuredReasoning } : {}),
    ...(nextInput ? { input: nextInput } : {}),
    ...(nextParams ? { params: nextParams } : {}),
    ...(nextCompat ? { compat: nextCompat } : {}),
  };
}

function buildSyntheticAllowedCatalogEntry(params: {
  parsed: ModelRef;
  metadata: ModelCatalogMetadata;
}): ModelCatalogEntry {
  const key = buildModelCatalogRef(params.parsed.provider, params.parsed.model);
  const configuredEntry = params.metadata.configuredByKey.get(key);
  const alias = params.metadata.aliasByKey.get(key);
  const nextContextWindow = configuredEntry?.contextWindow;
  const nextContextTokens = configuredEntry?.contextTokens;
  const nextReasoning = configuredEntry?.reasoning;
  const configuredReasoning = configuredEntry?.configuredReasoning;
  const nextInput = configuredEntry?.input;
  const nextParams = configuredEntry?.params;
  const nextCompat = configuredEntry?.compat;

  return {
    id: params.parsed.model,
    name: configuredEntry?.name ?? params.parsed.model,
    provider: params.parsed.provider,
    ...(alias ? { alias } : {}),
    ...(nextContextWindow !== undefined ? { contextWindow: nextContextWindow } : {}),
    ...(nextContextTokens !== undefined ? { contextTokens: nextContextTokens } : {}),
    ...(nextReasoning !== undefined ? { reasoning: nextReasoning } : {}),
    ...(configuredReasoning !== undefined ? { configuredReasoning } : {}),
    ...(nextInput ? { input: nextInput } : {}),
    ...(nextParams ? { params: nextParams } : {}),
    ...(nextCompat ? { compat: nextCompat } : {}),
  };
}

function findModelAlias(
  raw: string,
  index?: Pick<ModelAliasIndex, "byAlias" | "byProviderAlias">,
): { alias: string; ref: ModelRef } | undefined {
  const slash = raw.indexOf("/");
  return (
    index?.byAlias.get(normalizeLowercaseStringOrEmpty(raw)) ??
    (slash > 0
      ? index?.byProviderAlias?.get(providerAliasKey(raw.slice(0, slash), raw.slice(slash + 1)))
      : undefined)
  );
}

/** Prepare only the alias competitors and raw fallback that can own one model operand. */
export function planModelRefWithConfiguredAliases(
  params: BuildModelAliasIndexParams & { raw: string },
): { candidates: EffectiveModelAlias[]; fallbackRef: ModelRef | null } {
  const { model } = splitTrailingAuthProfile(params.raw);
  if (!model) {
    return { candidates: [], fallbackRef: null };
  }
  const manifestPluginContext =
    params.manifestPluginContext ?? createModelManifestPluginContext(params);
  const candidates = listModelAliasCandidates(params.cfg, params.agentId);
  const aliasKey = normalizeLowercaseStringOrEmpty(model);
  const slash = model.indexOf("/");
  const qualifiedAlias = slash > 0 ? normalizeLowercaseStringOrEmpty(model.slice(slash + 1)) : "";
  const normalization = manifestPluginContext.getContext();
  let competingCandidates: EffectiveModelAlias[] = [];
  if (
    candidates.some(({ alias }) => {
      const key = normalizeLowercaseStringOrEmpty(alias);
      return key && (key === aliasKey || key === qualifiedAlias);
    })
  ) {
    const parsedCandidates = candidates.flatMap((candidate) => {
      const ref = parseModelRefWithCompatAlias({
        ...params,
        ...normalization,
        raw: candidate.keyRaw,
        allowPluginNormalization: false,
      });
      return ref ? [{ ...candidate, ref }] : [];
    });
    const qualifiedProvider = slash > 0 ? normalizeProviderId(model.slice(0, slash)) : "";
    const providers = new Set(
      parsedCandidates
        .filter(({ alias, ref }) => {
          const key = normalizeLowercaseStringOrEmpty(alias);
          return (
            key &&
            (key === aliasKey || (key === qualifiedAlias && ref.provider === qualifiedProvider))
          );
        })
        .map(({ ref }) => ref.provider),
    );
    // Runtime-only model aliases can collide with blank or renamed agent rows.
    // Retain every candidate for competing providers in authored order, including blanks.
    competingCandidates = parsedCandidates.filter(({ ref }) => providers.has(ref.provider));
  }
  return {
    candidates: competingCandidates,
    // If runtime normalization removes every alias, the raw operand owns selection.
    // Its provider must already belong to the same closed runtime generation.
    fallbackRef: parseModelRefWithCompatAlias({
      ...params,
      ...normalization,
      raw: model,
      allowPluginNormalization: false,
    }),
  };
}

/** Resolve configured aliases without executing unrelated provider normalization hooks. */
export function resolveModelRefWithConfiguredAliases(
  params: BuildModelAliasIndexParams & { raw: string },
  plan?: ReturnType<typeof planModelRefWithConfiguredAliases>,
): ModelRef | null {
  const { model } = splitTrailingAuthProfile(params.raw);
  if (!model) {
    return null;
  }
  const manifestPluginContext =
    params.manifestPluginContext ?? createModelManifestPluginContext(params);
  const { candidates, fallbackRef } =
    plan ?? planModelRefWithConfiguredAliases({ ...params, manifestPluginContext });
  if (candidates.length > 0) {
    const { aliases, disabledKeys } = buildEffectiveModelAliases(
      { ...params, manifestPluginContext },
      candidates,
    );
    const alias = findModelAlias(model, indexModelAliases(aliases, disabledKeys));
    if (alias) {
      // Already normalized from its authored key; reparsing can strip nested paths twice.
      return alias.ref;
    }
  }
  return params.allowPluginNormalization === false
    ? fallbackRef
    : parseModelRefWithCompatAlias({
        ...params,
        ...manifestPluginContext.getContext(),
        raw: model,
      });
}

export function resolveModelRefFromString(
  params: {
    cfg?: OpenClawConfig;
    agentId?: string;
    raw: string;
    defaultProvider: string;
    aliasIndex?: ModelAliasIndex;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelSelectionNormalizationContext,
): { ref: ModelRef; alias?: string } | null {
  const { model } = splitTrailingAuthProfile(params.raw);
  if (!model) {
    return null;
  }
  const aliasMatch = findModelAlias(model, params.aliasIndex);
  if (aliasMatch) {
    return { ref: aliasMatch.ref, alias: aliasMatch.alias };
  }
  const parsed = parseModelRefWithCompatAlias({
    ...params,
    ...(params.cfg
      ? (
          params.manifestPluginContext ??
          createModelManifestPluginContext({ ...params, cfg: params.cfg })
        ).getContext()
      : undefined),
    raw: model,
  });
  if (!parsed) {
    return null;
  }
  return { ref: parsed };
}

/** Resolves legacy provider/model pairs only through their prepared alias index. */
export function resolveModelAliasFromPair(params: {
  provider: string;
  model: string;
  defaultProvider: string;
  aliasIndex?: ModelAliasIndex;
}): ModelRef | null {
  const bareModel = splitTrailingAuthProfile(params.model).model;
  const providerModel = splitTrailingAuthProfile(`${params.provider}/${params.model}`).model;
  const providerAlias = providerModel
    ? findModelAlias(providerModel, params.aliasIndex)
    : undefined;
  if (providerAlias?.alias) {
    return providerAlias.ref;
  }
  const bareAlias = bareModel ? findModelAlias(bareModel, params.aliasIndex) : undefined;
  const provider = normalizeProviderId(params.provider);
  return bareAlias?.alias &&
    (normalizeProviderId(bareAlias.ref.provider) === provider ||
      provider === normalizeProviderId(params.defaultProvider))
    ? bareAlias.ref
    : null;
}

type ConfiguredModelRefParams = {
  cfg: OpenClawConfig;
  agentId?: string;
  /** Resolve an authored operand without replacing the caller's config or agent scope. */
  rawModel?: string;
  defaultProvider: string;
  defaultModel: string;
  allowManifestNormalization?: boolean;
  allowPluginNormalization?: boolean;
} & ModelSelectionNormalizationContext;

/** Resolve the default configured model ref, including aliases and fallback provider rows. */
export function resolveConfiguredModelRef(params: ConfiguredModelRefParams): ModelRef {
  return resolveConfiguredModelSelection(params, params.allowPluginNormalization);
}

/** Resolve provider ownership without executing hooks for an unused final model id. */
export function resolveConfiguredModelProvider(params: ConfiguredModelRefParams): string {
  return resolveConfiguredModelSelection(params, false).provider;
}

function resolveConfiguredModelSelection(
  params: ConfiguredModelRefParams,
  allowSelectedPluginNormalization: boolean | undefined,
): ModelRef {
  const rawModel =
    params.rawModel ??
    (params.agentId
      ? resolveAgentModelPrimaryValue(resolveAgentConfig(params.cfg, params.agentId)?.model)
      : undefined) ??
    resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model) ??
    "";
  if (rawModel) {
    const trimmed = rawModel.trim();
    const { model: modelWithoutProfile } = splitTrailingAuthProfile(trimmed);
    const manifestPluginContext =
      params.manifestPluginContext ?? createModelManifestPluginContext(params);
    const profileStripped = Boolean(modelWithoutProfile && modelWithoutProfile !== trimmed);
    const aliasKeys = new Set(
      [trimmed, ...(profileStripped ? [modelWithoutProfile] : [])].map(
        normalizeLowercaseStringOrEmpty,
      ),
    );
    const hasPossibleAlias = listModelAliasCandidates(params.cfg, params.agentId).some(
      (candidate) => aliasKeys.has(normalizeLowercaseStringOrEmpty(candidate.alias)),
    );
    // Resolving alias targets can require workspace manifests. Keep ordinary
    // primary selection on the static path when it cannot match an alias.
    // Normalized alias collisions and blank overrides can change the provider winner,
    // even when the caller only needs its provider and discards the final model id.
    const aliasCandidates = hasPossibleAlias
      ? buildEffectiveModelAliases({
          cfg: params.cfg,
          agentId: params.agentId,
          defaultProvider: params.defaultProvider,
          allowManifestNormalization: params.allowManifestNormalization,
          allowPluginNormalization: params.allowPluginNormalization,
          manifestPluginContext,
        }).aliases
      : [];
    const exactAliasCandidate = findModelAliasCandidate(aliasCandidates, trimmed);
    const strippedAliasCandidate = profileStripped
      ? findModelAliasCandidate(aliasCandidates, modelWithoutProfile)
      : undefined;
    const profileAliasCandidate = profileStripped
      ? (exactAliasCandidate ?? strippedAliasCandidate)
      : undefined;
    if (profileAliasCandidate) {
      // Auth-profile suffixes are not part of alias matching; resolve the alias
      // target while preserving the provider/model semantics of the key.
      return profileAliasCandidate.ref;
    }
    const primaryWithoutProfile = modelWithoutProfile || trimmed;
    const exactConfiguredPrimary = findExactConfiguredProviderRefParts({
      cfg: params.cfg,
      raw: primaryWithoutProfile,
    });
    if (exactConfiguredPrimary) {
      return normalizeExactConfiguredProviderRef(exactConfiguredPrimary, {
        ...manifestPluginContext.getContext(),
        allowManifestNormalization: params.allowManifestNormalization,
      });
    }
    const aliasCandidate = profileStripped ? undefined : exactAliasCandidate;
    const manifestPlugins = manifestPluginContext.peek();
    if (
      aliasCandidate &&
      hasSlashFormModelRef(primaryWithoutProfile) &&
      !hasSlashFormModelRef(aliasCandidate.keyRaw)
    ) {
      const primaryRef = parseModelRefWithCompatAlias({
        ...manifestPluginContext.getContext(),
        cfg: params.cfg,
        agentId: params.agentId,
        raw: primaryWithoutProfile,
        defaultProvider: params.defaultProvider,
        allowManifestNormalization: params.allowManifestNormalization,
        allowPluginNormalization: allowSelectedPluginNormalization,
      });
      if (primaryRef) {
        return primaryRef;
      }
    }
    if (aliasCandidate) {
      return aliasCandidate.ref;
    }

    if (!trimmed.includes("/")) {
      const normalizedTrimmed = normalizeLowercaseStringOrEmpty(trimmed);
      const needsOpenRouterCompatManifestPlugins =
        normalizedTrimmed === "openrouter:auto" ||
        normalizedTrimmed === OPENROUTER_COMPAT_FREE_ALIAS;
      const openrouterCompatRef = resolveConfiguredOpenRouterCompatAlias({
        ...(needsOpenRouterCompatManifestPlugins
          ? manifestPluginContext.getContext()
          : { manifestPlugins }),
        cfg: params.cfg,
        agentId: params.agentId,
        raw: trimmed,
        defaultProvider: params.defaultProvider,
        allowManifestNormalization: params.allowManifestNormalization,
        allowPluginNormalization: params.allowPluginNormalization,
      });
      if (openrouterCompatRef) {
        return openrouterCompatRef;
      }

      let inferredProvider = inferUniqueProviderFromConfiguredModels({
        cfg: params.cfg,
        model: trimmed,
        agentId: params.agentId,
        allowManifestNormalization: false,
        manifestPlugins,
      });
      let inferredProviderManifestPlugins = manifestPlugins;
      if (
        (!inferredProvider || inferredProvider !== "openai") &&
        hasConfiguredRowsNeedingManifestLookup(params.cfg, params.defaultProvider, params.agentId)
      ) {
        // Non-default provider rows may normalize through plugin manifests. Avoid
        // that heavier lookup unless the cheap configured pass was ambiguous.
        inferredProviderManifestPlugins = manifestPluginContext.getContext().manifestPlugins;
        inferredProvider =
          inferUniqueProviderFromConfiguredModels({
            manifestPluginContext,
            cfg: params.cfg,
            model: trimmed,
            agentId: params.agentId,
            allowManifestNormalization: params.allowManifestNormalization,
            manifestPlugins: inferredProviderManifestPlugins,
          }) ?? inferredProvider;
      }
      if (inferredProvider) {
        const allowManifestNormalization = inferredProviderManifestPlugins
          ? params.allowManifestNormalization
          : false;
        return normalizeModelRef(inferredProvider, trimmed, {
          ...(inferredProviderManifestPlugins
            ? manifestPluginContext.getContext()
            : createModelManifestPluginContext({
                ...params,
                allowManifestNormalization,
              }).getContext()),
          allowManifestNormalization,
          allowPluginNormalization: allowSelectedPluginNormalization,
        });
      }

      const safeTrimmed = sanitizeModelWarningValue(trimmed);
      const safeResolved = sanitizeForLog(`${params.defaultProvider}/${safeTrimmed}`);
      getLog().warn(
        `Model "${safeTrimmed}" specified without provider. Falling back to "${safeResolved}". Please use "${safeResolved}" in your config.`,
      );
      return { provider: params.defaultProvider, model: trimmed };
    }

    const resolved = resolveModelRefFromString({
      manifestPluginContext,
      cfg: params.cfg,
      agentId: params.agentId,
      raw: trimmed,
      defaultProvider: params.defaultProvider,
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: allowSelectedPluginNormalization,
    });
    if (resolved) {
      return resolved.ref;
    }

    const safe = sanitizeForLog(trimmed);
    const safeFallback = sanitizeForLog(`${params.defaultProvider}/${params.defaultModel}`);
    getLog().warn(
      `Model "${safe}" could not be resolved. Falling back to default "${safeFallback}".`,
    );
  }
  const fallbackProvider = resolveConfiguredProviderFallback({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
  });
  if (fallbackProvider) {
    return fallbackProvider;
  }
  return { provider: params.defaultProvider, model: params.defaultModel };
}

type ModelPolicyPreparationParams = BuildModelAliasIndexParams & {
  catalog: ModelCatalogEntry[];
  defaultModel?: string;
  preparedDefaultModel?: ModelRef;
};

type AllowedModelSet = {
  allowAny: boolean;
  allowedCatalog: ModelCatalogEntry[];
  allowedKeys: Set<string>;
};

/** Build explicit model override authorization without widening it for automatic fallbacks. */
export function buildAllowedModelSet(
  params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    defaultProvider: string;
    defaultModel?: string;
    agentId?: string;
  } & ModelSelectionNormalizationContext,
): AllowedModelSet {
  // Model authorization reads metadata; it must not activate provider runtime.
  const policyParams = { ...params, allowPluginNormalization: false };
  return buildAllowedModelSetFromPrepared(policyParams, prepareModelPolicy(policyParams));
}

function prepareModelPolicy(params: ModelPolicyPreparationParams) {
  const manifestPluginContext =
    params.manifestPluginContext ?? createModelManifestPluginContext(params);
  const visibility = parseConfiguredModelVisibilityEntries(params);
  const policyAliasAgentId = resolvePolicyAliasAgentId(visibility.configPath, params.agentId);
  const policyAliasIndex = buildModelAliasIndexCore({
    ...params,
    agentId: policyAliasAgentId,
    manifestPluginContext,
  });
  // Inherited policy aliases keep their owner's scope; selection and display
  // aliases still honor the selected agent's overrides.
  const selectionAliasIndex =
    params.agentId && policyAliasAgentId !== params.agentId
      ? buildModelAliasIndexCore({ ...params, manifestPluginContext })
      : policyAliasIndex;
  const configuredCatalog = buildConfiguredModelCatalog({
    ...params,
    manifestPluginContext,
  });
  const metadata = buildModelCatalogMetadata({
    configuredCatalog,
    aliasIndex: selectionAliasIndex,
  });
  const catalog = mergeModelCatalogEntries({
    primary: params.catalog,
    secondary: configuredCatalog,
  }).map((entry) => applyModelCatalogMetadata({ entry, metadata }));
  return {
    manifestPluginContext,
    visibility,
    policyAliasIndex,
    selectionAliasIndex,
    configuredCatalog,
    metadata,
    catalog,
  };
}

function buildAllowedModelSetFromPrepared(
  params: ModelPolicyPreparationParams,
  {
    visibility,
    policyAliasIndex,
    metadata,
    catalog,
    manifestPluginContext,
  }: ReturnType<typeof prepareModelPolicy>,
): AllowedModelSet {
  const wildcardModelKeys = visibility.wildcardModelKeys;
  const allowAny = !visibility.hasEntries;
  const defaultModelNormalization = allowAny
    ? {
        allowManifestNormalization: false,
        allowPluginNormalization: false,
      }
    : {
        allowManifestNormalization: params.allowManifestNormalization,
        allowPluginNormalization: params.allowPluginNormalization,
      };
  const defaultModel = params.defaultModel?.trim();
  const defaultRef =
    params.preparedDefaultModel ??
    (defaultModel && params.defaultProvider
      ? parseModelRefWithCompatAlias({
          ...(!allowAny ? manifestPluginContext.getContext() : undefined),
          cfg: params.cfg,
          agentId: params.agentId,
          raw: defaultModel,
          defaultProvider: params.defaultProvider,
          ...defaultModelNormalization,
        })
      : null);
  const defaultKey = defaultRef
    ? buildModelCatalogRef(defaultRef.provider, defaultRef.model)
    : undefined;
  const resolvePolicyModelRef = (raw: string) => {
    const trimmed = raw.trim();
    const defaultProvider = !trimmed.includes("/")
      ? resolveBareModelDefaultProvider({
          ...params,
          manifestPluginContext,
          catalog,
          model: trimmed,
        })
      : params.defaultProvider;
    return resolveModelRefFromString({
      ...params,
      manifestPluginContext,
      raw,
      defaultProvider,
      aliasIndex: policyAliasIndex,
    })?.ref;
  };
  const catalogKeys = new Set<string>();
  for (const entry of catalog) {
    catalogKeys.add(buildModelCatalogRef(entry.provider, entry.id));
  }

  if (allowAny) {
    if (defaultKey) {
      catalogKeys.add(defaultKey);
    }
    return {
      allowAny: true,
      allowedCatalog: catalog,
      allowedKeys: catalogKeys,
    };
  }

  const allowedKeys = new Set<string>();
  const allowedRefs: ModelRef[] = [];
  const syntheticCatalogEntries = new Map<string, ModelCatalogEntry>();
  for (const wildcardKey of wildcardModelKeys) {
    allowedKeys.add(wildcardKey);
  }
  const addAllowedCatalogRef = (ref: ModelRef) => {
    if (
      !allowedRefs.some(
        (existing) =>
          buildModelCatalogRef(existing.provider, existing.model) ===
          buildModelCatalogRef(ref.provider, ref.model),
      )
    ) {
      allowedRefs.push(ref);
    }
  };
  for (const entry of expandModelCatalogWildcards(catalog, wildcardModelKeys)) {
    allowedKeys.add(buildModelCatalogRef(entry.provider, entry.id));
    addAllowedCatalogRef({ provider: entry.provider, model: entry.id });
  }
  const addAllowedModelRef = (raw: string) => {
    const parsed = resolvePolicyModelRef(raw);
    if (!parsed) {
      return;
    }
    const key = buildModelCatalogRef(parsed.provider, parsed.model);
    allowedKeys.add(key);
    addAllowedCatalogRef(parsed);

    if (
      !findModelCatalogEntry(catalog, { provider: parsed.provider, modelId: parsed.model }) &&
      !syntheticCatalogEntries.has(key)
    ) {
      // Config can allow a model before it appears in live provider catalogs.
      // Synthetic entries keep UI/model switchers aligned with that allowlist.
      syntheticCatalogEntries.set(key, buildSyntheticAllowedCatalogEntry({ parsed, metadata }));
    }
  };

  for (const raw of visibility.exactModelRefs) {
    addAllowedModelRef(raw);
  }

  if (
    defaultKey &&
    ((visibility.exactModelRefs.length > 0 && wildcardModelKeys.size === 0) ||
      isModelKeyAllowedBySet(wildcardModelKeys, defaultKey))
  ) {
    allowedKeys.add(defaultKey);
    if (defaultRef) {
      addAllowedCatalogRef(defaultRef);
    }
  }

  const allowedCatalog = [
    ...catalog.filter((entry) =>
      allowedRefs.some(
        (ref) =>
          findModelCatalogEntry([entry], { provider: ref.provider, modelId: ref.model }) === entry,
      ),
    ),
    ...syntheticCatalogEntries.values(),
  ];

  if (allowedCatalog.length === 0 && allowedKeys.size === 0 && wildcardModelKeys.size === 0) {
    if (defaultKey) {
      catalogKeys.add(defaultKey);
    }
    return {
      allowAny: true,
      allowedCatalog: catalog,
      allowedKeys: catalogKeys,
    };
  }

  return {
    allowAny: false,
    allowedCatalog,
    allowedKeys,
  };
}

/** Status of a candidate model against catalog and configured allowlist state. */
export type ModelRefStatus = {
  key: string;
  inCatalog: boolean;
  allowAny: boolean;
  allowed: boolean;
};

type ResolveAllowedModelRefResult =
  | { ref: ModelRef; key: string }
  | {
      error: string;
    };

export function getModelRefStatus(
  params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    ref: ModelRef;
    defaultProvider: string;
    defaultModel?: string;
    agentId?: string;
  } & ModelSelectionNormalizationContext,
): ModelRefStatus {
  const allowed = buildAllowedModelSet(params);
  const key = buildModelCatalogRef(params.ref.provider, params.ref.model);
  return {
    key,
    inCatalog: Boolean(
      findModelCatalogEntry(params.catalog, {
        provider: params.ref.provider,
        modelId: params.ref.model,
      }),
    ),
    allowAny: allowed.allowAny,
    allowed: allowed.allowAny || isModelKeyAllowedBySet(allowed.allowedKeys, key),
  };
}

/** Resolve a requested model string only if it is allowed by the supplied status check. */
export function resolveAllowedModelRefFromAliasIndex(
  params: {
    cfg: OpenClawConfig;
    raw: string;
    defaultProvider: string;
    agentId?: string;
    aliasIndex: ModelAliasIndex;
    getStatus: (ref: ModelRef) => ModelRefStatus;
  } & ModelSelectionNormalizationContext,
): ResolveAllowedModelRefResult {
  const trimmed = params.raw.trim();
  if (!trimmed) {
    return { error: "invalid model: empty" };
  }

  const effectiveDefaultProvider = !trimmed.includes("/")
    ? (inferUniqueProviderFromConfiguredModels({
        ...params,
        model: trimmed,
      }) ?? params.defaultProvider)
    : params.defaultProvider;

  const resolved = resolveModelRefFromString({
    ...params,
    raw: trimmed,
    defaultProvider: effectiveDefaultProvider,
  });
  if (!resolved) {
    return { error: `invalid model: ${trimmed}` };
  }

  const status = params.getStatus(resolved.ref);
  if (!status.allowed) {
    return { error: `model not allowed: ${status.key}` };
  }

  return { ref: resolved.ref, key: status.key };
}

/** True when config contains provider model rows that should seed catalogs. */
function hasConfiguredProviderModelRows(cfg: OpenClawConfig): boolean {
  const providers = cfg.models?.providers;
  if (!providers || typeof providers !== "object") {
    return false;
  }
  return Object.values(providers).some((provider) => Array.isArray(provider?.models));
}

function hasConfiguredProviderRowsNeedingManifestLookup(cfg: OpenClawConfig): boolean {
  const providers = cfg.models?.providers;
  if (!providers || typeof providers !== "object") {
    return false;
  }
  return Object.entries(providers).some(
    ([providerRaw, provider]) =>
      Array.isArray(provider?.models) && normalizeProviderId(providerRaw) !== "openai",
  );
}

function hasConfiguredModelRefsNeedingManifestLookup(
  cfg: OpenClawConfig,
  defaultProvider: string,
  agentId?: string,
): boolean {
  const normalizedDefaultProvider = normalizeProviderId(defaultProvider);
  return listConfiguredModelMaps(cfg, agentId).some(({ models }) =>
    Object.keys(models ?? {}).some((keyRaw) => {
      const key = keyRaw.trim();
      if (!key || key.endsWith("/*")) {
        return false;
      }
      const slashIndex = key.indexOf("/");
      if (slashIndex <= 0) {
        return false;
      }
      const provider = normalizeProviderId(key.slice(0, slashIndex));
      return Boolean(provider && provider !== normalizedDefaultProvider);
    }),
  );
}

function hasConfiguredRowsNeedingManifestLookup(
  cfg: OpenClawConfig,
  defaultProvider: string,
  agentId?: string,
): boolean {
  return (
    hasConfiguredProviderRowsNeedingManifestLookup(cfg) ||
    hasConfiguredModelRefsNeedingManifestLookup(cfg, defaultProvider, agentId)
  );
}

/** Build catalog entries from configured provider model rows. */
export function buildConfiguredModelCatalog(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
  } & ModelSelectionNormalizationContext,
): ModelCatalogEntry[] {
  const providers = params.cfg.models?.providers;
  if (!providers || !hasConfiguredProviderModelRows(params.cfg)) {
    return [];
  }

  // A cold unscoped catalog may consume current global policy, but must not
  // invent a workspace discovery context. Prepared operations carry their own.
  const normalization =
    params.manifestPluginContext?.getContext() ??
    (params.manifestPlugins ||
    params.pluginMetadataSnapshot ||
    params.workspaceDir ||
    getActivePluginRegistryWorkspaceDirFromState() ||
    getCurrentPluginMetadataOwner() ||
    getScopedPluginMetadata() ||
    getPluginRuntimeGenerationRegistry()
      ? createModelManifestPluginContext(params).getContext()
      : {
          manifestPlugins:
            getCurrentPluginMetadataSnapshot({ config: params.cfg, env: process.env })?.plugins ??
            [],
        });
  const normalizeModelId = createConfiguredProviderCatalogModelIdNormalizer(normalization);
  const catalog: ModelCatalogEntry[] = [];
  for (const [providerRaw, provider] of Object.entries(providers)) {
    const providerId = normalizeProviderId(providerRaw);
    if (!providerId || !Array.isArray(provider?.models)) {
      continue;
    }
    for (const model of provider.models) {
      const rawId = normalizeOptionalString(model?.id) ?? "";
      const id = rawId ? normalizeModelId(providerId, rawId) : "";
      if (!id) {
        continue;
      }
      const name = normalizeOptionalString(model?.name) || id;
      const contextWindow =
        typeof model?.contextWindow === "number" && model.contextWindow > 0
          ? model.contextWindow
          : undefined;
      const contextTokens =
        typeof model?.contextTokens === "number" && model.contextTokens > 0
          ? model.contextTokens
          : undefined;
      const input = Array.isArray(model?.input) ? model.input : undefined;
      const modelParams =
        model?.params && typeof model.params === "object" ? model.params : undefined;
      const compat = model?.compat && typeof model.compat === "object" ? model.compat : undefined;
      const reasoning =
        typeof model?.reasoning === "boolean"
          ? model.reasoning
          : isVllmQwenThinkingCompat(providerId, compat)
            ? true
            : undefined;
      catalog.push({
        provider: providerId,
        id,
        name,
        api: model.api ?? provider.api,
        ...((model.baseUrl ?? provider.baseUrl)
          ? { baseUrl: model.baseUrl ?? provider.baseUrl }
          : {}),
        contextWindow,
        contextTokens,
        reasoning,
        ...(typeof model?.reasoning === "boolean" ? { configuredReasoning: model.reasoning } : {}),
        ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
        input,
        ...(modelParams ? { params: modelParams } : {}),
        compat,
      });
    }
  }

  return catalog;
}

function isVllmQwenThinkingCompat(
  providerId: string,
  compat?: { thinkingFormat?: unknown } | null,
): boolean {
  return (
    providerId === "vllm" &&
    (compat?.thinkingFormat === "qwen" || compat?.thinkingFormat === "qwen-chat-template")
  );
}

export function resolveHooksGmailModel(
  params: {
    cfg: OpenClawConfig;
    defaultProvider: string;
  } & ModelSelectionNormalizationContext,
): ModelRef | null {
  const hooksModel = params.cfg.hooks?.gmail?.model;
  if (!hooksModel?.trim()) {
    return null;
  }

  const manifestPluginContext =
    params.manifestPluginContext ?? createModelManifestPluginContext(params);
  const aliasIndex = buildModelAliasIndexCore({ ...params, manifestPluginContext });

  const resolved = resolveModelRefFromString({
    ...params,
    manifestPluginContext,
    raw: hooksModel,
    aliasIndex,
  });

  return resolved?.ref ?? null;
}

const DEFAULT_MODEL_POLICY_ALLOW_CONFIG_PATH = "agents.defaults.modelPolicy.allow";
const AGENT_MODEL_POLICY_ALLOW_CONFIG_PATH = "agents.entries.*.modelPolicy.allow";
export const LEGACY_MODEL_POLICY_ALLOW_CONFIG_PATH = "agents.defaults.models";

function resolvePolicyAliasAgentId(
  configPath: string | null,
  agentId: string | undefined,
): string | undefined {
  return configPath === AGENT_MODEL_POLICY_ALLOW_CONFIG_PATH ? agentId : undefined;
}

export function resolveConfiguredModelPolicyAllow(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): { refs: readonly string[]; configPath: string | null; repairConfigPath: string } {
  const defaults = params.cfg?.agents?.defaults;
  if (params.agentId) {
    const agent = params.cfg ? resolveAgentConfig(params.cfg, params.agentId) : undefined;
    const agentPolicy = agent?.modelPolicy;
    if (hasExplicitModelPolicyAllow(agentPolicy)) {
      return {
        refs: agentPolicy?.allow ?? [],
        configPath: AGENT_MODEL_POLICY_ALLOW_CONFIG_PATH,
        repairConfigPath: AGENT_MODEL_POLICY_ALLOW_CONFIG_PATH,
      };
    }
  }
  const defaultPolicy = defaults?.modelPolicy;
  if (hasExplicitModelPolicyAllow(defaultPolicy)) {
    return {
      refs: defaultPolicy?.allow ?? [],
      configPath: DEFAULT_MODEL_POLICY_ALLOW_CONFIG_PATH,
      repairConfigPath: DEFAULT_MODEL_POLICY_ALLOW_CONFIG_PATH,
    };
  }
  const legacyDefaultRefs = computeModelPolicyAllowlist({
    root: params.cfg,
    defaults,
  });
  if (legacyDefaultRefs) {
    return {
      refs: legacyDefaultRefs,
      configPath: LEGACY_MODEL_POLICY_ALLOW_CONFIG_PATH,
      repairConfigPath: DEFAULT_MODEL_POLICY_ALLOW_CONFIG_PATH,
    };
  }
  return { refs: [], configPath: null, repairConfigPath: DEFAULT_MODEL_POLICY_ALLOW_CONFIG_PATH };
}

export function parseConfiguredModelVisibilityEntries(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): {
  exactModelRefs: string[];
  providerWildcards: Set<string>;
  wildcardModelKeys: Set<string>;
  hasEntries: boolean;
  configPath: string | null;
  repairConfigPath: string;
} {
  const configured = resolveConfiguredModelPolicyAllow(params);
  const exactModelRefs: string[] = [];
  const providerWildcards = new Set<string>();
  const wildcardModelKeys = new Set<string>();

  for (const raw of configured.refs) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    const wildcard = parseModelPolicyWildcardRef(trimmed);
    if (wildcard) {
      providerWildcards.add(wildcard.provider);
      wildcardModelKeys.add(wildcard.key);
      continue;
    }
    exactModelRefs.push(raw);
  }

  return {
    exactModelRefs,
    providerWildcards,
    wildcardModelKeys,
    hasEntries: configured.refs.length > 0,
    configPath: configured.configPath,
    repairConfigPath: configured.repairConfigPath,
  };
}

/** Expand segment-boundary prefix wildcard policy entries against discovered catalog rows. */
function expandModelCatalogWildcards<T extends { provider: string; id: string }>(
  catalog: readonly T[],
  wildcardModelKeys: ReadonlySet<string>,
): T[] {
  return catalog.filter((entry) =>
    isModelKeyAllowedBySet(wildcardModelKeys, buildModelCatalogRef(entry.provider, entry.id)),
  );
}

export function isModelKeyAllowedBySet(allowedKeys: ReadonlySet<string>, key: string): boolean {
  if (allowedKeys.has(key)) {
    return true;
  }
  let separator = key.indexOf("/");
  while (separator > 0) {
    if (allowedKeys.has(`${key.slice(0, separator + 1)}*`)) {
      return true;
    }
    separator = key.indexOf("/", separator + 1);
  }
  return false;
}

export type ModelVisibilityPolicy = {
  allowAny: boolean;
  allowedCatalog: ModelCatalogEntry[];
  allowedKeys: Set<string>;
  policyAliasIndex: ModelAliasIndex;
  selectionAliasIndex: ModelAliasIndex;
  configuredKeys: ReadonlySet<string>;
  retainedKeys: ReadonlySet<string>;
  exactModelRefs: readonly string[];
  providerWildcards: ReadonlySet<string>;
  hasConfiguredEntries: boolean;
  hasProviderWildcards: boolean;
  allowConfigPath?: string | null;
  allowRepairConfigPath: string;
  allowsKey: (key: string) => boolean;
  allows: (ref: { provider: string; model: string }) => boolean;
  allowsByWildcard: (ref: { provider: string; model: string }) => boolean;
  resolveSelection: (ref: { provider: string; model: string }) => ModelRef | null;
  visibleCatalog: (params: {
    catalog: readonly ModelCatalogEntry[];
    defaultVisibleCatalog: readonly ModelCatalogEntry[];
    view?: "default" | "configured" | "all";
  }) => ModelCatalogEntry[];
};

/** Canonical logical identity shared by visibility and physical route rows. */
export function modelCatalogLogicalKey(entry: Pick<ModelCatalogEntry, "provider" | "id">): string {
  const provider = normalizeProviderId(entry.provider);
  const model = splitTrailingAuthProfile(entry.id).model;
  return normalizeLowercaseStringOrEmpty(buildModelCatalogRef(provider, model));
}

export function dedupeModelCatalogEntries(
  entries: readonly ModelCatalogEntry[],
): ModelCatalogEntry[] {
  // Preserve the first occurrence after precedence merging while removing
  // provider/id duplicates from configured and auth-backed catalogs.
  const seen = new Set<string>();
  const next: ModelCatalogEntry[] = [];
  for (const entry of entries) {
    const key = buildModelCatalogRef(entry.provider, entry.id);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(entry);
  }
  return next;
}

export function createModelVisibilityPolicyWithFallbacks(
  params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    defaultProvider: string;
    defaultModel?: string;
    /** A prepared default keeps literal IDs and completed normalization intact. */
    preparedDefaultModel?: ModelRef;
    fallbackModels: readonly string[];
    additionalConfiguredModelRefs?: readonly string[];
    agentId?: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelSelectionNormalizationContext,
): ModelVisibilityPolicy {
  const prepared = prepareModelPolicy(params);
  const {
    visibility,
    policyAliasIndex,
    selectionAliasIndex,
    configuredCatalog,
    manifestPluginContext,
  } = prepared;
  const wildcardModelKeys = visibility.wildcardModelKeys;
  const allowed = buildAllowedModelSetFromPrepared(params, prepared);
  const configuredKeys = new Set(configuredCatalog.map(modelCatalogLogicalKey));
  const retainedKeys = new Set<string>();
  const addConfiguredRef = (
    raw: string | ModelRef | undefined,
    retained: boolean,
    aliasIndex: ModelAliasIndex,
  ): ModelRef | undefined => {
    if (typeof raw === "string" && (!raw.trim() || parseModelPolicyWildcardRef(raw))) {
      return undefined;
    }
    const ref =
      typeof raw === "string"
        ? resolveModelRefFromString({ ...params, manifestPluginContext, raw, aliasIndex })?.ref
        : raw;
    if (!ref) {
      return undefined;
    }
    const key = modelCatalogLogicalKey({ provider: ref.provider, id: ref.model });
    configuredKeys.add(key);
    if (retained) {
      retainedKeys.add(key);
    }
    return ref;
  };
  const exactConfiguredKeys = new Set<string>();
  for (const raw of visibility.exactModelRefs) {
    const resolved = addConfiguredRef(raw, false, policyAliasIndex);
    if (resolved) {
      exactConfiguredKeys.add(buildModelCatalogRef(resolved.provider, resolved.model));
    }
  }
  for (const raw of params.additionalConfiguredModelRefs ?? []) {
    addConfiguredRef(raw, false, selectionAliasIndex);
  }
  addConfiguredRef(params.preparedDefaultModel ?? params.defaultModel, true, selectionAliasIndex);
  for (const fallback of params.fallbackModels) {
    // Configured fallbacks remain available for automatic failover and catalog
    // retention, but are not user-selectable overrides unless policy also allows them.
    addConfiguredRef(fallback, true, selectionAliasIndex);
  }
  const allowsKey = (key: string): boolean =>
    allowed.allowAny || isModelKeyAllowedBySet(allowed.allowedKeys, key);
  const policy: ModelVisibilityPolicy = {
    allowAny: allowed.allowAny,
    allowedCatalog: allowed.allowedCatalog,
    allowedKeys: allowed.allowedKeys,
    policyAliasIndex,
    selectionAliasIndex,
    configuredKeys,
    retainedKeys,
    exactModelRefs: visibility.exactModelRefs,
    providerWildcards: visibility.providerWildcards,
    hasConfiguredEntries: visibility.hasEntries,
    hasProviderWildcards: wildcardModelKeys.size > 0,
    allowConfigPath: visibility.configPath,
    allowRepairConfigPath: visibility.repairConfigPath,
    allowsKey,
    allows: (ref) => allowsKey(buildModelCatalogRef(ref.provider, ref.model)),
    allowsByWildcard: (ref) =>
      isModelKeyAllowedBySet(wildcardModelKeys, buildModelCatalogRef(ref.provider, ref.model)),
    resolveSelection: (ref) => {
      // Selected refs and catalog rows already own their model identities. Replaying
      // provider normalization here can change the model after authorization.
      if (allowsKey(buildModelCatalogRef(ref.provider, ref.model))) {
        return ref;
      }
      const fallback = allowed.allowedCatalog[0];
      return fallback ? { provider: fallback.provider, model: fallback.id } : null;
    },
    visibleCatalog: ({ catalog, defaultVisibleCatalog, view }) => {
      if (view === "all") {
        return [...catalog];
      }
      if (allowed.allowAny) {
        return [...defaultVisibleCatalog];
      }
      if (wildcardModelKeys.size === 0) {
        return [...allowed.allowedCatalog];
      }
      return dedupeModelCatalogEntries([
        ...defaultVisibleCatalog.filter((entry) =>
          isModelKeyAllowedBySet(wildcardModelKeys, buildModelCatalogRef(entry.provider, entry.id)),
        ),
        ...allowed.allowedCatalog.filter((entry) =>
          exactConfiguredKeys.has(buildModelCatalogRef(entry.provider, entry.id)),
        ),
      ]);
    },
  };
  return policy;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
