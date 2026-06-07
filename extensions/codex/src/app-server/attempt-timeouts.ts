/**
 * Timeout defaults and normalizers for Codex app-server startup and turn
 * liveness watches.
 */
import { addTimerTimeoutGraceMs, resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";

/** Minimum startup timeout accepted by the Codex app-server harness. */
export const CODEX_APP_SERVER_STARTUP_TIMEOUT_FLOOR_MS = 100;
/** Default idle timeout while waiting for app-server turn completion. */
export const CODEX_TURN_COMPLETION_IDLE_TIMEOUT_MS = 60_000;
/** Short guard after apparent assistant completion. */
export const CODEX_TURN_ASSISTANT_COMPLETION_IDLE_TIMEOUT_MS = 10_000;
// Native Codex can spend a long quiet window synthesizing after tool results,
// raw assistant/reasoning completions, or reasoning progress. Forwarded deltas
// count as activity, but older native paths may not surface them, so keep this
// terminal guard conservative.
export const CODEX_POST_TOOL_RAW_ASSISTANT_COMPLETION_IDLE_TIMEOUT_MS = 5 * 60_000;
/** Guard after reasoning/commentary progress when no tool handoff occurred. */
export const CODEX_POST_REASONING_REPLY_IDLE_TIMEOUT_MS = 5 * 60_000;
/** Long terminal idle watch for app-server turns that never send completion. */
export const CODEX_TURN_TERMINAL_IDLE_TIMEOUT_MS = 30 * 60_000;

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

/** Resolves the completion-idle timeout for an active turn. */
export function resolveCodexTurnCompletionIdleTimeoutMs(value: number | undefined): number {
  return resolvePositiveIntegerTimeoutMs(value, CODEX_TURN_COMPLETION_IDLE_TIMEOUT_MS);
}

/** Resolves the short assistant-completion release timeout. */
export function resolveCodexTurnAssistantCompletionIdleTimeoutMs(
  value: number | undefined,
): number {
  return resolvePositiveIntegerTimeoutMs(value, CODEX_TURN_ASSISTANT_COMPLETION_IDLE_TIMEOUT_MS);
}

/** Resolves the conservative post-tool raw assistant guard timeout. */
export function resolveCodexPostToolRawAssistantCompletionIdleTimeoutMs(
  value: number | undefined,
  fallbackMs: number,
): number {
  const defaultMs = Math.max(
    resolvePositiveIntegerTimeoutMs(undefined, fallbackMs),
    CODEX_POST_TOOL_RAW_ASSISTANT_COMPLETION_IDLE_TIMEOUT_MS,
  );
  return resolvePositiveIntegerTimeoutMs(value, defaultMs);
}

/** Resolves the long terminal turn idle timeout. */
export function resolveCodexTurnTerminalIdleTimeoutMs(value: number | undefined): number {
  return resolvePositiveIntegerTimeoutMs(value, CODEX_TURN_TERMINAL_IDLE_TIMEOUT_MS);
}

/** Adds gateway grace time to a caller timeout without overflowing invalid values. */
export function resolveCodexGatewayTimeoutWithGraceMs(timeoutMs: number, graceMs = 10_000): number {
  const timeout = resolvePositiveIntegerTimeoutMs(timeoutMs, 1);
  const grace = resolveTimerTimeoutMs(graceMs, 0, 0);
  return addTimerTimeoutGraceMs(timeout, grace) ?? timeout;
}
