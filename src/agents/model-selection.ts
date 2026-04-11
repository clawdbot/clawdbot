import { resolveThinkingDefaultForModel } from "../auto-reply/thinking.shared.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
  toAgentModelListLike,
} from "../config/model-input.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveRuntimeCliBackends } from "../plugins/cli-backends.runtime.js";
import { resolvePluginSetupCliBackendRuntime } from "../plugins/setup-registry.runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { sanitizeForLog, stripAnsi } from "../terminal/ansi.js";
import {
  resolveAgentConfig,
  resolveAgentEffectiveModelPrimary,
  resolveAgentModelFallbacksOverride,
} from "./agent-scope.js";
import { resolveConfiguredProviderFallback } from "./configured-provider-fallback.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import {
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

let log: ReturnType<typeof createSubsystemLogger> | null = null;

function getLog(): ReturnType<typeof createSubsystemLogger> {
  log ??= createSubsystemLogger("model-selection");
  return log;
}

export type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive";

export type ModelAliasIndex = {
  byAlias: Map<string, { alias: string; ref: ModelRef }>;
  byKey: Map<string, string[]>;
};

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

export {
  findNormalizedProviderKey,
  findNormalizedProviderValue,
  legacyModelKey,
  modelKey,
  normalizeModelRef,
  normalizeProviderId,
  normalizeProviderIdForAuth,
  parseModelRef,
};
export type { ModelRef };

export function isCliProvider(provider: string, cfg?: OpenClawConfig): boolean {
  const normalized = normalizeProviderId(provider);
  const cliBackends = resolveRuntimeCliBackends();
  if (cliBackends.some((backend) => normalizeProviderId(backend.id) === normalized)) {
    return true;
  }
  if (resolvePluginSetupCliBackendRuntime({ backend: normalized })) {
    return true;
  }
  const backends = cfg?.agents?.defaults?.cliBackends ?? {};
  return Object.keys(backends).some((key) => normalizeProviderId(key) === normalized);
}

