/**
 * Prepares transport before streaming and settles the completed stream afterward.
 * It may assume session runtime ownership and provider inputs are established.
 */
import { formatErrorMessage } from "../../../infra/errors.js";
import { createCodexNativeWebSearchWrapper } from "../../../llm/providers/stream-wrappers/openai.js";
import type { AssistantMessage } from "../../../llm/types.js";
import type { ProviderRuntimePluginHandle } from "../../../plugins/provider-hook-runtime.js";
import { resolveProviderTextTransforms } from "../../../plugins/provider-runtime.js";
import type { AgentRunAttemptFailureSource } from "../../agent-run-terminal-outcome.js";
import type { subscribeEmbeddedAgentSession } from "../../embedded-agent-subscribe.js";
import { wrapStreamFnTextTransforms } from "../../plugin-text-transforms.js";
import { registerProviderStreamForModel } from "../../provider-stream.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { SandboxContext } from "../../sandbox/types.js";
import type { AgentSession, SessionManager, SettingsManager } from "../../sessions/index.js";
import { projectToolSearchTargetTranscriptMessages } from "../../tool-search.js";
import { hasNonzeroUsage, normalizeUsage, type NormalizedUsage } from "../../usage.js";
import { isRunnerAbortError } from "../abort.js";
import { isCacheTtlEligibleProvider, readLastCacheTtlTimestamp } from "../cache-ttl.js";
import {
  applyExtraParamsToAgent,
  resolveAgentTransportOverride,
  resolveExplicitSettingsTransport,
  resolvePreparedExtraParams,
} from "../extra-params.js";
import { log } from "../logger.js";
import {
  completePromptCacheObservation,
  type PromptCacheBreak,
  type PromptCacheChange,
} from "../prompt-cache-observability.js";
import { resolveCacheRetention } from "../prompt-cache-retention.js";
import {
  type ProviderPromptState,
  wrapStreamFnWithProviderPromptState,
} from "../provider-prompt-state.js";
import {
  describeEmbeddedAgentStreamStrategy,
  resolveEmbeddedAgentApiKey,
  resolveEmbeddedAgentBaseStreamFn,
  resolveEmbeddedAgentStreamFn,
} from "../stream-resolution.js";
import type { ProviderThinkLevel } from "../utils.js";
import { joinWithRunLivenessDeadline, RUN_LIVENESS_JOIN_TIMEOUT_MS } from "./abortable.js";
import {
  shouldWaitForCompletionRequiredAsyncTasks,
  waitForCompletionRequiredAsyncTasks,
  type CompletionRequiredAsyncTaskWaitResult,
} from "./attempt-async-tasks.js";
import {
  buildContextEnginePromptCacheInfo,
  findCurrentAttemptAssistantMessage,
  findLatestUncompactedAttemptUsageSnapshot,
  resolvePromptCacheTouchTimestamp,
} from "./attempt-context-engine-helpers.js";
import {
  resolveAttemptStreamAuthProfileId,
  resolveAttemptToolPolicyMessageProvider,
} from "./attempt-run-decisions.js";
import { appendAttemptCacheTtlIfNeeded } from "./attempt-thread-helpers.js";
import {
  flushSessionManagerTranscript,
  normalizeCompactionRecoveryTranscriptTail,
} from "./attempt-transcript-helpers.js";
import {
  hasActiveCompactionRetryWork,
  waitForCompactionRetryWithAggregateTimeout,
} from "./compaction-retry-aggregate-timeout.js";
import { selectCompactionTimeoutSnapshot } from "./compaction-timeout.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

/**
 * Settles async tools and compaction, then snapshots the completed stream.
 */
type EmbeddedAttemptSubscription = ReturnType<typeof subscribeEmbeddedAgentSession>;
type PromptCacheRetention = Parameters<typeof buildContextEnginePromptCacheInfo>[0]["retention"];
type ToolSearchTargetTranscriptProjections = Parameters<
  typeof projectToolSearchTargetTranscriptMessages
>[1];
type WithOwnedTranscriptWrite = <T>(operation: () => Promise<T> | T) => Promise<T>;

