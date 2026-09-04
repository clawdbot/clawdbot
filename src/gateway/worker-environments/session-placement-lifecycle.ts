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
    Partial<Pick<WorkerSessionPlacementStore, "retireSessionPlacement" | "listForReconcile">>;
};

type PlacementMutationAction = "fork" | "reset" | "restore" | "rewind" | "switch";
type Placement = WorkerSessionPlacementRecord;
type PlacementState = Placement["state"];

class SessionWorkerPlacementMutationError extends Error {
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
  const placement = readSessionWorkerPlacement(params);
  if (!placement) {
    return { status: "allowed" };
  }

  if (isWorkerPlacementSafeForMutation(params.context, placement)) {
    if (params.action === "reset") {
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

function readSessionWorkerPlacement(params: {
  context: SessionWorkerPlacementContext;
  sessionId?: string;
}): Placement | undefined {
  return params.sessionId
    ? params.context.workerSessionPlacementService
        ?.getMany([params.sessionId])
        .get(params.sessionId)
    : undefined;
}

function samePlacementOwner(
  expected: Placement | undefined,
  current: Placement | undefined,
): boolean {
  return (
    current?.sessionId === expected?.sessionId &&
    current?.sessionKey === expected?.sessionKey &&
    current?.agentId === expected?.agentId &&
    current?.state === expected?.state &&
    current?.generation === expected?.generation &&
    current?.environmentId === expected?.environmentId &&
    current?.activeOwnerEpoch === expected?.activeOwnerEpoch &&
    current?.executionMode === expected?.executionMode
  );
}

/** Retain the exact stopped placement across fallible workspace or session mutations. */
export function prepareSessionWorkerPlacementMutationCheck(
  params: Pick<SessionWorkerPlacementMutationParams, "context" | "sessionId">,
  operation: "mutation" | "retirement" = "mutation",
) {
  const expected = readSessionWorkerPlacement(params);
  const assertCurrent = () => {
    const current = readSessionWorkerPlacement(params);
    if (
      !samePlacementOwner(expected, current) ||
      current?.turnClaim ||
      (current && !isWorkerPlacementSafeForMutation(params.context, current))
    ) {
      throw new Error(`Worker session placement ${params.sessionId} changed before ${operation}`);
    }
  };
  assertCurrent();
  return assertCurrent;
}

/** Capture retirement without erasing cloud affinity before fallible session cleanup. */
export function prepareSessionWorkerPlacementRetirement(
  params: Pick<SessionWorkerPlacementMutationParams, "context" | "sessionId">,
) {
  const expected = readSessionWorkerPlacement(params);
  const assertCurrent = prepareSessionWorkerPlacementMutationCheck(params, "retirement");
  const retire = params.context.workerSessionPlacementService?.retireSessionPlacement;
  if (expected && !retire) {
    throw new Error("Worker session placement retirement service is unavailable");
  }
  return {
    assertCurrent,
    retire: () => {
      // Called only after confirmed deletion; orphan reconciliation may have
      // retired this placement while transcript archive publication awaited.
      if (!readSessionWorkerPlacement(params)) {
        return;
      }
      assertCurrent();
      if (expected && retire && isWorkerPlacementSafeForMutation(params.context, expected)) {
        retire({
          sessionId: expected.sessionId,
          expectedState: expected.state,
          expectedGeneration: expected.generation,
        });
      }
    },
  };
}

/** Validate before cancellation; the returned stop remains bound to this placement across drains. */
export function prepareSessionWorkerPlacementStop(params: {
  action: "archive" | "delete" | "recover";
  agentId: string;
  authorize?: () => void;
  context: SessionWorkerPlacementContext;
  sessionId?: string;
  sessionKey: string;
}): () => Promise<void> {
  const { agentId, context, sessionId, sessionKey } = params;
  const expected = readSessionWorkerPlacement(params);
  const matches = (candidate: Placement) =>
    candidate.sessionId === sessionId &&
    candidate.sessionKey === sessionKey &&
    candidate.agentId === agentId;
  if (expected && !matches(expected)) {
    throw new Error(`Session ${sessionKey} cloud worker placement identity changed.`);
  }
  if (
    expected &&
    !isWorkerPlacementSafeForMutation(context, expected) &&
    expected.state !== "active"
  ) {
    throw new Error(
      `Session ${sessionKey} cannot ${params.action} while cloud worker placement is ${expected.state}.`,
    );
  }
  const beforeDrain = () => {
    params.authorize?.();
    const current = readSessionWorkerPlacement(params);
    if (
      !samePlacementOwner(expected, current) ||
      (current && current.state !== "active" && !isWorkerPlacementSafeForMutation(context, current))
    ) {
      throw new Error(`Session ${sessionKey} cloud worker placement identity changed.`);
    }
  };
  return async () => {
    beforeDrain();
    if (!expected || expected.state !== "active" || !sessionId) {
      return;
    }
    if (!context.workerPlacementDispatchService?.reclaim) {
      throw new Error(`Session ${sessionKey} cloud worker reclaim is unavailable.`);
    }
    // The dispatch owner rechecks source eligibility before its own drain, and
    // caller authority throughout reconciliation. Never force-abandon unsynced work.
    const reclaimed = await context.workerPlacementDispatchService.reclaim(
      { agentId, sessionId, sessionKey },
      params.authorize,
      beforeDrain,
    );
    params.authorize?.();
    const settled = readSessionWorkerPlacement(params);
    if (
      reclaimed.state !== "reclaimed" ||
      !matches(reclaimed) ||
      !samePlacementOwner(reclaimed, settled)
    ) {
      throw new Error(`Session ${sessionKey} cloud worker reclaim identity changed.`);
    }
  };
}
