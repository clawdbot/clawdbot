import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { redactSensitiveText } from "../../logging/redact.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./placement-store.js";
import type { WorkerEnvironmentService } from "./service.js";
import { WorkerTunnelOwnerDisconnectedError, type WorkerTunnelHandle } from "./tunnel-contract.js";
import { latestDurableWorkspaceConflict, waitForTurnOperation } from "./worker-turn-admission.js";
import { resolveWorkerTurnTranscriptTarget } from "./worker-turn-transcript-target.js";
import {
  formatWorkspaceConflictSummary,
  projectWorkspaceResultConflict,
  WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE,
  WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
  type WorkerWorkspaceResultConflict,
} from "./workspace-conflicts.js";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";
import type { WorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import { recoverWorkerWorkspaceReconciliation } from "./workspace-reconcile.js";
import {
  deleteStagedWorkerWorkspaceResult,
  isWorkerWorkspaceResultCleanupRef,
  moveStagedWorkerWorkspaceResultToCleanup,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

type ActiveWorkerPlacement = Extract<WorkerSessionPlacementRecord, { state: "active" }>;
type OwnedWorkerPlacement = Extract<WorkerSessionPlacementRecord, { state: "active" | "draining" }>;
type RemoteExecEnvironmentService = Pick<WorkerEnvironmentService, "get" | "startTunnel">;

export class WorkerWorkspaceReconciliationError extends Error {
  override name = "WorkerWorkspaceReconciliationError";
}

type WorkspaceConflictReport = {
  paths: string[];
  stagedResultRef: string;
  totalCount: number;
  summary: string;
};

function workspaceError(error: unknown): string {
  const message = redactSensitiveText(formatErrorMessage(error), { mode: "tools" })
    .replace(/\s+/gu, " ")
    .trim();
  return truncateUtf16Safe(message || "cloud worker turn failed", 1_024);
}

function workspaceJournal(params: {
  placement: OwnedWorkerPlacement;
  placements: WorkerSessionPlacementStore;
  turnClaim: WorkerSessionTurnClaim;
}) {
  const owner = {
    sessionId: params.placement.sessionId,
    environmentId: params.placement.environmentId,
    ownerEpoch: params.placement.activeOwnerEpoch,
    placementGeneration: params.placement.generation,
  };
  let manifestAccepted = false;
  return {
    adapter: {
      load: () => params.placements.loadWorkspaceReconciliation(owner),
      begin: (next: Parameters<typeof params.placements.beginWorkspaceReconciliation>[1]) =>
        params.placements.beginWorkspaceReconciliation(owner, next),
      commit: (manifestRef: string) => {
        params.placements.updateWorkspaceBaseManifest({ claim: params.turnClaim, manifestRef });
        manifestAccepted = true;
      },
      abort: () => params.placements.abortWorkspaceReconciliation(owner),
    },
    wasAccepted: () => manifestAccepted,
  };
}

export async function recoverWorkspaceBeforeTurn(params: {
  placement: ActiveWorkerPlacement;
  placements: WorkerSessionPlacementStore;
  turnClaim: WorkerSessionTurnClaim;
  workspaceOperations: WorkerWorkspaceOperationCoordinator;
  localWorkspaceDir: string;
}): Promise<void> {
  const journal = workspaceJournal(params).adapter;
  try {
    await params.workspaceOperations.run(params.placement.environmentId, async () => {
      if (!params.placements.validateTurnClaim(params.turnClaim)) {
        throw new Error("Cloud worker workspace recovery lost its turn claim");
      }
      const pending = journal.load();
      if (pending) {
        await recoverWorkerWorkspaceReconciliation({
          root: params.localWorkspaceDir,
          journal: pending,
        });
        journal.abort();
      }
    });
  } catch (error) {
    throw new WorkerWorkspaceReconciliationError(
      `Cloud worker workspace recovery could not complete: ${workspaceError(error)}`,
      { cause: error },
    );
  }
}

export async function reconcileWorkspaceAfterTurn(params: {
  placement: ActiveWorkerPlacement;
  placements: WorkerSessionPlacementStore;
  turnClaim: WorkerSessionTurnClaim;
  workspaceOperations: WorkerWorkspaceOperationCoordinator;
  localWorkspaceDir: string;
  transcriptTarget: Parameters<typeof SessionManager.open>[0];
  tunnel: WorkerTunnelHandle;
  prepareAcceptedWorkspacePublication?: (claim: WorkerSessionTurnClaim) => Promise<void>;
  publishAcceptedWorkspace?: (claim: WorkerSessionTurnClaim) => Promise<void>;
}): Promise<WorkspaceConflictReport | undefined> {
  const currentPlacement = params.placements.get(params.placement.sessionId);
  const generationMatches =
    currentPlacement?.state === "active"
      ? currentPlacement.generation === params.turnClaim.placementGeneration
      : currentPlacement?.state === "draining"
        ? currentPlacement.generation === params.turnClaim.placementGeneration + 1
        : false;
  if (
    (currentPlacement?.state !== "active" && currentPlacement?.state !== "draining") ||
    currentPlacement.environmentId !== params.placement.environmentId ||
    currentPlacement.activeOwnerEpoch !== params.placement.activeOwnerEpoch ||
    !generationMatches
  ) {
    throw new Error("Cloud worker placement changed before workspace reconciliation");
  }
  const completed = SessionManager.open(params.transcriptTarget);
  const priorWorkspaceConflict =
    currentPlacement.workspaceResultConflict ??
    latestDurableWorkspaceConflict(completed.getBranch());
  const pendingWorkspaceResult = params.placements
    .listPendingWorkspaceResults()
    .some(
      (pending) =>
        pending.sessionId === params.turnClaim.sessionId &&
        pending.claimId === params.turnClaim.claimId &&
        pending.runId === params.turnClaim.runId,
    );
  if (!pendingWorkspaceResult) {
    throw new Error("Cloud worker completed without a durable workspace-result fence");
  }
  const journal = workspaceJournal({
    placement: currentPlacement,
    placements: params.placements,
    turnClaim: params.turnClaim,
  });
  let workspaceConflict: WorkspaceConflictReport | undefined;
  try {
    await params.workspaceOperations.run(currentPlacement.environmentId, async () => {
      if (!params.placements.validateTurnClaim(params.turnClaim)) {
        throw new Error("Cloud worker workspace result lost its turn claim");
      }
      const quiescence = await params.tunnel.quiesceWorkspace(currentPlacement.remoteWorkspaceDir);
      let resumed = false;
      try {
        const stagedResultRef = workerWorkspaceResultRef(params.turnClaim.claimId);
        const reconciliation = await params.tunnel.reconcileWorkspace({
          localPath: params.localWorkspaceDir,
          remoteWorkspaceDir: currentPlacement.remoteWorkspaceDir,
          baseManifestRef: currentPlacement.workspaceBaseManifestRef,
          journal: journal.adapter,
          stagedResult: {
            ref: stagedResultRef,
            record: (ref) => params.placements.recordStagedWorkspaceResult(params.turnClaim, ref),
          },
        });
        const applied = await verifyReconciledWorkspaceFinal(reconciliation, quiescence);
        if (!journal.wasAccepted()) {
          throw new Error("Cloud worker workspace reconciliation was not durably accepted");
        }
        if (params.prepareAcceptedWorkspacePublication) {
          await params.prepareAcceptedWorkspacePublication(params.turnClaim).catch(() => undefined);
        }
        params.placements.acceptWorkspaceResult(params.turnClaim);
        const recordedStagedResultRef = params.placements
          .listPendingWorkspaceResults()
          .find(
            (pending) =>
              pending.sessionId === params.turnClaim.sessionId &&
              pending.claimId === params.turnClaim.claimId &&
              pending.runId === params.turnClaim.runId,
          )?.stagedResultRef;
        if (applied?.conflictPaths.length && !recordedStagedResultRef) {
          throw new Error("Cloud workspace conflict has no staged result reference");
        }
        const finalized = await finalizeWorkspaceResultConflicts({
          placements: params.placements,
          turnClaim: params.turnClaim,
          conflictPaths: applied?.conflictPaths ?? [],
          priorConflict: priorWorkspaceConflict,
          stagedResultRef: recordedStagedResultRef,
          root: params.localWorkspaceDir,
          report: async (report) => {
            if ("cleared" in report) {
              SessionManager.open(params.transcriptTarget).appendCustomMessageEntry(
                WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE,
                "A later cloud workspace result superseded the previous conflict.",
                false,
              );
              return;
            }
            workspaceConflict = {
              ...report,
              summary: formatWorkspaceConflictSummary(
                report.paths,
                report.stagedResultRef,
                report.totalCount,
              ),
            };
            SessionManager.open(params.transcriptTarget).appendCustomMessageEntry(
              WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
              workspaceConflict.summary,
              true,
              {
                paths: workspaceConflict.paths,
                stagedResultRef: workspaceConflict.stagedResultRef,
                totalCount: workspaceConflict.totalCount,
              },
            );
          },
        });
        await params.publishAcceptedWorkspace?.(params.turnClaim);
        await settleStagedWorkspaceResult({
          placements: params.placements,
          turnClaim: params.turnClaim,
          root: params.localWorkspaceDir,
          stagedResultRef: recordedStagedResultRef,
          conflictRetained: finalized.conflictRetained,
          beforeComplete: async () => {
            await quiescence.resume();
            resumed = true;
          },
        });
      } finally {
        if (!resumed) {
          await quiescence.resume();
        }
      }
    });
  } catch (error) {
    throw new WorkerWorkspaceReconciliationError(
      `Cloud worker finished, but its workspace result could not be reconciled: ${workspaceError(error)}`,
      { cause: error },
    );
  }
  return workspaceConflict;
}

function appendWorkspaceConflict(
  result: EmbeddedAgentRunResult,
  workspaceConflict: WorkspaceConflictReport,
): EmbeddedAgentRunResult {
  const payloads = result.payloads ? [...result.payloads] : [];
  const textIndex = payloads.findLastIndex((payload) => typeof payload.text === "string");
  if (textIndex === -1) {
    payloads.push({ text: workspaceConflict.summary });
  } else {
    const payload = payloads[textIndex]!;
    payloads[textIndex] = {
      ...payload,
      text: payload.text
        ? `${payload.text}\n\n${workspaceConflict.summary}`
        : workspaceConflict.summary,
    };
  }
  return { ...result, payloads };
}

export async function executeRemoteExecTurn(params: {
  environments: RemoteExecEnvironmentService;
  onHandoff: () => void;
  placement: ActiveWorkerPlacement;
  placements: WorkerSessionPlacementStore;
  workspaceOperations: WorkerWorkspaceOperationCoordinator;
  turn: SessionPlacementTurnParams;
  turnClaim: WorkerSessionTurnClaim;
  localWorkspaceDir: string;
  runLocal: () => Promise<EmbeddedAgentRunResult>;
  prepareAcceptedWorkspacePublication?: (claim: WorkerSessionTurnClaim) => Promise<void>;
  publishAcceptedWorkspace?: (claim: WorkerSessionTurnClaim) => Promise<void>;
}): Promise<EmbeddedAgentRunResult> {
  const environment = params.environments.get(params.placement.environmentId);
  if (
    !environment ||
    environment.state !== "attached" ||
    environment.ownerEpoch !== params.placement.activeOwnerEpoch ||
    environment.bootstrapReceipt?.bundleHash !== params.placement.workerBundleHash ||
    environment.attachedSessionIds.length !== 1 ||
    environment.attachedSessionIds[0] !== params.placement.sessionId
  ) {
    throw new Error("Active remote-exec placement does not match its attached environment");
  }
  await recoverWorkspaceBeforeTurn(params);
  const tunnel = await waitForTurnOperation({
    operation: params.environments.startTunnel({
      environmentId: params.placement.environmentId,
      ownerEpoch: params.placement.activeOwnerEpoch,
    }),
    ...(params.turn.abortSignal ? { signal: params.turn.abortSignal } : {}),
    timeoutMs: params.turn.timeoutMs,
  });
  const transcriptTarget = resolveWorkerTurnTranscriptTarget(params.turn);
  params.placements.markWorkspaceResultPending(params.turnClaim);
  params.onHandoff();
  let result: EmbeddedAgentRunResult | undefined;
  let executionError: unknown;
  let executionActive = true;
  try {
    result = await withPluginRuntimeGatewayRequestScope(
      {
        isWebchatConnect: () => false,
        ...getPluginRuntimeGatewayRequestScope(),
        assertNodeExecutionCurrent: (request) => {
          const placement = params.placements.get(params.placement.sessionId);
          const currentEnvironment = params.environments.get(environment.environmentId);
          if (
            !executionActive ||
            params.turn.abortSignal?.aborted ||
            !params.placements.validateTurnClaim(params.turnClaim) ||
            request.runId !== params.turnClaim.runId ||
            request.agentId !== params.placement.agentId ||
            request.workspace.sessionId !== params.placement.sessionId ||
            request.workspace.sessionKey !== params.placement.sessionKey ||
            request.workspace.environmentId !== params.placement.environmentId ||
            request.workspace.ownerEpoch !== params.placement.activeOwnerEpoch ||
            request.workspace.workspaceDir !== params.placement.remoteWorkspaceDir ||
            placement?.state !== "active" ||
            placement.executionMode !== "remote-exec" ||
            placement.generation !== params.turnClaim.placementGeneration ||
            placement.sessionKey !== params.placement.sessionKey ||
            placement.agentId !== params.placement.agentId ||
            placement.environmentId !== params.placement.environmentId ||
            placement.activeOwnerEpoch !== params.placement.activeOwnerEpoch ||
            placement.remoteWorkspaceDir !== params.placement.remoteWorkspaceDir ||
            currentEnvironment?.state !== "attached" ||
            currentEnvironment.ownerEpoch !== environment.ownerEpoch ||
            currentEnvironment.leaseId !== environment.leaseId ||
            currentEnvironment.nodeDeviceId !== environment.nodeDeviceId ||
            currentEnvironment.nodeDeviceId !== request.nodeId ||
            currentEnvironment.attachedSessionIds.length !== 1 ||
            currentEnvironment.attachedSessionIds[0] !== params.placement.sessionId
          ) {
            throw new Error("node execution placement authority is no longer current");
          }
        },
      },
      params.runLocal,
    );
  } catch (error) {
    executionError = error;
  } finally {
    executionActive = false;
  }
  const workspaceConflict = await reconcileWorkspaceAfterTurn({
    placement: params.placement,
    placements: params.placements,
    turnClaim: params.turnClaim,
    workspaceOperations: params.workspaceOperations,
    localWorkspaceDir: params.localWorkspaceDir,
    transcriptTarget,
    tunnel,
    ...(params.prepareAcceptedWorkspacePublication
      ? { prepareAcceptedWorkspacePublication: params.prepareAcceptedWorkspacePublication }
      : {}),
    ...(params.publishAcceptedWorkspace
      ? { publishAcceptedWorkspace: params.publishAcceptedWorkspace }
      : {}),
  }).catch((reconciliationError: unknown) => {
    const currentEnvironment = params.environments.get(params.placement.environmentId);
    if (
      environment.nodeDeviceId &&
      currentEnvironment?.state === "attached" &&
      currentEnvironment.providerId === environment.providerId &&
      currentEnvironment.environmentId === environment.environmentId &&
      currentEnvironment.ownerEpoch === environment.ownerEpoch &&
      currentEnvironment.nodeDeviceId === environment.nodeDeviceId &&
      currentEnvironment.attachedSessionIds.length === 1 &&
      currentEnvironment.attachedSessionIds[0] === params.placement.sessionId &&
      reconciliationError instanceof WorkerWorkspaceReconciliationError &&
      reconciliationError.cause instanceof WorkerTunnelOwnerDisconnectedError
    ) {
      // Offline nodes keep their exact lease; the next turn reconciles its dirty workspace.
      params.placements.cancelWorkspaceResultAndReleaseTurn(params.turnClaim, {
        reason: "node-disconnect",
      });
    }
    if (executionError) {
      // Preserve the terminal execution failure while retaining the independent workspace loss.
      throw new Error(formatErrorMessage(executionError), { cause: reconciliationError });
    }
    throw reconciliationError;
  });
  if (executionError) {
    throw executionError instanceof Error
      ? executionError
      : new Error(formatErrorMessage(executionError));
  }
  if (!result) {
    throw new Error("Remote-exec local harness completed without a result");
  }
  if (!workspaceConflict) {
    return result;
  }
  const resultText = result.payloads
    ?.flatMap((payload) => (payload.text ? [payload.text] : []))
    .join("\n\n");
  await Promise.resolve(
    params.turn.onAgentEvent?.({
      stream: "assistant",
      data: {
        text: resultText
          ? `${resultText}\n\n${workspaceConflict.summary}`
          : workspaceConflict.summary,
        delta: `${resultText ? "\n\n" : ""}${workspaceConflict.summary}`,
      },
    }),
  ).catch(() => undefined);
  return appendWorkspaceConflict(result, workspaceConflict);
}

type WorkspaceResultFinalizationStore = Pick<
  WorkerSessionPlacementStore,
  | "closeWorkerTurnToolState"
  | "completeWorkspaceResultAndReleaseTurn"
  | "recordWorkspaceResultConflict"
>;

type WorkspaceResultConflictReport = Required<WorkerWorkspaceResultConflict> | { cleared: true };

export async function finalizeWorkspaceResultConflicts(params: {
  placements: WorkspaceResultFinalizationStore;
  turnClaim: WorkerSessionTurnClaim;
  conflictPaths: readonly string[];
  priorConflict: WorkerWorkspaceResultConflict | undefined;
  stagedResultRef: string | null | undefined;
  retainPriorConflict?: boolean;
  report: (report: WorkspaceResultConflictReport) => Promise<void>;
  root: string;
}): Promise<{
  conflict: Required<WorkerWorkspaceResultConflict> | undefined;
  conflictRetained: boolean;
}> {
  const retainedPriorConflict =
    params.retainPriorConflict && params.conflictPaths.length === 0
      ? params.priorConflict
      : undefined;
  const supersededConflict =
    params.priorConflict &&
    !retainedPriorConflict &&
    (params.conflictPaths.length === 0 ||
      params.priorConflict.stagedResultRef !== params.stagedResultRef)
      ? params.priorConflict
      : undefined;
  if (supersededConflict && supersededConflict.stagedResultRef !== params.stagedResultRef) {
    // Delete the inspectable result before replacing its last durable pointer.
    await deleteStagedWorkerWorkspaceResult({
      root: params.root,
      stagedResultRef: supersededConflict.stagedResultRef,
    });
  }

  let conflict: Required<WorkerWorkspaceResultConflict> | undefined;
  if (params.conflictPaths.length > 0) {
    if (!params.stagedResultRef) {
      throw new Error("Cloud workspace conflict has no staged result reference");
    }
    conflict = projectWorkspaceResultConflict(params.conflictPaths, params.stagedResultRef);
    params.placements.recordWorkspaceResultConflict(params.turnClaim, conflict);
    await params.report(conflict);
  } else if (retainedPriorConflict) {
    params.placements.recordWorkspaceResultConflict(params.turnClaim, retainedPriorConflict);
  } else if (supersededConflict) {
    params.placements.recordWorkspaceResultConflict(params.turnClaim, undefined);
    await params.report({ cleared: true });
  }

  return { conflict, conflictRetained: conflict !== undefined };
}

type StagedWorkspaceResultSettlement = {
  placements: WorkspaceResultFinalizationStore;
  turnClaim: WorkerSessionTurnClaim;
  root: string;
  stagedResultRef: string | null | undefined;
  conflictRetained: boolean;
  beforeComplete: () => Promise<void>;
  complete?: () => WorkerSessionPlacementRecord;
  afterComplete?: (completed: WorkerSessionPlacementRecord) => Promise<void>;
  validateCompleted?: (completed: WorkerSessionPlacementRecord) => void;
};
export async function settleStagedWorkspaceResult(
  params: StagedWorkspaceResultSettlement,
): Promise<WorkerSessionPlacementRecord> {
  if (params.turnClaim.owner.kind === "worker") {
    await params.placements.closeWorkerTurnToolState(params.turnClaim);
  }
  const cleanupRef =
    params.stagedResultRef && !params.conflictRetained
      ? isWorkerWorkspaceResultCleanupRef(params.stagedResultRef)
        ? params.stagedResultRef
        : await moveStagedWorkerWorkspaceResultToCleanup({
            root: params.root,
            stagedResultRef: params.stagedResultRef,
          })
      : undefined;
  await params.beforeComplete();
  const completed = params.complete
    ? params.complete()
    : params.placements.completeWorkspaceResultAndReleaseTurn(params.turnClaim);
  params.validateCompleted?.(completed);
  await params.afterComplete?.(completed);
  if (cleanupRef) {
    // Cleanup refs remain discoverable after the SQLite fence disappears.
    await deleteStagedWorkerWorkspaceResult({
      root: params.root,
      stagedResultRef: cleanupRef,
    }).catch(() => undefined);
  }
  return completed;
}
