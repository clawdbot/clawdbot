export const CODEX_APP_SERVER_STARTUP_TIMEOUT_FLOOR_MS = 100;
export const CODEX_TURN_COMPLETION_IDLE_TIMEOUT_MS = 60_000;
export const CODEX_TURN_ASSISTANT_COMPLETION_IDLE_TIMEOUT_MS = 10_000;
export const CODEX_POST_REASONING_SOURCE_REPLY_IDLE_TIMEOUT_MS = 5 * 60_000;
export const CODEX_TURN_TERMINAL_IDLE_TIMEOUT_MS = 30 * 60_000;

export async function withCodexStartupTimeout<T>(params: {
  timeoutMs: number;
  signal: AbortSignal;
  onTimeout?: () => void | Promise<void>;
  operation: () => Promise<T>;
}): Promise<T> {
  if (params.signal.aborted) {
    throw new Error("codex app-server startup aborted");
  }
  let timeout: NodeJS.Timeout | undefined;
  let abortCleanup: (() => void) | undefined;
  let timeoutError: Error | undefined;
  let timeoutCleanup: Promise<void> | undefined;
  try {
    return await Promise.race([
      params.operation(),
      new Promise<never>((_, reject) => {
        const rejectOnce = (error: Error) => {
          if (timeout) {
            clearTimeout(timeout);
            timeout = undefined;
          }
          reject(error);
        };
        timeout = setTimeout(() => {
          timeoutError = new Error("codex app-server startup timed out");
          timeoutCleanup = Promise.resolve(params.onTimeout?.()).then(
            () => undefined,
            () => undefined,
          );
          void timeoutCleanup.finally(() => {
            rejectOnce(timeoutError!);
          });
        }, params.timeoutMs);
        const abortListener = () => rejectOnce(new Error("codex app-server startup aborted"));
        params.signal.addEventListener("abort", abortListener, { once: true });
        abortCleanup = () => params.signal.removeEventListener("abort", abortListener);
      }),
    ]);
  } catch (error) {
    if (timeoutError) {
      await timeoutCleanup;
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    abortCleanup?.();
  }
}

export function resolveCodexStartupTimeoutMs(params: {
  timeoutMs: number;
  timeoutFloorMs?: number;
}): number {
  return Math.max(
    params.timeoutFloorMs ?? CODEX_APP_SERVER_STARTUP_TIMEOUT_FLOOR_MS,
    params.timeoutMs,
  );
}

export function resolveCodexTurnCompletionIdleTimeoutMs(value: number | undefined): number {
  if (value === undefined) {
    return CODEX_TURN_COMPLETION_IDLE_TIMEOUT_MS;
  }
  if (!Number.isFinite(value)) {
    return CODEX_TURN_COMPLETION_IDLE_TIMEOUT_MS;
  }
  return Math.max(1, Math.floor(value));
}

export function resolveCodexTurnAssistantCompletionIdleTimeoutMs(
  value: number | undefined,
): number {
  if (value === undefined) {
    return CODEX_TURN_ASSISTANT_COMPLETION_IDLE_TIMEOUT_MS;
  }
  if (!Number.isFinite(value)) {
    return CODEX_TURN_ASSISTANT_COMPLETION_IDLE_TIMEOUT_MS;
  }
  return Math.max(1, Math.floor(value));
}

export function resolveCodexPostToolRawAssistantCompletionIdleTimeoutMs(
  value: number | undefined,
  fallbackMs: number,
): number {
  if (value === undefined) {
    return fallbackMs;
  }
  if (!Number.isFinite(value)) {
    return fallbackMs;
  }
  return Math.max(1, Math.floor(value));
}

export function resolveCodexTurnTerminalIdleTimeoutMs(value: number | undefined): number {
  if (value === undefined) {
    return CODEX_TURN_TERMINAL_IDLE_TIMEOUT_MS;
  }
  if (!Number.isFinite(value)) {
    return CODEX_TURN_TERMINAL_IDLE_TIMEOUT_MS;
  }
  return Math.max(1, Math.floor(value));
}
