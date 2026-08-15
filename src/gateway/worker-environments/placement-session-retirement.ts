import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import {
  WorkerSessionPlacementRetirementBlockedError,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import type { WorkerEnvironmentService } from "./service.js";
import { isFailedWorkerPlacementEnvironmentGone } from "./session-placement-lifecycle.js";

export type PlacementSessionEvidence = "current" | "absent" | "unknown";
export type PlacementSessionEvidenceResolver = (
  placement: WorkerSessionPlacementRecord,
) => Promise<PlacementSessionEvidence>;

type PlacementSessionRetirementDeps = {
  placements: Pick<WorkerSessionPlacementStore, "get" | "list" | "retireSessionPlacement">;
  environments: Pick<WorkerEnvironmentService, "get">;
  forceDestroyEnvironment: (
    environmentId: string,
    onCleanupError?: (error: unknown) => void,
  ) => Promise<unknown>;
  createSessionEvidenceResolver: (
    placements: readonly WorkerSessionPlacementRecord[],
  ) => Promise<PlacementSessionEvidenceResolver>;
  warn: (message: string) => void;
};

export function createPlacementSessionRetirement(deps: PlacementSessionRetirementDeps) {
  const reportRetirementError = (sessionId: string, error: unknown): void => {
    if (error instanceof WorkerSessionPlacementRetirementBlockedError) {
      deps.warn(`Worker placement session retirement deferred for ${sessionId}: ${error.message}`);
    }
  };

  const retireCurrent = (placement: WorkerSessionPlacementRecord): boolean => {
    if (placement.turnClaim) {
      return false;
    }
    if (
      placement.environmentId !== null &&
      placement.state !== "reclaimed" &&
      (placement.state !== "failed" ||
        !isFailedWorkerPlacementEnvironmentGone({
          environmentService: deps.environments,
          placement,
        }))
    ) {
      return false;
    }
    // Dispatch binds environment intent before entering provisioning.
    if (placement.state === "provisioning") {
      return false;
    }
    deps.placements.retireSessionPlacement({
      sessionId: placement.sessionId,
      expectedState: placement.state,
      expectedGeneration: placement.generation,
    });
    if (placement.state === "requested") {
      deps.warn(
        `Retired ownerless worker placement ${placement.sessionId} because its authoritative session is absent (${placement.state}@${placement.generation})`,
      );
    }
    return true;
  };

  const reconcilePlacement = async (
    placement: WorkerSessionPlacementRecord,
    resolveSessionEvidence: PlacementSessionEvidenceResolver,
  ): Promise<void> => {
    const evidence = await resolveSessionEvidence(placement);
    if (evidence !== "absent") {
      return;
    }

    let current = deps.placements.get(placement.sessionId);
    if (!current) {
      return;
    }
    try {
      if (retireCurrent(current)) {
        return;
      }
    } catch (error) {
      reportRetirementError(current.sessionId, error);
      return;
    }

    const environmentId = current.environmentId;
    if (!environmentId) {
      return;
    }
    try {
      await deps.forceDestroyEnvironment(environmentId, (error) => {
        deps.warn(
          `Worker placement orphan cleanup deferred for ${current?.sessionId ?? placement.sessionId}: ${String(error)}`,
        );
      });
    } catch (error) {
      deps.warn(
        `Worker placement orphan teardown failed for ${current.sessionId}: ${String(error)}`,
      );
      return;
    }

    current = deps.placements.get(placement.sessionId);
    if (!current) {
      return;
    }
    try {
      retireCurrent(current);
    } catch (error) {
      // A concurrent placement transition owns the next reconciliation pass.
      reportRetirementError(current.sessionId, error);
    }
  };

  const reconcile = async (): Promise<void> => {
    const placements = deps.placements.list();
    const resolveSessionEvidence = await deps.createSessionEvidenceResolver(placements);
    for (const placement of placements) {
      try {
        await reconcilePlacement(placement, resolveSessionEvidence);
      } catch (error) {
        deps.warn(
          `Worker placement session evidence check failed for ${placement.sessionId}: ${String(error)}`,
        );
      }
    }
  };

  return { reconcile };
}
