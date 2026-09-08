/** Runs prompt assembly, admission, submission, and prompt-local recovery. */
import { formatErrorMessage } from "../../../infra/errors.js";
import {
  mergeAgentRunAttemptTerminal,
  projectAgentRunAttemptTerminal,
  setAgentRunAttemptTerminalFailure,
  type AgentRunAttemptFailureSource,
} from "../../agent-run-terminal-outcome.js";
import { resolvePendingRuntimeContextReplay } from "../../internal-runtime-context.js";
import {
  createCompactionRequestBudget,
  type CompactionRequestBudget,
} from "../../sessions/compaction/request-budget.js";
import { releasePendingAgentSteeringItems } from "../../subagents/registry/subagent-registry.js";
import { prepareGooglePromptCacheStreamFn } from "../google-prompt-cache.js";
import { log } from "../logger.js";
import { persistToolResultProjections } from "../session-prompt-state.js";
import { resolveEmbeddedAgentApiKey } from "../stream-resolution.js";
import { isOpenClawAbortableWrapper } from "./abortable.js";
import { runEmbeddedAttemptBeforeAgentRun } from "./attempt-before-agent-run.js";
import type { EmbeddedAttemptExecutionPhaseInput } from "./attempt-execution-types.js";
import {
  prepareEmbeddedAttemptPromptAssembly,
  prepareEmbeddedAttemptPromptContext,
} from "./attempt-prompt-build.js";
import {
  handleEmbeddedAttemptMidTurnPrecheck,
  prepareEmbeddedAttemptPromptPreflight,
} from "./attempt-prompt-preflight.js";
import {
  handleEmbeddedAttemptPromptError,
  submitEmbeddedAttemptPrompt,
} from "./attempt-prompt-submit.js";
import { observeEmbeddedAttemptPrompt } from "./attempt-prompt-support.js";
import type { PreparedStreamRuntime } from "./attempt-stream-runtime.types.js";
import { removeTrailingMidTurnPrecheckAssistantError } from "./attempt-transcript-helpers.js";
import type { MidTurnPrecheckRequest } from "./midturn-precheck.js";
import { prepareEmbeddedAttemptPromptExecution } from "./prompt-image-preparation.js";

type PromptAssemblyResult = Awaited<ReturnType<typeof prepareEmbeddedAttemptPromptAssembly>>;
type PromptPreflightState = Parameters<typeof prepareEmbeddedAttemptPromptPreflight>[0]["state"];

export type EmbeddedAttemptPromptState = Pick<
  PromptPreflightState,
  "contextBudgetStatus" | "preflightRecovery"
> & {
  finalPromptText?: string;
  yieldAborted: boolean;
};

