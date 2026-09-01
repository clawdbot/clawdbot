import type {
  AgentMessage,
  AnyAgentTool,
  SandboxContext,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  resolveAttemptFsWorkspaceOnly,
  resolveAttemptSpawnWorkspaceDir,
  resolveCompactionTimeoutMs,
  runAgentHarnessAfterToolCallHook,
  runAgentHarnessAfterCompactionHook,
  runAgentHarnessBeforeCompactionHook,
  clearActiveEmbeddedRun,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { registerCopilotActiveRun } from "./attempt-active-run.js";
import { deferBackgroundCompactionCleanup } from "./attempt-cleanup.js";
import {
  createMessageOptions,
  createPromptError,
  createResult,
  isSdkSendAndWaitTimeoutError,
  readNonEmptyString,
  readResolvedAttemptPath,
  resolvePoolAcquire,
  toCopilotError,
} from "./attempt-config.js";
import { completeCopilotAttempt } from "./attempt-finalize.js";
import { resolveCopilotAttemptSandbox } from "./attempt-prepare.js";
import { createCopilotSessionSetup } from "./attempt-session-setup.js";
import {
  createAttemptTranscriptJournal,
  type AttemptTranscriptJournal,
} from "./attempt-transcript-journal.js";
import { assertCopilotAttemptHostCapabilities } from "./attempt-types.js";
import type {
  AgentHarnessAttemptResult,
  AttemptParamsLike,
  CopilotAttemptDeps,
  CopilotAgentEndHookParams,
  ModelRef,
  CopilotAttemptParams,
} from "./attempt-types.js";
import { createCopilotByokProxy } from "./byok-proxy.js";
import { attachEventBridge, type SessionLike } from "./event-bridge.js";
import { createCopilotNativeSubagentTaskMirror } from "./native-subagent-task-mirror.js";
import { classifyResumeFailure, decideReplayAction } from "./replay-shim.js";
import type { PooledClient } from "./runtime.js";
import type { CopilotUserInputBridge } from "./user-input-bridge.js";
export async function runCopilotExecution(context: {
  params: CopilotAttemptParams;
  deps: CopilotAttemptDeps;
  now: () => number;
  attemptStartedAt: number;
  settledToolFinalization: boolean;
  input: AttemptParamsLike;
  createToolBridge: NonNullable<CopilotAttemptDeps["createToolBridge"]>;
  ringZeroSystemAgentRun: boolean;
  messages: AgentMessage[];
  modelRef: ModelRef;
  resolvedWorkspaceForSandbox: string | undefined;
  sandboxSessionKey: string | undefined;
  sessionAgentId: string;
  hookContextWindowFields: {
    contextTokenBudget?: number;
    contextWindowReferenceTokens?: number;
    contextWindowSource?: NonNullable<AttemptParamsLike["contextWindowInfo"]>["source"];
  };
  hookContext: CopilotAgentEndHookParams["ctx"];
  finishAttempt: (result: AgentHarnessAttemptResult) => Promise<AgentHarnessAttemptResult>;
  settledFinalizationSessionId: string | undefined;
}): Promise<AgentHarnessAttemptResult> {
  const {
    params,
    deps,
    now,
    attemptStartedAt,
    settledToolFinalization,
    input,
    createToolBridge,
    ringZeroSystemAgentRun,
    messages,
    modelRef,
    resolvedWorkspaceForSandbox,
    sandboxSessionKey,
    sessionAgentId,
    hookContextWindowFields,
    hookContext,
    finishAttempt,
    settledFinalizationSessionId,
  } = context;
  let abortRequested = false;
  let aborted = false;
  let externalAbort = false;
  let settled = false;
  let sentTurnStarted = false;
  let settledFinalizationAssistantCompleted = false;
  let timedOutDuringCompaction = false;
  let timedOut = false;
  let promptError: Error | undefined;
  let sdkSessionId: string | undefined;
  // Resumed sessions may predate the atomic journal or survive a crash. Only a
  // session created under this journal can be deleted after incomplete cleanup.
  let nativeSessionCreatedFresh = false;
  let nativeSessionHistoryValidated = false;
  let disconnectError: Error | undefined;
  let handle: PooledClient | undefined;
  let session: SessionLike | undefined;
  let bridge: ReturnType<typeof attachEventBridge> | undefined;
  let transcriptJournal: AttemptTranscriptJournal | undefined;
  let initialSdkUserValidated = false;
  const nativeSubagentTaskMirror = createCopilotNativeSubagentTaskMirror({
    agentId: sessionAgentId,
    now,
    scope: input.agentHarnessTaskRuntimeScope,
  });
  let activeRunHandleRef: ReturnType<typeof registerCopilotActiveRun> | undefined;
  let userInputBridgeRef: CopilotUserInputBridge | undefined;
  let cleanupToolBridge: (() => void) | undefined;
  let releaseError: Error | undefined;
  let downgradedFromResume = false;
  let resumeFailureRecovered = false;
  let yieldDetected = false;
  let yieldAcknowledgment: string | undefined;
  let lastToolError: AgentHarnessAttemptResult["lastToolError"];
  const hostObserveToolTerminal = input.observeToolTerminal;
  const observeToolTerminal = hostObserveToolTerminal
    ? (observation: Parameters<typeof hostObserveToolTerminal>[0]) => {
        const terminal = hostObserveToolTerminal(observation);
        lastToolError = terminal.lastToolError;
        return terminal;
      }
    : undefined;
  const markExternalAbort = () => {
    abortRequested = true;
    externalAbort = true;
    aborted = true;
  };
  const abortActiveSession = () => {
    markExternalAbort();
    if (settled || !sentTurnStarted || !session) {
      return;
    }
    void session.abort().catch(() => undefined);
  };
  const onAbort = () => {
    abortActiveSession();
  };
  params.abortSignal?.addEventListener("abort", onAbort, { once: true });
  let sandbox: SandboxContext | null = null;
  let effectiveWorkspaceDir = resolvedWorkspaceForSandbox;
  if (resolvedWorkspaceForSandbox) {
    try {
      ({ sandbox, effectiveWorkspaceDir } = await resolveCopilotAttemptSandbox({
        deps,
        input,
        resolvedWorkspaceForSandbox,
        sandboxSessionKey,
      }));
    } catch (error: unknown) {
      settled = true;
      params.abortSignal?.removeEventListener("abort", onAbort);
      if (abortRequested || params.abortSignal?.aborted) {
        return finishAttempt(
          createResult(input, {
            aborted: true,
            externalAbort: true,
            messagesSnapshot: messages,
            now,
            promptError: undefined,
            sdkSessionId: undefined,
          }),
        );
      }
      return finishAttempt(
        createResult(input, {
          messagesSnapshot: messages,
          now,
          promptError: createPromptError(
            "sandbox_resolution_failure",
            `[copilot-attempt] sandbox resolution failed: ${toCopilotError(error).message}`,
            error,
          ),
          sdkSessionId: undefined,
        }),
      );
    }
  }
  hookContext.workspaceDir = effectiveWorkspaceDir;
  const requestedCwd = readResolvedAttemptPath(input.cwd);
  if (sandbox?.enabled && requestedCwd && requestedCwd !== resolvedWorkspaceForSandbox) {
    settled = true;
    params.abortSignal?.removeEventListener("abort", onAbort);
    return finishAttempt(
      createResult(input, {
        messagesSnapshot: messages,
        now,
        promptError: createPromptError(
          "sandbox_cwd_override_unsupported",
          "[copilot-attempt] cwd override is not supported for sandboxed Copilot runs; omit cwd or use the agent workspace as cwd",
        ),
        sdkSessionId: undefined,
      }),
    );
  }
  const effectiveCwd = sandbox?.enabled
    ? effectiveWorkspaceDir
    : (requestedCwd ?? effectiveWorkspaceDir);
  const effectiveFsWorkspaceOnly = resolveAttemptFsWorkspaceOnly({
    config: input.config,
    sessionAgentId,
  });
  const sandboxAwareSpawnWorkspaceDir = resolvedWorkspaceForSandbox
    ? resolveAttemptSpawnWorkspaceDir({
        sandbox,
        resolvedWorkspace: resolvedWorkspaceForSandbox,
      })
    : undefined;
  const resolvedPoolAcquire = resolvePoolAcquire(input);
  const poolAcquire = settledToolFinalization
    ? {
        ...resolvedPoolAcquire,
        options: {
          ...resolvedPoolAcquire.options,
          mode: "empty" as const,
        },
      }
    : resolvedPoolAcquire;
  let byokProxy: Awaited<ReturnType<typeof createCopilotByokProxy>>;
  try {
    byokProxy = await createCopilotByokProxy(poolAcquire.provider);
  } catch (error) {
    return finishAttempt(
      createResult(input, {
        messagesSnapshot: messages,
        now,
        promptError: createPromptError("model_not_supported", toCopilotError(error).message, error),
        sdkSessionId: undefined,
      }),
    );
  }
  const cleanupByokProxy = byokProxy?.close;
  const sessionProvider = byokProxy?.provider ?? poolAcquire.provider;
  const sessionRef: { current: SessionLike | undefined } = { current: undefined };
  const computerContextEpoch: {
    value: number;
    frameToolCallId?: string;
    frameImageIdentity?: string;
  } = { value: 0 };
  let codeModeEngaged: boolean | undefined;
  let promptToolPolicy:
    | Awaited<ReturnType<typeof createToolBridge>>["promptToolPolicy"]
    | undefined;
  try {
    let resultContentSourceByToolName = new Map<
      string,
      NonNullable<AnyAgentTool["resultContentSource"]>
    >();
    if (!settledToolFinalization) {
      try {
        assertCopilotAttemptHostCapabilities(input);
        const toolBridge = await createToolBridge({
          allowModelTools: poolAcquire.provider.mode === "byok",
          modelProvider: modelRef.provider,
          modelId: modelRef.id,
          agentId: readNonEmptyString(params.agentId) ?? "copilot",
          sessionId: readNonEmptyString(input.sessionId) ?? "copilot-session",
          sessionKey: readNonEmptyString((input as { sessionKey?: unknown }).sessionKey),
          agentDir: readNonEmptyString(input.agentDir),
          workspaceDir: effectiveWorkspaceDir,
          cwd: effectiveCwd,
          sandbox,
          spawnWorkspaceDir: sandboxAwareSpawnWorkspaceDir,
          abortSignal: params.abortSignal,
          attemptParams: observeToolTerminal ? { ...input, observeToolTerminal } : input,
          computerContextEpoch,
          sessionRef,
          onYieldDetected: (_message, acknowledgment) => {
            yieldDetected = true;
            yieldAcknowledgment = acknowledgment;
          },
          onToolCompleted: ({ args, error, result, startedAt, toolCallId, toolName }) =>
            runAgentHarnessAfterToolCallHook({
              toolName,
              toolCallId,
              runId: input.runId,
              agentId: sessionAgentId,
              sessionId: input.sessionId,
              sessionKey: hookContext.sessionKey,
              channelId: hookContext.channelId,
              startArgs: args,
              ...(result !== undefined ? { result } : {}),
              ...(error ? { error } : {}),
              startedAt,
            }),
        });
        cleanupToolBridge = toolBridge.cleanup;
        codeModeEngaged = toolBridge.codeModeEngaged;
        promptToolPolicy = toolBridge.promptToolPolicy;
        resultContentSourceByToolName = new Map(
          toolBridge.sourceTools.flatMap((tool) =>
            tool.resultContentSource ? [[tool.name, tool.resultContentSource] as const] : [],
          ),
        );
      } catch (error: unknown) {
        const result = createResult(input, {
          messagesSnapshot: messages,
          now,
          promptError: createPromptError(
            "tool_bridge_failure",
            `[copilot-attempt] tool-bridge construction failed: ${toCopilotError(error).message}`,
            error,
          ),
          sdkSessionId: undefined,
        });
        return finishAttempt(result);
      }
    }
    handle = await deps.pool.acquire(poolAcquire.key, poolAcquire.options);
    const client = handle.client;
    const sessionSetup = await createCopilotSessionSetup({
      attempt: input,
      byokProxy,
      effectiveCwd,
      effectiveWorkspaceDir,
      hookContext,
      modelRef,
      messages,
      operation: deps.operation,
      poolAcquire,
      ringZeroSystemAgentRun,
      promptToolPolicy,
      sessionProvider,
      settledToolFinalization,
      signal: params.abortSignal,
    });
    const {
      attemptInput,
      compactionSessionConfig,
      emitLlmInput,
      hasNativePromptHook,
      sessionConfig,
      userInputBridge,
    } = sessionSetup;
    userInputBridgeRef = userInputBridge;
    const replayDecision = decideReplayAction({
      sdkSessionId: input.initialReplayState?.sdkSessionId,
      replayInvalid: input.initialReplayState?.replayInvalid,
    });
    downgradedFromResume = replayDecision.downgradedFromResume;
    const resumeSessionId = settledToolFinalization
      ? settledFinalizationSessionId
      : replayDecision.action === "resume"
        ? replayDecision.sdkSessionId
        : undefined;
    if (resumeSessionId) {
      try {
        session = (await client.resumeSession(resumeSessionId, {
          ...sessionConfig,
          continuePendingWork: false,
          // Settled finalization must not replay lifecycle from the completed turn.
          ...(settledToolFinalization ? { suppressResumeEvent: true } : {}),
        })) as unknown as SessionLike;
        nativeSessionHistoryValidated = input.initialReplayState?.journalValidated === true;
      } catch (error: unknown) {
        if (settledToolFinalization) {
          throw createPromptError(
            "settled_finalization_resume_failed",
            `[copilot-attempt] settled tool finalization could not resume the existing Copilot SDK session: ${toCopilotError(error).message}`,
            error,
          );
        }
        const classification = classifyResumeFailure(error);
        if (!classification.recoverable) {
          throw error;
        }
        resumeFailureRecovered = true;
        session = (await client.createSession(sessionConfig)) as unknown as SessionLike;
        nativeSessionCreatedFresh = true;
        nativeSessionHistoryValidated = true;
      }
    } else {
      session = (await client.createSession(sessionConfig)) as unknown as SessionLike;
      nativeSessionCreatedFresh = true;
      nativeSessionHistoryValidated = true;
    }
    sessionRef.current = session;
    sdkSessionId =
      readNonEmptyString(session.sessionId) ??
      readNonEmptyString(session.id) ??
      (resumeFailureRecovered ? undefined : resumeSessionId);
    if (!sdkSessionId) {
      throw createPromptError(
        "transcript_persistence_failed",
        "[copilot-attempt] canonical transcript persistence requires the Copilot SDK session id",
      );
    }
    if (sdkSessionId && deps.onSessionEstablished && !settledToolFinalization) {
      try {
        deps.onSessionEstablished({
          compactionSessionConfig,
          sdkSessionId,
          pooledClient: handle,
          sessionConfig,
        });
      } catch {}
    }
    transcriptJournal = createAttemptTranscriptJournal({
      abortSession: () => session?.abort() ?? Promise.resolve(),
      attempt: input,
      messages,
      onInitialSdkUserValidated: () => {
        initialSdkUserValidated = true;
      },
      sdkSessionId,
    });
    bridge = attachEventBridge(session, {
      onAssistantDelta: settledToolFinalization ? undefined : input.onAssistantDelta,
      onAgentEvent: settledToolFinalization ? undefined : input.onAgentEvent,
      onNativeSubagentEvent: (event) => nativeSubagentTaskMirror?.handleEvent(event),
      onContextCompacted: () => {
        computerContextEpoch.value += 1;
        delete computerContextEpoch.frameToolCallId;
        delete computerContextEpoch.frameImageIdentity;
      },
      onCompactionStart: async () => {
        if (settledToolFinalization) {
          return;
        }
        const sessionFile = readNonEmptyString(input.sessionFile);
        if (!sessionFile) {
          return;
        }
        await runAgentHarnessBeforeCompactionHook({
          sessionFile,
          ctx: hookContext,
        });
      },
      onCompactionComplete: async ({ messagesRemoved, success }) => {
        if (settledToolFinalization) {
          return;
        }
        const sessionFile = readNonEmptyString(input.sessionFile);
        if (!success || !sessionFile) {
          return;
        }
        await runAgentHarnessAfterCompactionHook({
          sessionFile,
          compactedCount: messagesRemoved ?? -1,
          ctx: hookContext,
        });
      },
      getSdkSessionId: () => sdkSessionId,
      isAborted: () => aborted || transcriptJournal?.hasFailed() === true,
      transcriptProjection: {
        journal: transcriptJournal,
        modelRef,
        now,
        resultContentSourceByToolName,
      },
    });
    if (!settledToolFinalization) {
      assertCopilotAttemptHostCapabilities(input);
      if (!userInputBridge) {
        throw new Error("[copilot-attempt] ordinary attempts require a user-input bridge");
      }
      activeRunHandleRef = registerCopilotActiveRun({
        abortActiveSession,
        bridge,
        canAcceptSteering: () => initialSdkUserValidated,
        startedAtMs: input.startedAtMs,
        input,
        isAborted: () => aborted,
        isSettled: () => settled,
        session,
        transcriptJournal,
        userInputBridge,
      });
    }
    const messageOptions = await createMessageOptions(attemptInput, {
      effectiveCwd,
      effectiveWorkspaceDir,
      provider: poolAcquire.provider,
      sandbox,
      workspaceOnly: effectiveFsWorkspaceOnly,
    });
    sessionSetup.setPromptImagesCount(messageOptions.attachments?.length ?? 0);
    if (!settledToolFinalization) {
      await transcriptJournal.persistInitialUser();
    }
    if (abortRequested || params.abortSignal?.aborted) {
      aborted = true;
      externalAbort = true;
    } else {
      sentTurnStarted = true;
      input.userTurnTranscriptRecorder?.markSentToProvider?.();
      if (!hasNativePromptHook) {
        emitLlmInput(attemptInput.prompt);
      }
      const result = await session.sendAndWait(messageOptions, input.timeoutMs);
      await bridge.awaitDeltaChain();
      await bridge.awaitAgentEventChain();
      const assistantCompleted = bridge.recordSendResult(result);
      await transcriptJournal.barrier("sendAndWait");
      settledFinalizationAssistantCompleted = settledToolFinalization && assistantCompleted;
      if (!assistantCompleted && !aborted) {
        timedOut = true;
        timedOutDuringCompaction = bridge.isCompacting();
      }
      const snap = bridge.snapshot();
      if (!promptError && !timedOut && !aborted && snap.streamError) {
        promptError = snap.streamError;
      }
    }
  } catch (error: unknown) {
    if (!aborted) {
      if (isSdkSendAndWaitTimeoutError(error)) {
        timedOut = true;
        timedOutDuringCompaction = bridge?.isCompacting() === true;
        try {
          await bridge?.awaitDeltaChain();
        } catch {}
        await bridge?.awaitAgentEventChain();
        bridge?.flushTranscriptProjection();
        try {
          await transcriptJournal?.barrier("timeout");
        } catch (transcriptError) {
          promptError = toCopilotError(transcriptError);
        }
      } else {
        try {
          bridge?.flushTranscriptProjection();
          await transcriptJournal?.barrier("attempt error");
          promptError = toCopilotError(error);
        } catch (transcriptError) {
          promptError = toCopilotError(transcriptError);
        }
      }
    }
  } finally {
    settled = true;
    try {
      bridge?.flushTranscriptProjection();
      await transcriptJournal?.barrier("bridge detach");
    } catch (transcriptError) {
      promptError = toCopilotError(transcriptError);
    }
    userInputBridgeRef?.cancelPending();
    if (activeRunHandleRef) {
      input.replyOperation?.detachBackend(activeRunHandleRef);
      clearActiveEmbeddedRun(
        input.sessionId,
        activeRunHandleRef,
        input.sessionKey,
        input.sessionFile,
      );
    }
    const journalSnapshot = transcriptJournal?.snapshot();
    const initialUserValidated =
      !sentTurnStarted ||
      settledToolFinalization ||
      journalSnapshot?.initialSdkUserValidated === true;
    const retainSessionForDeferredCleanup =
      journalSnapshot?.replayInvalid !== true &&
      (bridge?.hasObservedCompaction() || (timedOut && bridge?.hasObservedSessionIdle() === false));
    if (retainSessionForDeferredCleanup && bridge && session && handle) {
      const cleanupAbort = new AbortController();
      const abortCleanup = () => cleanupAbort.abort();
      if (params.abortSignal?.aborted) {
        abortCleanup();
      } else {
        params.abortSignal?.addEventListener("abort", abortCleanup, { once: true });
      }
      const cleanup = deferBackgroundCompactionCleanup({
        abortSignal: cleanupAbort.signal,
        awaitSessionIdle: !bridge.hasObservedSessionIdle(),
        bridge,
        cleanupToolBridge,
        cleanupByokProxy,
        deleteSessionOnIncompleteCleanup: nativeSessionCreatedFresh && initialUserValidated,
        finalizeNativeSubagents: () => nativeSubagentTaskMirror?.finalizeActiveRuns(),
        handle,
        pool: deps.pool,
        sdkSessionId,
        session,
        timeoutMs: resolveCompactionTimeoutMs(input.config),
      });
      void cleanup
        .finally(() => {
          params.abortSignal?.removeEventListener("abort", abortCleanup);
        })
        .catch(() => undefined);
      if (sdkSessionId && !settledToolFinalization) {
        try {
          deps.onDeferredCompaction?.({
            abort: () => cleanupAbort.abort(),
            cleanup,
            sdkSessionId,
          });
        } catch {}
      }
      params.abortSignal?.removeEventListener("abort", onAbort);
    } else {
      await bridge?.awaitCompactionChain();
      await bridge?.awaitAgentEventChain();
      nativeSubagentTaskMirror?.finalizeActiveRuns();
      cleanupToolBridge?.();
      await cleanupByokProxy?.();
      bridge?.detach();
      params.abortSignal?.removeEventListener("abort", onAbort);
      if (session) {
        try {
          await session.disconnect();
        } catch (error: unknown) {
          disconnectError = toCopilotError(error);
          if (!promptError && !timedOut) {
            promptError = disconnectError;
          }
        }
      }
      if (handle) {
        try {
          await deps.pool.release(handle);
        } catch (error: unknown) {
          const releaseFailure = toCopilotError(error);
          if (promptError) {
            console.warn(
              "[copilot-attempt] pool.release failed after primary error",
              releaseFailure,
            );
          } else {
            releaseError = releaseFailure;
          }
        }
      }
    }
  }
  return await completeCopilotAttempt({
    aborted,
    attemptStartedAt,
    bridge,
    codeModeEngaged,
    downgradedFromResume,
    externalAbort,
    hookContext,
    hookContextWindowFields,
    input,
    lastToolError,
    messages,
    nativeSessionHistoryUnvalidated: !nativeSessionHistoryValidated,
    transcriptJournal,
    modelRef,
    now,
    promptError,
    releaseError,
    resumeFailureRecovered,
    sdkSessionId,
    sentTurnStarted,
    settledFinalizationAssistantCompleted,
    settledToolFinalization,
    timedOut,
    timedOutDuringCompaction,
    yieldDetected,
    yieldAcknowledgment,
  });
}
