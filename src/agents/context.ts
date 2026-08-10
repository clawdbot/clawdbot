// Load session runtime model metadata so we can infer context windows when the
// agent reports a model id. This includes custom models.json entries.

import { getRuntimeConfig } from "../config/config.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { computeBackoff, type BackoffPolicy } from "../infra/backoff.js";
import { resolveAgentDir, resolveDefaultAgentId } from "./agent-scope.js";
import {
  applyConfiguredContextWindows,
  type ContextWindowCatalog,
  prepareContextWindowCaches,
  prepareDiscoveredContextTokenCache,
} from "./context-cache-projection.js";
import {
  getContextWindowCaches,
  lookupCachedContextTokens,
  lookupCachedContextWindow,
  minPositiveContextTokens,
  replaceContextWindowCaches,
  replaceDiscoveredContextTokenCache,
} from "./context-cache.js";
import {
  type ContextTokenResolutionParams,
  type ModelsConfig,
  resolveContextTokensForModelFromCache,
} from "./context-resolution.js";
import {
  beginContextWindowCacheRefresh,
  CONTEXT_WINDOW_RUNTIME_STATE,
} from "./context-runtime-state.js";

export {
  ANTHROPIC_CONTEXT_1M_TOKENS,
  ANTHROPIC_FABLE_CONTEXT_TOKENS,
  ANTHROPIC_MYTHOS_5_CONTEXT_TOKENS,
  ANTHROPIC_OPUS_5_CONTEXT_TOKENS,
  ANTHROPIC_SONNET_5_CONTEXT_TOKENS,
  ANTHROPIC_VERTEX_CONTEXT_1M_TOKENS,
} from "./context-resolution.js";
export { resetContextWindowCacheForTest } from "./context-runtime-state.js";
export {
  applyConfiguredContextWindows,
  applyDiscoveredContextWindows,
} from "./context-cache-projection.js";
type ContextWindowCatalogOwner = {
  config: OpenClawConfig;
  modelCatalog: ContextWindowCatalog;
};
const CONFIG_LOAD_RETRY_POLICY: BackoffPolicy = {
  initialMs: 1_000,
  maxMs: 60_000,
  factor: 2,
  jitter: 0,
};
const loadPreparedModelCatalogRuntime = () => import("./prepared-model-catalog.js");

class ContextWindowCachePrewarmCancelledError extends Error {}

