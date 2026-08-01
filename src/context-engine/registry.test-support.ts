import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  clearPersistedContextEngineQuarantineForProcess,
  recordPersistedContextEngineQuarantine,
} from "./quarantine-health.js";

type ContextEngineRuntimeQuarantineForTests = {
  engineId: string;
  owner?: string;
  operation: string;
  reason: string;
  failedAt: Date;
};

type ContextEngineRegistryStateForTests = {
  engines: Map<string, unknown>;
  quarantinedEngines: Map<string, ContextEngineRuntimeQuarantineForTests>;
};

const CONTEXT_ENGINE_REGISTRY_STATE = Symbol.for("openclaw.contextEngineRegistryState");

function getContextEngineRegistryStateForTests(): ContextEngineRegistryStateForTests {
  return resolveGlobalSingleton<ContextEngineRegistryStateForTests>(
    CONTEXT_ENGINE_REGISTRY_STATE,
    () => ({ engines: new Map(), quarantinedEngines: new Map() }),
  );
}

export function captureContextEngineRegistryStateForTests(): () => void {
  const state = getContextEngineRegistryStateForTests();
  const engines = new Map(state.engines);
  const quarantinedEngines = new Map(state.quarantinedEngines);

  return () => {
    state.engines.clear();
    for (const [engineId, registration] of engines) {
      state.engines.set(engineId, registration);
    }

    state.quarantinedEngines.clear();
    clearPersistedContextEngineQuarantineForProcess(undefined, process.pid);
    for (const [engineId, quarantine] of quarantinedEngines) {
      state.quarantinedEngines.set(engineId, quarantine);
      recordPersistedContextEngineQuarantine(quarantine);
    }
  };
}

export function resetContextEngineRuntimeQuarantineForTests(): void {
  const state = getContextEngineRegistryStateForTests();
  state.quarantinedEngines.clear();
  clearPersistedContextEngineQuarantineForProcess(undefined, process.pid);
}