export async function runEmbeddedAttemptPromptPhase(
  input: EmbeddedAttemptExecutionPhaseInput & { preparedStreamRuntime: PreparedStreamRuntime },
  promptState: EmbeddedAttemptPromptState,
): Promise<{ promptStartedAt: number; transcriptLeafId: string | null }> {
  const {
    attempt,
    activeContextEngine,
    isRawModelRun,
    prepared,
    preparedStreamRuntime,
    runAbortController,
  } = input;
  const { sessionRuntime, promptToolPolicy } = prepared;
  const {
    agentSession: { activeSession, hookRunner, setActiveSessionSystemPrompt, settingsManager },
    boundary: {
      boundaryTimezone,
      includeBoundaryTimestamp,
      orphanRepair,
      setCurrentUserTimestampOverride,
    },
    cacheTrace,
    contextGuards,
    preparedUserTurnMessage,
    sessionManager,
    sessionPromptState,
    state: sessionRuntimeState,
    toolResultPromptProjectionState,
    trajectoryRecorder,
    transcriptPolicy: { appendOnlyRuntimeContext },
    transport: {
      effectiveAgentTransport,
      effectiveExtraParams,
      streamStrategy,
      compactionReplayEnabled,
    },
  } = sessionRuntime;
  const { effectiveFsWorkspaceOnly, effectiveWorkspace, sandbox, sessionAgentId } = input.setup;
  const {
    history: {
      contextEngineAssemblySucceeded,
      contextEnginePromptAuthority,
      unwindowedContextEngineMessagesForPrecheck,
    },
    promptActiveSession,
    stream: { stopAcceptingSteerMessages },
  } = preparedStreamRuntime;
  const { withOwnedTranscriptWrite } = input.sessionLock;
  const { diagnosticTrace, runTrace } = input.diagnostics;
  const { systemPromptReport, runtimeInfo } = prepared.systemPrompt;
  // Hook phases retain the prompt snapshot prepared before assembly.
  const systemPromptText = sessionRuntimeState.systemPromptText;
  const toolSearchCompacted = prepared.toolCatalog.toolSearch.compacted;
  let skipPromptSubmission = false;
  let leasedSteering: PromptAssemblyResult["leasedSteering"];

  const setFailure = (error: unknown, source: AgentRunAttemptFailureSource | null) => {
    input.state.terminal = setAgentRunAttemptTerminalFailure(
      input.state.terminal,
      error !== null && error !== undefined ? { error, source: source ?? "prompt" } : null,
    );
  };
  const publishDispatchState = (state: PromptPreflightState) => {
    skipPromptSubmission = state.skipPromptSubmission;
    promptState.contextBudgetStatus = state.contextBudgetStatus;
    promptState.preflightRecovery = state.preflightRecovery;
    setFailure(state.promptError, state.promptErrorSource);
  };
  const releaseLeasedSteering = (error?: unknown) => {
    if (!leasedSteering) {
      return;
    }
    releasePendingAgentSteeringItems({
      runIds: leasedSteering.runIds,
      leaseId: leasedSteering.leaseId,
      error: error ? formatErrorMessage(error) : undefined,
    });
    leasedSteering = undefined;
  };
  const handleMidTurnPrecheckRequest = (request: MidTurnPrecheckRequest) => {
    const outcome = handleEmbeddedAttemptMidTurnPrecheck({
      attempt,
      request,
      sessionAgentId,
      sessionManager,
      toolResultPromptProjectionState,
      prePromptMessageCount: sessionRuntimeState.prePromptMessageCount,
      replaceSessionMessages: (messages) => {
        activeSession.agent.state.messages = messages;
      },
    });
    promptState.preflightRecovery = outcome.preflightRecovery;
    if (outcome.promptError) {
      setFailure(outcome.promptError, "precheck");
    }
  };

  const promptStartedAt = Date.now();

  const promptAssembly = await prepareEmbeddedAttemptPromptAssembly({
    attempt,
    activeSession,
    sessionManager,
    hookRunner,
    hookAgentId: sessionAgentId,
    diagnosticTrace,
    isRawModelRun,
    ...(orphanRepair ? { orphanRepair } : {}),
    sessionAgentId,
    runtimeModel: runtimeInfo.model,
    systemPromptText,
    setActiveSessionSystemPrompt,
    applyPromptBuildToolsAllow: (toolsAllow) => {
      return promptToolPolicy.apply(toolsAllow).activeToolNames;
    },
    setLeasedSteering: (lease) => {
      leasedSteering = lease;
    },
  });
  if (prepared.toolCatalog.emptyExplicitToolAllowlistError) {
    setFailure(prepared.toolCatalog.emptyExplicitToolAllowlistError, "precheck");
    skipPromptSubmission = true;
    log.warn(`[tools] ${prepared.toolCatalog.emptyExplicitToolAllowlistError.message}`);
  }
  const { hookCtx, promptBuildPrependContext, promptBuildAppendContext, transcriptLeafId } =
    promptAssembly;
  leasedSteering = promptAssembly.leasedSteering ?? leasedSteering;

  try {
    const promptContext = prepareEmbeddedAttemptPromptContext({
      sessionVersion: sessionManager.getHeader()?.version,
      attempt,
      capabilityToolNames: prepared.toolCatalog.toolSearchRunPlan.capabilityToolNames,
      messages: activeSession.messages,
      prompt: promptAssembly,
      replaceSessionMessages: (messages) => {
        activeSession.agent.state.messages = messages;
      },
      appendOnlyRuntimeContext,
      ...(boundaryTimezone ? { boundaryTimezone } : {}),
      includeBoundaryTimestamp,
      isRawModelRun,
      ...(preparedUserTurnMessage ? { preparedUserTurnMessage } : {}),
      sessionAgentId,
      setActiveSessionSystemPrompt,
      ...(systemPromptReport ? { systemPromptReport } : {}),
      systemPromptText,
      toolResultPromptProjectionState,
    });
    const { hookMessagesForCurrentPrompt, promptForModel, systemPromptForHook } = promptContext;
    sessionRuntimeState.prePromptMessageCount = promptContext.prePromptMessageCount;
    setCurrentUserTimestampOverride(promptContext.currentUserTimestampOverride);
    const beforeAgentRunOutcome =
      attempt.operation === "settled-tool-finalization"
        ? undefined
        : await runEmbeddedAttemptBeforeAgentRun({
            attempt,
            activeSession,
            hookContext: hookCtx,
            hookMessages: hookMessagesForCurrentPrompt,
            hookRunner,
            modelPrompt: promptForModel,
            sessionManager,
            systemPrompt: systemPromptForHook,
            withOwnedTranscriptWrite,
          });
    if (beforeAgentRunOutcome) {
      input.state.beforeAgentRunBlockedBy = beforeAgentRunOutcome.blockedBy;
      setFailure(beforeAgentRunOutcome.promptError, "hook:before_agent_run");
      skipPromptSubmission = true;
    }

    if (!skipPromptSubmission) {
      const { resolvedApiKey } = attempt;
      const googlePromptCacheStreamFn = await prepareGooglePromptCacheStreamFn({
        apiKey: await resolveEmbeddedAgentApiKey({
          provider: attempt.provider,
          resolvedApiKey,
          authStorage: attempt.authStorage,
        }),
        extraParams: effectiveExtraParams,
        model: attempt.model,
        modelId: attempt.modelId,
        provider: attempt.provider,
        sessionManager: {
          appendCustomEntry: async (customType, data) => {
            await withOwnedTranscriptWrite(() => {
              sessionManager.appendCustomEntry(customType, data);
            });
          },
          getEntries: () => sessionManager.getEntries(),
        },
        signal: runAbortController.signal,
        streamFn: activeSession.agent.streamFn,
      });
      if (googlePromptCacheStreamFn) {
        activeSession.agent.streamFn = googlePromptCacheStreamFn;
      }
      const { onModelRequest } = preparedStreamRuntime.cache;
      if (onModelRequest) {
        const streamFn = activeSession.agent.streamFn;
        activeSession.agent.streamFn = (model, context, options) => {
          // Observe canonical inputs before managed caches consume system/tools.
          if (!activeSession.isCompacting) {
            onModelRequest(model, context);
          }
          return streamFn(model, context, options);
        };
      }
    }

    const imageResult = await prepareEmbeddedAttemptPromptExecution({
      mediaOwnerAgentId: sessionAgentId,
      effectiveFsWorkspaceOnly,
      effectiveWorkspace,
      sandbox,
      attempt,
      prompt: promptContext.promptSubmission.prompt,
      skipPromptSubmission,
    });
    const reserveTokens = settingsManager.getCompactionReserveTokens();
    const terminal = projectAgentRunAttemptTerminal(input.state.terminal);
    let state: PromptPreflightState = {
      contextBudgetStatus: promptState.contextBudgetStatus,
      preflightRecovery: promptState.preflightRecovery,
      promptError: terminal.promptError,
      promptErrorSource: terminal.promptErrorSource,
      skipPromptSubmission: observeEmbeddedAttemptPrompt({
        cacheTrace,
        diagnosticTrace,
        hookAgentId: sessionAgentId,
        hookRunner,
        isRawModelRun,
        runTrace,
        streamStrategy,
        systemPromptText,
        toolSearchCompacted,
        trajectoryRecorder,
        transport: effectiveAgentTransport,
        effectiveTools: promptToolPolicy.current.effectiveTools,
        tools: promptToolPolicy.current.tools,
        uncompactedEffectiveTools: promptToolPolicy.current.uncompactedEffectiveTools,
        attempt,
        contextTokenBudget: promptContext.contextTokenBudget,
        effectivePrompt: promptContext.effectivePrompt,
        hookMessagesForCurrentPrompt: promptContext.hookMessagesForCurrentPrompt,
        imageCount: imageResult.images.length,
        llmBoundaryPromptForPrecheck: promptContext.llmBoundaryPromptForPrecheck,
        promptForModel: promptContext.promptForModel,
        promptSubmissionRuntimeOnly: promptContext.promptSubmission.runtimeOnly,
        reserveTokens,
        sessionMessages: activeSession.messages,
        skipPromptSubmission,
        systemPromptForHook: promptContext.systemPromptForHook,
        transcriptLeafId,
      }).skipPromptSubmission,
    };
    // Publish each admission transition before the next fallible phase so outer cleanup sees it.
    publishDispatchState(state);

    let compactionRequestBudget: CompactionRequestBudget | undefined;
    if (!state.skipPromptSubmission) {
      const userTurnRecorder = attempt.userTurnTranscriptRecorder;
      const pendingUserIdempotencyKey =
        attempt.skipPreparedUserTurnMessage !== true && userTurnRecorder?.hasPersisted() === true
          ? (userTurnRecorder.getPersistedMessage?.() ?? userTurnRecorder.message)?.idempotencyKey
          : undefined;
      const foregroundBudget = {
        contextWindow: promptContext.contextTokenBudget,
        reserveTokens,
      };
      const pendingContextMessages = promptContext.runtimeContextMessageForCurrentTurn
        ? [promptContext.runtimeContextMessageForCurrentTurn]
        : [];
      compactionRequestBudget = createCompactionRequestBudget({
        ...foregroundBudget,
        systemPrompt: promptContext.systemPromptForHook,
        tools: activeSession.agent.state.tools,
        pendingPrompt: promptContext.llmBoundaryPromptForPrecheck,
        pendingImageCount: imageResult.images.length,
        // The SDK replaces the queued reservation at submission. Transient
        // installation remains separate because that carrier never enters its queue.
        ...(appendOnlyRuntimeContext
          ? {
              pendingQueuedContextMessages: resolvePendingRuntimeContextReplay({
                messages: activeSession.messages,
                pendingContextMessages,
                persistedUserIdempotencyKey: pendingUserIdempotencyKey,
              }).pendingContextMessages,
            }
          : { pendingContextMessages }),
        pendingAdditivePrompt: [promptBuildPrependContext, promptBuildAppendContext]
          .filter(Boolean)
          .join("\n\n"),
        pendingUserIdempotencyKey,
      });
      attempt.onCompactionRequestBudget?.(compactionRequestBudget);
      const streamFn = activeSession.agent.streamFn;
      activeSession.agent.streamFn = (model, context, options) => {
        // Summarization has its own prompt/model; it cannot replace foreground accounting.
        if (!activeSession.isCompacting) {
          attempt.onCompactionRequestBudget?.(
            createCompactionRequestBudget({
              ...foregroundBudget,
              systemPrompt: context.systemPrompt,
              tools: context.tools,
            }),
          );
        }
        return streamFn(model, context, options);
      };
    }

    state = await prepareEmbeddedAttemptPromptPreflight({
      appendOnlyRuntimeContext,
      compactionReplayEnabled,
      contextEngineAssemblySucceeded,
      contextEnginePromptAuthority,
      includeBoundaryTimestamp,
      ...(boundaryTimezone ? { timezone: boundaryTimezone } : {}),
      ...(unwindowedContextEngineMessagesForPrecheck
        ? { unwindowedContextEngineMessagesForPrecheck }
        : {}),
      attempt,
      ...(activeContextEngine ? { activeContextEngine } : {}),
      contextTokenBudget: promptContext.contextTokenBudget,
      hookMessagesForCurrentPrompt: promptContext.hookMessagesForCurrentPrompt,
      promptForPrecheck: promptContext.llmBoundaryPromptForPrecheck,
      reserveTokens,
      sessionMessageCount: activeSession.messages.length,
      state,
      systemPrompt: promptContext.systemPromptForHook,
      toolResultMaxChars: promptContext.promptToolResultMaxChars,
    });
    publishDispatchState(state);

    if (!state.skipPromptSubmission) {
      await submitEmbeddedAttemptPrompt({
        ...(promptBuildAppendContext ? { appendContext: promptBuildAppendContext } : {}),
        attempt,
        activeSession,
        contextTokenBudget: promptContext.contextTokenBudget,
        compactionRequestBudget,
        images: imageResult.images,
        ...(leasedSteering ? { leasedSteering } : {}),
        modelPrompt: promptContext.promptForModel,
        onFinalPromptText: (prompt) => {
          promptState.finalPromptText = prompt;
        },
        onSteeringAcknowledged: () => {
          leasedSteering = undefined;
        },
        persistToolResultProjections: async () => {
          if (!isRawModelRun && toolResultPromptProjectionState.frozen.size > 0) {
            await withOwnedTranscriptWrite(() => {
              persistToolResultProjections(toolResultPromptProjectionState, (customType, data) =>
                sessionManager.appendCustomEntry(customType, data),
              );
            });
          }
        },
        ...(promptBuildPrependContext ? { prependContext: promptBuildPrependContext } : {}),
        ...(promptContext.runtimeContextMessageForCurrentTurn
          ? { runtimeContextMessage: promptContext.runtimeContextMessageForCurrentTurn }
          : {}),
        runtimeOnly: promptContext.promptSubmission.runtimeOnly === true,
        systemPrompt: promptContext.systemPromptForHook,
        toolResultAggregateMaxChars: promptContext.promptToolResultAggregateMaxChars,
        toolResultMaxChars: promptContext.promptToolResultMaxChars,
        transcriptLeafId,
        transcriptPrompt: promptContext.promptForSession,
        appendOnlyRuntimeContext,
        promptActiveSession,
        sessionPromptState,
        toolResultPromptProjectionState,
        trajectoryRecorder,
      });
    } else {
      releaseLeasedSteering(state.promptError ?? "prompt submission skipped");
    }
    publishDispatchState(state);
  } catch (error) {
    const promptErrorOutcome = await handleEmbeddedAttemptPromptError({
      activeSession,
      attempt,
      error,
      handleMidTurnPrecheckRequest,
      markYieldAborted: () => {
        promptState.yieldAborted = true;
        input.state.terminal = mergeAgentRunAttemptTerminal(input.state.terminal, {
          kind: "aborted",
          source: "yield_cleanup",
        });
      },
      releaseLeasedSteering,
      withOwnedTranscriptWrite,
      ...input.lifecycle.readYieldState(),
    });
    // The timeout owner records its terminal before aborting the prompt. That
    // abort is not a provider failure and must leave timeout salvage eligible.
    if (
      promptErrorOutcome.promptFailure &&
      !(
        projectAgentRunAttemptTerminal(input.state.terminal).timedOutByRunBudget &&
        isOpenClawAbortableWrapper(promptErrorOutcome.promptFailure.error) &&
        promptErrorOutcome.promptFailure.error instanceof Error &&
        promptErrorOutcome.promptFailure.error.cause === runAbortController.signal.reason
      )
    ) {
      setFailure(promptErrorOutcome.promptFailure.error, promptErrorOutcome.promptFailure.source);
    }
  } finally {
    stopAcceptingSteerMessages();
    log.debug(
      `embedded run prompt end: runId=${attempt.runId} sessionId=${attempt.sessionId} durationMs=${Date.now() - promptStartedAt}`,
    );
  }

  const pendingMidTurnPrecheckRequest = contextGuards.takePendingMidTurnPrecheckRequest();
  if (pendingMidTurnPrecheckRequest) {
    await withOwnedTranscriptWrite(() => {
      removeTrailingMidTurnPrecheckAssistantError({ activeSession, sessionManager });
      const terminal = projectAgentRunAttemptTerminal(input.state.terminal);
      if (!promptState.preflightRecovery && terminal.promptErrorSource !== "precheck") {
        setFailure(null, null);
        handleMidTurnPrecheckRequest(pendingMidTurnPrecheckRequest);
      }
    });
  }

  return { promptStartedAt, transcriptLeafId };
}