function primeConfiguredContextWindowsFromConfig(cfg: OpenClawConfig): OpenClawConfig {
  const caches = getContextWindowCaches();
  applyConfiguredContextWindows({
    cache: caches.configuredTokenCache,
    windowCache: caches.contextWindowCache,
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

function ensureContextWindowCacheLoadedFromOwner(params: {
  cfgOverride?: OpenClawConfig;
  catalogOwner?: ContextWindowCatalogOwner;
}): Promise<void> {
  const generation = CONTEXT_WINDOW_RUNTIME_STATE.generation;
  if (
    CONTEXT_WINDOW_RUNTIME_STATE.loadPromise &&
    CONTEXT_WINDOW_RUNTIME_STATE.loadGeneration === generation
  ) {
    return CONTEXT_WINDOW_RUNTIME_STATE.loadPromise;
  }

  const cfg = params.catalogOwner
    ? primeConfiguredContextWindowsFromConfig(params.catalogOwner.config)
    : params.cfgOverride
      ? primeConfiguredContextWindowsFromConfig(params.cfgOverride)
      : primeConfiguredContextWindows();
  if (!cfg) {
    return Promise.resolve();
  }
  CONTEXT_WINDOW_RUNTIME_STATE.loadPromise = Promise.resolve()
    .then(async () => {
      if (CONTEXT_WINDOW_RUNTIME_STATE.generation !== generation) {
        return;
      }
      let stagedTokenCache = new Map<string, number>();
      try {
        const catalogResult = params.catalogOwner
          ? ({ status: "fulfilled" as const, value: params.catalogOwner } as const)
          : await (async () => {
              const { loadPreparedModelCatalogOwnerSnapshot } =
                await loadPreparedModelCatalogRuntime();
              const defaultAgentId = resolveDefaultAgentId(cfg);
              return await loadPreparedModelCatalogOwnerSnapshot({
                config: cfg,
                agentId: defaultAgentId,
                agentDir: resolveAgentDir(cfg, defaultAgentId),
                readOnly: true,
              }).then(
                (value) => ({ status: "fulfilled" as const, value }),
                (reason: unknown) => ({ status: "rejected" as const, reason }),
              );
            })();
        if (CONTEXT_WINDOW_RUNTIME_STATE.generation !== generation) {
          return;
        }
        if (catalogResult.status === "fulfilled") {
          stagedTokenCache = await prepareDiscoveredContextTokenCache({
            modelCatalog: catalogResult.value.modelCatalog,
            assertCurrent: () => {
              if (CONTEXT_WINDOW_RUNTIME_STATE.generation !== generation) {
                throw new Error("context window cache generation was superseded");
              }
            },
          });
        }
      } catch {
        // Static and discovered rows belong to one atomic generation. If its owner fails, keep
        // config overrides only instead of mixing in independently rediscovered static metadata.
      }
      if (CONTEXT_WINDOW_RUNTIME_STATE.generation === generation) {
        replaceDiscoveredContextTokenCache(stagedTokenCache);
      }
    })
    .catch(() => {
      // Keep lookup best-effort.
    });
  CONTEXT_WINDOW_RUNTIME_STATE.loadGeneration = generation;
  return CONTEXT_WINDOW_RUNTIME_STATE.loadPromise;
}

export function ensureContextWindowCacheLoaded(cfgOverride?: OpenClawConfig): Promise<void> {
  return ensureContextWindowCacheLoadedFromOwner({ cfgOverride });
}

/**
 * Reuse the Gateway's published catalog generation. Omitting the Gateway binding
 * falls through to a read-only owner whose key hashes the full model config.
 */
export async function prewarmContextWindowCacheAfterReady(params: {
  config: OpenClawConfig;
  isCancelled?: () => boolean;
}): Promise<void> {
  // Post-ready warmup owns a published-owner generation. Do not reuse a request-time
  // load that may have completed before Gateway catalog publication.
  beginContextWindowCacheRefresh();
  const generation = CONTEXT_WINDOW_RUNTIME_STATE.generation;
  const shouldStop = () =>
    CONTEXT_WINDOW_RUNTIME_STATE.generation !== generation || params.isCancelled?.() === true;
  if (shouldStop()) {
    return;
  }
  let published = false;
  const loadPromise = (async () => {
    const { getPublishedPreparedModelCatalogOwnerSnapshot } =
      await loadPreparedModelCatalogRuntime();
    if (shouldStop()) {
      return;
    }
    const defaultAgentId = resolveDefaultAgentId(params.config);
    const owner = getPublishedPreparedModelCatalogOwnerSnapshot({
      config: params.config,
      agentId: defaultAgentId,
      agentDir: resolveAgentDir(params.config, defaultAgentId),
      allowGatewaySubagentBinding: true,
    });
    if (!owner) {
      throw new Error("published Gateway model catalog owner is unavailable");
    }
    if (shouldStop()) {
      return;
    }
    // Gateway publication intentionally exposes configured/static turn facts. Full catalog
    // inventory is a separate control-plane load and must not run in post-ready warmup.
    const caches = await prepareContextWindowCaches({
      config: owner.config,
      modelCatalog: owner.modelCatalog,
      assertCurrent: () => {
        if (shouldStop()) {
          throw new ContextWindowCachePrewarmCancelledError();
        }
      },
    });
    if (shouldStop()) {
      return;
    }
    replaceContextWindowCaches(caches);
    CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig = owner.config;
    CONTEXT_WINDOW_RUNTIME_STATE.configLoadFailures = 0;
    CONTEXT_WINDOW_RUNTIME_STATE.nextConfigLoadAttemptAtMs = 0;
    published = true;
  })();
  const trackedLoadPromise = loadPromise.catch(() => {});
  CONTEXT_WINDOW_RUNTIME_STATE.loadPromise = trackedLoadPromise;
  CONTEXT_WINDOW_RUNTIME_STATE.loadGeneration = generation;
  try {
    await loadPromise;
  } catch {
    // Optional Gateway warmup is best-effort; request-time loading remains exact.
  } finally {
    if (
      !published &&
      CONTEXT_WINDOW_RUNTIME_STATE.generation === generation &&
      CONTEXT_WINDOW_RUNTIME_STATE.loadPromise === trackedLoadPromise
    ) {
      CONTEXT_WINDOW_RUNTIME_STATE.loadPromise = null;
      CONTEXT_WINDOW_RUNTIME_STATE.loadGeneration = null;
    }
  }
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
  const caches = getContextWindowCaches();
  caches.configuredTokenCache.clear();
  caches.contextWindowCache.clear();
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
