import type { OpenClawConfig } from "../config/types.openclaw.js";
import { MODEL_CONTEXT_TOKEN_CACHE } from "./context-cache.js";

const CONTEXT_WINDOW_RUNTIME_STATE_KEY = Symbol.for("openclaw.contextWindowRuntimeState");

type ContextWindowRuntimeState = {
  loadPromise: Promise<void> | null;
  configuredConfig: OpenClawConfig | undefined;
  configLoadFailures: number;
  nextConfigLoadAttemptAtMs: number;
  modelsConfigRuntimePromise: Promise<typeof import("./models-config.runtime.js")> | undefined;
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
      modelsConfigRuntimePromise: undefined,
    };
  }
  return globalState[CONTEXT_WINDOW_RUNTIME_STATE_KEY];
})();

export function resetContextWindowCacheForTest(): void {
  CONTEXT_WINDOW_RUNTIME_STATE.loadPromise = null;
  CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig = undefined;
  CONTEXT_WINDOW_RUNTIME_STATE.configLoadFailures = 0;
  CONTEXT_WINDOW_RUNTIME_STATE.nextConfigLoadAttemptAtMs = 0;
  CONTEXT_WINDOW_RUNTIME_STATE.modelsConfigRuntimePromise = undefined;
  MODEL_CONTEXT_TOKEN_CACHE.clear();
}
