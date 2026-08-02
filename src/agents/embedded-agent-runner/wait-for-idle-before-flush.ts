/**
 * Waits for tool-result streams to become idle before flushing output.
 */
import { resolveTimerTimeoutMs } from "../../shared/number-coercion.js";

type IdleAwareAgent = {
  waitForIdle?: (() => Promise<void>) | undefined;
};

type ToolResultFlushManager = {
  flushPendingToolResults?: (() => void) | undefined;
  clearPendingToolResults?: (() => void) | undefined;
  /**
   * Optional settlement barrier owned by the tool-result guard: awaits the
   * runner-owned completion of pending tool-result writes (each tracked id
   * being deleted as its real result lands) or returns after the timeout so
   * the caller can flush the remainder synthetically.
   */
  waitForPendingToolResultSettlement?: ((timeoutMs: number) => Promise<void>) | undefined;
};

const DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS = 30_000;

async function waitForAgentIdleBestEffort(
  agent: IdleAwareAgent | null | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const waitForIdle = agent?.waitForIdle;
  if (typeof waitForIdle !== "function") {
    return false;
  }
  const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS);

  const idleResolved = Symbol("idle");
  const idleTimedOut = Symbol("timeout");
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      waitForIdle.call(agent).then(() => idleResolved),
      new Promise<symbol>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(idleTimedOut), resolvedTimeoutMs);
        timeoutHandle.unref?.();
      }),
    ]);
    return outcome === idleTimedOut;
  } catch {
    // Best-effort during cleanup.
    return false;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export async function flushPendingToolResultsAfterIdle(opts: {
  agent: IdleAwareAgent | null | undefined;
  sessionManager: ToolResultFlushManager | null | undefined;
  timeoutMs?: number;
}): Promise<void> {
  const isImmediateTimeout = opts.timeoutMs !== undefined && opts.timeoutMs <= 0;
  if (!isImmediateTimeout) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS;
    const idleTimedOut = await waitForAgentIdleBestEffort(opts.agent, timeoutMs);
    // Settlement barrier: await the runner-owned tool-result write completion
    // (each pending id being deleted as its real result lands) rather than a
    // fixed event-loop tick count. A real in-flight HTTP result that settles
    // after the agent reports idle wins over the synthetic flush; a result
    // that never settles is still flushed once the timeout elapses.
    // Skipped when idle itself timed out (agent stuck) so cleanup does not
    // double-wait before the fail-safe synthetic flush.
    if (!idleTimedOut) {
      await opts.sessionManager?.waitForPendingToolResultSettlement?.(timeoutMs);
    }
  }
  opts.sessionManager?.flushPendingToolResults?.();
}
