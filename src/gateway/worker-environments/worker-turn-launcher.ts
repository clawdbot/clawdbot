import { randomUUID } from "node:crypto";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { mapThinkingLevelForProvider } from "../../agents/embedded-agent-runner/utils.js";
import type { SandboxContext } from "../../agents/sandbox/types.js";
import type {
  LocalTurnPlacementClaim,
  SessionPlacementAdmissionProvider,
  SessionPlacementTurnParams,
} from "../../agents/session-placement-admission.js";
import { convertToLlm } from "../../agents/sessions/messages.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { emitAgentRunStatusEvent } from "../../infra/agent-run-status-events.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { parseWorkerLaunchPlan } from "../../worker/launch-descriptor.js";
import { WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE } from "../../worker/transcript-message.js";
import { prepareGitHubPublicationAvailability } from "../github-publication-availability.js";
import {
  STALE_WORKER_BUILD_REASON,
  StaleWorkerBuildError,
  supportsWorkerExecutionContextLaunch,
} from "./admission.js";
import { placementTurnOwner, sameWorkerSessionTurnClaim } from "./placement-record.js";
import { createRemoteExecPlacementSandbox } from "./placement-sandbox.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./placement-store.js";
import { WorkerRunnerCapacityError, WorkerRunnerUnavailableError } from "./tunnel-contract.js";
import { resolveWorkerBrowserLaunchPlan } from "./worker-browser-launch-plan.js";
import {
  claimWorkerTurn,
  executeLocalTurn,
  rejectPendingWorkerResult,
  releaseClaimIfOwned,
  requireActivePlacement,
  resolvePlacementIdentity,
  waitForTurnOperation,
} from "./worker-turn-admission.js";
import {
  failHandedOffTurn,
  WorkerTurnExecutionError,
  type ActiveWorkerPlacement,
  type WorkerTurnEnvironmentService,
} from "./worker-turn-failure.js";
import {
  assertSupportedTurn,
  assistantText,
  buildWorkerTurnResult,
  emitProviderReplayRejected,
  fitLaunchDescriptorWithRuntimeIdentity,
  parseRuntimeResult,
  prepareWorkerAgentRuntimeIdentity,
  windowInitialMessages,
} from "./worker-turn-payload.js";
import { createWorkerTurnRunOwner, type ActiveWorkerTurn } from "./worker-turn-run-owner.js";
import { resolveWorkerTurnTranscriptTarget } from "./worker-turn-transcript-target.js";
import type { WorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import {
  executeRemoteExecTurn,
  reconcileWorkspaceAfterTurn,
  recoverWorkspaceBeforeTurn,
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

async function executeWorkerTurn(params: {
  environments: WorkerTurnEnvironmentService;
  onHandoff: () => void;
  onTerminal: () => void;
  placement: ActiveWorkerPlacement;
  placements: WorkerSessionPlacementStore;
  reconcileActivePlacement: (environmentId: string) => Promise<void>;
  workspaceOperations: WorkerWorkspaceOperationCoordinator;
  turn: SessionPlacementTurnParams;
  turnClaim: WorkerSessionTurnClaim;
  localWorkspaceDir: string;
  prepareAcceptedWorkspacePublication?: (claim: WorkerSessionTurnClaim) => Promise<void>;
  publishAcceptedWorkspace?: (claim: WorkerSessionTurnClaim) => Promise<void>;
}) {
  const { placement, turn } = params;
  const modelRef = assertSupportedTurn(turn);
  const environment = params.environments.get(placement.environmentId);
  const bootstrapReceipt = environment?.bootstrapReceipt;
  // Provider reconciliation records current-build teardown before placement repair. Consume
  // that fact before launch so canonical reconciliation can persist the same cause.
  if (environment?.error === STALE_WORKER_BUILD_REASON) {
    throw new StaleWorkerBuildError();
  }
  if (
    !environment ||
    environment.state !== "attached" ||
    environment.ownerEpoch !== placement.activeOwnerEpoch ||
    !bootstrapReceipt ||
    bootstrapReceipt.bundleHash !== placement.workerBundleHash ||
    environment.attachedSessionIds.length !== 1 ||
    environment.attachedSessionIds[0] !== placement.sessionId
  ) {
    throw new Error("Active worker placement does not match its attached environment");
  }
  if (!supportsWorkerExecutionContextLaunch(bootstrapReceipt)) {
    throw new Error(
      "Active worker bundle lacks the current execution-context capability; reprovision the worker before launch",
    );
  }
  await recoverWorkspaceBeforeTurn(params);
  const githubPublicationAvailable = await prepareGitHubPublicationAvailability({
    sessionId: placement.sessionId,
    sessionKey: placement.sessionKey,
    agentId: placement.agentId,
    assertCurrent: () => params.placements.validateTurnClaim(params.turnClaim),
  });

  const startedAt = Date.now();
  turn.onExecutionStarted?.({ lifecycleGeneration: turn.lifecycleGeneration });
  turn.onExecutionPhase?.({ phase: "runner_entered", backend: "cloud-worker" });
  const transcriptTarget = resolveWorkerTurnTranscriptTarget(turn);
  const manager = SessionManager.open(transcriptTarget);
  const userMessageAlreadyPersisted =
    turn.suppressNextUserMessagePersistence === true ||
    turn.userTurnTranscriptRecorder?.hasPersisted() === true;
  const contextMessages = convertToLlm(manager.buildSessionContext().messages);
  const leaf = manager.getLeafEntry();
  const initialMessagePlan = windowInitialMessages(
    userMessageAlreadyPersisted && leaf?.type === "message" && leaf.message.role === "user"
      ? contextMessages.slice(0, -1)
      : contextMessages,
  );
  if (initialMessagePlan.kind === "provider-replay-unavailable") {
    const details = initialMessagePlan.details;
    emitProviderReplayRejected(
      turn.config,
      "bytes" in details ? details : { count: details.messageCount, reason: details.reason },
    );
    throw new WorkerTurnExecutionError(WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE);
  }
  const initialMessages = initialMessagePlan.messages;
  let baseLeafId = manager.getLeafId();
  if (!userMessageAlreadyPersisted) {
    const persisted = turn.userTurnTranscriptRecorder
      ? await turn.userTurnTranscriptRecorder.persistApproved({ cwd: params.localWorkspaceDir })
      : undefined;
    if (persisted) {
      baseLeafId = persisted.messageId;
      turn.userTurnTranscriptRecorder?.markRuntimePersisted(persisted.message, persisted.admission);
      turn.onUserMessagePersisted?.(persisted.message);
    } else if (turn.userTurnTranscriptRecorder?.hasPersisted()) {
      baseLeafId = SessionManager.open(transcriptTarget).getLeafId();
    } else if (!turn.userTurnTranscriptRecorder) {
      const message = {
        role: "user" as const,
        content: [{ type: "text" as const, text: turn.transcriptPrompt ?? turn.prompt }],
        timestamp: Date.now(),
      };
      baseLeafId = manager.appendMessage(message);
      turn.onUserMessagePersisted?.(message);
    } else {
      throw new Error("Cloud worker turn could not persist its canonical user message");
    }
  }
  turn.onExecutionPhase?.({
    phase: "model_resolution",
    backend: "cloud-worker",
    provider: modelRef.provider,
    model: modelRef.model,
  });

  const credential = await params.environments.acquireTurnCredential(params.turnClaim);
  const tunnel = await waitForTurnOperation({
    operation: params.environments.startTunnel({
      environmentId: placement.environmentId,
      ownerEpoch: placement.activeOwnerEpoch,
    }),
    ...(turn.abortSignal ? { signal: turn.abortSignal } : {}),
    timeoutMs: turn.timeoutMs,
  });
  const portalAvailable =
    Boolean(environment.nodeDeviceId) &&
    environment.sshEndpoint === null &&
    (await params.environments.supportsNodePortal?.(
      placement.environmentId,
      placement.activeOwnerEpoch,
    )) === true;
  const reasoning = mapThinkingLevelForProvider(turn.thinkLevel);
  const { browser, toolAuthority } = resolveWorkerBrowserLaunchPlan({
    desktop: environment.desktop,
    modelRef,
    turn,
    githubPublicationAvailable,
    portalAvailable,
  });
  params.placements.authorizeWorkerTurnTools(params.turnClaim, toolAuthority.allowedToolNames);
  const { operationalRunInstance, runtimeIdentity } = await prepareWorkerAgentRuntimeIdentity({
    agentId: placement.agentId,
    runtimeInstanceId: placement.environmentId,
    placements: params.placements,
    sessionKey: placement.sessionKey,
    turn,
    turnClaim: params.turnClaim,
  });
  // Project the wire handshake; the receipt also carries storage-only provenance.
  const { bundleHash, openclawVersion, protocolFeatures } = bootstrapReceipt;
  const launchPlan = await fitLaunchDescriptorWithRuntimeIdentity({
    runtimeIdentity,
    messages: initialMessages,
    build: (agentRuntimeIdentityToken, windowedMessages) =>
      parseWorkerLaunchPlan({
        version: 4,
        admission: {
          environmentId: placement.environmentId,
          credential: credential.credential,
          sessionId: placement.sessionId,
          ownerEpoch: placement.activeOwnerEpoch,
          rpcSetVersion: credential.rpcSetVersion,
          handshake: { bundleHash, openclawVersion, protocolFeatures },
        },
        assignment: {
          agentId: placement.agentId,
          operationalRunInstance,
          agentRuntimeIdentityToken,
          runId: turn.runId,
          turnId: randomUUID(),
          prompt: turn.prompt,
          suppressPromptTranscript: true,
          workspaceDir: placement.remoteWorkspaceDir,
          ...(turn.permissionMode
            ? {
                permissionMode: turn.permissionMode,
                workerContainmentRoot: placement.remoteWorkspaceDir,
              }
            : {}),
          modelRef,
          inferenceOptions: reasoning ? { reasoning } : {},
          ...(turn.extraSystemPrompt === undefined ? {} : { systemPrompt: turn.extraSystemPrompt }),
          initialMessages: windowedMessages,
          transcript: {
            baseLeafId,
            nextSeq: (placement.lastTranscriptAckCursor ?? 0) + 1,
          },
          liveEvents: {
            ackedSeq: placement.lastLiveEventAckCursor ?? 0,
            nextSeq: (placement.lastLiveEventAckCursor ?? 0) + 1,
          },
          toolAuthority,
          ...(browser ? { browser } : {}),
        },
      }),
  });
  if (launchPlan.kind === "local-fallback") {
    emitProviderReplayRejected(turn.config, {
      bytes: launchPlan.bytes,
      limitBytes: launchPlan.limitBytes,
      reason: launchPlan.reason,
    });
    throw new WorkerTurnExecutionError(WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE);
  }
  const plan = launchPlan.plan;
  turn.userTurnTranscriptRecorder?.markSentToProvider?.();
  turn.onExecutionPhase?.({ phase: "attempt_dispatch", backend: "cloud-worker" });
  const handoffAbort = new AbortController();
  let handoffError: Error | undefined;
  let dispatchReady = false;
  const onDispatchReady = () => {
    if (dispatchReady) {
      return;
    }
    dispatchReady = true;
    params.onHandoff();
    turn.onExecutionPhase?.({ phase: "process_spawned", backend: "cloud-worker" });
    try {
      if (!params.environments.acknowledgeCredentialDelivery(credential)) {
        handoffError = new Error("Cloud worker credential owner changed during process handoff");
      }
    } catch (error) {
      handoffError = new Error("Cloud worker credential handoff failed", { cause: error });
    }
    if (handoffError) {
      handoffAbort.abort(handoffError);
    }
  };
  if (!tunnel.launchTurn) {
    throw new Error("Worker tunnel does not support worker turns");
  }
  const processPromise = tunnel.launchTurn({
    plan,
    turnClaim: params.turnClaim,
    timeoutMs: turn.timeoutMs,
    credentialExpiresAtMs: credential.expiresAtMs,
    signal: turn.abortSignal
      ? AbortSignal.any([turn.abortSignal, handoffAbort.signal])
      : handoffAbort.signal,
    onDispatchReady,
  });
  const processResult = await processPromise;
  // Node launches return only after the exact launch journal receipt is terminal,
  // including any admission re-arms. Transport failures never reach this fact.
  if (environment.nodeDeviceId && environment.sshEndpoint === null) {
    params.onTerminal();
  }
  if (handoffError) {
    throw handoffError;
  }
  if (!dispatchReady) {
    throw new Error("Cloud worker launch completed before transport dispatch");
  }
  if (processResult.code !== 0 || processResult.signal !== null || processResult.killed) {
    // Boxes are destroyed on failure, so the redacted stderr tail is the only forensics.
    const detail = truncateUtf16Safe(
      redactSensitiveText(processResult.stderr, { mode: "tools" }).replace(/\s+/gu, " ").trim(),
      400,
    );
    throw new Error(
      detail
        ? `Cloud worker process failed before completing the turn: ${detail}`
        : "Cloud worker process failed before completing the turn",
    );
  }
  const runtimeResult = parseRuntimeResult(processResult.stdout);
  if (runtimeResult.status === "fenced") {
    throw new Error(`Cloud worker turn was fenced: ${runtimeResult.reason}`);
  }
  const workerTurnFailed = runtimeResult.status === "failed";

  const completed = SessionManager.open(transcriptTarget);
  const currentPlacement = params.placements.get(placement.sessionId);
  if (
    runtimeResult.transcriptLeafId !== completed.getLeafId() ||
    runtimeResult.transcriptNextSeq !== (currentPlacement?.lastTranscriptAckCursor ?? 0) + 1
  ) {
    throw new Error(
      `Cloud worker result does not match its committed transcript acknowledgement ` +
        `(leaf=${runtimeResult.transcriptLeafId ?? "none"}/${completed.getLeafId() ?? "none"}, ` +
        `nextSeq=${runtimeResult.transcriptNextSeq}/${(currentPlacement?.lastTranscriptAckCursor ?? 0) + 1})`,
    );
  }
  const terminal = runtimeResult.transcriptLeafId
    ? completed.getEntry(runtimeResult.transcriptLeafId)
    : undefined;
  if (!terminal || terminal.type !== "message" || terminal.message.role !== "assistant") {
    throw new Error("Cloud worker completed without a terminal assistant transcript message");
  }
  const text = assistantText(terminal.message);
  const baseIndex = completed.getBranch().findIndex((entry) => entry.id === baseLeafId);
  const workerMessages = completed
    .getBranch()
    .slice(baseIndex + 1)
    .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
  const workspaceConflict = await reconcileWorkspaceAfterTurn({
    placement,
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
  });
  if (workspaceConflict) {
    const reportedWorkspaceConflict = workspaceConflict;
    await Promise.resolve()
      .then(() =>
        turn.onAgentEvent?.({
          stream: "assistant",
          data: {
            text: text
              ? `${text}\n\n${reportedWorkspaceConflict.summary}`
              : reportedWorkspaceConflict.summary,
            delta: `${text ? "\n\n" : ""}${reportedWorkspaceConflict.summary}`,
          },
        }),
      )
      .catch(() => undefined);
  }
  if (workerTurnFailed) {
    throw new WorkerTurnExecutionError(terminal.message.errorMessage ?? "Cloud worker turn failed");
  }
  return buildWorkerTurnResult({
    messages: workerMessages,
    modelRef,
    terminal: terminal.message,
    durationMs: Date.now() - startedAt,
    sessionId: placement.sessionId,
    sessionFile: turn.sessionFile,
    text,
    workspaceConflictSummary: workspaceConflict?.summary,
  });
}

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
          reconcileActivePlacement: options.reconcileActivePlacement,
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
