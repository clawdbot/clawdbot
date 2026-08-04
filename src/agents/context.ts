// Load session runtime model metadata so we can infer context windows when the
// agent reports a model id. This includes custom models.json entries.

import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/config.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { computeBackoff, type BackoffPolicy } from "../infra/backoff.js";
import { resolveAgentDir, resolveDefaultAgentId } from "./agent-scope.js";
import {
  lookupCachedContextTokens,
  lookupCachedContextWindow,
  minPositiveContextTokens,
  MODEL_CONFIGURED_CONTEXT_TOKEN_CACHE,
  MODEL_CONTEXT_WINDOW_CACHE,
  providerContextTokenCacheKey,
  replaceContextWindowCaches,
  replaceDiscoveredContextTokenCache,
} from "./context-cache.js";
import {
  type ContextTokenResolutionParams,
  type ModelsConfig,
  resolveAnthropicFixedContextWindow,
  resolveContextTokensForModelFromCache,
} from "./context-resolution.js";
import {
  beginContextWindowCacheRefresh,
  CONTEXT_WINDOW_RUNTIME_STATE,
} from "./context-runtime-state.js";
import { normalizeProviderId } from "./model-selection.js";

export {
  ANTHROPIC_CONTEXT_1M_TOKENS,
  ANTHROPIC_FABLE_CONTEXT_TOKENS,
  ANTHROPIC_MYTHOS_5_CONTEXT_TOKENS,
  ANTHROPIC_OPUS_5_CONTEXT_TOKENS,
  ANTHROPIC_SONNET_5_CONTEXT_TOKENS,
  ANTHROPIC_VERTEX_CONTEXT_1M_TOKENS,
} from "./context-resolution.js";
export { resetContextWindowCacheForTest } from "./context-runtime-state.js";

type ModelEntry = {
  id: string;
  provider?: string;
  contextWindow?: number;
  contextTokens?: number;
};
type ConfiguredProviderEntry = NonNullable<NonNullable<ModelsConfig["providers"]>[string]>;
type ConfiguredModelEntry = NonNullable<ConfiguredProviderEntry["models"]>[number];
const CONFIG_LOAD_RETRY_POLICY: BackoffPolicy = {
  initialMs: 1_000,
  maxMs: 60_000,
  factor: 2,
  jitter: 0,
};
const CONTEXT_CACHE_PREWARM_BATCH_SIZE = 512;
const loadPreparedModelCatalogRuntime = () => import("./prepared-model-catalog.js");

function cacheMinimum(cache: Map<string, number>, key: string, contextTokens: number): void {
  const existing = cache.get(key);
  if (existing === undefined || contextTokens < existing) {
    cache.set(key, contextTokens);
  }
}

function applyDiscoveredContextWindow(cache: Map<string, number>, model: ModelEntry): void {
  if (!model?.id) {
    return;
  }
  const discoveredContextTokens =
    typeof model.contextTokens === "number"
      ? Math.trunc(model.contextTokens)
      : typeof model.contextWindow === "number"
        ? Math.trunc(model.contextWindow)
        : undefined;
  const contextTokens =
    resolveDiscoveredAnthropicFixedContextWindow(model) ?? discoveredContextTokens;
  if (!contextTokens || contextTokens <= 0) {
    return;
  }
  // Cache the most conservative effective limit. Provider/runtime callers that
  // know the active provider prefer the provider-owned entry below.
  cacheMinimum(cache, model.id, contextTokens);
  if (typeof model.provider !== "string") {
    return;
  }
  const provider = normalizeProviderId(model.provider);
  if (!provider) {
    return;
  }
  cacheMinimum(cache, providerContextTokenCacheKey(provider, model.id), contextTokens);
  const slash = model.id.indexOf("/");
  const prefixedProvider = slash > 0 ? normalizeProviderId(model.id.slice(0, slash)) : "";
  const bareModelId = slash > 0 ? model.id.slice(slash + 1).trim() : "";
  // Some registries preserve a self-prefixed id alongside provider ownership.
  // Cache its bare form without stripping cross-provider ids such as OpenRouter rows.
  if (prefixedProvider === provider && bareModelId) {
    cacheMinimum(cache, providerContextTokenCacheKey(provider, bareModelId), contextTokens);
  }
}

