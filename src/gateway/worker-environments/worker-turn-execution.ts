import { randomUUID } from "node:crypto";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { mapThinkingLevelForProvider } from "../../agents/embedded-agent-runner/utils.js";
import { convertToLlm } from "../../agents/sessions/messages.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  getActiveAgentRunDelegatedAuthority,
  registerAgentRunDelegatedAuthorityClosedHandler,
} from "../../infra/agent-run-registry.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { buildPersistedUserTurnMessage } from "../../sessions/user-turn-transcript.js";
import { parseWorkerLaunchPlan } from "../../worker/launch-descriptor.js";
import { WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE } from "../../worker/transcript-message.js";
import { prepareGitHubPublicationAvailability } from "../github-publication-availability.js";
import {
  STALE_WORKER_BUILD_REASON,
  StaleWorkerBuildError,
  supportsWorkerExecutionContextLaunch,
} from "./admission.js";
import { sameWorkerSessionTurnClaim } from "./placement-record.js";
import { resolveWorkerBrowserLaunchPlan } from "./worker-browser-launch-plan.js";
import { waitForTurnOperation } from "./worker-turn-admission.js";
import {
  WorkerTurnExecutionError,
  type WorkerTurnEnvironmentService,
} from "./worker-turn-failure.js";
import { prepareWorkerTurnMedia } from "./worker-turn-media.js";
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
import { resolveWorkerTurnTranscriptTarget } from "./worker-turn-transcript-target.js";
import {
  type executeRemoteExecTurn,
  reconcileWorkspaceAfterTurn,
  recoverWorkspaceBeforeTurn,
} from "./workspace-result-finalize.js";

export async function executeWorkerTurn(
  params: Omit<Parameters<typeof executeRemoteExecTurn>[0], "environments" | "runLocal"> & {
    environments: WorkerTurnEnvironmentService;
    onTerminal: () => void;
  },
) {
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
  const history =
    userMessageAlreadyPersisted && leaf?.type === "message" && leaf.message.role === "user"
      ? contextMessages.slice(0, -1)
      : contextMessages;
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
    } else if (turn.userTurnTranscriptRecorder) {
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
  const { operationalRunInstance, runtimeIdentity, assertActive } =
    await prepareWorkerAgentRuntimeIdentity({
      agentId: placement.agentId,
      runtimeInstanceId: placement.environmentId,
      placements: params.placements,
      sessionKey: placement.sessionKey,
      turn,
      turnClaim: params.turnClaim,
    });
  const authority = getActiveAgentRunDelegatedAuthority(operationalRunInstance);
  const authorityAbort = new AbortController();
  const signal = turn.abortSignal
    ? AbortSignal.any([turn.abortSignal, authorityAbort.signal])
    : authorityAbort.signal;
  const cancel = () => authorityAbort.abort(new Error("Worker turn authority closed"));
  // Keep exact closure wired through transfer and launch dispatch, including awaited
  // node readiness. The workspace/tunnel lifetime alone outlives this admitted turn.
  const stopWatchingRun = registerAgentRunDelegatedAuthorityClosedHandler((closed) => {
    if (closed === authority) {
      cancel();
    }
  });
  const stopWatchingClaim = params.placements.registerTurnClaimClosedHandler((closed) => {
    if (closed.owner.kind === "worker" && sameWorkerSessionTurnClaim(closed, params.turnClaim)) {
      cancel();
    }
  });
  try {
    const isAuthorized = () => {
      try {
        assertActive();
        signal.throwIfAborted();
        const current = params.environments.get(placement.environmentId);
        return (
          params.placements.validateTurnClaim(params.turnClaim) &&
          current?.state === "attached" &&
          current.ownerEpoch === placement.activeOwnerEpoch &&
          current.attachedSessionIds.length === 1 &&
          current.attachedSessionIds[0] === placement.sessionId
        );
      } catch {
        return false;
      }
    };
    const media = await prepareWorkerTurnMedia({
      turn,
      history,
      localWorkspaceDir: params.localWorkspaceDir,
      remoteWorkspaceDir: placement.remoteWorkspaceDir,
      tunnel,
      isAuthorized,
      signal,
    });
    if (!userMessageAlreadyPersisted && !turn.userTurnTranscriptRecorder) {
      const canonical = buildPersistedUserTurnMessage({
        text: turn.transcriptPrompt ?? turn.prompt,
        media: turn.media,
        mediaImageLayout: {
          slots: media.imageFactIndexes.map((factIndex) => ({
            kind: "inline" as const,
            ...(factIndex === null ? {} : { factIndex }),
          })),
        },
      });
      const message = {
        ...canonical,
        content: [
          { type: "text" as const, text: turn.transcriptPrompt ?? turn.prompt },
          ...media.images,
        ],
        __openclaw: {
          ...canonical["__openclaw"],
          mediaImageBlockFactIndexes: media.imageFactIndexes,
        },
      };
      baseLeafId = manager.appendMessage(message);
      turn.onUserMessagePersisted?.(message);
    }
    const initialMessagePlan = windowInitialMessages(media.history);
    if (initialMessagePlan.kind === "provider-replay-unavailable") {
      const details = initialMessagePlan.details;
      emitProviderReplayRejected(
        turn.config,
        "bytes" in details ? details : { count: details.messageCount, reason: details.reason },
      );
      throw new WorkerTurnExecutionError(WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE);
    }
    // Project the wire handshake; the receipt also carries storage-only provenance.
    const { bundleHash, openclawVersion, protocolFeatures } = bootstrapReceipt;
    const launchPlan = await fitLaunchDescriptorWithRuntimeIdentity({
      runtimeIdentity,
      messages: initialMessagePlan.messages,
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
            prompt: media.prompt,
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
            ...(turn.extraSystemPrompt === undefined
              ? {}
              : { systemPrompt: turn.extraSystemPrompt }),
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
    if (!isAuthorized()) {
      throw new Error("Worker turn authority changed while preparing its launch");
    }
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
      signal: AbortSignal.any([signal, handoffAbort.signal]),
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
      throw new WorkerTurnExecutionError(
        terminal.message.errorMessage ?? "Cloud worker turn failed",
      );
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
  } finally {
    stopWatchingClaim();
    stopWatchingRun();
  }
}
