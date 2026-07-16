/**
 * Shared model-selection resolution, alias, allowlist, and visibility logic.
 */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog, stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { loadManifestMetadataSnapshot } from "../plugins/manifest-contract-eligibility.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "../plugins/runtime-state.js";
import { resolveConfiguredProviderFallback } from "./configured-provider-fallback.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import { findModelCatalogEntry } from "./model-catalog-lookup.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import {
  normalizeConfiguredProviderCatalogModelId,
  normalizeStaticProviderModelId,
} from "./model-ref-shared.js";
import {
  type ModelManifestNormalizationContext,
  type ModelRef,
  findNormalizedProviderValue,
  modelKey,
  normalizeModelRef,
  normalizeProviderId,
  parseModelRef,
} from "./model-selection-normalize.js";

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
};

type ModelManifestPluginContext = {
  peek: () => ModelManifestPlugins;
  get: () => ModelManifestPlugins;
};

type ModelAliasCandidate = {
  keyRaw: string;
  alias: string;
};

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
    return loadManifestMetadataSnapshot({
      config: params.cfg,
      env: process.env,
    }).plugins;
  }
  return loadManifestMetadataSnapshot({
    config: params.cfg,
    workspaceDir,
    env: process.env,
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

function listModelAliasCandidates(cfg: OpenClawConfig): ModelAliasCandidate[] {
  return Object.entries(cfg.agents?.defaults?.models ?? {}).flatMap(([keyRaw, entryRaw]) => {
    if (parseProviderWildcardModelRef(keyRaw)) {
      return [];
    }
    const alias =
      normalizeOptionalString((entryRaw as { alias?: string } | undefined)?.alias) ?? "";
    return alias ? [{ keyRaw, alias }] : [];
  });
}

function findModelAliasCandidate(
  cfg: OpenClawConfig,
  raw: string,
): ModelAliasCandidate | undefined {
  const aliasKey = normalizeLowercaseStringOrEmpty(raw);
  let match: ModelAliasCandidate | undefined;
  for (const candidate of listModelAliasCandidates(cfg)) {
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
    allowManifestNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): string | undefined {
  const model = params.model.trim();
  if (!model) {
    return undefined;
  }
  const normalized = normalizeLowercaseStringOrEmpty(model);
  const providers = new Set<string>();
  const addProvider = (provider: string) => {
    const normalizedProvider = normalizeProviderId(provider);
    if (!normalizedProvider) {
      return;
    }
    providers.add(normalizedProvider);
  };
  const configuredModels = params.cfg.agents?.defaults?.models;
  if (configuredModels) {
    for (const key of Object.keys(configuredModels)) {
      const ref = key.trim();
      if (!ref || !ref.includes("/") || ref.endsWith("/*")) {
        continue;
      }
      const parsed = parseModelRef(ref, DEFAULT_PROVIDER, {
        allowManifestNormalization: params.allowManifestNormalization,
        allowPluginNormalization: false,
        manifestPlugins: params.manifestPlugins,
      });
      if (!parsed) {
        continue;
      }
      if (parsed.model === model || normalizeLowercaseStringOrEmpty(parsed.model) === normalized) {
        addProvider(parsed.provider);
        if (providers.size > 1) {
          return undefined;
        }
      }
    }
  }
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
export function inferUniqueProviderFromCatalog(params: {
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
  } & ModelManifestNormalizationContext,
): string {
  return (
    inferUniqueProviderFromConfiguredModels({
      cfg: params.cfg,
      model: params.model,
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
    defaultProvider: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelRef | null {
  const configuredModels = params.cfg.agents?.defaults?.models ?? {};
  for (const raw of Object.keys(configuredModels)) {
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
export function resolveConfiguredOpenRouterCompatAlias(
  params: {
    cfg?: OpenClawConfig;
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
    defaultProvider: params.defaultProvider,
    allowManifestNormalization: params.allowManifestNormalization,
    allowPluginNormalization: params.allowPluginNormalization,
    manifestPlugins: params.manifestPlugins,
  });
}

function parseModelRefWithCompatAlias(
  params: {
    cfg?: OpenClawConfig;
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

/** Normalize a configured allowlist entry into the canonical provider/model key. */
export function resolveAllowlistModelKey(
  params: {
    cfg?: OpenClawConfig;
    raw: string;
    defaultProvider: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): string | null {
  const parsed = parseModelRefWithCompatAlias({
    cfg: params.cfg,
    raw: params.raw,
    defaultProvider: params.defaultProvider,
    allowManifestNormalization: params.allowManifestNormalization,
    allowPluginNormalization: params.allowPluginNormalization,
    manifestPlugins: params.manifestPlugins,
  });
  if (!parsed) {
    return null;
  }
  return modelKey(parsed.provider, parsed.model);
}

/** Build the exact configured model keys that constrain model visibility. */
export function buildConfiguredAllowlistKeys(
  params: {
    cfg: OpenClawConfig | undefined;
    defaultProvider: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): Set<string> | null {
  const visibility = parseConfiguredModelVisibilityEntries({ cfg: params.cfg });
  if (visibility.exactModelRefs.length === 0) {
    return null;
  }

  const keys = new Set<string>();
  for (const raw of visibility.exactModelRefs) {
    const key = resolveAllowlistModelKey({
      cfg: params.cfg,
      raw,
      defaultProvider: params.defaultProvider,
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: params.manifestPlugins,
    });
    if (key) {
      keys.add(key);
    }
  }
  return keys.size > 0 ? keys : null;
}

type BuildModelAliasIndexParams = {
  cfg: OpenClawConfig;
  defaultProvider: string;
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
  const aliasCandidates = listModelAliasCandidates(params.cfg);
  if (aliasCandidates.length === 0) {
    return { byAlias, byProviderAlias, byKey };
  }
  const manifestPlugins = params.manifestPluginContext.get();

  for (const { keyRaw, alias } of aliasCandidates) {
    // Aliases point at configured model keys, not arbitrary model ids, so profile
    // suffixes and configured-provider normalization happen on the target key.
    const parsed = parseModelRefWithCompatAlias({
      cfg: params.cfg,
      raw: keyRaw,
      defaultProvider: params.defaultProvider,
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins,
    });
    if (!parsed) {
      continue;
    }
    const aliasKey = normalizeLowercaseStringOrEmpty(alias);
    const match = { alias, ref: parsed };
    byAlias.set(aliasKey, match);
    // Bare aliases retain their existing last-wins behavior. Provider-qualified
    // aliases stay scoped so duplicate display names cannot select another provider.
    byProviderAlias.set(providerAliasKey(parsed.provider, alias), match);
    const key = modelKey(parsed.provider, parsed.model);
    const existing = byKey.get(key) ?? [];
    existing.push(alias);
    byKey.set(key, existing);
  }

  return { byAlias, byProviderAlias, byKey };
}

/** Build lookup maps from user-facing aliases to normalized model refs. */
export function buildModelAliasIndex(params: BuildModelAliasIndexParams): ModelAliasIndex {
  return buildModelAliasIndexWithManifestContext({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
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
    defaultProvider: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelCatalogMetadata {
  const configuredByKey = new Map<string, ModelCatalogEntry>();
  for (const entry of buildConfiguredModelCatalog({
    cfg: params.cfg,
    manifestPlugins: params.manifestPlugins,
  })) {
    configuredByKey.set(modelKey(entry.provider, entry.id), entry);
  }

  const aliasByKey = new Map<string, string>();
  const configuredModels = params.cfg.agents?.defaults?.models ?? {};
  for (const [rawKey, entryRaw] of Object.entries(configuredModels)) {
    if (parseProviderWildcardModelRef(rawKey)) {
      continue;
    }
    const key = resolveAllowlistModelKey({
      cfg: params.cfg,
      raw: rawKey,
      defaultProvider: params.defaultProvider,
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: params.manifestPlugins,
    });
    if (!key) {
      continue;
    }
    const alias = ((entryRaw as { alias?: string } | undefined)?.alias ?? "").trim();
    if (alias) {
      aliasByKey.set(key, alias);
    }
  }

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
  const nextInput = configuredEntry?.input ?? params.entry.input;
  const nextParams =
    params.entry.params || configuredEntry?.params
      ? { ...params.entry.params, ...configuredEntry?.params }
      : undefined;
  const nextCompat =
    params.entry.compat || configuredEntry?.compat
      ? { ...params.entry.compat, ...configuredEntry?.compat }
      : undefined;

  return {
    ...params.entry,
    name: configuredEntry?.name ?? params.entry.name,
    ...(nextAlias ? { alias: nextAlias } : {}),
    ...(nextContextWindow !== undefined ? { contextWindow: nextContextWindow } : {}),
    ...(nextContextTokens !== undefined ? { contextTokens: nextContextTokens } : {}),
    ...(nextReasoning !== undefined ? { reasoning: nextReasoning } : {}),
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
    ...(nextInput ? { input: nextInput } : {}),
    ...(nextParams ? { params: nextParams } : {}),
    ...(nextCompat ? { compat: nextCompat } : {}),
  };
}

export function resolveModelRefFromString(
  params: {
    cfg?: OpenClawConfig;
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

/** Resolve the default configured model ref, including aliases and fallback provider rows. */
export function resolveConfiguredModelRef(
  params: {
    cfg: OpenClawConfig;
    defaultProvider: string;
    defaultModel: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelRef {
  const rawModel = resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model) ?? "";
  if (rawModel) {
    const trimmed = rawModel.trim();
    const { model: modelWithoutProfile } = splitTrailingAuthProfile(trimmed);
    const manifestPluginContext = createModelManifestPluginContext(params);
    const profileStripped = Boolean(modelWithoutProfile && modelWithoutProfile !== trimmed);
    const exactAliasCandidate = findModelAliasCandidate(params.cfg, trimmed);
    const strippedAliasCandidate = profileStripped
      ? findModelAliasCandidate(params.cfg, modelWithoutProfile)
      : undefined;
    const profileAliasCandidate = profileStripped
      ? (exactAliasCandidate ?? strippedAliasCandidate)
      : undefined;
    if (profileAliasCandidate) {
      // Auth-profile suffixes are not part of alias matching; resolve the alias
      // target while preserving the provider/model semantics of the key.
      const aliasRef = parseModelRefWithCompatAlias({
        cfg: params.cfg,
        raw: profileAliasCandidate.keyRaw,
        defaultProvider: params.defaultProvider,
        allowManifestNormalization: params.allowManifestNormalization,
        allowPluginNormalization: params.allowPluginNormalization,
        manifestPlugins: manifestPluginContext.get(),
      });
      if (aliasRef) {
        return aliasRef;
      }
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
      const aliasRef = parseModelRefWithCompatAlias({
        cfg: params.cfg,
        raw: aliasCandidate.keyRaw,
        defaultProvider: params.defaultProvider,
        allowManifestNormalization: params.allowManifestNormalization,
        allowPluginNormalization: params.allowPluginNormalization,
        manifestPlugins: manifestPluginContext.get(),
      });
      if (aliasRef) {
        return aliasRef;
      }
    }

    if (!trimmed.includes("/")) {
      const normalizedTrimmed = normalizeLowercaseStringOrEmpty(trimmed);
      const needsOpenRouterCompatManifestPlugins =
        normalizedTrimmed === "openrouter:auto" ||
        normalizedTrimmed === OPENROUTER_COMPAT_FREE_ALIAS;
      const openrouterCompatRef = resolveConfiguredOpenRouterCompatAlias({
        cfg: params.cfg,
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
        allowManifestNormalization: false,
        manifestPlugins,
      });
      let inferredProviderManifestPlugins = manifestPlugins;
      if (
        (!inferredProvider || inferredProvider !== "openai") &&
        hasConfiguredRowsNeedingManifestLookup(params.cfg, params.defaultProvider)
      ) {
        // Non-default provider rows may normalize through plugin manifests. Avoid
        // that heavier lookup unless the cheap configured pass was ambiguous.
        inferredProviderManifestPlugins = manifestPluginContext.get();
        inferredProvider =
          inferUniqueProviderFromConfiguredModels({
            cfg: params.cfg,
            model: trimmed,
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
  });
  if (fallbackProvider) {
    return fallbackProvider;
  }
  return { provider: params.defaultProvider, model: params.defaultModel };
}

/** Build allowed model keys/catalog entries after provider wildcards and fallbacks. */
export function buildAllowedModelSetWithFallbacks(
  params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    defaultProvider: string;
    defaultModel?: string;
    fallbackModels: readonly string[];
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): {
  allowAny: boolean;
  allowedCatalog: ModelCatalogEntry[];
  allowedKeys: Set<string>;
  configuredCatalog: ModelCatalogEntry[];
} {
  const metadata = buildModelCatalogMetadata({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
    allowManifestNormalization: params.allowManifestNormalization,
    allowPluginNormalization: params.allowPluginNormalization,
    manifestPlugins: params.manifestPlugins,
  });
  const configuredCatalog = buildConfiguredModelCatalog({
    cfg: params.cfg,
    manifestPlugins: params.manifestPlugins,
  });
  const catalog = mergeModelCatalogEntries({
    primary: params.catalog,
    secondary: configuredCatalog,
  }).map((entry) => applyModelCatalogMetadata({ entry, metadata }));
  const visibility = parseConfiguredModelVisibilityEntries({ cfg: params.cfg });
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
          raw: defaultModel,
          defaultProvider: params.defaultProvider,
          ...defaultModelNormalization,
        })
      : null;
  const defaultKey = defaultRef ? modelKey(defaultRef.provider, defaultRef.model) : undefined;
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
      configuredCatalog,
    };
  }

  const allowedKeys = new Set<string>();
  const allowedRefs: ModelRef[] = [];
  const syntheticCatalogEntries = new Map<string, ModelCatalogEntry>();
  for (const provider of visibility.providerWildcards) {
    allowedKeys.add(providerWildcardModelKey(provider));
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
  for (const entry of catalog) {
    if (!visibility.providerWildcards.has(normalizeProviderId(entry.provider))) {
      continue;
    }
    allowedKeys.add(modelKey(entry.provider, entry.id));
    addAllowedCatalogRef({ provider: entry.provider, model: entry.id });
  }
  const addAllowedModelRef = (raw: string) => {
    const trimmed = raw.trim();
    const defaultProvider = !trimmed.includes("/")
      ? resolveBareModelDefaultProvider({
          cfg: params.cfg,
          catalog,
          model: trimmed,
          defaultProvider: params.defaultProvider,
          manifestPlugins: params.manifestPlugins,
        })
      : params.defaultProvider;
    const parsed = parseModelRefWithCompatAlias({
      cfg: params.cfg,
      raw,
      defaultProvider,
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: params.manifestPlugins,
    });
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
    addAllowedModelRef(raw);
  }

  if (visibility.exactModelRefs.length > 0) {
    for (const fallback of params.fallbackModels) {
      addAllowedModelRef(fallback);
    }
  }

  if (
    defaultKey &&
    ((visibility.exactModelRefs.length > 0 && visibility.providerWildcards.size === 0) ||
      (defaultRef && visibility.providerWildcards.has(normalizeProviderId(defaultRef.provider))))
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

  if (
    allowedCatalog.length === 0 &&
    allowedKeys.size === 0 &&
    visibility.providerWildcards.size === 0
  ) {
    if (defaultKey) {
      catalogKeys.add(defaultKey);
    }
    return {
      allowAny: true,
      allowedCatalog: catalog,
      allowedKeys: catalogKeys,
      configuredCatalog,
    };
  }

  return { allowAny: false, allowedCatalog, allowedKeys, configuredCatalog };
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
  } & ModelManifestNormalizationContext,
): ModelRefStatus {
  const allowed = buildAllowedModelSetWithFallbacks({
    cfg: params.cfg,
    catalog: params.catalog,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    fallbackModels: params.fallbackModels,
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
        manifestPlugins: params.manifestPlugins,
      }) ?? params.defaultProvider)
    : params.defaultProvider;

  const resolved = resolveModelRefFromString({
    cfg: params.cfg,
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
): boolean {
  const configuredModels = cfg.agents?.defaults?.models;
  if (!configuredModels || typeof configuredModels !== "object") {
    return false;
  }
  const normalizedDefaultProvider = normalizeProviderId(defaultProvider);
  return Object.keys(configuredModels).some((keyRaw) => {
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
  });
}

function hasConfiguredRowsNeedingManifestLookup(
  cfg: OpenClawConfig,
  defaultProvider: string,
): boolean {
  return (
    hasConfiguredProviderRowsNeedingManifestLookup(cfg) ||
    hasConfiguredModelRefsNeedingManifestLookup(cfg, defaultProvider)
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
    return (
      getCurrentPluginMetadataSnapshot({
        config: params.cfg,
        env: process.env,
      })?.plugins ?? []
    );
  }
  return loadManifestMetadataSnapshot({
    config: params.cfg,
    workspaceDir,
    env: process.env,
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

function parseProviderWildcardModelRef(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.endsWith("/*")) {
    return null;
  }
  return normalizeProviderId(trimmed.slice(0, -2)) || null;
}

export function parseConfiguredModelVisibilityEntries(params: { cfg?: OpenClawConfig }): {
  exactModelRefs: string[];
  providerWildcards: Set<string>;
  hasEntries: boolean;
} {
  const rawModels = Object.keys(params.cfg?.agents?.defaults?.models ?? {});
  const exactModelRefs: string[] = [];
  const providerWildcards = new Set<string>();

  for (const raw of rawModels) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    const wildcardProvider = parseProviderWildcardModelRef(trimmed);
    if (wildcardProvider) {
      providerWildcards.add(wildcardProvider);
      continue;
    }
    exactModelRefs.push(raw);
  }

  return {
    exactModelRefs,
    providerWildcards,
    hasEntries: rawModels.length > 0,
  };
}

function providerWildcardModelKey(provider: string): string {
  return modelKey(normalizeProviderId(provider), "*");
}

export function isModelKeyAllowedBySet(allowedKeys: ReadonlySet<string>, key: string): boolean {
  if (allowedKeys.has(key)) {
    return true;
  }
  const separator = key.indexOf("/");
  if (separator <= 0) {
    return false;
  }
  return allowedKeys.has(providerWildcardModelKey(key.slice(0, separator)));
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
  configuredKeys: ReadonlySet<string>;
  retainedKeys: ReadonlySet<string>;
  exactModelRefs: readonly string[];
  providerWildcards: ReadonlySet<string>;
  hasConfiguredEntries: boolean;
  hasProviderWildcards: boolean;
  allowsKey: (key: string) => boolean;
  allows: (ref: { provider: string; model: string }) => boolean;
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
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelVisibilityPolicy {
  const visibility = parseConfiguredModelVisibilityEntries({ cfg: params.cfg });
  const allowed = buildAllowedModelSetWithFallbacks(params);
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
    allowManifestNormalization: params.allowManifestNormalization,
    allowPluginNormalization: params.allowPluginNormalization,
    manifestPlugins: params.manifestPlugins,
  });
  const configuredKeys = new Set(allowed.configuredCatalog.map(modelCatalogLogicalKey));
  const retainedKeys = new Set<string>();
  const addConfiguredRef = (raw: string | undefined, retained: boolean) => {
    if (!raw?.trim() || parseProviderWildcardModelRef(raw)) {
      return;
    }
    const resolved = resolveModelRefFromString({
      cfg: params.cfg,
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
  for (const raw of [
    ...visibility.exactModelRefs,
    ...(params.additionalConfiguredModelRefs ?? []),
  ]) {
    addConfiguredRef(raw, false);
  }
  addConfiguredRef(params.defaultModel, true);
  for (const fallback of params.fallbackModels) {
    addConfiguredRef(fallback, true);
  }
  const allowsKey = (key: string): boolean =>
    allowed.allowAny || isModelKeyAllowedBySet(allowed.allowedKeys, key);
  const exactConfiguredKeys = new Set<string>();
  for (const raw of visibility.exactModelRefs) {
    const key = resolveAllowlistModelKey({
      cfg: params.cfg,
      raw,
      defaultProvider: params.defaultProvider,
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: params.manifestPlugins,
    });
    if (key) {
      exactConfiguredKeys.add(key);
    }
  }
  const policy: ModelVisibilityPolicy = {
    allowAny: allowed.allowAny,
    allowedCatalog: allowed.allowedCatalog,
    allowedKeys: allowed.allowedKeys,
    configuredKeys,
    retainedKeys,
    exactModelRefs: visibility.exactModelRefs,
    providerWildcards: visibility.providerWildcards,
    hasConfiguredEntries: visibility.hasEntries,
    hasProviderWildcards: visibility.providerWildcards.size > 0,
    allowsKey,
    allows: (ref) => allowsKey(modelKey(ref.provider, ref.model)),
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
      if (visibility.providerWildcards.size === 0) {
        return [...allowed.allowedCatalog];
      }
      return dedupeModelCatalogEntries([
        ...defaultVisibleCatalog.filter((entry) =>
          visibility.providerWildcards.has(normalizeProviderId(entry.provider)),
        ),
        ...allowed.allowedCatalog.filter(
          (entry) =>
            !visibility.providerWildcards.has(normalizeProviderId(entry.provider)) ||
            exactConfiguredKeys.has(modelKey(entry.provider, entry.id)),
        ),
      ]);
    },
  };
  return policy;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