export function applyDiscoveredContextWindows(params: {
  cache: Map<string, number>;
  models: ModelEntry[];
}) {
  for (const model of params.models) {
    applyDiscoveredContextWindow(params.cache, model);
  }
}

function applyConfiguredContextWindow(params: {
  cache: Map<string, number>;
  windowCache: Map<string, number>;
  providerId: string;
  provider: ConfiguredProviderEntry;
  model: ConfiguredModelEntry;
}): void {
  const modelId = typeof params.model?.id === "string" ? params.model.id : undefined;
  const contextTokens =
    typeof params.model?.contextTokens === "number"
      ? params.model.contextTokens
      : typeof params.provider?.contextTokens === "number"
        ? params.provider.contextTokens
        : undefined;
  const contextWindow =
    typeof params.model?.contextWindow === "number"
      ? params.model.contextWindow
      : typeof params.provider?.contextWindow === "number"
        ? params.provider.contextWindow
        : undefined;
  const configuredValue =
    contextTokens && contextTokens > 0
      ? { cache: params.cache, value: contextTokens }
      : contextWindow && contextWindow > 0
        ? { cache: params.windowCache, value: contextWindow }
        : undefined;
  if (!modelId || !configuredValue) {
    return;
  }
  configuredValue.cache.set(modelId, configuredValue.value);
  configuredValue.cache.set(
    providerContextTokenCacheKey(normalizeProviderId(params.providerId), modelId),
    configuredValue.value,
  );
  const normalizedProvider = normalizeProviderId(params.providerId);
  const slash = modelId.indexOf("/");
  const prefixedProvider = slash > 0 ? normalizeProviderId(modelId.slice(0, slash)) : "";
  const bareModelId = slash > 0 ? modelId.slice(slash + 1).trim() : "";
  if (normalizedProvider && prefixedProvider === normalizedProvider && bareModelId) {
    configuredValue.cache.set(
      providerContextTokenCacheKey(normalizedProvider, bareModelId),
      configuredValue.value,
    );
  }
}

export function applyConfiguredContextWindows(params: {
  cache: Map<string, number>;
  windowCache: Map<string, number>;
  modelsConfig: ModelsConfig | undefined;
}) {
  const providers = params.modelsConfig?.providers;
  if (!providers || typeof providers !== "object") {
    return;
  }
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!Array.isArray(provider?.models)) {
      continue;
    }
    for (const model of provider.models) {
      applyConfiguredContextWindow({
        cache: params.cache,
        windowCache: params.windowCache,
        providerId,
        provider,
        model,
      });
    }
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function applyConfiguredContextWindowsCooperatively(params: {
  cache: Map<string, number>;
  windowCache: Map<string, number>;
  modelsConfig: ModelsConfig | undefined;
  shouldStop: () => boolean;
}): Promise<boolean> {
  const providers = params.modelsConfig?.providers;
  if (!providers || typeof providers !== "object") {
    return !params.shouldStop();
  }
  let processed = 0;
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!Array.isArray(provider?.models)) {
      continue;
    }
    for (const model of provider.models) {
      if (params.shouldStop()) {
        return false;
      }
      if (processed > 0 && processed % CONTEXT_CACHE_PREWARM_BATCH_SIZE === 0) {
        await yieldToEventLoop();
        if (params.shouldStop()) {
          return false;
        }
      }
      applyConfiguredContextWindow({
        cache: params.cache,
        windowCache: params.windowCache,
        providerId,
        provider,
        model,
      });
      processed += 1;
    }
  }
  return !params.shouldStop();
}

