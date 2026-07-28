/**
 * Process-global context-window runtime state.
 * Keeps discovery loads, config backoff, and token cache reset behavior
 * shared across module reloads and runtime seams.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createLazyImportLoader, type LazyPromiseLoader } from "../shared/lazy-promise.js";
import {
  MODEL_CONFIGURED_CONTEXT_TOKEN_CACHE,
  MODEL_CONTEXT_TOKEN_CACHE,
  MODEL_CONTEXT_WINDOW_CACHE,
} from "./context-cache.js";

const CONTEXT_WINDOW_RUNTIME_STATE_KEY = Symbol.for("openclaw.contextWindowRuntimeState");

type ContextWindowRuntimeState = {
  generation: number;
  loadPromise: Promise<void> | null;
  loadGeneration: number | null;
  configuredConfig: OpenClawConfig | undefined;
  configLoadFailures: number;
  nextConfigLoadAttemptAtMs: number;
  // Released gateways may still import this stable runtime path after an
  // in-place dist rebuild. Keep the loader until that upgrade path retires.
  modelsConfigRuntimeLoader: LazyPromiseLoader<typeof import("./models-config.runtime.js")>;
};

/** Shared mutable state for context-window resolution and model discovery. */
export const CONTEXT_WINDOW_RUNTIME_STATE = (() => {
  const globalState = globalThis as typeof globalThis & {
    [CONTEXT_WINDOW_RUNTIME_STATE_KEY]?: ContextWindowRuntimeState;
  };
  let state = globalState[CONTEXT_WINDOW_RUNTIME_STATE_KEY] as
    | Partial<ContextWindowRuntimeState>
    | undefined;
  if (!state) {
    // Discovery is lifecycle-owned here; callers reuse the same pending load
    // promise and backoff counters instead of racing config discovery.
    state = {
      generation: 0,
      loadPromise: null,
      loadGeneration: null,
      configuredConfig: undefined,
      configLoadFailures: 0,
      nextConfigLoadAttemptAtMs: 0,
      modelsConfigRuntimeLoader: createLazyImportLoader(() => import("./models-config.runtime.js")),
    };
    globalState[CONTEXT_WINDOW_RUNTIME_STATE_KEY] = state as ContextWindowRuntimeState;
  } else {
    // Normalize the exact state shape held by released gateways before this
    // module added generation tracking; otherwise refresh increments NaN.
    if (typeof state.generation !== "number") {
      state.generation = 0;
    }
    if (state.loadGeneration === undefined) {
      // A legacy promise populated the previous module's cache maps. Force the
      // newly loaded module to warm its own maps once after an in-place rebuild.
      state.loadGeneration = null;
    }
    state.modelsConfigRuntimeLoader ??= createLazyImportLoader(
      () => import("./models-config.runtime.js"),
    );
  }
  return state as ContextWindowRuntimeState;
})();

/** Invalidate prepared context metadata while a replacement load is staged. */
export function beginContextWindowCacheRefresh(): void {
  CONTEXT_WINDOW_RUNTIME_STATE.generation += 1;
  CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig = undefined;
  CONTEXT_WINDOW_RUNTIME_STATE.configLoadFailures = 0;
  CONTEXT_WINDOW_RUNTIME_STATE.nextConfigLoadAttemptAtMs = 0;
}

/** Reset prepared context-window state after model config or plugin metadata changes. */
function resetContextWindowCache(): void {
  beginContextWindowCacheRefresh();
  CONTEXT_WINDOW_RUNTIME_STATE.modelsConfigRuntimeLoader.clear();
  MODEL_CONFIGURED_CONTEXT_TOKEN_CACHE.clear();
  MODEL_CONTEXT_TOKEN_CACHE.clear();
  MODEL_CONTEXT_WINDOW_CACHE.clear();
}

/** Reset context-window runtime state and token cache for isolated tests. */
export function resetContextWindowCacheForTest(): void {
  resetContextWindowCache();
}
