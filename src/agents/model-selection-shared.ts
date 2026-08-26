/**
 * Shared model-selection resolution, alias, allowlist, and visibility logic.
 */
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
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { loadManifestMetadataSnapshot } from "../plugins/manifest-contract-eligibility.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "../plugins/runtime-state.js";
import { resolveAgentConfig } from "./agent-scope-config.js";
import { resolveConfiguredProviderFallback } from "./configured-provider-fallback.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import { findModelCatalogEntry } from "./model-catalog-lookup.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { resolveCatalogOwnedModelCompat } from "./model-compat-catalog.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import {
  normalizeConfiguredProviderCatalogModelId,
  normalizeStaticProviderModelId,
  type ModelManifestNormalizationContext,
  type ModelRef,
  modelKey,
  normalizeModelRef,
  normalizeProviderId,
} from "./model-ref-shared.js";
import { findNormalizedProviderValue, parseModelRef } from "./model-selection-normalize.js";

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

type ModelManifestPluginContext = {
  peek: () => ModelManifestPlugins;
  get: () => ModelManifestPlugins;
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

function resolveManifestPluginsForModelIdNormalization(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  manifestPlugins?: ModelManifestPlugins;
  allowManifestNormalization?: boolean;
}): ModelManifestPlugins {
  if (params.allowManifestNormalization === false || params.manifestPlugins !== undefined) {
    return params.manifestPlugins;
  }
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  if (!workspaceDir) {
    const currentManifestPlugins = getCurrentPluginMetadataSnapshot({
      config: params.cfg,
      env: process.env,
    })?.plugins;
    if (currentManifestPlugins) {
      return currentManifestPlugins;
    }
  }
  return loadManifestMetadataSnapshot({
    config: params.cfg,
    env: process.env,
    ...(workspaceDir ? { workspaceDir } : {}),
  }).plugins;
}