async function applyDiscoveredContextWindowsCooperatively(params: {
  cache: Map<string, number>;
  modelGroups: readonly (readonly ModelEntry[])[];
  shouldStop: () => boolean;
}): Promise<boolean> {
  let processed = 0;
  for (const models of params.modelGroups) {
    for (const model of models) {
      if (params.shouldStop()) {
        return false;
      }
      if (processed > 0 && processed % CONTEXT_CACHE_PREWARM_BATCH_SIZE === 0) {
        await yieldToEventLoop();
        if (params.shouldStop()) {
          return false;
        }
      }
      applyDiscoveredContextWindow(params.cache, model);
      processed += 1;
    }
  }
  return !params.shouldStop();
}

/**
 * Warm the process cache from the Gateway's currently published catalog owner
 * without letting optional post-ready projection monopolize the main loop.
 */
export function prewarmContextWindowCacheAfterReady(params: {
  config: OpenClawConfig;
  isCancelled?: () => boolean;
}): Promise<void> {
  const generation = CONTEXT_WINDOW_RUNTIME_STATE.generation;
  if (
    CONTEXT_WINDOW_RUNTIME_STATE.loadPromise &&
    CONTEXT_WINDOW_RUNTIME_STATE.loadGeneration === generation
  ) {
    return CONTEXT_WINDOW_RUNTIME_STATE.loadPromise;
  }

  const shouldStop = () =>
    CONTEXT_WINDOW_RUNTIME_STATE.generation !== generation || params.isCancelled?.() === true;
  const loadPromise = Promise.resolve()
    .then(async () => {
      if (shouldStop()) {
        return;
      }
      let owner:
        | Awaited<
            ReturnType<
              typeof import("./prepared-model-catalog.js").loadPublishedPreparedModelCatalogOwnerSnapshot
            >
          >
        | undefined;
      try {
        const { loadPublishedPreparedModelCatalogOwnerSnapshot } =
          await loadPreparedModelCatalogRuntime();
        const defaultAgentId = resolveDefaultAgentId(params.config);
        owner = await loadPublishedPreparedModelCatalogOwnerSnapshot({
          config: params.config,
          agentId: defaultAgentId,
          agentDir: resolveAgentDir(params.config, defaultAgentId),
          readOnly: true,
        });
      } catch {
        // Config-backed overrides still converge when the prepared owner is unavailable.
      }
      if (shouldStop()) {
        return;
      }

      const sourceConfig = owner?.config ?? params.config;
      const stagedConfiguredTokenCache = new Map<string, number>();
      const stagedContextWindowCache = new Map<string, number>();
      const stagedDiscoveredTokenCache = new Map<string, number>();
      if (
        !(await applyConfiguredContextWindowsCooperatively({
          cache: stagedConfiguredTokenCache,
          windowCache: stagedContextWindowCache,
          modelsConfig: sourceConfig.models as ModelsConfig | undefined,
          shouldStop,
        }))
      ) {
        return;
      }
      if (
        !(await applyDiscoveredContextWindowsCooperatively({
          cache: stagedDiscoveredTokenCache,
          modelGroups: [owner?.modelCatalog.entries ?? [], owner?.modelCatalog.staticEntries ?? []],
          shouldStop,
        }))
      ) {
        return;
      }
      if (shouldStop()) {
        return;
      }

      // Publish one complete generation so yielded preparation never exposes a
      // mix of old and new configured, static, or discovered metadata.
      replaceContextWindowCaches({
        configuredTokenCache: stagedConfiguredTokenCache,
        contextWindowCache: stagedContextWindowCache,
        discoveredTokenCache: stagedDiscoveredTokenCache,
      });
      CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig = sourceConfig;
      CONTEXT_WINDOW_RUNTIME_STATE.configLoadFailures = 0;
      CONTEXT_WINDOW_RUNTIME_STATE.nextConfigLoadAttemptAtMs = 0;
    })
    .catch(() => {
      // Keep optional Gateway warmup best-effort.
    });
  CONTEXT_WINDOW_RUNTIME_STATE.loadPromise = loadPromise;
  CONTEXT_WINDOW_RUNTIME_STATE.loadGeneration = generation;
  return loadPromise;
}

