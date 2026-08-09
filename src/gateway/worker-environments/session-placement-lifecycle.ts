import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import type {
  WorkerSessionPlacementRetirement,
  WorkerSessionPlacementStore,
} from "./placement-store.js";
import type { WorkerEnvironmentServiceContract } from "./service-contract.js";

export type SessionWorkerPlacementContext = {
  workerEnvironmentService?: Pick<WorkerEnvironmentServiceContract, "get">;
  workerSessionPlacementService?: Pick<WorkerSessionPlacementStore, "getMany"> &
    Partial<Pick<WorkerSessionPlacementStore, "retireSessionPlacement">>;
};

type PlacementMutationAction = "delete" | "fork" | "reset" | "restore" | "rewind" | "switch";
type Placement = WorkerSessionPlacementRecord;
type PlacementState = Placement["state"];

export class SessionWorkerPlacementMutationError extends Error {
  constructor(state: PlacementState, action: PlacementMutationAction, key: string) {
    super(`Session ${key} cannot ${action} while cloud worker placement is ${state}.`);
  }
}

type SessionWorkerPlacementMutationGuard =
  | { status: "allowed" }
  | { status: "blocked"; error: SessionWorkerPlacementMutationError }
  | ({ status: "retirement-required" } & WorkerSessionPlacementRetirement);

type SessionWorkerPlacementMutationParams = {
  action: PlacementMutationAction;
  context: SessionWorkerPlacementContext;
  key: string;
  sessionId: string | undefined;
};

type RetirablePlacement = Extract<Placement, { state: "local" | "reclaimed" | "failed" }>;

function retirementGuard(placement: RetirablePlacement): SessionWorkerPlacementMutationGuard {
  return {
    status: "retirement-required",
    sessionId: placement.sessionId,
    expectedState: placement.state,
    expectedGeneration: placement.generation,
  };
}

function resolveSessionWorkerPlacementMutationGuard(
  params: SessionWorkerPlacementMutationParams,
): SessionWorkerPlacementMutationGuard {
  const placement = params.sessionId
    ? params.context.workerSessionPlacementService
        ?.getMany([params.sessionId])
        .get(params.sessionId)
    : undefined;
  if (!placement) {
    return { status: "allowed" };
  }

  if (placement.state === "local") {
    return params.action === "delete" || params.action === "reset"
      ? retirementGuard(placement)
      : { status: "allowed" };
  }
  if (params.action === "delete" && placement.state === "reclaimed") {
    return retirementGuard(placement);
  }
  if (params.action === "delete" && placement.state === "failed") {
    const environment = placement.environmentId
      ? params.context.workerEnvironmentService?.get(placement.environmentId)
      : undefined;
    // Failed environments retain their lease until teardown is proven, so they stay fenced.
    const failedPlacementCanDelete =
      placement.environmentId === null ||
      environment?.state === "destroyed" ||
      (environment?.state === "failed" && environment.leaseId === null);
    if (failedPlacementCanDelete) {
      return retirementGuard(placement);
    }
  }
  return {
    status: "blocked",
    error: new SessionWorkerPlacementMutationError(placement.state, params.action, params.key),
  };
}

export function retireSessionWorkerPlacementBeforeMutation(
  params: SessionWorkerPlacementMutationParams,
): SessionWorkerPlacementMutationError | undefined {
  const guard = resolveSessionWorkerPlacementMutationGuard(params);
  if (guard.status !== "retirement-required") {
    return guard.status === "blocked" ? guard.error : undefined;
  }
  const retirementService = params.context.workerSessionPlacementService;
  if (!retirementService?.retireSessionPlacement) {
    throw new Error("Worker session placement retirement service is unavailable");
  }
  retirementService.retireSessionPlacement(guard);
  return undefined;
}

export function resolveSessionWorkerPlacementMutationError(
  params: SessionWorkerPlacementMutationParams,
): SessionWorkerPlacementMutationError | undefined {
  const guard = resolveSessionWorkerPlacementMutationGuard(params);
  return guard.status === "blocked" ? guard.error : undefined;
}
