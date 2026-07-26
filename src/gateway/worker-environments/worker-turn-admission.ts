import { randomUUID } from "node:crypto";
import type { LocalTurnPlacementClaim } from "../../agents/session-placement-admission.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS } from "../../sessions/session-lifecycle-admission.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./placement-store.js";
import { ActiveTurnClaimError } from "./placement-turn-claims.js";
import {
  projectWorkspaceResultConflict,
  type WorkerWorkspaceResultConflict,
  WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE,
  WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
} from "./workspace-conflicts.js";

type ActiveWorkerPlacement = Extract<WorkerSessionPlacementRecord, { state: "active" }>;

const PREVIOUS_RESULT_RECONCILING_MESSAGE =
  "The previous cloud turn's workspace result is still reconciling; it retries automatically — try again shortly.";

function required(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`Worker turn ${field} is required`);
  }
  return normalized;
}

export function latestDurableWorkspaceConflict(
  entries: ReturnType<SessionManager["getBranch"]>,
): WorkerWorkspaceResultConflict | undefined {
  for (const entry of entries.toReversed()) {
    if (entry.type !== "custom_message") {
      continue;
    }
    if (entry.customType === WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE) {
      return undefined;
    }
    if (entry.customType !== WORKSPACE_CONFLICT_TRANSCRIPT_TYPE) {
      continue;
    }
    const details = entry.details as
      | { paths?: unknown; stagedResultRef?: unknown; totalCount?: unknown }
      | null
      | undefined;
    if (
      !Array.isArray(details?.paths) ||
      details.paths.length === 0 ||
      !details.paths.every(
        (entryPath): entryPath is string => typeof entryPath === "string" && entryPath.length > 0,
      ) ||
      typeof details.stagedResultRef !== "string" ||
      (details.totalCount !== undefined &&
        (!Number.isSafeInteger(details.totalCount) ||
          (details.totalCount as number) < details.paths.length)) ||
      !/^refs\/openclaw\/worker-results\/[A-Za-z0-9-]+$/u.test(details.stagedResultRef)
    ) {
      return undefined;
    }
    return projectWorkspaceResultConflict(
      details.paths,
      details.stagedResultRef,
      details.totalCount as number | undefined,
    );
  }
  return undefined;
}

export async function waitForTurnOperation<T>(params: {
  operation: Promise<T>;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<T> {
  const timeout = AbortSignal.timeout(params.timeoutMs);
  const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
  const abortError = () =>
    signal.reason instanceof Error
      ? signal.reason
      : new Error("Cloud worker operation aborted", { cause: signal.reason });
  if (signal.aborted) {
    throw abortError();
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    params.operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

export function resolvePlacementIdentity(
  claim: LocalTurnPlacementClaim,
  placement: WorkerSessionPlacementRecord | undefined,
) {
  return {
    sessionId: claim.sessionId,
    agentId: placement?.agentId ?? required(claim.agentId, "agent id"),
    sessionKey: placement?.sessionKey ?? required(claim.sessionKey, "session key"),
  };
}

export function requireActivePlacement(
  placement: WorkerSessionPlacementRecord,
): ActiveWorkerPlacement {
  if (
    placement.state !== "active" ||
    !placement.remoteWorkspaceDir ||
    !placement.workerBundleHash
  ) {
    throw new Error(`Worker turn rejected in placement ${placement.state}`);
  }
  return placement;
}

export function releaseClaimIfOwned(
  placements: WorkerSessionPlacementStore,
  turnClaim: WorkerSessionTurnClaim,
): void {
  if (placements.validateTurnClaim(turnClaim)) {
    placements.releaseTurn(turnClaim);
  }
}

export async function claimWorkerTurn(params: {
  placements: WorkerSessionPlacementStore;
  identity: ReturnType<typeof resolvePlacementIdentity>;
  placement: ActiveWorkerPlacement;
  runId: string;
  signal?: AbortSignal;
}): Promise<{ placement: ActiveWorkerPlacement; turnClaim: WorkerSessionTurnClaim }> {
  const claim = () =>
    params.placements.claimTurn({
      ...params.identity,
      claimId: randomUUID(),
      runId: params.runId,
      owner: {
        kind: "worker",
        environmentId: params.placement.environmentId,
        ownerEpoch: params.placement.activeOwnerEpoch,
      },
    });
  try {
    return { placement: params.placement, turnClaim: claim() };
  } catch (error) {
    if (!(error instanceof ActiveTurnClaimError)) {
      throw error;
    }
    const activeClaim = params.placements.get(params.identity.sessionId)?.turnClaim;
    if (activeClaim?.runId === params.runId) {
      throw error;
    }
    const resultIsReconciling = params.placements
      .listPendingWorkspaceResults()
      .some(
        (pending) =>
          activeClaim?.owner === "worker" &&
          pending.sessionId === params.identity.sessionId &&
          pending.claimId === activeClaim.claimId &&
          pending.runId === activeClaim.runId,
      );
    if (!resultIsReconciling) {
      const refreshed = params.placements.get(params.identity.sessionId);
      if (
        refreshed?.state !== "active" ||
        refreshed.environmentId !== params.placement.environmentId ||
        refreshed.activeOwnerEpoch !== params.placement.activeOwnerEpoch ||
        refreshed.turnClaim
      ) {
        throw error;
      }
      return { placement: refreshed, turnClaim: claim() };
    }
  }
  try {
    await params.placements.waitForTurnClaimRelease(params.identity.sessionId, {
      timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
      ...(params.signal ? { signal: params.signal } : {}),
    });
  } catch (error) {
    if (params.signal?.aborted) {
      throw error;
    }
    throw new Error(PREVIOUS_RESULT_RECONCILING_MESSAGE, { cause: error });
  }
  const refreshed = params.placements.get(params.identity.sessionId);
  if (
    refreshed?.state !== "active" ||
    refreshed.environmentId !== params.placement.environmentId ||
    refreshed.activeOwnerEpoch !== params.placement.activeOwnerEpoch
  ) {
    throw new Error(PREVIOUS_RESULT_RECONCILING_MESSAGE);
  }
  try {
    return { placement: refreshed, turnClaim: claim() };
  } catch (error) {
    if (error instanceof ActiveTurnClaimError) {
      throw new Error(PREVIOUS_RESULT_RECONCILING_MESSAGE, { cause: error });
    }
    throw error;
  }
}