function primeConfiguredContextWindowsFromConfig(cfg: OpenClawConfig): OpenClawConfig {
  applyConfiguredContextWindows({
    cache: MODEL_CONFIGURED_CONTEXT_TOKEN_CACHE,
    windowCache: MODEL_CONTEXT_WINDOW_CACHE,
    modelsConfig: cfg.models as ModelsConfig | undefined,
  });
  CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig = cfg;
  CONTEXT_WINDOW_RUNTIME_STATE.configLoadFailures = 0;
  CONTEXT_WINDOW_RUNTIME_STATE.nextConfigLoadAttemptAtMs = 0;
  return cfg;
}

function primeConfiguredContextWindows(): OpenClawConfig | undefined {
  if (CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig) {
    return primeConfiguredContextWindowsFromConfig(CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig);
  }
  if (Date.now() < CONTEXT_WINDOW_RUNTIME_STATE.nextConfigLoadAttemptAtMs) {
    return undefined;
  }
  try {
    return primeConfiguredContextWindowsFromConfig(getRuntimeConfig());
  } catch {
    CONTEXT_WINDOW_RUNTIME_STATE.configLoadFailures += 1;
    const backoffMs = computeBackoff(
      CONFIG_LOAD_RETRY_POLICY,
      CONTEXT_WINDOW_RUNTIME_STATE.configLoadFailures,
    );
    CONTEXT_WINDOW_RUNTIME_STATE.nextConfigLoadAttemptAtMs = Date.now() + backoffMs;
    // If config can't be loaded, leave cache empty and retry after backoff.
    return undefined;
  }
}

export function ensureContextWindowCacheLoaded(cfgOverride?: OpenClawConfig): Promise<void> {
  const generation = CONTEXT_WINDOW_RUNTIME_STATE.generation;
  if (
    CONTEXT_WINDOW_RUNTIME_STATE.loadPromise &&
    CONTEXT_WINDOW_RUNTIME_STATE.loadGeneration === generation
  ) {
    return CONTEXT_WINDOW_RUNTIME_STATE.loadPromise;
  }

  const cfg = cfgOverride
    ? primeConfiguredContextWindowsFromConfig(cfgOverride)
    : primeConfiguredContextWindows();
  if (!cfg) {
    return Promise.resolve();
  }
  const stagedTokenCache = new Map<string, number>();

  CONTEXT_WINDOW_RUNTIME_STATE.loadPromise = Promise.resolve()
    .then(async () => {
      if (CONTEXT_WINDOW_RUNTIME_STATE.generation !== generation) {
        return;
      }
      try {
        const { loadPreparedModelCatalogOwnerSnapshot } = await loadPreparedModelCatalogRuntime();
        const defaultAgentId = resolveDefaultAgentId(cfg);
        const catalogResult = await loadPreparedModelCatalogOwnerSnapshot({
          config: cfg,
          agentId: defaultAgentId,
          agentDir: resolveAgentDir(cfg, defaultAgentId),
          readOnly: true,
        }).then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        );
        if (CONTEXT_WINDOW_RUNTIME_STATE.generation !== generation) {
          return;
        }
        const modelCatalog =
          catalogResult.status === "fulfilled" ? catalogResult.value.modelCatalog : undefined;
        if (
          !(await applyDiscoveredContextWindowsCooperatively({
            cache: stagedTokenCache,
            modelGroups: [modelCatalog?.entries ?? [], modelCatalog?.staticEntries ?? []],
            shouldStop: () => CONTEXT_WINDOW_RUNTIME_STATE.generation !== generation,
          }))
        ) {
          return;
        }
      } catch {
        // Static and discovered rows belong to one atomic generation. If its owner fails, keep
        // config overrides only instead of mixing in independently rediscovered static metadata.
      }

      if (CONTEXT_WINDOW_RUNTIME_STATE.generation !== generation) {
        return;
      }
      replaceDiscoveredContextTokenCache(stagedTokenCache);
    })
    .catch(() => {
      // Keep lookup best-effort.
    });
  CONTEXT_WINDOW_RUNTIME_STATE.loadGeneration = generation;
  return CONTEXT_WINDOW_RUNTIME_STATE.loadPromise;
}

