import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createLazyImportLoader, type LazyPromiseLoader } from "../shared/lazy-promise.js";
import { MODEL_CONTEXT_TOKEN_CACHE } from "./context-cache.js";

const CONTEXT_WINDOW_RUNTIME_STATE_KEY = Symbol.for("openclaw.contextWindowRuntimeState");

type ContextWindowRuntimeState = {
  loadPromise: Promise<void> | null;
  configuredConfig: OpenClawConfig | undefined;
  configLoadFailures: number;
  nextConfigLoadAttemptAtMs: number;
  modelsConfigRuntimeLoader: LazyPromiseLoader<typeof import("./models-config.runtime.js")>;
};

export const CONTEXT_WINDOW_RUNTIME_STATE = (() => {
  const globalState = globalThis as typeof globalThis & {
    [CONTEXT_WINDOW_RUNTIME_STATE_KEY]?: ContextWindowRuntimeState;
  };
  if (!globalState[CONTEXT_WINDOW_RUNTIME_STATE_KEY]) {
    globalState[CONTEXT_WINDOW_RUNTIME_STATE_KEY] = {
      loadPromise: null,
      configuredConfig: undefined,
      configLoadFailures: 0,
      nextConfigLoadAttemptAtMs: 0,
      modelsConfigRuntimeLoader: createLazyImportLoader(() => import("./models-config.runtime.js")),
    };
  }
  return globalState[CONTEXT_WINDOW_RUNTIME_STATE_KEY];
})();

export function resetContextWindowCacheForTest(): void {
  CONTEXT_WINDOW_RUNTIME_STATE.loadPromise = null;
  CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig = undefined;
  CONTEXT_WINDOW_RUNTIME_STATE.configLoadFailures = 0;
  CONTEXT_WINDOW_RUNTIME_STATE.nextConfigLoadAttemptAtMs = 0;
  CONTEXT_WINDOW_RUNTIME_STATE.modelsConfigRuntimeLoader.clear();
  MODEL_CONTEXT_TOKEN_CACHE.clear();
}
