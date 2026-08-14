import { getRuntimeConfig } from "../config/config.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";

const loadPlacementSessionEvidenceRuntime = createLazyRuntimeModule(async () => {
  const [sessionUtils, sessionAccessor] = await Promise.all([
    import("./session-utils.js"),
    import("../config/sessions/session-accessor.transcript.js"),
  ]);
  return {
    resolveCanonicalSessionEntryFromStoreKeys:
      sessionUtils.resolveCanonicalSessionEntryFromStoreKeys,
    resolveGatewaySessionStoreTargetWithStore:
      sessionUtils.resolveGatewaySessionStoreTargetWithStore,
    resolveSessionKeyBySessionId: sessionAccessor.resolveTranscriptSessionKeyBySessionId,
  };
});

/** Resolves authoritative session existence without treating transient store errors as absence. */
export async function resolveWorkerPlacementSessionEvidence(
  placement: WorkerSessionPlacementRecord,
): Promise<"current" | "absent" | "unknown"> {
  try {
    const runtime = await loadPlacementSessionEvidenceRuntime();
    const target = runtime.resolveGatewaySessionStoreTargetWithStore({
      cfg: getRuntimeConfig(),
      key: placement.sessionKey,
      agentId: placement.agentId,
      clone: false,
    });
    const exactEntry = runtime.resolveCanonicalSessionEntryFromStoreKeys(
      target.store,
      target.storeKeys,
    );
    if (exactEntry?.sessionId === placement.sessionId) {
      return "current";
    }
    const currentKey = runtime.resolveSessionKeyBySessionId({
      agentId: target.agentId,
      sessionId: placement.sessionId,
      storePath: target.storePath,
    });
    const currentEntry = currentKey
      ? runtime.resolveCanonicalSessionEntryFromStoreKeys(target.store, [currentKey])
      : undefined;
    return currentEntry?.sessionId === placement.sessionId ? "current" : "absent";
  } catch {
    // Session stores can be temporarily unreadable during migration or lock contention.
    // Unknown evidence must never tear down a potentially live remote session.
    return "unknown";
  }
}
