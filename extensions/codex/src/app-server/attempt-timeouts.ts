/**
 * Timeout defaults and normalizers for Codex app-server startup and turn
 * liveness watches.
 */
import { addTimerTimeoutGraceMs, resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";

/** Minimum startup timeout accepted by the Codex app-server harness. */
const CODEX_APP_SERVER_STARTUP_TIMEOUT_FLOOR_MS = 100;
// Native terminal receipt must still reach local settlement; a blocked
// projection must not retain the session lane indefinitely.
export const TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS = 2 * 60_000;
// Aborted/timed-out completions still join queued projection work; this grace
// bounds a blocked handler tail so finalization cannot hang forever.
export const TURN_FINALIZE_DRAIN_ABORT_GRACE_MS = 5_000;

type CodexAppServerStartupErrorReason = "aborted" | "timed_out";

export class CodexAppServerStartupError extends Error {
  readonly code = "CODEX_APP_SERVER_STARTUP_CANCELLED";

  constructor(
    readonly reason: CodexAppServerStartupErrorReason,
    message = reason === "timed_out"
      ? "codex app-server startup timed out"
      : "codex app-server startup aborted",
  ) {
    super(message);
    this.name = "CodexAppServerStartupError";
  }
}

export function isCodexAppServerStartupError(
  error: unknown,
  reason?: CodexAppServerStartupErrorReason,
): error is CodexAppServerStartupError {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "CODEX_APP_SERVER_STARTUP_CANCELLED" &&
    "reason" in error &&
    (error.reason === "aborted" || error.reason === "timed_out") &&
    (reason === undefined || error.reason === reason)
  );
}

function resolvePositiveIntegerTimeoutMs(value: number | undefined, fallbackMs: number): number {
  const fallback = resolveTimerTimeoutMs(fallbackMs, 1);
  return resolveTimerTimeoutMs(value, fallback);
}

/** Runs startup work with abort and timeout handling plus optional cleanup. */
export async function withCodexStartupTimeout<T>(params: {
  timeoutMs: number;
  signal: AbortSignal;
  onTimeout?: () => void | Promise<void>;
  operation: () => Promise<T>;
}): Promise<T> {
  if (params.signal.aborted) {
    throw new CodexAppServerStartupError("aborted");
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
          timeoutError = new CodexAppServerStartupError("timed_out");
          timeoutCleanup = Promise.resolve(params.onTimeout?.()).then(
            () => undefined,
            () => undefined,
          );
          void timeoutCleanup.finally(() => {
            rejectOnce(timeoutError!);
          });
        }, params.timeoutMs);
        const abortListener = () => rejectOnce(new CodexAppServerStartupError("aborted"));
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

/** Resolves startup timeout while honoring the configured floor. */
export function resolveCodexStartupTimeoutMs(params: {
  timeoutMs: number;
  timeoutFloorMs?: number;
}): number {
  const timeoutFloorMs = resolvePositiveIntegerTimeoutMs(
    params.timeoutFloorMs,
    CODEX_APP_SERVER_STARTUP_TIMEOUT_FLOOR_MS,
  );
  const timeoutMs = resolvePositiveIntegerTimeoutMs(params.timeoutMs, timeoutFloorMs);
  return Math.max(timeoutFloorMs, timeoutMs);
}

/** Adds gateway grace time to a caller timeout without overflowing invalid values. */
export function resolveCodexGatewayTimeoutWithGraceMs(timeoutMs: number, graceMs = 10_000): number {
  const timeout = resolvePositiveIntegerTimeoutMs(timeoutMs, 1);
  const grace = resolveTimerTimeoutMs(graceMs, 0, 0);
  return addTimerTimeoutGraceMs(timeout, grace) ?? timeout;
}
