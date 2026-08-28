/**
 * Serialization of agent-command session turns against the reply-run registry.
 *
 * Channel-delivered turns register a ReplyOperation and queue concurrent
 * arrivals behind it per the configured queue mode. Agent-command turns
 * (inter-session sessions_send, gateway agent RPC, cron agent turns)
 * historically dispatched without consulting that registry, so a turn arriving
 * while a channel turn was live started a second concurrent backend on the
 * same session: two processes interleaving one transcript and one workspace.
 *
 * Acquiring the session reply lane closes both directions: the agent-command
 * turn waits for the live run instead of racing it, and while it holds the
 * lane, channel arrivals see the session as busy and queue normally.
 */
import {
  createReplyOperation,
  markReplyOperationExecutionStarted,
  ReplyRunAlreadyActiveError,
  ReplyRunSuccessorAdmissionBlockedError,
  resolveActiveReplyRunSessionId,
  waitForReplyRunEndBySessionId,
  waitForReplyRunSuccessorAdmission,
  type ReplyOperation,
} from "../../auto-reply/reply/reply-run-registry.js";
import { RUN_STALE_TAKEOVER_MS } from "../../logging/diagnostic-run-activity.js";

/**
 * Wedged runs stop refreshing activity and become reclaimable after
 * RUN_STALE_TAKEOVER_MS, so two takeover windows bound the wait on a healthy
 * gateway; past that the session is genuinely stuck and the caller should hear
 * about it rather than pile up more waiters.
 */
const REPLY_LANE_ACQUIRE_TIMEOUT_MS = 2 * RUN_STALE_TAKEOVER_MS;

class SessionReplyLaneBusyError extends Error {
  constructor(sessionKey: string, waitedMs: number) {
    super(
      `Session "${sessionKey}" still has an active reply run after waiting ` +
        `${Math.round(waitedMs / 1000)}s; refusing to start a concurrent turn.`,
    );
    this.name = "SessionReplyLaneBusyError";
  }
}

function abortErrorFrom(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(
        `Aborted while waiting for the session reply lane: ${String(signal.reason ?? "aborted")}`,
      );
}

/**
 * Registers this turn in the reply-run registry, waiting for any active run on
 * the session to end first. The caller must complete() the returned operation
 * when its turn finishes, on every exit path.
 */
export async function acquireSessionReplyLane(
  sessionKey: string,
  sessionId: string,
  options?: { abortSignal?: AbortSignal; timeoutMs?: number; routeThreadId?: string | number },
): Promise<ReplyOperation> {
  const abortSignal = options?.abortSignal;
  const timeoutMs = options?.timeoutMs ?? REPLY_LANE_ACQUIRE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  // Recovery handoffs may rotate the session while this turn waits; adopt the
  // rotated identity so the operation registers against the live session.
  let currentSessionId = sessionId;
  for (;;) {
    if (abortSignal?.aborted) {
      throw abortErrorFrom(abortSignal);
    }
    try {
      const operation = createReplyOperation({
        sessionKey,
        sessionId: currentSessionId,
        turnKind: "visible",
        resetTriggered: false,
        routeThreadId: options?.routeThreadId,
        upstreamAbortSignal: abortSignal,
      });
      markReplyOperationExecutionStarted(operation);
      operation.setPhase("running");
      return operation;
    } catch (error) {
      if (error instanceof ReplyRunSuccessorAdmissionBlockedError) {
        const barrierRemainingMs = deadline - Date.now();
        if (barrierRemainingMs <= 0) {
          throw new SessionReplyLaneBusyError(sessionKey, timeoutMs);
        }
        const handoff = await waitForReplyRunSuccessorAdmission(
          sessionKey,
          barrierRemainingMs,
          abortSignal ? { signal: abortSignal } : undefined,
        );
        if (handoff.sessionId) {
          currentSessionId = handoff.sessionId;
        }
        continue;
      }
      if (!(error instanceof ReplyRunAlreadyActiveError)) {
        throw error;
      }
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new SessionReplyLaneBusyError(sessionKey, timeoutMs);
    }
    const activeSessionId = resolveActiveReplyRunSessionId(sessionKey);
    if (!activeSessionId) {
      // The active run cleared between the failed create and this lookup.
      continue;
    }
    await waitForActiveRunEnd(activeSessionId, remainingMs, abortSignal);
  }
}

async function waitForActiveRunEnd(
  sessionId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    await waitForReplyRunEndBySessionId(sessionId, timeoutMs);
    return;
  }
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      waitForReplyRunEndBySessionId(sessionId, timeoutMs),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(abortErrorFrom(signal));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
