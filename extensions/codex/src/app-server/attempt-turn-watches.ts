/**
 * Idle-watch controller for Codex app-server turn progress, completion, and
 * terminal-event gaps.
 */
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";

type Timer = ReturnType<typeof setTimeout>;
type WatchTimerKind = "completion" | "assistant" | "attempt" | "terminal";

/** Timeout bucket reported by the turn watch controller. */
export type CodexAttemptTurnWatchTimeoutKind = "progress" | "completion" | "terminal";

/** Structured timeout event emitted when a watch fires. */
type CodexAttemptTurnWatchTimeout = {
  kind: CodexAttemptTurnWatchTimeoutKind;
  idleMs: number;
  timeoutMs: number;
  lastActivityReason: string;
  details?: Record<string, unknown>;
};

/** Controller API returned by `createCodexAttemptTurnWatchController`. */
export type CodexAttemptTurnWatchController = ReturnType<
  typeof createCodexAttemptTurnWatchController
>;

/**
 * Creates a controller that arms/disarms timers as Codex app-server
 * notifications and tool handoffs progress.
 */
export function createCodexAttemptTurnWatchController(params: {
  threadId: string;
  signal: AbortSignal;
  getTurnId: () => string | undefined;
  isCompleted: () => boolean;
  isTerminalTurnNotificationQueued: () => boolean;
  getActiveAppServerTurnRequests: () => number;
  getActiveTurnItemCount: () => number;
  getActiveCompletionBlockerItemCount: () => number;
  getActiveFinalizationHookCount: () => number;
  canReleaseAssistantCompletionIdle: () => boolean;
  turnCompletionIdleTimeoutMs: number;
  turnAssistantCompletionIdleTimeoutMs: number;
  turnAttemptIdleTimeoutMs: number;
  turnTerminalIdleTimeoutMs: number;
  interruptTimeoutMs: number;
  onInterruptTurn: (input: {
    threadId: string;
    turnId: string;
    timeoutMs: number;
  }) => Promise<boolean>;
  onTimeout: (timeout: CodexAttemptTurnWatchTimeout) => void;
  onAbort: (reason: string) => void;
  onCompleted: () => void;
  onRecordEvent: (name: string, fields: Record<string, unknown>) => void;
  onAttemptProgress: (reason: string, details?: Record<string, unknown>) => void;
  onProgressDiagnostic: (reason: string) => void;
}) {
  const timers: Partial<Record<WatchTimerKind, Timer>> = {};
  let completionIdleWatchArmed = false;
  let completionIdleWatchPinnedByTerminalError = false;
  let completionIdleTimeoutOverrideMs: number | undefined;
  let assistantCompletionIdleWatchArmed = false;
  let assistantCompletionLastActivityAt = Date.now();
  let assistantCompletionLastActivityDetails: Record<string, unknown> | undefined;
  let attemptIdleWatchArmed = false;
  let terminalIdleWatchArmed = false;
  let completionLastActivityAt = Date.now();
  let completionLastActivityReason = "startup";
  let completionLastActivityDetails: Record<string, unknown> | undefined;
  let attemptIdleTimeoutOverrideMs: number | undefined;
  let attemptLastProgressAt = Date.now();
  let attemptLastProgressReason = "startup";
  let attemptLastProgressDetails: Record<string, unknown> | undefined;
  const turnCompletionIdleTimeoutMs = resolveTimerTimeoutMs(params.turnCompletionIdleTimeoutMs, 1);
  const turnAssistantCompletionIdleTimeoutMs = resolveTimerTimeoutMs(
    params.turnAssistantCompletionIdleTimeoutMs,
    1,
  );
  const turnAttemptIdleTimeoutMs = resolveTimerTimeoutMs(params.turnAttemptIdleTimeoutMs, 1);
  const turnTerminalIdleTimeoutMs = resolveTimerTimeoutMs(params.turnTerminalIdleTimeoutMs, 1);
  const interruptTimeoutMs = resolveTimerTimeoutMs(params.interruptTimeoutMs, 1);
  const resolveWatchTimeoutMs = (timeoutMs: number) => resolveTimerTimeoutMs(timeoutMs, 1);

  const clearTimer = (kind: WatchTimerKind) => {
    const timer = timers[kind];
    if (timer) {
      clearTimeout(timer);
      delete timers[kind];
    }
  };
  const clearCompletionIdleTimer = () => clearTimer("completion");
  const clearAllTimers = () => {
    for (const kind of Object.keys(timers) as WatchTimerKind[]) {
      clearTimer(kind);
    }
  };

  function scheduleWatch(
    kind: WatchTimerKind,
    callback: () => void,
    lastActivityAt: number,
    timeoutMs: number,
    ready: boolean,
  ) {
    clearTimer(kind);
    if (!ready || params.isCompleted() || params.signal.aborted) {
      return;
    }
    const elapsedMs = Math.max(0, Date.now() - lastActivityAt);
    const timer = setTimeout(callback, Math.max(1, timeoutMs - elapsedMs));
    timer.unref?.();
    timers[kind] = timer;
  }

  function scheduleCompletionIdleWatch() {
    scheduleWatch(
      "completion",
      fireCompletionIdleTimeout,
      completionLastActivityAt,
      completionIdleTimeoutOverrideMs ?? turnCompletionIdleTimeoutMs,
      completionIdleWatchArmed &&
        params.getActiveAppServerTurnRequests() === 0 &&
        params.getActiveCompletionBlockerItemCount() === 0,
    );
  }

  function scheduleAssistantCompletionIdleWatch() {
    scheduleWatch(
      "assistant",
      fireAssistantCompletionIdleRelease,
      assistantCompletionLastActivityAt,
      turnAssistantCompletionIdleTimeoutMs,
      assistantCompletionIdleWatchArmed && params.getActiveFinalizationHookCount() === 0,
    );
  }

  function scheduleAttemptIdleWatch() {
    scheduleWatch(
      "attempt",
      fireAttemptIdleTimeout,
      attemptLastProgressAt,
      attemptIdleTimeoutOverrideMs ?? turnAttemptIdleTimeoutMs,
      attemptIdleWatchArmed,
    );
  }

  function scheduleTerminalIdleWatch() {
    scheduleWatch(
      "terminal",
      fireTerminalIdleTimeout,
      completionLastActivityAt,
      turnTerminalIdleTimeoutMs,
      terminalIdleWatchArmed && params.getActiveAppServerTurnRequests() === 0,
    );
  }

  function scheduleProgressWatches() {
    scheduleAttemptIdleWatch();
    scheduleCompletionIdleWatch();
    scheduleTerminalIdleWatch();
  }

  function isCompletionIdleTimeoutDueBeforeAttempt(timeoutMs: number) {
    if (
      params.isCompleted() ||
      params.isTerminalTurnNotificationQueued() ||
      params.signal.aborted ||
      !completionIdleWatchArmed ||
      params.getActiveAppServerTurnRequests() > 0 ||
      params.getActiveCompletionBlockerItemCount() > 0
    ) {
      return false;
    }
    const completionTimeoutMs = completionIdleTimeoutOverrideMs ?? turnCompletionIdleTimeoutMs;
    if (completionTimeoutMs > timeoutMs) {
      return false;
    }
    return Math.max(0, Date.now() - completionLastActivityAt) >= completionTimeoutMs;
  }

  function recordAttemptProgress(
    reason: string,
    options?: { details?: Record<string, unknown>; attemptTimeoutMs?: number },
  ) {
    attemptIdleTimeoutOverrideMs =
      options?.attemptTimeoutMs !== undefined
        ? resolveWatchTimeoutMs(options.attemptTimeoutMs)
        : undefined;
    attemptLastProgressAt = completionLastActivityAt;
    attemptLastProgressReason = reason;
    attemptLastProgressDetails = options?.details;
    params.onAttemptProgress(reason, options?.details);
    scheduleAttemptIdleWatch();
  }

  function fireAssistantCompletionIdleRelease() {
    if (params.isCompleted() || params.signal.aborted || !assistantCompletionIdleWatchArmed) {
      return;
    }
    if (
      params.getActiveAppServerTurnRequests() > 0 ||
      params.getActiveTurnItemCount() > 0 ||
      params.getActiveFinalizationHookCount() > 0
    ) {
      scheduleAssistantCompletionIdleWatch();
      return;
    }
    if (!params.canReleaseAssistantCompletionIdle()) {
      assistantCompletionIdleWatchArmed = false;
      assistantCompletionLastActivityDetails = undefined;
      clearTimer("assistant");
      return;
    }
    const idleMs = Math.max(0, Date.now() - assistantCompletionLastActivityAt);
    if (idleMs < turnAssistantCompletionIdleTimeoutMs) {
      scheduleAssistantCompletionIdleWatch();
      return;
    }
    assistantCompletionIdleWatchArmed = false;
    clearCompletionIdleTimer();
    clearTimer("terminal");
    const turnId = params.getTurnId();
    const fields = {
      threadId: params.threadId,
      turnId,
      idleMs,
      timeoutMs: turnAssistantCompletionIdleTimeoutMs,
      ...assistantCompletionLastActivityDetails,
    };
    params.onRecordEvent("turn.assistant_completion_idle_release", fields);
    embeddedAgentLog.warn(
      "codex app-server turn released after completed assistant item without terminal event",
      fields,
    );
    if (turnId) {
      void params
        .onInterruptTurn({
          threadId: params.threadId,
          turnId,
          timeoutMs: interruptTimeoutMs,
        })
        .finally(params.onCompleted);
      return;
    }
    params.onCompleted();
  }

  function reportTimeout(timeout: CodexAttemptTurnWatchTimeout) {
    params.onTimeout(timeout);
    const fields = {
      threadId: params.threadId,
      turnId: params.getTurnId(),
      idleMs: timeout.idleMs,
      timeoutMs: timeout.timeoutMs,
      lastActivityReason: timeout.lastActivityReason,
      ...timeout.details,
    };
    params.onRecordEvent(`turn.${timeout.kind}_idle_timeout`, fields);
    embeddedAgentLog.warn(
      `codex app-server turn idle timed out waiting for ${timeout.kind === "terminal" ? "terminal event" : timeout.kind}`,
      fields,
    );
    params.onAbort(`turn_${timeout.kind}_idle_timeout`);
  }

  function fireAttemptIdleTimeout() {
    if (params.isCompleted() || params.signal.aborted || !attemptIdleWatchArmed) {
      return;
    }
    const idleMs = Math.max(0, Date.now() - attemptLastProgressAt);
    const timeoutMs = attemptIdleTimeoutOverrideMs ?? turnAttemptIdleTimeoutMs;
    if (idleMs < timeoutMs) {
      scheduleAttemptIdleWatch();
      return;
    }
    if (isCompletionIdleTimeoutDueBeforeAttempt(timeoutMs)) {
      fireCompletionIdleTimeout();
      return;
    }
    reportTimeout({
      kind: "progress" as const,
      idleMs,
      timeoutMs,
      lastActivityReason: attemptLastProgressReason,
      details: attemptLastProgressDetails,
    });
  }

  function fireCompletionIdleTimeout() {
    if (
      params.isCompleted() ||
      params.isTerminalTurnNotificationQueued() ||
      params.signal.aborted ||
      !completionIdleWatchArmed ||
      params.getActiveAppServerTurnRequests() > 0 ||
      params.getActiveCompletionBlockerItemCount() > 0
    ) {
      return;
    }
    const timeoutMs = completionIdleTimeoutOverrideMs ?? turnCompletionIdleTimeoutMs;
    const idleMs = Math.max(0, Date.now() - completionLastActivityAt);
    if (idleMs < timeoutMs) {
      scheduleCompletionIdleWatch();
      return;
    }
    const details = {
      ...completionLastActivityDetails,
      activeAppServerTurnRequests: params.getActiveAppServerTurnRequests(),
      activeTurnItemCount: params.getActiveTurnItemCount(),
      terminalTurnNotificationQueued: params.isTerminalTurnNotificationQueued(),
      completionIdleWatchArmed,
      assistantCompletionIdleWatchArmed,
      terminalIdleWatchArmed,
    };
    reportTimeout({
      kind: "completion" as const,
      idleMs,
      timeoutMs,
      lastActivityReason: completionLastActivityReason,
      details,
    });
  }

  function fireTerminalIdleTimeout() {
    // Physical-client liveness backstop. A terminal timeout retires the shared
    // client, so it must only measure silence the client owns: while a
    // server->client request is pending (approval/elicitation/tool call) the
    // app-server legitimately says nothing until we respond. The response path
    // touches activity when the request settles, so a wedged client is still
    // caught within one terminal window after our response.
    if (
      params.isCompleted() ||
      params.isTerminalTurnNotificationQueued() ||
      params.signal.aborted ||
      !terminalIdleWatchArmed ||
      params.getActiveAppServerTurnRequests() > 0
    ) {
      return;
    }
    const idleMs = Math.max(0, Date.now() - completionLastActivityAt);
    if (idleMs < turnTerminalIdleTimeoutMs) {
      scheduleTerminalIdleWatch();
      return;
    }
    reportTimeout({
      kind: "terminal" as const,
      idleMs,
      timeoutMs: turnTerminalIdleTimeoutMs,
      lastActivityReason: completionLastActivityReason,
      details: completionLastActivityDetails,
    });
  }

  return {
    isCompletionIdleWatchArmed: () => completionIdleWatchArmed,
    isCompletionIdleWatchPinnedByTerminalError: () => completionIdleWatchPinnedByTerminalError,
    isAssistantCompletionIdleWatchArmed: () => assistantCompletionIdleWatchArmed,
    armAttemptIdleWatch: () => {
      attemptIdleWatchArmed = true;
      scheduleAttemptIdleWatch();
    },
    armTerminalIdleWatch: () => {
      terminalIdleWatchArmed = true;
      scheduleTerminalIdleWatch();
    },
    armCompletionIdleWatch: (options?: { pinnedByTerminalError?: boolean; timeoutMs?: number }) => {
      completionIdleWatchArmed = true;
      completionIdleWatchPinnedByTerminalError = options?.pinnedByTerminalError === true;
      completionIdleTimeoutOverrideMs =
        options?.timeoutMs !== undefined ? resolveWatchTimeoutMs(options.timeoutMs) : undefined;
      scheduleCompletionIdleWatch();
    },
    disarmCompletionIdleWatch: () => {
      completionIdleWatchArmed = false;
      completionIdleWatchPinnedByTerminalError = false;
      completionIdleTimeoutOverrideMs = undefined;
      clearCompletionIdleTimer();
    },
    armAssistantCompletionIdleWatch: (details?: Record<string, unknown>) => {
      assistantCompletionIdleWatchArmed = true;
      assistantCompletionLastActivityAt = Date.now();
      assistantCompletionLastActivityDetails = details;
      scheduleAssistantCompletionIdleWatch();
    },
    disarmAssistantCompletionIdleWatch: () => {
      assistantCompletionIdleWatchArmed = false;
      assistantCompletionLastActivityDetails = undefined;
      clearTimer("assistant");
    },
    touchActivity: (
      reason: string,
      options?: {
        arm?: boolean;
        details?: Record<string, unknown>;
        attemptProgress?: boolean;
        attemptTimeoutMs?: number;
      },
    ) => {
      completionLastActivityAt = Date.now();
      completionLastActivityReason = reason;
      completionLastActivityDetails = options?.details;
      completionIdleTimeoutOverrideMs = undefined;
      if (options?.attemptProgress) {
        recordAttemptProgress(reason, options);
      }
      params.onProgressDiagnostic(reason);
      if (options?.arm) {
        completionIdleWatchArmed = true;
        completionIdleWatchPinnedByTerminalError = false;
      }
      scheduleProgressWatches();
    },
    noteNotificationReceived: (
      method: string,
      options?: {
        details?: Record<string, unknown>;
        attemptProgress?: boolean;
        attemptTimeoutMs?: number;
        receivedAtMs?: number;
      },
    ) => {
      // Buffered pre-bind notifications flush later than they arrived; honor
      // the wire timestamp but never move recorded activity backwards, or the
      // completion/terminal idle watches could fire early after a flush.
      const now = Date.now();
      completionLastActivityAt = Math.max(
        completionLastActivityAt,
        Math.min(now, options?.receivedAtMs ?? now),
      );
      completionLastActivityReason = `notification:${method}`;
      if (options?.details !== undefined) {
        completionLastActivityDetails = options.details;
      }
      if (options?.attemptProgress) {
        recordAttemptProgress(completionLastActivityReason, options);
      }
    },
    extendAttemptIdleWatch: (timeoutMs: number) => {
      attemptIdleTimeoutOverrideMs = resolveWatchTimeoutMs(timeoutMs);
      scheduleAttemptIdleWatch();
    },
    scheduleProgressWatches,
    clearCompletionIdleTimer,
    clearAllTimers,
  };
}
