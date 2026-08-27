import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import type {
  WorkerSessionPlacementRetirement,
  WorkerSessionPlacementStore,
} from "./placement-store.js";
import type {
  WorkerEnvironmentServiceContract,
  WorkerPlacementDispatchContract,
} from "./service-contract.js";

export type SessionWorkerPlacementContext = {
  workerEnvironmentService?: Pick<WorkerEnvironmentServiceContract, "get">;
  workerPlacementDispatchService?: Pick<WorkerPlacementDispatchContract, "reclaim">;
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
type FailedPlacement = Extract<Placement, { state: "failed" }>;

export function isFailedWorkerPlacementEnvironmentGone(params: {
  environmentService: SessionWorkerPlacementContext["workerEnvironmentService"];
  placement: FailedPlacement;
}): boolean {
  if (params.placement.environmentId === null) {
    return true;
  }
  // Provisioning persists deterministic allocation intent first; only the configured service
  // can prove that the corresponding durable environment row was never created or is gone.
  if (!params.environmentService) {
    return false;
  }
  try {
    const environment = params.environmentService.get(params.placement.environmentId);
    return (
      environment === undefined ||
      environment.state === "destroyed" ||
      (environment.state === "failed" && environment.leaseId === null)
    );
  } catch {
    return false;
  }
}

function isWorkerPlacementSafeForMutation(
  context: SessionWorkerPlacementContext,
  placement: Placement,
): placement is RetirablePlacement {
  if (placement.state === "failed") {
    return isFailedWorkerPlacementEnvironmentGone({
      environmentService: context.workerEnvironmentService,
      placement,
    });
  }
  return placement.state === "local" || placement.state === "reclaimed";
}

export function resolveWorkerPlacementArchiveRestoreError(params: {
  context: SessionWorkerPlacementContext;
  key: string;
  placement: WorkerSessionPlacementRecord | undefined;
}): string | undefined {
  if (!params.placement || isWorkerPlacementSafeForMutation(params.context, params.placement)) {
    return undefined;
  }
  return `Session ${params.key} cannot change archive state while cloud worker placement is ${params.placement.state}.`;
}

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

  if (isWorkerPlacementSafeForMutation(params.context, placement)) {
    if (params.action === "delete" || params.action === "reset") {
      return retirementGuard(placement);
    }
    // History rewrites rotate the session identity and would strand stopped cloud affinity.
    if (placement.state === "local" || params.action === "fork") {
      return { status: "allowed" };
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

export async function prepareSessionWorkerPlacementForArchive(params: {
  agentId: string;
  authorize?: () => void;
  context: SessionWorkerPlacementContext;
  reclaimActive: boolean;
  sessionId?: string;
  sessionKey: string;
}): Promise<void> {
  const { agentId, context, sessionId, sessionKey } = params;
  if (!sessionId) {
    return;
  }
  const request = { agentId, sessionId, sessionKey };
  const placement = context.workerSessionPlacementService?.getMany([sessionId]).get(sessionId);
  if (!placement) {
    return;
  }
  const matches = (candidate: Placement) =>
    candidate.sessionId === sessionId &&
    candidate.sessionKey === sessionKey &&
    candidate.agentId === agentId;
  if (!matches(placement)) {
    throw new Error(`Session ${sessionKey} cloud worker placement identity changed.`);
  }
  if (isWorkerPlacementSafeForMutation(context, placement)) {
    return;
  }
  if (placement.state !== "active") {
    throw new Error(`Session ${sessionKey} cannot archive from placement ${placement.state}.`);
  }
  if (!params.reclaimActive) {
    return;
  }
  if (!context.workerPlacementDispatchService?.reclaim) {
    throw new Error(`Session ${sessionKey} cloud worker reclaim is unavailable.`);
  }
  const reclaimed: Placement = params.authorize
    ? await context.workerPlacementDispatchService.reclaim(request, params.authorize)
    : await context.workerPlacementDispatchService.reclaim(request);
  const settled = context.workerSessionPlacementService?.getMany([sessionId]).get(sessionId);
  if (
    reclaimed.state !== "reclaimed" ||
    !matches(reclaimed) ||
    settled?.state !== "reclaimed" ||
    !matches(settled) ||
    settled.generation !== reclaimed.generation
  ) {
    throw new Error(`Session ${sessionKey} cloud worker reclaim identity changed.`);
  }
}
