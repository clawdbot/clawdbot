// Process-global runtime quarantine state for context engines: when a resolved
// custom engine fails a guarded operation it is recorded here and skipped for the
// rest of the process, with a best-effort persisted mirror for diagnostics.
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  clearPersistedContextEngineQuarantineForProcess,
  listPersistedContextEngineQuarantines,
  recordPersistedContextEngineQuarantine,
} from "./quarantine-health.js";

const CONTEXT_ENGINE_REGISTRY_STATE = Symbol.for("openclaw.contextEngineRegistryState");

export type ContextEngineRuntimeQuarantine = {
  engineId: string;
  owner?: string;
  operation: string;
  reason: string;
  failedAt: Date;
};

type ContextEngineRegistryState = {
  quarantinedEngines: Map<string, ContextEngineRuntimeQuarantine>;
};

// Keep context-engine registrations process-global so duplicated dist chunks
// still share one registry map at runtime.
const contextEngineRegistryState = resolveGlobalSingleton<ContextEngineRegistryState>(
  CONTEXT_ENGINE_REGISTRY_STATE,
  () => ({
    quarantinedEngines: new Map(),
  }),
);

export function recordContextEngineQuarantine(params: {
  engineId: string;
  owner?: string;
  operation: string;
  error: unknown;
  defaultEngineId: string;
}): ContextEngineRuntimeQuarantine {
  const existing = contextEngineRegistryState.quarantinedEngines.get(params.engineId);
  if (existing) {
    // First failure wins so logs and diagnostics point at the root cause, not follow-on fallback use.
    return existing;
  }

  const quarantine: ContextEngineRuntimeQuarantine = {
    engineId: params.engineId,
    operation: params.operation,
    reason: params.error instanceof Error ? params.error.message : String(params.error),
    failedAt: new Date(),
    ...(params.owner ? { owner: params.owner } : {}),
  };
  contextEngineRegistryState.quarantinedEngines.set(params.engineId, quarantine);
  try {
    recordPersistedContextEngineQuarantine(quarantine);
  } catch {
    // Quarantine behavior must not depend on the best-effort health mirror.
  }
  const ownerSuffix = params.owner ? ` owner=${sanitizeForLog(params.owner)}` : "";
  console.error(
    `[context-engine] Context engine "${sanitizeForLog(params.engineId)}"${ownerSuffix} failed during ${sanitizeForLog(params.operation)}: ` +
      `${sanitizeForLog(quarantine.reason)}; quarantining it for this process and falling back to default engine "${params.defaultEngineId}".`,
  );
  return quarantine;
}

export function getContextEngineQuarantine(
  engineId: string,
): ContextEngineRuntimeQuarantine | undefined {
  return contextEngineRegistryState.quarantinedEngines.get(engineId);
}

export function listContextEngineQuarantines(): ContextEngineRuntimeQuarantine[] {
  const quarantines = Array.from(
    contextEngineRegistryState.quarantinedEngines.values(),
    ({ failedAt, ...quarantine }) => ({ ...quarantine, failedAt: new Date(failedAt) }),
  );
  const seenEngineIds = new Set(quarantines.map((entry) => entry.engineId));
  return quarantines.concat(
    listPersistedContextEngineQuarantines().filter(({ engineId }) => !seenEngineIds.has(engineId)),
  );
}

export function clearContextEngineRuntimeQuarantine(engineId: string): void {
  contextEngineRegistryState.quarantinedEngines.delete(engineId);
  clearPersistedContextEngineQuarantineForProcess(engineId, process.pid);
}