export function resolvePersistedOverrideModelRef(params: {
  defaultProvider: string;
  overrideProvider?: string;
  overrideModel?: string;
}): ModelRef | null {
  const defaultProvider = params.defaultProvider.trim();
  const overrideProvider = params.overrideProvider?.trim();
  const overrideModel = params.overrideModel?.trim();
  if (!overrideModel) {
    return null;
  }
  const encodedOverride = overrideProvider ? `${overrideProvider}/${overrideModel}` : overrideModel;
  return (
    parseModelRef(encodedOverride, defaultProvider) ?? {
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
  defaultProvider: string;
  runtimeProvider?: string;
  runtimeModel?: string;
  overrideProvider?: string;
  overrideModel?: string;
}): ModelRef | null {
  const defaultProvider = params.defaultProvider.trim();
  const runtimeProvider = params.runtimeProvider?.trim();
  const runtimeModel = params.runtimeModel?.trim();
  if (runtimeModel) {
    if (runtimeProvider) {
      return { provider: runtimeProvider, model: runtimeModel };
    }
    return (
      parseModelRef(runtimeModel, defaultProvider) ?? {
        provider: defaultProvider,
        model: runtimeModel,
      }
    );
  }
  return resolvePersistedOverrideModelRef({
    defaultProvider,
    overrideProvider: params.overrideProvider,
    overrideModel: params.overrideModel,
  });
}

/**
 * Selected-model resolver for persisted model metadata.
 * Use this for control/status/UI surfaces that should honor explicit session
 * overrides before falling back to runtime identity.
 */
export function resolvePersistedSelectedModelRef(params: {
  defaultProvider: string;
  runtimeProvider?: string;
  runtimeModel?: string;
  overrideProvider?: string;
  overrideModel?: string;
}): ModelRef | null {
  const override = resolvePersistedOverrideModelRef({
    defaultProvider: params.defaultProvider,
    overrideProvider: params.overrideProvider,
    overrideModel: params.overrideModel,
  });
  if (override) {
    return override;
  }
  return resolvePersistedModelRef({
    defaultProvider: params.defaultProvider,
    runtimeProvider: params.runtimeProvider,
    runtimeModel: params.runtimeModel,
  });
}

export function normalizeStoredOverrideModel(params: {
  providerOverride?: string | null;
  modelOverride?: string | null;
}): { providerOverride?: string; modelOverride?: string } {
  const providerOverride = params.providerOverride?.trim();
  const modelOverride = params.modelOverride?.trim();
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

export function inferUniqueProviderFromConfiguredModels(params: {
  cfg: OpenClawConfig;
  model: string;
}): string | undefined {
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
      if (!ref || !ref.includes("/")) {
        continue;
      }
      const parsed = parseModelRef(ref, DEFAULT_PROVIDER, {
        allowPluginNormalization: false,
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
        if (modelId === model || normalizeLowercaseStringOrEmpty(modelId) === normalized) {
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

export function resolveAllowlistModelKey(raw: string, defaultProvider: string): string | null {
  const parsed = parseModelRef(raw, defaultProvider);
  if (!parsed) {
    return null;
  }
  return modelKey(parsed.provider, parsed.model);
}

export function buildConfiguredAllowlistKeys(params: {
  cfg: OpenClawConfig | undefined;
  defaultProvider: string;
}): Set<string> | null {
  const rawAllowlist = Object.keys(params.cfg?.agents?.defaults?.models ?? {});
  if (rawAllowlist.length === 0) {
    return null;
  }

  const keys = new Set<string>();
  for (const raw of rawAllowlist) {
    const key = resolveAllowlistModelKey(raw, params.defaultProvider);
    if (key) {
      keys.add(key);
    }
  }
  return keys.size > 0 ? keys : null;
}

export function buildModelAliasIndex(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
  allowPluginNormalization?: boolean;
}): ModelAliasIndex {
  const byAlias = new Map<string, { alias: string; ref: ModelRef }>();
  const byKey = new Map<string, string[]>();

  const rawModels = params.cfg.agents?.defaults?.models ?? {};
  for (const [keyRaw, entryRaw] of Object.entries(rawModels)) {
    const parsed = parseModelRef(keyRaw, params.defaultProvider, {
      allowPluginNormalization: params.allowPluginNormalization,
    });
    if (!parsed) {
      continue;
    }
    const alias =
      normalizeOptionalString((entryRaw as { alias?: string } | undefined)?.alias) ?? "";
    if (!alias) {
      continue;
    }
    const aliasKey = normalizeLowercaseStringOrEmpty(alias);
    byAlias.set(aliasKey, { alias, ref: parsed });
    const key = modelKey(parsed.provider, parsed.model);
    const existing = byKey.get(key) ?? [];
    existing.push(alias);
    byKey.set(key, existing);
  }

  return { byAlias, byKey };
}

type ModelCatalogMetadata = {
  configuredByKey: Map<string, ModelCatalogEntry>;
  aliasByKey: Map<string, string>;
};

function buildModelCatalogMetadata(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
}): ModelCatalogMetadata {
  const configuredByKey = new Map<string, ModelCatalogEntry>();
  for (const entry of buildConfiguredModelCatalog({ cfg: params.cfg })) {
    configuredByKey.set(modelKey(entry.provider, entry.id), entry);
  }

  const aliasByKey = new Map<string, string>();
  const configuredModels = params.cfg.agents?.defaults?.models ?? {};
  for (const [rawKey, entryRaw] of Object.entries(configuredModels)) {
    const key = resolveAllowlistModelKey(rawKey, params.defaultProvider);
    if (!key) {
      continue;
    }
    const alias = ((entryRaw as { alias?: string } | undefined)?.alias ?? "").trim();
    if (!alias) {
      continue;
    }
    aliasByKey.set(key, alias);
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
  const nextReasoning = configuredEntry?.reasoning ?? params.entry.reasoning;
  const nextInput = configuredEntry?.input ?? params.entry.input;

  return {
    ...params.entry,
    name: configuredEntry?.name ?? params.entry.name,
    ...(nextAlias ? { alias: nextAlias } : {}),
    ...(nextContextWindow !== undefined ? { contextWindow: nextContextWindow } : {}),
    ...(nextReasoning !== undefined ? { reasoning: nextReasoning } : {}),
    ...(nextInput ? { input: nextInput } : {}),
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
  const nextReasoning = configuredEntry?.reasoning;
  const nextInput = configuredEntry?.input;

  return {
    id: params.parsed.model,
    name: configuredEntry?.name ?? params.parsed.model,
    provider: params.parsed.provider,
    ...(alias ? { alias } : {}),
    ...(nextContextWindow !== undefined ? { contextWindow: nextContextWindow } : {}),
    ...(nextReasoning !== undefined ? { reasoning: nextReasoning } : {}),
    ...(nextInput ? { input: nextInput } : {}),
  };
}

export function resolveModelRefFromString(params: {
  raw: string;
  defaultProvider: string;
  aliasIndex?: ModelAliasIndex;
  allowPluginNormalization?: boolean;
}): { ref: ModelRef; alias?: string } | null {
  const { model } = splitTrailingAuthProfile(params.raw);
  if (!model) {
    return null;
  }
  if (!model.includes("/")) {
    const aliasKey = normalizeLowercaseStringOrEmpty(model);
    const aliasMatch = params.aliasIndex?.byAlias.get(aliasKey);
    if (aliasMatch) {
      return { ref: aliasMatch.ref, alias: aliasMatch.alias };
    }
  }
  const parsed = parseModelRef(model, params.defaultProvider, {
    allowPluginNormalization: params.allowPluginNormalization,
  });
  if (!parsed) {
    return null;
  }
  return { ref: parsed };
}

export function resolveConfiguredModelRef(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
  defaultModel: string;
  allowPluginNormalization?: boolean;
}): ModelRef {
  const rawModel = resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model) ?? "";
  if (rawModel) {
    const trimmed = rawModel.trim();
    const aliasIndex = buildModelAliasIndex({
      cfg: params.cfg,
      defaultProvider: params.defaultProvider,
      allowPluginNormalization: params.allowPluginNormalization,
    });
    if (!trimmed.includes("/")) {
      const aliasKey = normalizeLowercaseStringOrEmpty(trimmed);
      const aliasMatch = aliasIndex.byAlias.get(aliasKey);
      if (aliasMatch) {
        return aliasMatch.ref;
      }

      const inferredProvider = inferUniqueProviderFromConfiguredModels({
        cfg: params.cfg,
        model: trimmed,
      });
      if (inferredProvider) {
        return { provider: inferredProvider, model: trimmed };
      }

      // Default to the configured provider if no provider is specified, but warn as this is deprecated.
      const safeTrimmed = sanitizeModelWarningValue(trimmed);
      const safeResolved = sanitizeForLog(`${params.defaultProvider}/${safeTrimmed}`);
      getLog().warn(
        `Model "${safeTrimmed}" specified without provider. Falling back to "${safeResolved}". Please use "${safeResolved}" in your config.`,
      );
      return { provider: params.defaultProvider, model: trimmed };
    }

    const resolved = resolveModelRefFromString({
      raw: trimmed,
      defaultProvider: params.defaultProvider,
      aliasIndex,
      allowPluginNormalization: params.allowPluginNormalization,
    });
    if (resolved) {
      return resolved.ref;
    }

    // User specified a model but it could not be resolved — warn before falling back.
    const safe = sanitizeForLog(trimmed);
    const safeFallback = sanitizeForLog(`${params.defaultProvider}/${params.defaultModel}`);
    getLog().warn(
      `Model "${safe}" could not be resolved. Falling back to default "${safeFallback}".`,
    );
  }
  // Before falling back to the hardcoded default, check if the default provider
  // is actually available. If it isn't but other providers are configured, prefer
  // the first configured provider's first model to avoid reporting a stale default
  // from a removed provider. (See #38880)
  const fallbackProvider = resolveConfiguredProviderFallback({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
  });
  if (fallbackProvider) {
    return fallbackProvider;
  }
  return { provider: params.defaultProvider, model: params.defaultModel };
}

export function resolveDefaultModelForAgent(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): ModelRef {
  const agentModelOverride = params.agentId
    ? resolveAgentEffectiveModelPrimary(params.cfg, params.agentId)
    : undefined;
  const cfg =
    agentModelOverride && agentModelOverride.length > 0
      ? {
          ...params.cfg,
          agents: {
            ...params.cfg.agents,
            defaults: {
              ...params.cfg.agents?.defaults,
              model: {
                ...toAgentModelListLike(params.cfg.agents?.defaults?.model),
                primary: agentModelOverride,
              },
            },
          },
        }
      : params.cfg;
  return resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
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

export function resolveSubagentConfiguredModelSelection(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): string | undefined {
  const agentConfig = resolveAgentConfig(params.cfg, params.agentId);
  return (
    normalizeModelSelection(agentConfig?.subagents?.model) ??
    normalizeModelSelection(agentConfig?.model) ??
    normalizeModelSelection(params.cfg.agents?.defaults?.subagents?.model)
  );
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
  return (
    normalizeModelSelection(params.modelOverride) ??
    resolveSubagentConfiguredModelSelection({
      cfg: params.cfg,
      agentId: params.agentId,
    }) ??
    normalizeModelSelection(resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model)) ??
    `${runtimeDefault.provider}/${runtimeDefault.model}`
  );
}

export function buildAllowedModelSet(params: {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  defaultProvider: string;
  defaultModel?: string;
  agentId?: string;
}): {
  allowAny: boolean;
  allowedCatalog: ModelCatalogEntry[];
  allowedKeys: Set<string>;
} {
  const metadata = buildModelCatalogMetadata({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
  });
  const catalog = params.catalog.map((entry) => applyModelCatalogMetadata({ entry, metadata }));
  const rawAllowlist = (() => {
    const modelMap = params.cfg.agents?.defaults?.models ?? {};
    return Object.keys(modelMap);
  })();
  const allowAny = rawAllowlist.length === 0;
  const defaultModel = params.defaultModel?.trim();
  const defaultRef =
    defaultModel && params.defaultProvider
      ? parseModelRef(defaultModel, params.defaultProvider)
      : null;
  const defaultKey = defaultRef ? modelKey(defaultRef.provider, defaultRef.model) : undefined;
  const catalogKeys = new Set(catalog.map((entry) => modelKey(entry.provider, entry.id)));

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
  const syntheticCatalogEntries = new Map<string, ModelCatalogEntry>();
  for (const raw of rawAllowlist) {
    const parsed = parseModelRef(raw, params.defaultProvider);
    if (!parsed) {
      continue;
    }
    const key = modelKey(parsed.provider, parsed.model);
    // Explicit allowlist entries are always trusted, even when bundled catalog
    // data is stale and does not include the configured model yet.
    allowedKeys.add(key);

    if (!catalogKeys.has(key) && !syntheticCatalogEntries.has(key)) {
      syntheticCatalogEntries.set(key, buildSyntheticAllowedCatalogEntry({ parsed, metadata }));
    }
  }

  for (const fallback of resolveAllowedFallbacks({
    cfg: params.cfg,
    agentId: params.agentId,
  })) {
    const parsed = parseModelRef(fallback, params.defaultProvider);
    if (parsed) {
      const key = modelKey(parsed.provider, parsed.model);
      allowedKeys.add(key);

      if (!catalogKeys.has(key) && !syntheticCatalogEntries.has(key)) {
        syntheticCatalogEntries.set(key, buildSyntheticAllowedCatalogEntry({ parsed, metadata }));
      }
    }
  }

  if (defaultKey) {
    allowedKeys.add(defaultKey);
  }

  const allowedCatalog = [
    ...catalog.filter((entry) => allowedKeys.has(modelKey(entry.provider, entry.id))),
    ...syntheticCatalogEntries.values(),
  ];

  if (allowedCatalog.length === 0 && allowedKeys.size === 0) {
    if (defaultKey) {
      catalogKeys.add(defaultKey);
    }
    return {
      allowAny: true,
      allowedCatalog: catalog,
      allowedKeys: catalogKeys,
    };
  }

  return { allowAny: false, allowedCatalog, allowedKeys };
}

export function buildConfiguredModelCatalog(params: { cfg: OpenClawConfig }): ModelCatalogEntry[] {
  const providers = params.cfg.models?.providers;
  if (!providers || typeof providers !== "object") {
    return [];
  }

  const catalog: ModelCatalogEntry[] = [];
  for (const [providerRaw, provider] of Object.entries(providers)) {
    const providerId = normalizeProviderId(providerRaw);
    if (!providerId || !Array.isArray(provider?.models)) {
      continue;
    }
    for (const model of provider.models) {
      const id = normalizeOptionalString(model?.id) ?? "";
      if (!id) {
        continue;
      }
      const name = normalizeOptionalString(model?.name) || id;
      const contextWindow =
        typeof model?.contextWindow === "number" && model.contextWindow > 0
          ? model.contextWindow
          : undefined;
      const reasoning = typeof model?.reasoning === "boolean" ? model.reasoning : undefined;
      const input = Array.isArray(model?.input) ? model.input : undefined;
      catalog.push({
        provider: providerId,
        id,
        name,
        contextWindow,
        reasoning,
        input,
      });
    }
  }

  return catalog;
}

export type ModelRefStatus = {
  key: string;
  inCatalog: boolean;
  allowAny: boolean;
  allowed: boolean;
};

export function getModelRefStatus(params: {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  ref: ModelRef;
  defaultProvider: string;
  defaultModel?: string;
}): ModelRefStatus {
  const allowed = buildAllowedModelSet({
    cfg: params.cfg,
    catalog: params.catalog,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
  });
  const key = modelKey(params.ref.provider, params.ref.model);
  return {
    key,
    inCatalog: params.catalog.some((entry) => modelKey(entry.provider, entry.id) === key),
    allowAny: allowed.allowAny,
    allowed: allowed.allowAny || allowed.allowedKeys.has(key),
  };
}

export function resolveAllowedModelRef(params: {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  raw: string;
  defaultProvider: string;
  defaultModel?: string;
}):
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
  });

  // When the model string has no provider prefix ("/"), try to infer the
  // correct provider from the configured allowlist before falling back to the
  // session's current default provider. This prevents provider prefix drift
  // when switching models across different providers (see #48369).
  const effectiveDefaultProvider = !trimmed.includes("/")
    ? (inferUniqueProviderFromConfiguredModels({ cfg: params.cfg, model: trimmed }) ??
      params.defaultProvider)
    : params.defaultProvider;

  const resolved = resolveModelRefFromString({
    raw: trimmed,
    defaultProvider: effectiveDefaultProvider,
    aliasIndex,
  });
  if (!resolved) {
    return { error: `invalid model: ${trimmed}` };
  }

  const status = getModelRefStatus({
    cfg: params.cfg,
    catalog: params.catalog,
    ref: resolved.ref,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
  });
  if (!status.allowed) {
    return { error: `model not allowed: ${status.key}` };
  }

  return { ref: resolved.ref, key: status.key };
}

export function resolveThinkingDefault(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  catalog?: ModelCatalogEntry[];
}): ThinkLevel {
  const normalizedProvider = normalizeProviderId(params.provider);
  const normalizedModel = normalizeLowercaseStringOrEmpty(params.model).replace(/\./g, "-");
  const catalogCandidate = params.catalog?.find(
    (entry) => entry.provider === params.provider && entry.id === params.model,
  );
  const configuredModels = params.cfg.agents?.defaults?.models;
  const canonicalKey = modelKey(params.provider, params.model);
  const legacyKey = legacyModelKey(params.provider, params.model);
  const normalizedCanonicalKey = normalizeLowercaseStringOrEmpty(canonicalKey);
  const normalizedLegacyKey = normalizeOptionalLowercaseString(legacyKey);
  const primarySelection = normalizeModelSelection(params.cfg.agents?.defaults?.model);
  const normalizedPrimarySelection = normalizeOptionalLowercaseString(primarySelection);
  const explicitModelConfigured =
    (configuredModels ? canonicalKey in configuredModels : false) ||
    Boolean(legacyKey && configuredModels && legacyKey in configuredModels) ||
    normalizedPrimarySelection === normalizedCanonicalKey ||
    Boolean(normalizedLegacyKey && normalizedPrimarySelection === normalizedLegacyKey) ||
    normalizedPrimarySelection === normalizeLowercaseStringOrEmpty(params.model);
  const perModelThinking =
    configuredModels?.[canonicalKey]?.params?.thinking ??
    (legacyKey ? configuredModels?.[legacyKey]?.params?.thinking : undefined);
  if (
    perModelThinking === "off" ||
    perModelThinking === "minimal" ||
    perModelThinking === "low" ||
    perModelThinking === "medium" ||
    perModelThinking === "high" ||
    perModelThinking === "xhigh" ||
    perModelThinking === "adaptive"
  ) {
    return perModelThinking;
  }
  const configured = params.cfg.agents?.defaults?.thinkingDefault;
  if (configured) {
    return configured;
  }
  if (
    normalizedProvider === "anthropic" &&
    explicitModelConfigured &&
    typeof catalogCandidate?.name === "string" &&
    /4\.6\b/.test(catalogCandidate.name) &&
    (normalizedModel.startsWith("claude-opus-4-6") ||
      normalizedModel.startsWith("claude-sonnet-4-6"))
  ) {
    return "adaptive";
  }
  return resolveThinkingDefaultForModel({
    provider: params.provider,
    model: params.model,
    catalog: params.catalog,
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

/**
 * Resolve the model configured for Gmail hook processing.
 * Returns null if hooks.gmail.model is not set.
 */
export function resolveHooksGmailModel(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
}): ModelRef | null {
  const hooksModel = params.cfg.hooks?.gmail?.model;
  if (!hooksModel?.trim()) {
    return null;
  }

  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
  });

  const resolved = resolveModelRefFromString({
    raw: hooksModel,
    defaultProvider: params.defaultProvider,
    aliasIndex,
  });

  return resolved?.ref ?? null;
}

/**
 * Normalize a model selection value (string or `{primary?: string}`) to a
 * plain trimmed string.  Returns `undefined` when the input is empty/missing.
 * Shared by sessions-spawn and cron isolated-agent model resolution.
 */
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
