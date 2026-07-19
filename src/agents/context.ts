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
  MODEL_CONTEXT_TOKEN_CACHE,
  MODEL_CONTEXT_WINDOW_CACHE,
  providerContextTokenCacheKey,
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
const CONFIG_LOAD_RETRY_POLICY: BackoffPolicy = {
  initialMs: 1_000,
  maxMs: 60_000,
  factor: 2,
  jitter: 0,
};
const loadPreparedModelCatalogRuntime = () => import("./prepared-model-catalog.js");

export function applyDiscoveredContextWindows(params: {
  cache: Map<string, number>;
  models: ModelEntry[];
}) {
  const cacheMinimum = (key: string, contextTokens: number) => {
    const existing = params.cache.get(key);
    if (existing === undefined || contextTokens < existing) {
      params.cache.set(key, contextTokens);
    }
  };

  for (const model of params.models) {
    if (!model?.id) {
      continue;
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
      continue;
    }
    // Cache the most conservative effective limit. Provider/runtime callers that
    // know the active provider prefer the provider-owned entry below.
    cacheMinimum(model.id, contextTokens);
    if (typeof model.provider === "string") {
      const provider = normalizeProviderId(model.provider);
      if (provider) {
        cacheMinimum(providerContextTokenCacheKey(provider, model.id), contextTokens);
        const slash = model.id.indexOf("/");
        const prefixedProvider = slash > 0 ? normalizeProviderId(model.id.slice(0, slash)) : "";
        const bareModelId = slash > 0 ? model.id.slice(slash + 1).trim() : "";
        // Some registries preserve a self-prefixed id alongside provider ownership.
        // Cache its bare form without stripping cross-provider ids such as OpenRouter rows.
        if (prefixedProvider === provider && bareModelId) {
          cacheMinimum(providerContextTokenCacheKey(provider, bareModelId), contextTokens);
        }
      }
    }
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
      const modelId = typeof model?.id === "string" ? model.id : undefined;
      const contextTokens =
        typeof model?.contextTokens === "number"
          ? model.contextTokens
          : typeof provider?.contextTokens === "number"
            ? provider.contextTokens
            : undefined;
      const contextWindow =
        typeof model?.contextWindow === "number"
          ? model.contextWindow
          : typeof provider?.contextWindow === "number"
            ? provider.contextWindow
            : undefined;
      const configuredValue =
        contextTokens && contextTokens > 0
          ? { cache: params.cache, value: contextTokens }
          : contextWindow && contextWindow > 0
            ? { cache: params.windowCache, value: contextWindow }
            : undefined;
      if (!modelId || !configuredValue) {
        continue;
      }
      configuredValue.cache.set(modelId, configuredValue.value);
      configuredValue.cache.set(
        providerContextTokenCacheKey(normalizeProviderId(providerId), modelId),
        configuredValue.value,
      );
      const normalizedProvider = normalizeProviderId(providerId);
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
  }
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
        const models =
          catalogResult.status === "fulfilled" ? catalogResult.value.modelCatalog.entries : [];
        const providerStaticModels =
          catalogResult.status === "fulfilled"
            ? (catalogResult.value.modelCatalog.staticEntries ?? [])
            : [];
        applyDiscoveredContextWindows({
          cache: stagedTokenCache,
          models: [...models, ...providerStaticModels],
        });
      } catch {
        // Static and discovered rows belong to one atomic generation. If its owner fails, keep
        // config overrides only instead of mixing in independently rediscovered static metadata.
      }

      if (CONTEXT_WINDOW_RUNTIME_STATE.generation !== generation) {
        return;
      }
      MODEL_CONTEXT_TOKEN_CACHE.clear();
      for (const [key, value] of stagedTokenCache) {
        MODEL_CONTEXT_TOKEN_CACHE.set(key, value);
      }
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
