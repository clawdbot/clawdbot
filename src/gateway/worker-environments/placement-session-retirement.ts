import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerEnvironmentService } from "./service.js";
import { isFailedWorkerPlacementEnvironmentGone } from "./session-placement-lifecycle.js";

type PlacementSessionEvidence = "current" | "absent" | "unknown";

type PlacementSessionRetirementDeps = {
  placements: Pick<WorkerSessionPlacementStore, "get" | "list" | "retireSessionPlacement">;
  environments: Pick<WorkerEnvironmentService, "get">;
  forceDestroyEnvironment: (
    environmentId: string,
    onCleanupError?: (error: unknown) => void,
  ) => Promise<unknown>;
  resolveSessionEvidence: (
    placement: WorkerSessionPlacementRecord,
  ) => Promise<PlacementSessionEvidence>;
  warn: (message: string) => void;
};

export function createPlacementSessionRetirement(deps: PlacementSessionRetirementDeps) {
  const retireCurrent = (placement: WorkerSessionPlacementRecord): boolean => {
    if (placement.turnClaim) {
      return false;
    }
    const retirement =
      placement.state === "local" || placement.state === "reclaimed"
        ? {
            sessionId: placement.sessionId,
            expectedState: placement.state,
            expectedGeneration: placement.generation,
          }
        : placement.state === "failed" &&
            isFailedWorkerPlacementEnvironmentGone({
              environmentService: deps.environments,
              placement,
            })
          ? {
              sessionId: placement.sessionId,
              expectedState: placement.state,
              expectedGeneration: placement.generation,
            }
          : undefined;
    if (!retirement) {
      return false;
    }
    deps.placements.retireSessionPlacement(retirement);
    return true;
  };

  const reconcilePlacement = async (placement: WorkerSessionPlacementRecord): Promise<void> => {
    const evidence = await deps.resolveSessionEvidence(placement);
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
    } catch {
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
    } catch {
      // A concurrent placement transition owns the next reconciliation pass.
    }
  };

  const reconcile = async (): Promise<void> => {
    for (const placement of deps.placements.list()) {
      try {
        await reconcilePlacement(placement);
      } catch (error) {
        deps.warn(
          `Worker placement session evidence check failed for ${placement.sessionId}: ${String(error)}`,
        );
      }
    }
  };

  return { reconcile };
}