export async function waitForContextWindowCacheLoad(options?: {
  timeoutMs?: number;
}): Promise<"idle" | "loaded" | "timeout"> {
  const promise = CONTEXT_WINDOW_RUNTIME_STATE.loadPromise;
  if (
    !promise ||
    CONTEXT_WINDOW_RUNTIME_STATE.loadGeneration !== CONTEXT_WINDOW_RUNTIME_STATE.generation
  ) {
    return "idle";
  }

  const timeoutMs = Math.max(0, Math.trunc(options?.timeoutMs ?? 250));
  if (timeoutMs === 0) {
    return "timeout";
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.then(() => "loaded" as const),
      new Promise<"timeout">((resolve) => {
        timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
        (timeoutHandle as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

/** Replace cached model context metadata for the active runtime configuration. */
export async function refreshContextWindowCache(cfg: OpenClawConfig): Promise<void> {
  beginContextWindowCacheRefresh();
  MODEL_CONFIGURED_CONTEXT_TOKEN_CACHE.clear();
  MODEL_CONTEXT_WINDOW_CACHE.clear();
  primeConfiguredContextWindowsFromConfig(cfg);
  await ensureContextWindowCacheLoaded();
}

function prepareContextWindowCache(options?: {
  allowAsyncLoad?: boolean;
  skipRuntimeConfigLoad?: boolean;
}) {
  if (options?.skipRuntimeConfigLoad) {
    return;
  }
  if (options?.allowAsyncLoad === false) {
    // Read-only callers still need synchronous config-backed overrides, but they
    // should not start background model discovery.
    primeConfiguredContextWindows();
  } else {
    // Best-effort: kick off loading on demand, but don't block lookups.
    void ensureContextWindowCacheLoaded();
  }
}

export function lookupContextTokens(
  modelId?: string,
  options?: { allowAsyncLoad?: boolean; skipRuntimeConfigLoad?: boolean },
): number | undefined {
  if (!modelId) {
    return undefined;
  }
  prepareContextWindowCache(options);
  return minPositiveContextTokens(
    lookupCachedContextTokens(modelId),
    lookupCachedContextWindow(modelId),
  );
}

function resolveDiscoveredAnthropicFixedContextWindow(model: ModelEntry): number | undefined {
  const provider =
    typeof model.provider === "string" ? normalizeProviderId(model.provider) : undefined;
  const modelId = model.id;
  if (provider) {
    return resolveAnthropicFixedContextWindow(provider, modelId);
  }
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  const slash = normalized.indexOf("/");
  if (slash < 0) {
    return undefined;
  }
  const inferredProvider = normalizeProviderId(normalized.slice(0, slash));
  const inferredModel = normalized.slice(slash + 1);
  return inferredProvider === "claude-cli"
    ? resolveAnthropicFixedContextWindow(inferredProvider, inferredModel)
    : undefined;
}

export function resolveContextTokensForModel(
  params: ContextTokenResolutionParams,
): number | undefined {
  const lookupOptions = {
    allowAsyncLoad: params.allowAsyncLoad,
    skipRuntimeConfigLoad: Boolean(params.cfg),
  };
  prepareContextWindowCache(lookupOptions);
  const sourceCfg =
    params.sourceCfg !== undefined
      ? params.sourceCfg
      : params.cfg
        ? projectConfigOntoRuntimeSourceSnapshot(params.cfg)
        : undefined;
  return resolveContextTokensForModelFromCache(
    { ...params, sourceCfg },
    (modelId) => lookupCachedContextTokens(modelId),
    (modelId) => lookupCachedContextWindow(modelId),
  );
}
