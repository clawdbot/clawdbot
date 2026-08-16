import { getRuntimeConfig } from "../config/config.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";
import type {
  PlacementSessionEvidence,
  PlacementSessionEvidenceResolver,
} from "./worker-environments/placement-session-retirement.js";

const loadPlacementSessionEvidenceRuntime = createLazyRuntimeModule(async () => {
  const [sessionTargets, sessionAccessor] = await Promise.all([
    import("../config/sessions/targets.js"),
    import("../config/sessions/session-accessor.js"),
  ]);
  return {
    readSessionIdentityEvidenceBatch: sessionAccessor.readSessionIdentityEvidenceBatch,
    resolveExistingAgentSessionStoreTargetsSync:
      sessionTargets.resolveExistingAgentSessionStoreTargetsSync,
  };
});

export async function createWorkerPlacementSessionEvidenceResolver(
  placements: readonly WorkerSessionPlacementRecord[],
): Promise<PlacementSessionEvidenceResolver> {
  try {
    const cfg = getRuntimeConfig();
    const runtime = await loadPlacementSessionEvidenceRuntime();
    const targetsByAgentId = new Map(
      [...new Set(placements.map((placement) => normalizeAgentId(placement.agentId)))].map(
        (agentId) =>
          [agentId, runtime.resolveExistingAgentSessionStoreTargetsSync(cfg, agentId)] as const,
      ),
    );
    const prepared = placements.flatMap((placement) =>
      (targetsByAgentId.get(normalizeAgentId(placement.agentId)) ?? []).map((target) => ({
        placement,
        target,
      })),
    );
    const evidence = runtime.readSessionIdentityEvidenceBatch(
      prepared.map(({ placement, target }) => ({
        agentId: target.agentId,
        sessionId: placement.sessionId,
        sessionKey: placement.sessionKey,
        storePath: target.storePath,
      })),
    );
    const evidenceByPlacement = new Map<WorkerSessionPlacementRecord, PlacementSessionEvidence>(
      placements.map((placement) => [placement, "absent"]),
    );
    for (const [index, result] of evidence.entries()) {
      const placement = prepared[index]?.placement;
      if (!placement) {
        continue;
      }
      const current = evidenceByPlacement.get(placement) ?? "absent";
      if (current !== "current" && result.status !== "absent") {
        evidenceByPlacement.set(placement, result.status);
      }
    }
    return async (placement) => evidenceByPlacement.get(placement) ?? "unknown";
  } catch {
    return async () => "unknown";
  }
}
