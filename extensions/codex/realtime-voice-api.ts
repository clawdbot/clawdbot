/**
 * Bundled Codex realtime integration shared with the bundled OpenAI provider.
 *
 * This artifact keeps the HTTP offer route and the provider fallback on one
 * process-owned runtime without adding a general Plugin SDK registration API.
 */
import {
  createCodexRealtimeBrowserSessionBroker,
  type CodexRealtimeBrowserSessionFallback,
} from "./src/realtime-browser-session.js";

type CodexRealtimeBrowserSessionRuntime = ReturnType<
  typeof createCodexRealtimeBrowserSessionBroker
>;
type CodexRealtimeBrowserSessionParams = Parameters<
  typeof createCodexRealtimeBrowserSessionBroker
>[0];

type CodexRealtimeGlobalState = {
  version: 1;
  runtime?: CodexRealtimeBrowserSessionRuntime;
  fallback?: CodexRealtimeBrowserSessionFallback;
  sources: Map<symbol, CodexRealtimeBrowserSessionParams>;
};

const CODEX_REALTIME_GLOBAL_STATE = Symbol.for("openclaw.codex.realtime-voice.v1");

function getGlobalState(): CodexRealtimeGlobalState {
  const root = globalThis as typeof globalThis & {
    [CODEX_REALTIME_GLOBAL_STATE]?: CodexRealtimeGlobalState;
  };
  const state = (root[CODEX_REALTIME_GLOBAL_STATE] ??= {
    version: 1,
    sources: new Map(),
  });
  state.sources ??= new Map();
  return state;
}

export function configureCodexRealtimeBrowserSession(
  params: CodexRealtimeBrowserSessionParams,
): CodexRealtimeBrowserSessionRuntime {
  const state = getGlobalState();
  const leaseId = Symbol("codex-realtime-registration");
  state.sources.set(leaseId, params);
  if (state.runtime) {
    return createRuntimeLease(state, state.runtime, leaseId);
  }
  const resolveCurrentSource = (): CodexRealtimeBrowserSessionParams | undefined =>
    Array.from(state.sources.values()).at(-1);
  const created = createCodexRealtimeBrowserSessionBroker({
    getConfig: () => resolveCurrentSource()?.getConfig(),
    getPluginConfig: () => resolveCurrentSource()?.getPluginConfig(),
  });
  state.runtime = created;
  state.fallback = created.broker;
  return createRuntimeLease(state, created, leaseId);
}

export function getCodexRealtimeBrowserSessionFallback():
  | CodexRealtimeBrowserSessionFallback
  | undefined {
  return getGlobalState().fallback;
}

function createRuntimeLease(
  state: CodexRealtimeGlobalState,
  runtime: CodexRealtimeBrowserSessionRuntime,
  leaseId: symbol,
): CodexRealtimeBrowserSessionRuntime {
  let released = false;
  return {
    ...runtime,
    cleanup: async () => {
      if (released) {
        return;
      }
      released = true;
      state.sources.delete(leaseId);
      if (state.runtime !== runtime || state.sources.size > 0) {
        return;
      }
      state.runtime = undefined;
      state.fallback = undefined;
      await runtime.cleanup();
    },
  };
}

export { CODEX_REALTIME_OFFER_PATH } from "./src/realtime-browser-session.js";