type StreamSettleResult = {
  promptError: unknown;
  promptErrorSource: AgentRunAttemptFailureSource | null;
  timedOutDuringCompaction: boolean;
  compactionOccurredThisAttempt: boolean;
  messagesSnapshot: AgentMessage[];
  sessionIdUsed: string;
  lastAssistant: EmbeddedRunAttemptResult["lastAssistant"];
  currentAttemptAssistant: EmbeddedRunAttemptResult["currentAttemptAssistant"];
  currentAttemptCompletedAssistant: EmbeddedRunAttemptResult["currentAttemptCompletedAssistant"];
  attemptUsage: EmbeddedRunAttemptResult["attemptUsage"];
  cacheBreak: PromptCacheBreak | null;
  lastCallUsage: NormalizedUsage | undefined;
  promptCache: EmbeddedRunAttemptResult["promptCache"];
};

export async function settleEmbeddedAttemptStream(input: {
  attempt: EmbeddedRunAttemptParams;
  activeSession: AgentSession;
  sessionManager: SessionManager;
  withOwnedTranscriptWrite: WithOwnedTranscriptWrite;
  subscription: EmbeddedAttemptSubscription;
  state: {
    promptError: unknown;
    promptErrorSource: AgentRunAttemptFailureSource | null;
    yieldAborted: boolean;
    sessionIdUsed: string;
  };
  readLifecycleState: () => {
    aborted: boolean;
    timedOut: boolean;
    timedOutDuringCompaction: boolean;
  };
  markTimedOutDuringCompaction: () => void;
  runAbortDeadlineAtMs: number;
  runAbortSignal: AbortSignal;
  isProbeSession: boolean;
  onBlockReplyFlush?: (payload: {
    reason: "pre_compaction";
    attemptAccepted: boolean;
  }) => Promise<void> | void;
  abortable: <T>(promise: Promise<T>) => Promise<T>;
  prePromptMessageCount: number;
  toolSearchTargetTranscriptProjections: ToolSearchTargetTranscriptProjections;
  cache: {
    observabilityEnabled: boolean;
    changesForTurn: PromptCacheChange[] | null;
    retention: PromptCacheRetention;
  };
  shouldFlushForContextEngine: boolean;
}): Promise<StreamSettleResult> {
  const { attempt, activeSession, sessionManager, subscription, state } = input;
  let { promptError, promptErrorSource, sessionIdUsed } = state;

  if (
    shouldWaitForCompletionRequiredAsyncTasks({
      sessionKey: attempt.sessionKey,
      toolMetas: subscription.toolMetas,
      yieldDetected: state.yieldAborted,
    })
  ) {
    const getAsyncStartedToolMetas = () =>
      subscription.toolMetas
        .filter(
          (
            entry,
          ): entry is {
            toolName: string;
            asyncStarted?: boolean;
            asyncTaskRunId?: string;
            asyncTaskId?: string;
          } => typeof entry.toolName === "string" && entry.toolName.trim().length > 0,
        )
        .map((entry) => ({
          toolName: entry.toolName,
          asyncStarted: entry.asyncStarted,
          asyncTaskRunId: entry.asyncTaskRunId,
          asyncTaskId: entry.asyncTaskId,
        }));
    const completionRequiredAsyncDeadlineAtMs = Math.max(
      Date.now(),
      input.runAbortDeadlineAtMs - 500,
    );
    let asyncTaskWait: CompletionRequiredAsyncTaskWaitResult;
    try {
      asyncTaskWait = await waitForCompletionRequiredAsyncTasks({
        getToolMetas: getAsyncStartedToolMetas,
        sessionKey: attempt.sessionKey,
        deadlineAtMs: completionRequiredAsyncDeadlineAtMs,
        abortSignal: input.runAbortSignal,
      });
    } catch (err) {
      // Timeouts AND user aborts must still settle so the attempt reaches
      // after-turn (transcript flush, agent-end side effects). Rethrowing here
      // unwinds the whole lane task and silently starves every agent_end
      // consumer for aborted runs.
      const lifecycle = input.readLifecycleState();
      if ((!lifecycle.timedOut && !lifecycle.aborted) || !isRunnerAbortError(err)) {
        throw err;
      }
      asyncTaskWait = await waitForCompletionRequiredAsyncTasks({
        getToolMetas: getAsyncStartedToolMetas,
        sessionKey: attempt.sessionKey,
        deadlineAtMs: Date.now(),
      });
    }
    // An aborted run legitimately leaves async tasks unfinished; stamping a
    // timeout failure here would reclassify the abort as an errored completion.
    if (asyncTaskWait.timedOutRunIds.length > 0 && !input.readLifecycleState().aborted) {
      promptError = new Error(
        `Timed out waiting for async task completion: ${asyncTaskWait.timedOutRunIds.join(", ")}`,
      );
      promptErrorSource = "prompt";
      state.promptError = promptError;
      state.promptErrorSource = promptErrorSource;
    }
  }

  // Snapshot only outside compaction. Compaction rewrites history in place and
  // cannot be allowed to leave the timeout result with a half-written view.
  const wasCompactingBefore = activeSession.isCompacting;
  const snapshot = activeSession.messages.slice();
  const wasCompactingAfter = activeSession.isCompacting;
  const preCompactionSnapshot = wasCompactingBefore || wasCompactingAfter ? null : snapshot;
  const preCompactionSessionId = activeSession.sessionId;
  const aggregateTimeoutMs = 60_000;

  try {
    if (input.onBlockReplyFlush) {
      const currentAssistant = findCurrentAttemptAssistantMessage({
        messagesSnapshot: snapshot,
        prePromptMessageCount: input.prePromptMessageCount,
      });
      const attemptAccepted =
        !promptError &&
        !input.readLifecycleState().aborted &&
        !input.readLifecycleState().timedOut &&
        !state.yieldAborted &&
        currentAssistant?.stopReason === "stop";
      // The flush rides the same delivery chain the finalize-phase join just
      // bounded; a wedged lane (including the supported blockReplyTimeoutMs: 0
      // path) must not park settlement until the 48h run budget either.
      await joinWithRunLivenessDeadline({
        joinWork: () => input.onBlockReplyFlush?.({ reason: "pre_compaction", attemptAccepted }),
        runAbortSignal: input.runAbortSignal,
        onTimeout: () => {
          log.warn(
            `block-reply flush did not settle within ${RUN_LIVENESS_JOIN_TIMEOUT_MS}ms; ` +
              `proceeding with settlement: runId=${attempt.runId}`,
          );
        },
      });
    }

    const compactionRetryWait = state.yieldAborted
      ? { timedOut: false }
      : await waitForCompactionRetryWithAggregateTimeout({
          waitForCompactionRetry: subscription.waitForCompactionRetry,
          abortable: input.abortable,
          aggregateTimeoutMs,
          isCompactionRetryStillActive: () =>
            hasActiveCompactionRetryWork({
              isCompactionInFlight: subscription.isCompactionInFlight(),
              isSessionStreaming: activeSession.isStreaming,
            }),
        });
    if (compactionRetryWait.timedOut) {
      input.markTimedOutDuringCompaction();
      if (!input.isProbeSession) {
        log.warn(
          `compaction retry aggregate timeout (${aggregateTimeoutMs}ms): ` +
            `proceeding with pre-compaction state runId=${attempt.runId} sessionId=${attempt.sessionId}`,
        );
      }
    }
  } catch (err) {
    if (!isRunnerAbortError(err)) {
      throw err;
    }
    if (!promptError) {
      promptError = err;
      promptErrorSource = "compaction";
      state.promptError = promptError;
      state.promptErrorSource = promptErrorSource;
    }
    if (!input.isProbeSession) {
      log.debug(`compaction wait aborted: runId=${attempt.runId} sessionId=${attempt.sessionId}`);
    }
  }

  let compactionOccurredThisAttempt = false;
  let messagesSnapshot: AgentMessage[] = [];
  let lastAssistant: AssistantMessage | undefined;
  let currentAttemptAssistant: AssistantMessage | undefined;
  let currentAttemptCompletedAssistant: AssistantMessage | undefined;
  let attemptUsage: EmbeddedRunAttemptResult["attemptUsage"];
  let cacheBreak: PromptCacheBreak | null = null;
  let lastCallUsage: NormalizedUsage | undefined;
  let promptCache: EmbeddedRunAttemptResult["promptCache"];

  await input.withOwnedTranscriptWrite(async () => {
    const { timedOutDuringCompaction } = input.readLifecycleState();
    compactionOccurredThisAttempt = subscription.getCompactionCount() > 0;
    appendAttemptCacheTtlIfNeeded({
      sessionManager,
      timedOutDuringCompaction,
      compactionOccurredThisAttempt,
      config: attempt.config,
      provider: attempt.provider,
      modelId: attempt.modelId,
      modelApi: attempt.model.api,
      isCacheTtlEligibleProvider,
    });

    if (timedOutDuringCompaction) {
      const removedEntries = normalizeCompactionRecoveryTranscriptTail({
        activeSession,
        sessionManager,
      });
      if (removedEntries > 0 && !input.isProbeSession) {
        log.warn(
          `normalized compaction timeout transcript tail: removedEntries=${removedEntries} ` +
            `runId=${attempt.runId} sessionId=${attempt.sessionId}`,
        );
      }
    }

    const snapshotSelection = selectCompactionTimeoutSnapshot({
      timedOutDuringCompaction,
      preCompactionSnapshot,
      preCompactionSessionId,
      currentSnapshot: activeSession.messages.slice(),
      currentSessionId: activeSession.sessionId,
    });
    if (timedOutDuringCompaction && !input.isProbeSession) {
      log.warn(
        `using ${snapshotSelection.source} snapshot: timed out during compaction ` +
          `runId=${attempt.runId} sessionId=${attempt.sessionId}`,
      );
    }
    const modelMessagesSnapshot = snapshotSelection.messagesSnapshot;
    messagesSnapshot = projectToolSearchTargetTranscriptMessages(
      modelMessagesSnapshot,
      input.toolSearchTargetTranscriptProjections,
    );
    sessionIdUsed = snapshotSelection.sessionIdUsed;
    // Projected target-tool assistants are transcript evidence, not model
    // turns. Letting one own terminal state hides its parent tool's outcome.
    lastAssistant = modelMessagesSnapshot
      .slice()
      .toReversed()
      .find((message): message is AssistantMessage => message.role === "assistant");
    currentAttemptAssistant = findCurrentAttemptAssistantMessage({
      messagesSnapshot: modelMessagesSnapshot,
      prePromptMessageCount: input.prePromptMessageCount,
    });
    currentAttemptCompletedAssistant = subscription.getCurrentAttemptAssistant();
    attemptUsage = subscription.getUsageTotals();
    cacheBreak = input.cache.observabilityEnabled
      ? completePromptCacheObservation({
          sessionId: attempt.sessionId,
          promptCacheKey: attempt.promptCacheKey,
          sessionKey: attempt.sessionKey,
          usage: attemptUsage,
        })
      : null;
    const transcriptUsageSnapshot = findLatestUncompactedAttemptUsageSnapshot({
      messagesSnapshot,
      prePromptMessageCount: input.prePromptMessageCount,
      compactionOccurred: compactionOccurredThisAttempt,
    });
    const completedAssistantUsage = normalizeUsage(currentAttemptCompletedAssistant?.usage);
    lastCallUsage =
      subscription.getLastAssistantUsage() ??
      (hasNonzeroUsage(completedAssistantUsage)
        ? completedAssistantUsage
        : transcriptUsageSnapshot?.usage);
    // Keep cache timing bound to the assistant that supplied the exact usage.
    // A terminal zero-usage abort must not advance TTL for the previous call.
    const usageAssistant = hasNonzeroUsage(completedAssistantUsage)
      ? currentAttemptCompletedAssistant
      : transcriptUsageSnapshot?.assistant;
    const promptCacheObservation =
      input.cache.observabilityEnabled &&
      (cacheBreak || input.cache.changesForTurn || typeof attemptUsage?.cacheRead === "number")
        ? {
            broke: Boolean(cacheBreak),
            ...(typeof cacheBreak?.previousCacheRead === "number"
              ? { previousCacheRead: cacheBreak.previousCacheRead }
              : {}),
            ...(typeof cacheBreak?.cacheRead === "number"
              ? { cacheRead: cacheBreak.cacheRead }
              : typeof attemptUsage?.cacheRead === "number"
                ? { cacheRead: attemptUsage.cacheRead }
                : {}),
            changes: cacheBreak?.changes ?? input.cache.changesForTurn,
          }
        : undefined;
    const fallbackLastCacheTouchAt = readLastCacheTtlTimestamp(sessionManager, {
      provider: attempt.provider,
      modelId: attempt.modelId,
    });
    promptCache = buildContextEnginePromptCacheInfo({
      retention: input.cache.retention,
      lastCallUsage,
      observation: promptCacheObservation,
      lastCacheTouchAt: resolvePromptCacheTouchTimestamp({
        lastCallUsage,
        assistantTimestamp: usageAssistant?.timestamp,
        fallbackLastCacheTouchAt,
      }),
    });

    if (promptError && promptErrorSource === "prompt" && !compactionOccurredThisAttempt) {
      try {
        sessionManager.appendCustomEntry("openclaw:prompt-error", {
          timestamp: Date.now(),
          runId: attempt.runId,
          sessionId: attempt.sessionId,
          provider: attempt.provider,
          model: attempt.modelId,
          api: attempt.model.api,
          error: formatErrorMessage(promptError),
        });
      } catch (entryErr) {
        log.warn(`failed to persist prompt error entry: ${String(entryErr)}`);
      }
    }

    if (input.shouldFlushForContextEngine) {
      flushSessionManagerTranscript(sessionManager);
    }
  });

  return {
    promptError,
    promptErrorSource,
    timedOutDuringCompaction: input.readLifecycleState().timedOutDuringCompaction,
    compactionOccurredThisAttempt,
    messagesSnapshot,
    sessionIdUsed,
    lastAssistant,
    currentAttemptAssistant,
    currentAttemptCompletedAssistant,
    attemptUsage,
    cacheBreak,
    lastCallUsage,
    promptCache,
  };
}

