import { randomUUID } from "node:crypto";
import type { SandboxContext } from "../../agents/sandbox/types.js";
import type {
  LocalTurnPlacementClaim,
  SessionPlacementAdmissionProvider,
} from "../../agents/session-placement-admission.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { emitAgentRunStatusEvent } from "../../infra/agent-run-status-events.js";
import { StaleWorkerBuildError } from "./admission.js";
import { placementTurnOwner, sameWorkerSessionTurnClaim } from "./placement-record.js";
import { createRemoteExecPlacementSandbox } from "./placement-sandbox.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./placement-store.js";
import { WorkerRunnerCapacityError, WorkerRunnerUnavailableError } from "./tunnel-contract.js";
import {
  claimWorkerTurn,
  executeLocalTurn,
  rejectPendingWorkerResult,
  releaseClaimIfOwned,
  requireActivePlacement,
  resolvePlacementIdentity,
} from "./worker-turn-admission.js";
import { executeWorkerTurn } from "./worker-turn-execution.js";
import {
  failHandedOffTurn,
  WorkerTurnExecutionError,
  type ActiveWorkerPlacement,
  type WorkerTurnEnvironmentService,
} from "./worker-turn-failure.js";
import { createWorkerTurnRunOwner, type ActiveWorkerTurn } from "./worker-turn-run-owner.js";
import type { WorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import {
  executeRemoteExecTurn,
  WorkerWorkspaceReconciliationError,
} from "./workspace-result-finalize.js";

type ReclaimedWorkerPlacement = Extract<WorkerSessionPlacementRecord, { state: "reclaimed" }>;

type WorkerTurnLauncherOptions = {
  environments: WorkerTurnEnvironmentService;
  placements: WorkerSessionPlacementStore;
  resolveWorkspacePath: (identity: ReturnType<typeof resolvePlacementIdentity>) => Promise<string>;
  reconcileActivePlacement: (environmentId: string) => Promise<void>;
  workspaceOperations: WorkerWorkspaceOperationCoordinator;
  redispatchReclaimed: (placement: ReclaimedWorkerPlacement) => Promise<ActiveWorkerPlacement>;
  prepareAcceptedWorkspacePublication?: (claim: WorkerSessionTurnClaim) => Promise<void>;
  publishAcceptedWorkspace?: (claim: WorkerSessionTurnClaim) => Promise<void>;
};

export function createWorkerSessionTurnPlacementProvider(options: WorkerTurnLauncherOptions) {
  const activeWorkerTurns = new Map<string, ActiveWorkerTurn>();
  const provider: SessionPlacementAdmissionProvider & {
    resolveSandbox(params: {
      agentId: string;
      config?: OpenClawConfig;
      sessionId: string;
      sessionKey?: string;
      workspaceDir: string;
    }): Promise<SandboxContext | null>;
  } = {
    recoverTerminalTurn(session) {
      const active = activeWorkerTurns.get(session.sessionId);
      return active && (!session.sessionKey || active.sessionKey === session.sessionKey)
        ? active.recoverTerminal?.()
        : undefined;
    },
    async resolveSandbox(params) {
      const placement = options.placements.get(params.sessionId);
      if (
        placement?.state !== "active" ||
        placement.executionMode !== "remote-exec" ||
        placement.agentId !== params.agentId ||
        placement.sessionKey !== params.sessionKey
      ) {
        return null;
      }
      const localWorkspaceDir = await options.resolveWorkspacePath({
        sessionId: placement.sessionId,
        agentId: placement.agentId,
        sessionKey: placement.sessionKey,
      });
      const preparedPlacement = options.placements.get(params.sessionId);
      if (
        preparedPlacement?.state !== "active" ||
        preparedPlacement.executionMode !== "remote-exec" ||
        preparedPlacement.agentId !== placement.agentId ||
        preparedPlacement.sessionKey !== placement.sessionKey ||
        preparedPlacement.environmentId !== placement.environmentId ||
        preparedPlacement.activeOwnerEpoch !== placement.activeOwnerEpoch ||
        preparedPlacement.generation !== placement.generation
      ) {
        throw new Error("Remote-exec placement changed while preparing its managed workspace");
      }
      const sandbox = await createRemoteExecPlacementSandbox({
        config: params.config,
        environments: {
          get: options.environments.get,
          ...(options.environments.resolveSshIdentity
            ? { resolveSshIdentity: options.environments.resolveSshIdentity }
            : {}),
        },
        localWorkspaceDir,
        placement,
      });
      const current = options.placements.get(params.sessionId);
      if (
        current?.state !== "active" ||
        current.executionMode !== "remote-exec" ||
        current.agentId !== placement.agentId ||
        current.sessionKey !== placement.sessionKey ||
        current.environmentId !== placement.environmentId ||
        current.activeOwnerEpoch !== placement.activeOwnerEpoch ||
        current.generation !== placement.generation
      ) {
        throw new Error("Remote-exec placement changed while preparing its sandbox");
      }
      const currentEnvironment = options.environments.get(placement.environmentId);
      if (
        currentEnvironment?.state !== "attached" ||
        currentEnvironment.environmentId !== placement.environmentId ||
        currentEnvironment.ownerEpoch !== placement.activeOwnerEpoch ||
        currentEnvironment.attachedSessionIds.length !== 1 ||
        currentEnvironment.attachedSessionIds[0] !== placement.sessionId ||
        (sandbox.backendId === "node" &&
          "placementNodeId" in sandbox &&
          currentEnvironment.nodeDeviceId !== sandbox.placementNodeId)
      ) {
        throw new Error("Remote-exec environment changed while preparing its sandbox");
      }
      return sandbox;
    },
    async executeLocalTurn<T>(claim: LocalTurnPlacementClaim, runLocal: () => Promise<T>) {
      return await executeLocalTurn({ claim, placements: options.placements, runLocal });
    },
    async executeTurn(claim, inputTurn, runLocal, onAdmitted) {
      let turn = inputTurn;
      const current = options.placements.get(claim.sessionId);
      if (!current && turn.modelRun === true && !claim.sessionKey?.trim()) {
        return await runLocal();
      }
      if (!current || current.state === "local") {
        return await executeLocalTurn({ claim, placements: options.placements, runLocal });
      }
      let identity = resolvePlacementIdentity(claim, current);
      let routablePlacement = current;
      if (routablePlacement.state === "reclaimed") {
        emitAgentRunStatusEvent({
          runId: claim.runId,
          phase: "provisioning_environment",
          sessionKey: identity.sessionKey,
          agentId: identity.agentId,
        });
        routablePlacement = await options.redispatchReclaimed(routablePlacement);
        identity = resolvePlacementIdentity(
          { ...claim, agentId: identity.agentId, sessionKey: identity.sessionKey },
          routablePlacement,
        );
      }
      if (
        routablePlacement.state === "draining" &&
        options.placements
          .listPendingWorkspaceResults()
          .some((pending) => pending.sessionId === identity.sessionId)
      ) {
        await rejectPendingWorkerResult({
          placements: options.placements,
          sessionId: identity.sessionId,
          ...(turn.abortSignal ? { signal: turn.abortSignal } : {}),
        });
      }
      let placement = requireActivePlacement(routablePlacement);
      // The placement owns the managed worktree. Callers can carry a default or stale
      // workspace path, but remote results must only reconcile into that canonical root.
      const localWorkspaceDir = await options.resolveWorkspacePath(identity);
      const remoteExec = placement.executionMode === "remote-exec";
      let turnClaim: WorkerSessionTurnClaim;
      if (remoteExec) {
        turnClaim = options.placements.claimTurn({
          ...identity,
          claimId: randomUUID(),
          runId: claim.runId,
          owner: placementTurnOwner(placement),
        });
        const refreshed = options.placements.get(claim.sessionId);
        if (
          refreshed?.state !== "active" ||
          refreshed.executionMode !== "remote-exec" ||
          refreshed.environmentId !== placement.environmentId ||
          refreshed.activeOwnerEpoch !== placement.activeOwnerEpoch ||
          refreshed.generation !== turnClaim.placementGeneration
        ) {
          await releaseClaimIfOwned(options.placements, turnClaim);
          throw new Error("Remote-exec placement changed during turn admission");
        }
        placement = refreshed;
      } else {
        const admitted = await claimWorkerTurn({
          placements: options.placements,
          identity,
          placement,
          runId: claim.runId,
          isCancellationRequested: (activeClaim) => {
            const active = activeWorkerTurns.get(activeClaim.sessionId);
            return Boolean(
              active?.signal?.aborted && sameWorkerSessionTurnClaim(active.claim, activeClaim),
            );
          },
          ...(turn.abortSignal ? { signal: turn.abortSignal } : {}),
        });
        placement = admitted.placement;
        turnClaim = admitted.turnClaim;
      }
      let activeWorkerTurn: ActiveWorkerTurn | undefined;
      let handedOff = false;
      let terminalAtMs: number | undefined;
      try {
        if (!remoteExec) {
          activeWorkerTurn = createWorkerTurnRunOwner({
            placements: options.placements,
            claim: turnClaim,
            sessionKey: placement.sessionKey,
            turn,
          });
          activeWorkerTurn.signal.throwIfAborted();
          turn = { ...turn, abortSignal: activeWorkerTurn.signal };
          activeWorkerTurns.set(turnClaim.sessionId, activeWorkerTurn);
        }
        // Release queue protection only after the placement claim is durable.
        onAdmitted?.();
        const executionParams = {
          environments: options.environments,
          onHandoff: () => {
            handedOff = true;
          },
          onTerminal: () => {
            terminalAtMs = Date.now();
          },
          placement,
          placements: options.placements,
          localWorkspaceDir,
          ...(options.prepareAcceptedWorkspacePublication
            ? { prepareAcceptedWorkspacePublication: options.prepareAcceptedWorkspacePublication }
            : {}),
          ...(options.publishAcceptedWorkspace
            ? { publishAcceptedWorkspace: options.publishAcceptedWorkspace }
            : {}),
          workspaceOperations: options.workspaceOperations,
          turn,
          turnClaim,
        };
        const result = remoteExec
          ? await executeRemoteExecTurn({ ...executionParams, runLocal })
          : await executeWorkerTurn(executionParams);
        return result;
      } catch (error) {
        if (error instanceof StaleWorkerBuildError) {
          await options.reconcileActivePlacement(placement.environmentId);
          const reconciled = options.placements.get(placement.sessionId);
          if (reconciled) {
            requireActivePlacement(reconciled);
          }
        }
        const pendingWorkspaceResult = options.placements
          .listPendingWorkspaceResults()
          .find(
            (pending) =>
              pending.sessionId === turnClaim.sessionId &&
              pending.claimId === turnClaim.claimId &&
              pending.runId === turnClaim.runId,
          );
        if (pendingWorkspaceResult) {
          if (turnClaim.owner.kind === "local") {
            // The Gateway-owned run is already terminal. Atomically record the
            // reconciliation failure before teardown so reclaim cannot see live work.
            options.placements.failWorkspaceResultAndReleaseTurn(pendingWorkspaceResult, error);
          } else {
            // A recovery sweep owns the still-live worker claim. Teardown here
            // could discard the terminal event's durably fenced file results.
            options.placements.handoffWorkspaceResultRecovery(turnClaim);
          }
          await options.reconcileActivePlacement(placement.environmentId);
          throw error;
        }
        if (
          error instanceof WorkerRunnerCapacityError ||
          (error instanceof WorkerRunnerUnavailableError && !handedOff) ||
          // Canceling the exact worker turn must not destroy its reusable placement.
          (!remoteExec && handedOff && turn.abortSignal?.aborted)
        ) {
          await releaseClaimIfOwned(options.placements, turnClaim);
          throw error;
        }
        const settledPlacement = options.placements.get(turnClaim.sessionId);
        if (
          remoteExec &&
          settledPlacement?.state === "active" &&
          settledPlacement.environmentId === placement.environmentId &&
          settledPlacement.activeOwnerEpoch === placement.activeOwnerEpoch &&
          settledPlacement.turnClaim === null
        ) {
          // Reconciliation released the placement before the local harness error
          // crossed back to this owner; do not turn a model error into box teardown.
          throw error;
        }
        if (error instanceof WorkerWorkspaceReconciliationError && !handedOff) {
          // Recovery runs before remote launch. Preserve the journal's active
          // generation; only the new admission claim belongs to this attempt.
          await releaseClaimIfOwned(options.placements, turnClaim);
          throw error;
        }
        if (error instanceof WorkerTurnExecutionError) {
          if (options.placements.validateTurnClaim(turnClaim)) {
            await releaseClaimIfOwned(options.placements, turnClaim);
            throw error;
          }
          const workerSettledPlacement = options.placements.get(turnClaim.sessionId);
          if (
            workerSettledPlacement?.state === "active" &&
            workerSettledPlacement.environmentId === placement.environmentId &&
            workerSettledPlacement.activeOwnerEpoch === placement.activeOwnerEpoch &&
            workerSettledPlacement.turnClaim === null
          ) {
            // Workspace result settlement durably released this failed model turn.
            // The outer fallback cycle owns run-terminal normalization.
            throw error;
          }
        }
        if (handedOff) {
          const terminalOwner = activeWorkerTurn;
          await failHandedOffTurn({
            environments: options.environments,
            placements: options.placements,
            placement,
            turnClaim,
            error,
            ...(terminalOwner && terminalAtMs !== undefined
              ? {
                  terminal: {
                    observedAtMs: terminalAtMs,
                    registerRecovery: (recover: () => string | undefined) => {
                      terminalOwner.recoverTerminal = recover;
                    },
                  },
                }
              : {}),
          });
        } else {
          await releaseClaimIfOwned(options.placements, turnClaim);
        }
        throw error;
      } finally {
        activeWorkerTurn?.dispose();
        if (activeWorkerTurn && activeWorkerTurns.get(turnClaim.sessionId) === activeWorkerTurn) {
          activeWorkerTurns.delete(turnClaim.sessionId);
        }
      }
    },
  };
  provider satisfies SessionPlacementAdmissionProvider;
  return provider;
}
