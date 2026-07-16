import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { clearPersistedContextEngineQuarantineForProcess } from "./quarantine-health.js";

type ContextEngineRegistryStateForTests = {
  engines: Map<string, unknown>;
  quarantinedEngines: Map<string, unknown>;
};

const CONTEXT_ENGINE_REGISTRY_STATE = Symbol.for("openclaw.contextEngineRegistryState");

export function resetContextEngineRuntimeQuarantineForTests(): void {
  const state = resolveGlobalSingleton<ContextEngineRegistryStateForTests>(
    CONTEXT_ENGINE_REGISTRY_STATE,
    () => ({ engines: new Map(), quarantinedEngines: new Map() }),
  );
  state.quarantinedEngines.clear();
  clearPersistedContextEngineQuarantineForProcess(undefined, process.pid);
}