/**
 * Selects and configures the provider transport for one embedded attempt.
 */
export async function prepareEmbeddedAttemptTransport(input: {
  attempt: EmbeddedRunAttemptParams;
  session: AgentSession;
  settingsManager: SettingsManager;
  providerThinkingLevel: ProviderThinkLevel | undefined;
  sessionAgentId: string;
  workspaceDir: string;
  agentDir: string;
  abortSignal: AbortSignal;
  getProviderRuntimeHandle: () => ProviderRuntimePluginHandle;
  sandboxSessionKey: string;
  sandbox?: SandboxContext | null;
  codeModeControlsEnabled: boolean;
  providerPromptState: {
    state: ProviderPromptState;
    effectiveContextTokenBudget: number;
    recordEvent?: (type: string, data?: Record<string, unknown>) => void;
  };
}) {
  const attempt = input.attempt;
  const session = input.session;
  // Rebuild each turn from the session's original stream base so prior-turn
  // wrappers do not pin us to stale provider/API transport behavior.
  const defaultSessionStreamFn = resolveEmbeddedAgentBaseStreamFn({
    session,
  });
  const resolvedTransport = resolveExplicitSettingsTransport({
    settingsManager: input.settingsManager,
    sessionTransport: session.agent.transport,
  });
  const streamExtraParamsOverride = {
    ...attempt.streamParams,
    fastMode: attempt.fastMode,
  };
  const preparedRuntimeExtraParams = attempt.runtimePlan?.transport.resolveExtraParams({
    extraParamsOverride: streamExtraParamsOverride,
    thinkingLevel: input.providerThinkingLevel,
    agentId: input.sessionAgentId,
    workspaceDir: input.workspaceDir,
    model: attempt.model,
    resolvedTransport,
  });
  const effectiveExtraParams =
    preparedRuntimeExtraParams ??
    resolvePreparedExtraParams({
      cfg: attempt.config,
      provider: attempt.provider,
      modelId: attempt.modelId,
      extraParamsOverride: streamExtraParamsOverride,
      thinkingLevel: input.providerThinkingLevel,
      agentId: input.sessionAgentId,
      agentDir: input.agentDir,
      workspaceDir: input.workspaceDir,
      model: attempt.model,
      resolvedTransport,
    });
  const providerStreamFn = registerProviderStreamForModel({
    model: attempt.model,
    cfg: attempt.config,
    agentDir: input.agentDir,
    workspaceDir: input.workspaceDir,
  });
  const transportApiKey = await resolveEmbeddedAgentApiKey({
    provider: attempt.model.provider,
    resolvedApiKey: attempt.resolvedApiKey,
    authStorage: attempt.authStorage,
  });
  const streamStrategy = describeEmbeddedAgentStreamStrategy({
    currentStreamFn: defaultSessionStreamFn,
    providerStreamFn,
    model: attempt.model,
    resolvedApiKey: transportApiKey,
  });
  session.agent.streamFn = resolveEmbeddedAgentStreamFn({
    currentStreamFn: defaultSessionStreamFn,
    providerStreamFn,
    sessionId: attempt.sessionId,
    promptCacheKey: attempt.promptCacheKey,
    signal: input.abortSignal,
    model: attempt.model,
    resolvedApiKey: attempt.resolvedApiKey,
    transportAuthAvailable: Boolean(transportApiKey?.trim()),
    authProfileId: resolveAttemptStreamAuthProfileId(attempt),
    authStorage: attempt.authStorage,
  });
  // Install inside provider/config wrappers so their full onPayload chain runs
  // before admission hashes the request body that the built-in transport sends.
  session.agent.streamFn = wrapStreamFnWithProviderPromptState({
    streamFn: session.agent.streamFn,
    ...input.providerPromptState,
  });
  const providerTextTransforms = resolveProviderTextTransforms({
    provider: attempt.provider,
    config: attempt.config,
    workspaceDir: input.workspaceDir,
    runtimeHandle: input.getProviderRuntimeHandle(),
  });
  if (providerTextTransforms?.input?.length) {
    session.agent.streamFn = wrapStreamFnTextTransforms({
      streamFn: session.agent.streamFn,
      input: providerTextTransforms.input,
      transformSystemPrompt: false,
    });
  }
  const nativeWebSearchPolicyContext = {
    webSearchEnabled: attempt.disableTools !== true && attempt.toolOverrides?.webSearch !== false,
    runtimeToolAllowlist: attempt.toolsAllow,
    sessionKey: input.sandboxSessionKey,
    sandboxToolPolicy: input.sandbox?.tools,
    messageProvider: resolveAttemptToolPolicyMessageProvider(attempt),
    agentAccountId: attempt.agentAccountId,
    groupId: attempt.groupId,
    groupChannel: attempt.groupChannel,
    groupSpace: attempt.groupSpace,
    spawnedBy: attempt.spawnedBy,
    senderId: attempt.senderId,
    senderName: attempt.senderName,
    senderUsername: attempt.senderUsername,
    senderE164: attempt.senderE164,
  };

  applyExtraParamsToAgent(
    session.agent,
    attempt.config,
    attempt.provider,
    attempt.modelId,
    streamExtraParamsOverride,
    input.providerThinkingLevel,
    input.sessionAgentId,
    input.workspaceDir,
    attempt.model,
    input.agentDir,
    resolvedTransport,
    {
      preparedExtraParams: effectiveExtraParams,
      nativeWebSearchPolicyContext,
    },
  );
  if (input.codeModeControlsEnabled) {
    session.agent.streamFn = createCodexNativeWebSearchWrapper(session.agent.streamFn, {
      config: attempt.config,
      agentDir: input.agentDir,
      agentId: input.sessionAgentId,
      ...nativeWebSearchPolicyContext,
      codeModeToolSurfaceEnabled: true,
    });
  }
  const effectivePromptCacheRetention = resolveCacheRetention(
    effectiveExtraParams,
    attempt.provider,
    attempt.model.api,
    attempt.modelId,
  );
  const agentTransportOverride = resolveAgentTransportOverride({
    settingsManager: input.settingsManager,
    effectiveExtraParams,
  });
  const effectiveAgentTransport = agentTransportOverride ?? session.agent.transport;
  if (agentTransportOverride && session.agent.transport !== agentTransportOverride) {
    const previousTransport = session.agent.transport;
    log.debug(
      `embedded agent transport override: ${previousTransport} -> ${agentTransportOverride} ` +
        `(${attempt.provider}/${attempt.modelId})`,
    );
  }
  return {
    effectiveAgentTransport,
    effectiveExtraParams,
    effectivePromptCacheRetention,
    providerTextTransforms,
    streamStrategy,
  };
}
