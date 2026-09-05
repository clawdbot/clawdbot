import { getRuntimeConfig } from "../config/config.js";
import type { SessionStoreTargetsReadCache } from "../config/sessions/targets-read-availability.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { resolveSessionStoreAgentId, resolveSessionStoreKey } from "./session-store-key.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";
import type {
  PlacementSessionEvidence,
  PlacementSessionEvidenceResolver,
} from "./worker-environments/placement-session-retirement.js";

const log = createSubsystemLogger("gateway/placement-session-evidence");

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

type PlacementSessionIdentity = {
  placement: WorkerSessionPlacementRecord;
  agentId: string;
  sessionKey: string;
};

function resolvePlacementSessionIdentities(
  cfg: OpenClawConfig,
  placement: WorkerSessionPlacementRecord,
): PlacementSessionIdentity[] {
  const requestedAgentId = normalizeAgentId(placement.agentId);
  const parsedKey = parseAgentSessionKey(placement.sessionKey);
  const canonicalKey = resolveSessionStoreKey({
    cfg,
    sessionKey: placement.sessionKey,
    storeAgentId: requestedAgentId,
  });
  const canonicalAgentId =
    canonicalKey === "global" || canonicalKey === "unknown" || !parsedKey
      ? requestedAgentId
      : resolveSessionStoreAgentId(cfg, canonicalKey);
  const canonical = { placement, agentId: canonicalAgentId, sessionKey: canonicalKey };
  if (!parsedKey) {
    return [canonical];
  }
  const persistedAgentId = normalizeAgentId(parsedKey.agentId);
  if (persistedAgentId === canonicalAgentId) {
    return [canonical];
  }
  // A deleted legacy owner can still hold the exact persisted placement row.
  // Probe it alongside the canonical owner and preserve current > unknown > absent.
  return [canonical, { placement, agentId: persistedAgentId, sessionKey: placement.sessionKey }];
}

export async function createWorkerPlacementSessionEvidenceResolver(
  placements: readonly WorkerSessionPlacementRecord[],
): Promise<PlacementSessionEvidenceResolver> {
  try {
    const cfg = getRuntimeConfig();
    const runtime = await loadPlacementSessionEvidenceRuntime();
    const identities = placements.flatMap((placement) =>
      resolvePlacementSessionIdentities(cfg, placement),
    );
    const targetsReadCache: SessionStoreTargetsReadCache = new Map();
    const targetResultsByAgentId = new Map(
      [
        ...new Set(
          identities
            .filter((identity) => !isIncognitoSessionKey(identity.sessionKey))
            .map((identity) => identity.agentId),
        ),
      ].map(
        (agentId) =>
          [
            agentId,
            runtime.resolveExistingAgentSessionStoreTargetsReadOnlyResult(cfg, agentId, {
              cache: targetsReadCache,
            }),
          ] as const,
      ),
    );
    const prepared = identities.flatMap((identity) => {
      if (isIncognitoSessionKey(identity.sessionKey)) {
        return [
          {
            identity,
            target: {
              agentId: identity.agentId,
              storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: identity.agentId }),
            },
          },
        ];
      }
      const targetResult = targetResultsByAgentId.get(identity.agentId);
      return targetResult?.available
        ? targetResult.targets.map((target) => ({ identity, target }))
        : [];
    });
    const evidence = prepared.length
      ? runtime.readSessionIdentityEvidenceBatch(
          prepared.map(({ identity, target }) => ({
            agentId: target.agentId,
            sessionId: identity.placement.sessionId,
            sessionKey: identity.sessionKey,
            storePath: target.storePath,
          })),
        )
      : [];
    const evidenceByPlacement = new Map<WorkerSessionPlacementRecord, PlacementSessionEvidence>(
      placements.map((placement) => [placement, "absent"]),
    );
    for (const identity of identities) {
      if (isIncognitoSessionKey(identity.sessionKey)) {
        continue;
      }
      const targetResult = targetResultsByAgentId.get(identity.agentId);
      if (!targetResult?.available && targetResult?.reason !== "database-missing") {
        evidenceByPlacement.set(identity.placement, "unknown");
      }
    }
    for (const [index, result] of evidence.entries()) {
      const placement = prepared[index]?.identity.placement;
      if (!placement) {
        continue;
      }
      const current = evidenceByPlacement.get(placement) ?? "unknown";
      if (current !== "current" && result.status !== "absent") {
        evidenceByPlacement.set(placement, result.status);
      }
    }
    return async (placement) => evidenceByPlacement.get(placement) ?? "unknown";
  } catch (error) {
    // "unknown" keeps retirement fail-open, but a silent catch would hide a broken
    // evidence pipeline (bad config, store corruption) behind indefinite retention.
    log.warn("worker placement session evidence resolution failed; treating all as unknown", {
      error,
    });
    return async () => "unknown";
  }
}
