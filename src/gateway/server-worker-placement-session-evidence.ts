import { getRuntimeConfig } from "../config/config.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";

const loadPlacementSessionEvidenceRuntime = createLazyRuntimeModule(async () => {
  const [sessionUtils, sessionAccessor] = await Promise.all([
    import("./session-utils.js"),
    import("../config/sessions/session-accessor.js"),
  ]);
  return {
    readSessionIdentityEvidence: sessionAccessor.readSessionIdentityEvidence,
    resolveGatewaySessionStoreTarget: sessionUtils.resolveGatewaySessionStoreTarget,
  };
});

/** Resolves authoritative session existence without treating unreadable state as absence. */
export async function resolveWorkerPlacementSessionEvidence(
  placement: WorkerSessionPlacementRecord,
): Promise<"current" | "absent" | "unknown"> {
  const runtime = await loadPlacementSessionEvidenceRuntime();
  const target = runtime.resolveGatewaySessionStoreTarget({
    cfg: getRuntimeConfig(),
    key: placement.sessionKey,
    agentId: placement.agentId,
  });
  const evidence = runtime.readSessionIdentityEvidence({
    agentId: target.agentId,
    sessionId: placement.sessionId,
    sessionKey: target.canonicalKey,
    storePath: target.storePath,
  });
  return evidence.status;
}
