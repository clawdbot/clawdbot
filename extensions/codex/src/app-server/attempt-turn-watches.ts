import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";

type Timer = ReturnType<typeof setTimeout>;

export type CodexAttemptTurnWatchTimeoutKind = "progress" | "completion" | "terminal";

export type CodexAttemptTurnWatchTimeout = {
  kind: CodexAttemptTurnWatchTimeoutKind;
  idleMs: number;
  timeoutMs: number;
  lastActivityReason: string;
  details?: Record<string, unknown>;
};

export type CodexAttemptTurnWatchController = ReturnType<
  typeof createCodexAttemptTurnWatchController
>;

export function createCodexAttemptTurnWatchController(params: {
  threadId: string;
  signal: AbortSignal;
  getTurnId: () => string | undefined;
  isCompleted: () => boolean;
  isTerminalTurnNotificationQueued: () => boolean;
  getActiveAppServerTurnRequests: () => number;
  getActiveTurnItemCount: () => number;
  turnCompletionIdleTimeoutMs: number;
  turnAssistantCompletionIdleTimeoutMs: number;
  turnAttemptIdleTimeoutMs: number;
  turnTerminalIdleTimeoutMs: number;
  interruptTimeoutMs: number;
  onInterruptTurn: (input: { threadId: string; turnId: string; timeoutMs: number }) => void;
  onTimeout: (timeout: CodexAttemptTurnWatchTimeout) => void;
  onMarkTimedOut: () => void;
  onAbort: (reason: string) => void;
  onCompleted: () => void;
  onResolveCompletion: () => void;
  onRecordEvent: (name: string, fields: Record<string, unknown>) => void;
  onAttemptProgress: (reason: string, details?: Record<string, unknown>) => void;
  onProgressDiagnostic: (reason: string) => void;
}) {
  let completionIdleTimer: Timer | undefined;
  let completionIdleWatchArmed = false;
  let completionIdleWatchPinnedByTerminalError = false;
  let completionIdleTimeoutOverrideMs: number | undefined;
  let assistantCompletionIdleTimer: Timer | undefined;
  let assistantCompletionIdleWatchArmed = false;
  let assistantCompletionLastActivityAt = Date.now();
  let assistantCompletionLastActivityDetails: Record<string, unknown> | undefined;
  let attemptIdleTimer: Timer | undefined;
  let attemptIdleWatchArmed = false;
  let terminalIdleTimer: Timer | undefined;
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

  const clearCompletionIdleTimer = () => {
    if (completionIdleTimer) {
      clearTimeout(completionIdleTimer);
      completionIdleTimer = undefined;
    }
  };

  const clearTerminalIdleTimer = () => {
    if (terminalIdleTimer) {
      clearTimeout(terminalIdleTimer);
      terminalIdleTimer = undefined;
    }
  };

  const clearAssistantCompletionIdleTimer = () => {
    if (assistantCompletionIdleTimer) {
      clearTimeout(assistantCompletionIdleTimer);
      assistantCompletionIdleTimer = undefined;
    }
  };

  const clearAttemptIdleTimer = () => {
    if (attemptIdleTimer) {
      clearTimeout(attemptIdleTimer);
      attemptIdleTimer = undefined;
    }
  };

  const clearAllTimers = () => {
    clearAttemptIdleTimer();
    clearCompletionIdleTimer();
    clearAssistantCompletionIdleTimer();
    clearTerminalIdleTimer();
  };

  function scheduleCompletionIdleWatch() {
    clearCompletionIdleTimer();
    if (
      params.isCompleted() ||
      params.signal.aborted ||
      !completionIdleWatchArmed ||
      params.getActiveAppServerTurnRequests() > 0
    ) {
      return;
    }
    const elapsedMs = Math.max(0, Date.now() - completionLastActivityAt);
    const timeoutMs = completionIdleTimeoutOverrideMs ?? turnCompletionIdleTimeoutMs;
    const delayMs = Math.max(1, timeoutMs - elapsedMs);
    completionIdleTimer = setTimeout(fireCompletionIdleTimeout, delayMs);
    completionIdleTimer.unref?.();
  }

  function scheduleAssistantCompletionIdleWatch() {
    clearAssistantCompletionIdleTimer();
    if (params.isCompleted() || params.signal.aborted || !assistantCompletionIdleWatchArmed) {
      return;
    }
    const elapsedMs = Math.max(0, Date.now() - assistantCompletionLastActivityAt);
    const delayMs = Math.max(1, turnAssistantCompletionIdleTimeoutMs - elapsedMs);
    assistantCompletionIdleTimer = setTimeout(fireAssistantCompletionIdleRelease, delayMs);
    assistantCompletionIdleTimer.unref?.();
  }

  function scheduleAttemptIdleWatch() {
    clearAttemptIdleTimer();
    if (params.isCompleted() || params.signal.aborted || !attemptIdleWatchArmed) {
      return;
    }
    const elapsedMs = Math.max(0, Date.now() - attemptLastProgressAt);
    const timeoutMs = attemptIdleTimeoutOverrideMs ?? turnAttemptIdleTimeoutMs;
    const delayMs = Math.max(1, timeoutMs - elapsedMs);
    attemptIdleTimer = setTimeout(fireAttemptIdleTimeout, delayMs);
    attemptIdleTimer.unref?.();
  }

  function scheduleTerminalIdleWatch() {
    clearTerminalIdleTimer();
    if (
      params.isCompleted() ||
      params.signal.aborted ||
      !terminalIdleWatchArmed ||
      params.getActiveAppServerTurnRequests() > 0
    ) {
      return;
    }
    const elapsedMs = Math.max(0, Date.now() - completionLastActivityAt);
    const delayMs = Math.max(1, turnTerminalIdleTimeoutMs - elapsedMs);
    terminalIdleTimer = setTimeout(fireTerminalIdleTimeout, delayMs);
    terminalIdleTimer.unref?.();
  }

  function scheduleProgressWatches() {
    scheduleAttemptIdleWatch();
    scheduleCompletionIdleWatch();
    scheduleTerminalIdleWatch();
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
    if (params.getActiveAppServerTurnRequests() > 0 || params.getActiveTurnItemCount() > 0) {
      scheduleAssistantCompletionIdleWatch();
      return;
    }
    const idleMs = Math.max(0, Date.now() - assistantCompletionLastActivityAt);
    if (idleMs < turnAssistantCompletionIdleTimeoutMs) {
      scheduleAssistantCompletionIdleWatch();
      return;
    }
    assistantCompletionIdleWatchArmed = false;
    clearCompletionIdleTimer();
    clearTerminalIdleTimer();
    const turnId = params.getTurnId();
    params.onRecordEvent("turn.assistant_completion_idle_release", {
      threadId: params.threadId,
      turnId,
      idleMs,
      timeoutMs: turnAssistantCompletionIdleTimeoutMs,
      ...assistantCompletionLastActivityDetails,
    });
    embeddedAgentLog.warn(
      "codex app-server turn released after completed assistant item without terminal event",
      {
        threadId: params.threadId,
        turnId,
        idleMs,
        timeoutMs: turnAssistantCompletionIdleTimeoutMs,
        ...assistantCompletionLastActivityDetails,
      },
    );
    if (turnId) {
      params.onInterruptTurn({
        threadId: params.threadId,
        turnId,
        timeoutMs: interruptTimeoutMs,
      });
    }
    params.onCompleted();
    params.onResolveCompletion();
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
    const timeout = {
      kind: "progress" as const,
      idleMs,
      timeoutMs,
      lastActivityReason: attemptLastProgressReason,
      details: attemptLastProgressDetails,
    };
    params.onTimeout(timeout);
    params.onMarkTimedOut();
    params.onRecordEvent("turn.progress_idle_timeout", {
      threadId: params.threadId,
      turnId: params.getTurnId(),
      idleMs,
      timeoutMs: timeout.timeoutMs,
      lastActivityReason: timeout.lastActivityReason,
      ...timeout.details,
    });
    embeddedAgentLog.warn("codex app-server turn idle timed out waiting for progress", {
      threadId: params.threadId,
      turnId: params.getTurnId(),
      idleMs,
      timeoutMs: timeout.timeoutMs,
      lastActivityReason: timeout.lastActivityReason,
      ...timeout.details,
    });
    params.onAbort("turn_progress_idle_timeout");
  }

  function fireCompletionIdleTimeout() {
    if (
      params.isCompleted() ||
      params.isTerminalTurnNotificationQueued() ||
      params.signal.aborted ||
      !completionIdleWatchArmed ||
      params.getActiveAppServerTurnRequests() > 0
    ) {
      return;
    }
    const timeoutMs = completionIdleTimeoutOverrideMs ?? turnCompletionIdleTimeoutMs;
    const idleMs = Math.max(0, Date.now() - completionLastActivityAt);
    if (idleMs < timeoutMs) {
      scheduleCompletionIdleWatch();
      return;
    }
    const timeout = {
      kind: "completion" as const,
      idleMs,
      timeoutMs,
      lastActivityReason: completionLastActivityReason,
      details: completionLastActivityDetails,
    };
    params.onTimeout(timeout);
    params.onMarkTimedOut();
    params.onRecordEvent("turn.completion_idle_timeout", {
      threadId: params.threadId,
      turnId: params.getTurnId(),
      idleMs,
      timeoutMs,
      lastActivityReason: timeout.lastActivityReason,
      ...timeout.details,
    });
    embeddedAgentLog.warn("codex app-server turn idle timed out waiting for completion", {
      threadId: params.threadId,
      turnId: params.getTurnId(),
      idleMs,
      timeoutMs,
      lastActivityReason: timeout.lastActivityReason,
      ...timeout.details,
    });
    params.onAbort("turn_completion_idle_timeout");
  }

  function fireTerminalIdleTimeout() {
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
    const timeout = {
      kind: "terminal" as const,
      idleMs,
      timeoutMs: turnTerminalIdleTimeoutMs,
      lastActivityReason: completionLastActivityReason,
      details: completionLastActivityDetails,
    };
    params.onTimeout(timeout);
    params.onMarkTimedOut();
    params.onRecordEvent("turn.terminal_idle_timeout", {
      threadId: params.threadId,
      turnId: params.getTurnId(),
      idleMs,
      timeoutMs: timeout.timeoutMs,
      lastActivityReason: timeout.lastActivityReason,
      ...timeout.details,
    });
    embeddedAgentLog.warn("codex app-server turn idle timed out waiting for terminal event", {
      threadId: params.threadId,
      turnId: params.getTurnId(),
      idleMs,
      timeoutMs: timeout.timeoutMs,
      lastActivityReason: timeout.lastActivityReason,
      ...timeout.details,
    });
    params.onAbort("turn_terminal_idle_timeout");
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
      clearAssistantCompletionIdleTimer();
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
      },
    ) => {
      completionLastActivityAt = Date.now();
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
    clearAssistantCompletionIdleTimer,
    clearTerminalIdleTimer,
    clearAttemptIdleTimer,
    clearAllTimers,
  };
}
