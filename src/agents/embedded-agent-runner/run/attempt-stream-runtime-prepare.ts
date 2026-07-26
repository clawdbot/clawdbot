/** Prepares guarded history, abort handling, stream subscription, and run deadlines. */
import {
  bindOwnedSessionTranscriptWrites,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import { log } from "../logger.js";
import type { EmbeddedAgentQueueHandle } from "../runs.js";
import { flushPendingToolResultsAfterIdle } from "../wait-for-idle-before-flush.js";
import { abortable as abortableWithSignal } from "./abortable.js";
import {
  type createEmbeddedAttemptExternalAbortController,
  createEmbeddedAttemptRunAbort,
} from "./attempt-abort.js";
import { prepareEmbeddedAttemptHistory } from "./attempt-history-prepare.js";
import { prepareEmbeddedAttemptStream } from "./attempt-stream-prepare.js";
import { installEmbeddedAttemptStreamGuards } from "./attempt-stream.js";
import { prepareEmbeddedAttemptTimeout } from "./attempt-timeout-prepare.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type StreamGuardInput = Parameters<typeof installEmbeddedAttemptStreamGuards>[0];
type HistoryInput = Parameters<typeof prepareEmbeddedAttemptHistory>[0];
type StreamInput = Parameters<typeof prepareEmbeddedAttemptStream>[0];
type ToolResultFlushInput = Parameters<typeof flushPendingToolResultsAfterIdle>[0];
type ExternalAbortController = Pick<
  ReturnType<typeof createEmbeddedAttemptExternalAbortController>,
  "setCompactionState" | "setRunAbort"
>;
type StreamGuardPhaseInput = Omit<
  StreamGuardInput,
  | "abortSignal"
  | "attempt"
  | "isYieldDetected"
  | "onIdleTimeout"
  | "onRejectedThinkingReplayRepaired"
  | "session"
  | "sessionLockController"
  | "sessionManager"
>;
type HistoryPhaseInput = Omit<HistoryInput, "activeSession" | "attempt" | "sessionManager">;
type StreamPhaseInput = Omit<
  StreamInput,
  | "abortRun"
  | "activeSession"
  | "attempt"
  | "getRunState"
  | "markExternalAbort"
  | "onBlockReply"
  | "onBlockReplyFlush"
  | "runAbortController"
>;

export async function prepareEmbeddedAttemptStreamRuntime(input: {
  attempt: EmbeddedRunAttemptParams;
  activeSession: StreamInput["activeSession"];
  sessionManager: HistoryInput["sessionManager"] &
    NonNullable<ToolResultFlushInput["sessionManager"]>;
  sessionLockController: StreamGuardInput["sessionLockController"];
  ownedTranscriptWriteContext: Parameters<typeof withOwnedSessionTranscriptWrites>[0];
  runAbortController: AbortController;
  externalAbortController: ExternalAbortController;
  abortActiveSession: Parameters<typeof createEmbeddedAttemptRunAbort>[0]["abortActiveSession"];
  abortState: Parameters<typeof createEmbeddedAttemptRunAbort>[0]["state"];
  trackPromptSettlePromise: (promise: Promise<void>) => Promise<void>;
  compactionTimeoutMs: number;
  guards: StreamGuardPhaseInput;
  history: HistoryPhaseInput;
  stream: StreamPhaseInput;
  lifecycle: {
    isYieldDetected: StreamGuardInput["isYieldDetected"];
    markRejectedThinkingReplayRepaired: () => void;
    markStreamReady: () => void;
    markIdleTimedOut: () => void;
    markExternalAbort: () => void;
    markTimedOutDuringCompaction: () => void;
    markTimedOutByRunBudget: () => void;
    readRunState: StreamInput["getRunState"];
    setToolSearchCatalogExecutor: (
      executor: ReturnType<typeof prepareEmbeddedAttemptStream>["toolSearchCatalogExecutor"],
    ) => void;
  };
}) {
  const { activeSession, attempt, sessionManager } = input;
  const idleTimeoutTriggerRef: { current?: (error: Error) => void } = {};
  const { cacheObservabilityEnabled, promptCacheToolNames } = installEmbeddedAttemptStreamGuards({
    ...input.guards,
    attempt,
    session: activeSession,
    sessionManager,
    sessionLockController: input.sessionLockController,
    isYieldDetected: input.lifecycle.isYieldDetected,
    onRejectedThinkingReplayRepaired: input.lifecycle.markRejectedThinkingReplayRepaired,
    onIdleTimeout: (error) => idleTimeoutTriggerRef.current?.(error),
    abortSignal: input.runAbortController.signal,
  });
  input.lifecycle.markStreamReady();

  let preparedHistory: Awaited<ReturnType<typeof prepareEmbeddedAttemptHistory>>;
  try {
    preparedHistory = await prepareEmbeddedAttemptHistory({
      ...input.history,
      attempt,
      activeSession,
      sessionManager,
    });
  } catch (error) {
    await flushPendingToolResultsAfterIdle({
      agent: activeSession.agent,
      sessionManager,
      // An already-aborted setup must dispose immediately without orphaning tool calls.
      ...(attempt.abortSignal?.aborted ? { timeoutMs: 0 } : {}),
    });
    activeSession.dispose();
    throw error;
  }

  const isProbeSession = attempt.sessionId?.startsWith("probe-") ?? false;
  const queueHandleRef: { current?: EmbeddedAgentQueueHandle } = {};
  const abortRun = createEmbeddedAttemptRunAbort({
    abortActiveSession: input.abortActiveSession,
    activeSession,
    attempt,
    getQueueHandle: () => queueHandleRef.current,
    isProbeSession,
    log,
    runAbortController: input.runAbortController,
    sessionLockController: input.sessionLockController,
    state: input.abortState,
  });
  input.externalAbortController.setRunAbort(abortRun);
  idleTimeoutTriggerRef.current = (error) => {
    input.lifecycle.markIdleTimedOut();
    abortRun(true, error);
  };
  const abortable = <T>(promise: Promise<T>): Promise<T> =>
    abortableWithSignal(input.runAbortController.signal, promise);
  const promptActiveSession = (
    prompt: string,
    options?: Parameters<typeof activeSession.prompt>[1],
  ): Promise<void> =>
    withOwnedSessionTranscriptWrites(input.ownedTranscriptWriteContext, async () =>
      abortable(input.trackPromptSettlePromise(activeSession.prompt(prompt, options))),
    );
  const onBlockReply = attempt.onBlockReply
    ? bindOwnedSessionTranscriptWrites(input.ownedTranscriptWriteContext, attempt.onBlockReply)
    : undefined;
  const onBlockReplyFlush = attempt.onBlockReplyFlush
    ? bindOwnedSessionTranscriptWrites(input.ownedTranscriptWriteContext, attempt.onBlockReplyFlush)
    : undefined;
  const preparedStream = prepareEmbeddedAttemptStream({
    ...input.stream,
    attempt,
    activeSession,
    runAbortController: input.runAbortController,
    abortRun,
    markExternalAbort: input.lifecycle.markExternalAbort,
    getRunState: input.lifecycle.readRunState,
    onBlockReply,
    onBlockReplyFlush,
  });
  input.lifecycle.setToolSearchCatalogExecutor(preparedStream.toolSearchCatalogExecutor);
  input.externalAbortController.setCompactionState({
    isPendingOrRetrying: preparedStream.subscription.isCompacting,
    isInFlight: () => activeSession.isCompacting,
  });
  queueHandleRef.current = preparedStream.queueHandle;

  const attemptTimeout = prepareEmbeddedAttemptTimeout({
    attempt,
    activeSession,
    compactionState: preparedStream.subscription,
    compactionTimeoutMs: input.compactionTimeoutMs,
    isProbeSession,
    abortRun,
    markExternalAbort: input.lifecycle.markExternalAbort,
    markTimedOutDuringCompaction: input.lifecycle.markTimedOutDuringCompaction,
    markTimedOutByRunBudget: input.lifecycle.markTimedOutByRunBudget,
  });

  return {
    abortable,
    cache: {
      observabilityEnabled: cacheObservabilityEnabled,
      promptToolNames: promptCacheToolNames,
    },
    history: preparedHistory,
    isProbeSession,
    onBlockReplyFlush,
    promptActiveSession,
    stream: preparedStream,
    timeout: attemptTimeout,
  };
}
