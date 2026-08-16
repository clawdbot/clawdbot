import { getRuntimeConfig } from "../config/config.js";
import type { SessionStoreTargetsReadCache } from "../config/sessions/targets-read-availability.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";
import type {
  PlacementSessionEvidence,
  PlacementSessionEvidenceResolver,
} from "./worker-environments/placement-session-retirement.js";

const loadPlacementSessionEvidenceRuntime = createLazyRuntimeModule(async () => {
  const [sessionTargetsReadAvailability, sessionAccessor] = await Promise.all([
    import("../config/sessions/targets-read-availability.js"),
    import("../config/sessions/session-accessor.js"),
  ]);
  return {
    readSessionIdentityEvidenceBatch: sessionAccessor.readSessionIdentityEvidenceBatch,
    resolveExistingAgentSessionStoreTargetsReadOnlyResult:
      sessionTargetsReadAvailability.resolveExistingAgentSessionStoreTargetsReadOnlyResult,
  };
});

export async function createWorkerPlacementSessionEvidenceResolver(
  placements: readonly WorkerSessionPlacementRecord[],
): Promise<PlacementSessionEvidenceResolver> {
  try {
    const cfg = getRuntimeConfig();
    const runtime = await loadPlacementSessionEvidenceRuntime();
    const targetsReadCache: SessionStoreTargetsReadCache = new Map();
    const targetResultsByAgentId = new Map(
      [...new Set(placements.map((placement) => normalizeAgentId(placement.agentId)))].map(
        (agentId) =>
          [
            agentId,
            runtime.resolveExistingAgentSessionStoreTargetsReadOnlyResult(cfg, agentId, {
              cache: targetsReadCache,
            }),
          ] as const,
      ),
    );
    const prepared = placements.flatMap((placement) => {
      const targetResult = targetResultsByAgentId.get(normalizeAgentId(placement.agentId));
      return targetResult?.available
        ? targetResult.targets.map((target) => ({
            placement,
            target,
          }))
        : [];
    });
    const evidence = prepared.length
      ? runtime.readSessionIdentityEvidenceBatch(
          prepared.map(({ placement, target }) => ({
            agentId: target.agentId,
            sessionId: placement.sessionId,
            sessionKey: placement.sessionKey,
            storePath: target.storePath,
          })),
        )
      : [];
    const evidenceByPlacement = new Map<WorkerSessionPlacementRecord, PlacementSessionEvidence>(
      placements.map((placement) => {
        const targetResult = targetResultsByAgentId.get(normalizeAgentId(placement.agentId));
        const initialEvidence =
          targetResult?.available || targetResult?.reason === "database-missing"
            ? "absent"
            : "unknown";
        return [placement, initialEvidence];
      }),
    );
    for (const [index, result] of evidence.entries()) {
      const placement = prepared[index]?.placement;
      if (!placement) {
        continue;
      }
      const current = evidenceByPlacement.get(placement) ?? "unknown";
      if (current !== "current" && result.status !== "absent") {
        evidenceByPlacement.set(placement, result.status);
      }
    }
    return async (placement) => evidenceByPlacement.get(placement) ?? "unknown";
  } catch {
    return async () => "unknown";
  }
}
