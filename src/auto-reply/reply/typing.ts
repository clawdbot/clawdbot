export type TypingController = {
  onReplyStart: () => Promise<void>;
  startTypingLoop: () => Promise<void>;
  startTypingOnText: (text?: string) => Promise<void>;
  refreshTypingTtl: () => void;
  markRunComplete: () => void;
  markDispatchIdle: () => void;
  cleanup: () => void;
};

export function createTypingController(params: {
  onReplyStart?: () => Promise<void> | void;
  typingIntervalSeconds?: number;
  typingTtlMs?: number;
  silentToken?: string;
  log?: (message: string) => void;
}): TypingController {
  const {
    onReplyStart,
    typingIntervalSeconds = 6,
    typingTtlMs = 2 * 60_000,
    silentToken,
    log,
  } = params;
  let started = false;
  let active = false;
  let runComplete = false;
  let dispatchIdle = false;
  let typingTimer: NodeJS.Timeout | undefined;
  let typingTtlTimer: NodeJS.Timeout | undefined;
  const typingIntervalMs = typingIntervalSeconds * 1000;

  const formatTypingTtl = (ms: number) => {
    if (ms % 60_000 === 0) return `${ms / 60_000}m`;
    return `${Math.round(ms / 1000)}s`;
  };

  const resetCycle = () => {
    started = false;
    active = false;
    runComplete = false;
    dispatchIdle = false;
  };

  const cleanup = () => {
    if (typingTtlTimer) {
      clearTimeout(typingTtlTimer);
      typingTtlTimer = undefined;
    }
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = undefined;
    }
    resetCycle();
  };

  const refreshTypingTtl = () => {
    if (!typingIntervalMs || typingIntervalMs <= 0) return;
    if (typingTtlMs <= 0) return;
    if (typingTtlTimer) {
      clearTimeout(typingTtlTimer);
    }
    typingTtlTimer = setTimeout(() => {
      if (!typingTimer) return;
      log?.(
        `typing TTL reached (${formatTypingTtl(typingTtlMs)}); stopping typing indicator`,
      );
      cleanup();
    }, typingTtlMs);
  };

  const triggerTyping = async () => {
    await onReplyStart?.();
  };

  const ensureStart = async () => {
    if (!active) {
      active = true;
    }
    if (started) return;
    started = true;
    await triggerTyping();
  };

  const maybeStopOnIdle = () => {
    if (!active) return;
    // Stop only when the model run is done and the dispatcher queue is empty.
    if (runComplete && dispatchIdle) cleanup();
  };

  const startTypingLoop = async () => {
    if (!onReplyStart) return;
    if (typingIntervalMs <= 0) return;
    if (typingTimer) return;
    await ensureStart();
    refreshTypingTtl();
    typingTimer = setInterval(() => {
      void triggerTyping();
    }, typingIntervalMs);
  };

  const startTypingOnText = async (text?: string) => {
    const trimmed = text?.trim();
    if (!trimmed) return;
    if (silentToken && trimmed === silentToken) return;
    refreshTypingTtl();
    await startTypingLoop();
  };

  const markRunComplete = () => {
    runComplete = true;
    maybeStopOnIdle();
  };

  const markDispatchIdle = () => {
    dispatchIdle = true;
    maybeStopOnIdle();
  };

  return {
    onReplyStart: ensureStart,
    startTypingLoop,
    startTypingOnText,
    refreshTypingTtl,
    markRunComplete,
    markDispatchIdle,
    cleanup,
  };
}