function createModelManifestPluginContext(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  manifestPlugins?: ModelManifestPlugins;
  allowManifestNormalization?: boolean;
}): ModelManifestPluginContext {
  let manifestPlugins = params.manifestPlugins;
  let resolved =
    params.allowManifestNormalization === false || params.manifestPlugins !== undefined;
  return {
    peek: () => manifestPlugins,
    get: () => {
      // Manifest metadata can touch plugin registries. Defer that work until a
      // path actually needs plugin/provider normalization.
      if (!resolved) {
        manifestPlugins = resolveManifestPluginsForModelIdNormalization(params);
        resolved = true;
      }
      return manifestPlugins;
    },
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
): { aliases: EffectiveModelAlias[]; disabledKeys: Set<string> } {
  const aliasesByKey = new Map<string, EffectiveModelAlias | null>();
  const candidates = listModelAliasCandidates(params.cfg, params.agentId);
  if (candidates.length === 0) {
    return { aliases: [], disabledKeys: new Set() };
  }
  // One alias index must use one manifest generation. Skip discovery only when
  // every candidate is a default-provider identity transform.
  const useStaticDefaultProviderAliases =
    params.allowManifestNormalization !== false &&
    candidates.every((candidate) => isStaticDefaultProviderAliasCandidate(candidate, params.cfg)) &&
    params.manifestPluginContext.peek() === undefined &&
    !getActivePluginRegistryWorkspaceDirFromState() &&
    !getCurrentPluginMetadataSnapshot({ config: params.cfg, env: process.env });
  const manifestPlugins = useStaticDefaultProviderAliases
    ? undefined
    : params.manifestPluginContext.get();
  for (const candidate of candidates) {
    const ref = parseModelRefWithCompatAlias({
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
      manifestPlugins,
    });
    if (!ref) {
      continue;
    }
    const key = modelKey(ref.provider, ref.model);
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
  const seen = new Set(merged.map((entry) => modelKey(entry.provider, entry.id)));
  for (const entry of params.secondary) {
    const key = modelKey(entry.provider, entry.id);
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
  } & ModelManifestNormalizationContext,
): string | undefined {
  const model = params.model.trim();
  if (!model) {
    return undefined;
  }
  const normalized = normalizeLowercaseStringOrEmpty(model);
  const collectModelMapProviders = (models: Record<string, unknown> | undefined) => {
    const providers = new Set<string>();
    for (const key of Object.keys(models ?? {})) {
      const ref = key.trim();
      if (!ref || !ref.includes("/") || ref.endsWith("/*")) {
        continue;
      }
      const parsed = parseModelRef(ref, DEFAULT_PROVIDER, {
        allowManifestNormalization: params.allowManifestNormalization,
        allowPluginNormalization: false,
        manifestPlugins: params.manifestPlugins,
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
        const normalizedModelId = normalizeConfiguredProviderCatalogModelId(providerId, modelId, {
          allowManifestNormalization: params.allowManifestNormalization,
          manifestPlugins: params.manifestPlugins,
        });
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
  } & ModelManifestNormalizationContext,
): string {
  return (
    inferUniqueProviderFromConfiguredModels({
      cfg: params.cfg,
      model: params.model,
      agentId: params.agentId,
      manifestPlugins: params.manifestPlugins,
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
        allowManifestNormalization: params.allowManifestNormalization,
        allowPluginNormalization: params.allowPluginNormalization,
        manifestPlugins: params.manifestPlugins,
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
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: params.manifestPlugins,
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
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: params.manifestPlugins,
    });
  }
  if (normalized !== OPENROUTER_COMPAT_FREE_ALIAS || !params.cfg) {
    return null;
  }
  return resolveConfiguredOpenRouterCompatFreeRef({
    cfg: params.cfg,
    agentId: params.agentId,
    defaultProvider: params.defaultProvider,
    allowManifestNormalization: params.allowManifestNormalization,
    allowPluginNormalization: params.allowPluginNormalization,
    manifestPlugins: params.manifestPlugins,
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
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: params.manifestPlugins,
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
  if (!apiOwner || apiOwner === normalizedConfiguredProvider) {
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
    model: normalizeConfiguredProviderCatalogModelId(
      provider,
      normalizeStaticProviderModelId(provider, modelRaw.trim(), {
        allowManifestNormalization: params.allowManifestNormalization,
        manifestPlugins: params.manifestPlugins,
      }),
      {
        allowManifestNormalization: params.allowManifestNormalization,
        manifestPlugins: params.manifestPlugins,
      },
    ),
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

type BuildModelAliasIndexParams = {
  cfg: OpenClawConfig;
  defaultProvider: string;
  agentId?: string;
  allowManifestNormalization?: boolean;
  allowPluginNormalization?: boolean;
} & ModelManifestNormalizationContext;

function buildModelAliasIndexWithManifestContext(
  params: Omit<BuildModelAliasIndexParams, "manifestPlugins"> & {
    manifestPluginContext: ModelManifestPluginContext;
  },
): ModelAliasIndex {
  const byAlias = new Map<string, { alias: string; ref: ModelRef }>();
  const byProviderAlias = new Map<string, { alias: string; ref: ModelRef }>();
  const byKey = new Map<string, string[]>();
  const { aliases, disabledKeys } = buildEffectiveModelAliases(params);
  if (aliases.length === 0) {
    return { byAlias, byProviderAlias, byKey, disabledKeys };
  }

  for (const { alias, ref } of aliases) {
    const aliasKey = normalizeLowercaseStringOrEmpty(alias);
    const match = { alias, ref };
    const key = modelKey(ref.provider, ref.model);
    byAlias.set(aliasKey, match);
    // Bare aliases retain their existing last-wins behavior. Provider-qualified
    // aliases stay scoped so duplicate display names cannot select another provider.
    byProviderAlias.set(providerAliasKey(ref.provider, alias), match);
    byKey.set(key, [alias]);
  }

  return { byAlias, byProviderAlias, byKey, disabledKeys };
}

/** Build lookup maps from user-facing aliases to normalized model refs. */
export function buildModelAliasIndex(params: BuildModelAliasIndexParams): ModelAliasIndex {
  return buildModelAliasIndexWithManifestContext({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
    agentId: params.agentId,
    allowManifestNormalization: params.allowManifestNormalization,
    allowPluginNormalization: params.allowPluginNormalization,
    manifestPluginContext: createModelManifestPluginContext(params),
  });
}

type ModelCatalogMetadata = {
  configuredByKey: Map<string, ModelCatalogEntry>;
  aliasByKey: Map<string, string>;
};

function buildModelCatalogMetadata(
  params: {
    cfg: OpenClawConfig;
    configuredCatalog: readonly ModelCatalogEntry[];
    defaultProvider: string;
    agentId?: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelCatalogMetadata {
  const configuredByKey = new Map<string, ModelCatalogEntry>();
  for (const entry of params.configuredCatalog) {
    configuredByKey.set(modelKey(entry.provider, entry.id), entry);
  }

  const aliasByKey = new Map(
    [...buildModelAliasIndex(params).byKey].flatMap(([key, aliases]) => {
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
  const key = modelKey(params.entry.provider, params.entry.id);
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
  const key = modelKey(params.parsed.provider, params.parsed.model);
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

export function resolveModelRefFromString(
  params: {
    cfg?: OpenClawConfig;
    agentId?: string;
    raw: string;
    defaultProvider: string;
    aliasIndex?: ModelAliasIndex;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): { ref: ModelRef; alias?: string } | null {
  const { model } = splitTrailingAuthProfile(params.raw);
  if (!model) {
    return null;
  }
  const aliasKey = normalizeLowercaseStringOrEmpty(model);
  const aliasMatch = params.aliasIndex?.byAlias.get(aliasKey);
  if (aliasMatch) {
    return { ref: aliasMatch.ref, alias: aliasMatch.alias };
  }
  const slash = model.indexOf("/");
  if (slash > 0) {
    const providerAliasMatch = params.aliasIndex?.byProviderAlias?.get(
      providerAliasKey(model.slice(0, slash), model.slice(slash + 1)),
    );
    if (providerAliasMatch) {
      return { ref: providerAliasMatch.ref, alias: providerAliasMatch.alias };
    }
  }
  const parsed = parseModelRefWithCompatAlias({
    cfg: params.cfg,
    agentId: params.agentId,
    raw: model,
    defaultProvider: params.defaultProvider,
    allowManifestNormalization: params.allowManifestNormalization,
    allowPluginNormalization: params.allowPluginNormalization,
    manifestPlugins: params.manifestPlugins,
  });
  if (!parsed) {
    return null;
  }
  return { ref: parsed };
}

/** Resolves legacy provider/model pairs whose model field may still contain an alias. */
export function resolveModelAliasFromPair(
  params: {
    cfg?: OpenClawConfig;
    agentId?: string;
    provider: string;
    model: string;
    defaultProvider: string;
    aliasIndex?: ModelAliasIndex;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelRef | null {
  const bareAlias = resolveModelRefFromString({
    ...params,
    raw: params.model,
    defaultProvider: params.provider,
  });
  const providerAlias = resolveModelRefFromString({
    ...params,
    raw: `${params.provider}/${params.model}`,
  });
  if (providerAlias?.alias) {
    return providerAlias.ref;
  }
  const provider = normalizeProviderId(params.provider);
  return bareAlias?.alias &&
    (normalizeProviderId(bareAlias.ref.provider) === provider ||
      provider === normalizeProviderId(params.defaultProvider))
    ? bareAlias.ref
    : null;
}

/** Resolve the default configured model ref, including aliases and fallback provider rows. */
export function resolveConfiguredModelRef(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    defaultProvider: string;
    defaultModel: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelRef {
  const rawModel =
    (params.agentId
      ? resolveAgentModelPrimaryValue(resolveAgentConfig(params.cfg, params.agentId)?.model)
      : undefined) ??
    resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model) ??
    "";
  if (rawModel) {
    const trimmed = rawModel.trim();
    const { model: modelWithoutProfile } = splitTrailingAuthProfile(trimmed);
    const manifestPluginContext = createModelManifestPluginContext(params);
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
        allowManifestNormalization: params.allowManifestNormalization,
        manifestPlugins: manifestPluginContext.get(),
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
        cfg: params.cfg,
        agentId: params.agentId,
        raw: primaryWithoutProfile,
        defaultProvider: params.defaultProvider,
        allowManifestNormalization: params.allowManifestNormalization,
        allowPluginNormalization: params.allowPluginNormalization,
        manifestPlugins: manifestPluginContext.get(),
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
        cfg: params.cfg,
        agentId: params.agentId,
        raw: trimmed,
        defaultProvider: params.defaultProvider,
        allowManifestNormalization: params.allowManifestNormalization,
        allowPluginNormalization: params.allowPluginNormalization,
        manifestPlugins: needsOpenRouterCompatManifestPlugins
          ? manifestPluginContext.get()
          : manifestPlugins,
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
        inferredProviderManifestPlugins = manifestPluginContext.get();
        inferredProvider =
          inferUniqueProviderFromConfiguredModels({
            cfg: params.cfg,
            model: trimmed,
            agentId: params.agentId,
            allowManifestNormalization: params.allowManifestNormalization,
            manifestPlugins: inferredProviderManifestPlugins,
          }) ?? inferredProvider;
      }
      if (inferredProvider) {
        return normalizeModelRef(inferredProvider, trimmed, {
          allowManifestNormalization: inferredProviderManifestPlugins
            ? params.allowManifestNormalization
            : false,
          allowPluginNormalization: params.allowPluginNormalization,
          manifestPlugins: inferredProviderManifestPlugins,
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
      cfg: params.cfg,
      agentId: params.agentId,
      raw: trimmed,
      defaultProvider: params.defaultProvider,
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: manifestPluginContext.get(),
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

/** Build explicit override authorization plus configured automatic fallback keys. */
export function buildAllowedModelSetWithFallbacks(
  params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    defaultProvider: string;
    defaultModel?: string;
    fallbackModels: readonly string[];
    agentId?: string;
    aliasIndex?: ModelAliasIndex;
    selectionAliasIndex?: ModelAliasIndex;
    visibility?: ReturnType<typeof parseConfiguredModelVisibilityEntries>;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): {
  allowAny: boolean;
  allowedCatalog: ModelCatalogEntry[];
  allowedKeys: Set<string>;
  automaticFallbackKeys: Set<string>;
  configuredCatalog: ModelCatalogEntry[];
} {
  const configuredCatalog = buildConfiguredModelCatalog({
    cfg: params.cfg,
    manifestPlugins: params.manifestPlugins,
  });
  const metadata = buildModelCatalogMetadata({
    cfg: params.cfg,
    configuredCatalog,
    defaultProvider: params.defaultProvider,
    agentId: params.agentId,
    allowManifestNormalization: params.allowManifestNormalization,
    allowPluginNormalization: params.allowPluginNormalization,
    manifestPlugins: params.manifestPlugins,
  });
  const catalog = mergeModelCatalogEntries({
    primary: params.catalog,
    secondary: configuredCatalog,
  }).map((entry) => applyModelCatalogMetadata({ entry, metadata }));
  const visibility =
    params.visibility ??
    parseConfiguredModelVisibilityEntries({ cfg: params.cfg, agentId: params.agentId });
  const wildcardModelKeys = visibility.wildcardModelKeys;
  const policyAliasAgentId = resolvePolicyAliasAgentId(visibility.configPath, params.agentId);
  const policyAliasIndex =
    params.aliasIndex ??
    buildModelAliasIndex({
      cfg: params.cfg,
      defaultProvider: params.defaultProvider,
      agentId: policyAliasAgentId,
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: params.manifestPlugins,
    });
  const selectionAliasIndex =
    params.selectionAliasIndex ??
    (params.agentId && policyAliasAgentId !== params.agentId
      ? buildModelAliasIndex({
          cfg: params.cfg,
          defaultProvider: params.defaultProvider,
          agentId: params.agentId,
          allowManifestNormalization: params.allowManifestNormalization,
          allowPluginNormalization: params.allowPluginNormalization,
          manifestPlugins: params.manifestPlugins,
        })
      : policyAliasIndex);
  const allowAny = !visibility.hasEntries;
  const defaultModelNormalization = allowAny
    ? {
        allowManifestNormalization: false,
        allowPluginNormalization: false,
        manifestPlugins: params.manifestPlugins,
      }
    : {
        allowManifestNormalization: params.allowManifestNormalization,
        allowPluginNormalization: params.allowPluginNormalization,
        manifestPlugins: params.manifestPlugins,
      };
  const defaultModel = params.defaultModel?.trim();
  const defaultRef =
    defaultModel && params.defaultProvider
      ? parseModelRefWithCompatAlias({
          cfg: params.cfg,
          agentId: params.agentId,
          raw: defaultModel,
          defaultProvider: params.defaultProvider,
          ...defaultModelNormalization,
        })
      : null;
  const defaultKey = defaultRef ? modelKey(defaultRef.provider, defaultRef.model) : undefined;
  const resolveSelectionModelRef = (raw: string, aliasIndex: ModelAliasIndex) => {
    const trimmed = raw.trim();
    const defaultProvider = !trimmed.includes("/")
      ? resolveBareModelDefaultProvider({
          cfg: params.cfg,
          catalog,
          model: trimmed,
          defaultProvider: params.defaultProvider,
          agentId: params.agentId,
          manifestPlugins: params.manifestPlugins,
        })
      : params.defaultProvider;
    return resolveModelRefFromString({
      cfg: params.cfg,
      agentId: params.agentId,
      raw,
      defaultProvider,
      aliasIndex,
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: params.manifestPlugins,
    })?.ref;
  };
  const automaticFallbackKeys = new Set<string>();
  for (const fallback of params.fallbackModels) {
    const parsed = resolveSelectionModelRef(fallback, selectionAliasIndex);
    if (parsed) {
      automaticFallbackKeys.add(modelKey(parsed.provider, parsed.model));
    }
  }
  const catalogKeys = new Set<string>();
  for (const entry of catalog) {
    catalogKeys.add(modelKey(entry.provider, entry.id));
  }

  if (allowAny) {
    if (defaultKey) {
      catalogKeys.add(defaultKey);
    }
    return {
      allowAny: true,
      allowedCatalog: catalog,
      allowedKeys: catalogKeys,
      automaticFallbackKeys,
      configuredCatalog,
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
          modelKey(existing.provider, existing.model) === modelKey(ref.provider, ref.model),
      )
    ) {
      allowedRefs.push(ref);
    }
  };
  for (const entry of expandModelCatalogWildcards(catalog, wildcardModelKeys)) {
    allowedKeys.add(modelKey(entry.provider, entry.id));
    addAllowedCatalogRef({ provider: entry.provider, model: entry.id });
  }
  const addAllowedModelRef = (raw: string, aliasIndex: ModelAliasIndex) => {
    const parsed = resolveSelectionModelRef(raw, aliasIndex);
    if (!parsed) {
      return;
    }
    const key = modelKey(parsed.provider, parsed.model);
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
    addAllowedModelRef(raw, policyAliasIndex);
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
      automaticFallbackKeys,
      configuredCatalog,
    };
  }

  return {
    allowAny: false,
    allowedCatalog,
    allowedKeys,
    automaticFallbackKeys,
    configuredCatalog,
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

function getModelRefStatusFromAllowedSet(params: {
  catalog: ModelCatalogEntry[];
  ref: ModelRef;
  allowed: {
    allowAny: boolean;
    allowedKeys: Set<string>;
  };
}): ModelRefStatus {
  const key = modelKey(params.ref.provider, params.ref.model);
  return {
    key,
    inCatalog: Boolean(
      findModelCatalogEntry(params.catalog, {
        provider: params.ref.provider,
        modelId: params.ref.model,
      }),
    ),
    allowAny: params.allowed.allowAny,
    allowed: params.allowed.allowAny || isModelKeyAllowedBySet(params.allowed.allowedKeys, key),
  };
}

export function getModelRefStatusWithFallbackModels(
  params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    ref: ModelRef;
    defaultProvider: string;
    defaultModel?: string;
    fallbackModels: readonly string[];
    agentId?: string;
  } & ModelManifestNormalizationContext,
): ModelRefStatus {
  const allowed = buildAllowedModelSetWithFallbacks({
    cfg: params.cfg,
    catalog: params.catalog,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    fallbackModels: params.fallbackModels,
    agentId: params.agentId,
    manifestPlugins: params.manifestPlugins,
  });
  return getModelRefStatusFromAllowedSet({
    catalog: params.catalog,
    ref: params.ref,
    allowed,
  });
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
  } & ModelManifestNormalizationContext,
): ResolveAllowedModelRefResult {
  const trimmed = params.raw.trim();
  if (!trimmed) {
    return { error: "invalid model: empty" };
  }

  const effectiveDefaultProvider = !trimmed.includes("/")
    ? (inferUniqueProviderFromConfiguredModels({
        cfg: params.cfg,
        model: trimmed,
        agentId: params.agentId,
        manifestPlugins: params.manifestPlugins,
      }) ?? params.defaultProvider)
    : params.defaultProvider;

  const resolved = resolveModelRefFromString({
    cfg: params.cfg,
    agentId: params.agentId,
    raw: trimmed,
    defaultProvider: effectiveDefaultProvider,
    aliasIndex: params.aliasIndex,
    manifestPlugins: params.manifestPlugins,
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
export function hasConfiguredProviderModelRows(cfg: OpenClawConfig): boolean {
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

function resolveConfiguredModelManifestPlugins(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  manifestPlugins?: ModelManifestPlugins;
}): ModelManifestPlugins {
  if (params.manifestPlugins) {
    return params.manifestPlugins;
  }
  if (!hasConfiguredProviderModelRows(params.cfg)) {
    return undefined;
  }
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  if (!workspaceDir) {
    return getCurrentPluginMetadataSnapshot({
      config: params.cfg,
      env: process.env,
    })?.plugins;
  }
  return loadManifestMetadataSnapshot({
    config: params.cfg,
    env: process.env,
    ...(workspaceDir ? { workspaceDir } : {}),
  }).plugins;
}

/** Build catalog entries from configured provider model rows. */
export function buildConfiguredModelCatalog(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  manifestPlugins?: ModelManifestPlugins;
}): ModelCatalogEntry[] {
  const providers = params.cfg.models?.providers;
  if (!providers || typeof providers !== "object") {
    return [];
  }

  const manifestPlugins = resolveConfiguredModelManifestPlugins(params);
  const catalog: ModelCatalogEntry[] = [];
  for (const [providerRaw, provider] of Object.entries(providers)) {
    const providerId = normalizeProviderId(providerRaw);
    if (!providerId || !Array.isArray(provider?.models)) {
      continue;
    }
    for (const model of provider.models) {
      const rawId = normalizeOptionalString(model?.id) ?? "";
      const id = rawId
        ? normalizeConfiguredProviderCatalogModelId(providerId, rawId, { manifestPlugins })
        : "";
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
  } & ModelManifestNormalizationContext,
): ModelRef | null {
  const hooksModel = params.cfg.hooks?.gmail?.model;
  if (!hooksModel?.trim()) {
    return null;
  }

  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
    manifestPlugins: params.manifestPlugins,
  });

  const resolved = resolveModelRefFromString({
    cfg: params.cfg,
    raw: hooksModel,
    defaultProvider: params.defaultProvider,
    aliasIndex,
    manifestPlugins: params.manifestPlugins,
  });

  return resolved?.ref ?? null;
}

export function normalizeModelSelection(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const primary = (value as { primary?: unknown }).primary;
  if (typeof primary === "string" && primary.trim()) {
    return primary.trim();
  }
  return undefined;
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
    isModelKeyAllowedBySet(wildcardModelKeys, modelKey(entry.provider, entry.id)),
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

function resolveAllowedModelSelection(
  params: {
    cfg?: OpenClawConfig;
    provider: string;
    model: string;
    allowAny: boolean;
    allowedKeys: ReadonlySet<string>;
    allowedCatalog: readonly ModelCatalogEntry[];
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelRef | null {
  const normalizeSelectionRef = (provider: string, model: string) =>
    resolveExactConfiguredProviderRef({
      cfg: params.cfg,
      raw: `${provider}/${model}`,
      allowManifestNormalization: params.allowManifestNormalization,
      manifestPlugins: params.manifestPlugins,
    }) ??
    normalizeModelRef(provider, model, {
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: params.manifestPlugins,
    });
  const current = normalizeSelectionRef(params.provider, params.model);
  if (
    params.allowAny ||
    isModelKeyAllowedBySet(params.allowedKeys, modelKey(current.provider, current.model))
  ) {
    return current;
  }
  const fallback = params.allowedCatalog[0];
  if (!fallback) {
    return null;
  }
  return normalizeSelectionRef(fallback.provider, fallback.id);
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
  automaticFallbackKeys: ReadonlySet<string>;
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
  return normalizeLowercaseStringOrEmpty(modelKey(provider, model));
}

export function dedupeModelCatalogEntries(
  entries: readonly ModelCatalogEntry[],
): ModelCatalogEntry[] {
  // Preserve the first occurrence after precedence merging while removing
  // provider/id duplicates from configured and auth-backed catalogs.
  const seen = new Set<string>();
  const next: ModelCatalogEntry[] = [];
  for (const entry of entries) {
    const key = modelKey(entry.provider, entry.id);
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
    fallbackModels: readonly string[];
    additionalConfiguredModelRefs?: readonly string[];
    agentId?: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelVisibilityPolicy {
  const visibility = parseConfiguredModelVisibilityEntries({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const wildcardModelKeys = visibility.wildcardModelKeys;
  const policyAliasAgentId = resolvePolicyAliasAgentId(visibility.configPath, params.agentId);
  const policyAliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
    agentId: policyAliasAgentId,
    allowManifestNormalization: params.allowManifestNormalization,
    allowPluginNormalization: params.allowPluginNormalization,
    manifestPlugins: params.manifestPlugins,
  });
  const selectionAliasIndex =
    params.agentId && policyAliasAgentId !== params.agentId
      ? buildModelAliasIndex({
          cfg: params.cfg,
          defaultProvider: params.defaultProvider,
          agentId: params.agentId,
          allowManifestNormalization: params.allowManifestNormalization,
          allowPluginNormalization: params.allowPluginNormalization,
          manifestPlugins: params.manifestPlugins,
        })
      : policyAliasIndex;
  const allowed = buildAllowedModelSetWithFallbacks({
    ...params,
    aliasIndex: policyAliasIndex,
    selectionAliasIndex,
    visibility,
  });
  const configuredKeys = new Set(allowed.configuredCatalog.map(modelCatalogLogicalKey));
  const retainedKeys = new Set<string>();
  const addConfiguredRef = (
    raw: string | undefined,
    retained: boolean,
    aliasIndex: ModelAliasIndex,
  ) => {
    if (!raw?.trim() || parseModelPolicyWildcardRef(raw)) {
      return;
    }
    const resolved = resolveModelRefFromString({
      cfg: params.cfg,
      agentId: params.agentId,
      raw,
      defaultProvider: params.defaultProvider,
      aliasIndex,
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: params.manifestPlugins,
    });
    if (!resolved) {
      return;
    }
    const key = modelCatalogLogicalKey({
      provider: resolved.ref.provider,
      id: resolved.ref.model,
    });
    configuredKeys.add(key);
    if (retained) {
      retainedKeys.add(key);
    }
  };
  for (const raw of visibility.exactModelRefs) {
    addConfiguredRef(raw, false, policyAliasIndex);
  }
  for (const raw of params.additionalConfiguredModelRefs ?? []) {
    addConfiguredRef(raw, false, selectionAliasIndex);
  }
  addConfiguredRef(params.defaultModel, true, selectionAliasIndex);
  for (const fallback of params.fallbackModels) {
    // Configured fallbacks remain available for automatic failover and catalog
    // retention, but are not user-selectable overrides unless policy also allows them.
    addConfiguredRef(fallback, true, selectionAliasIndex);
  }
  const allowsKey = (key: string): boolean =>
    allowed.allowAny || isModelKeyAllowedBySet(allowed.allowedKeys, key);
  const exactConfiguredKeys = new Set<string>();
  for (const raw of visibility.exactModelRefs) {
    const resolved = resolveModelRefFromString({
      cfg: params.cfg,
      agentId: params.agentId,
      raw,
      defaultProvider: params.defaultProvider,
      aliasIndex: policyAliasIndex,
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: params.manifestPlugins,
    })?.ref;
    if (resolved) {
      exactConfiguredKeys.add(modelKey(resolved.provider, resolved.model));
    }
  }
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
    automaticFallbackKeys: allowed.automaticFallbackKeys,
    allowsKey,
    allows: (ref) => allowsKey(modelKey(ref.provider, ref.model)),
    allowsByWildcard: (ref) =>
      isModelKeyAllowedBySet(wildcardModelKeys, modelKey(ref.provider, ref.model)),
    resolveSelection: (ref) =>
      resolveAllowedModelSelection({
        provider: ref.provider,
        model: ref.model,
        cfg: params.cfg,
        allowAny: allowed.allowAny,
        allowedKeys: allowed.allowedKeys,
        allowedCatalog: allowed.allowedCatalog,
        allowManifestNormalization: params.allowManifestNormalization,
        allowPluginNormalization: params.allowPluginNormalization,
        manifestPlugins: params.manifestPlugins,
      }),
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
          isModelKeyAllowedBySet(wildcardModelKeys, modelKey(entry.provider, entry.id)),
        ),
        ...allowed.allowedCatalog.filter((entry) =>
          exactConfiguredKeys.has(modelKey(entry.provider, entry.id)),
        ),
      ]);
    },
  };
  return policy;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
