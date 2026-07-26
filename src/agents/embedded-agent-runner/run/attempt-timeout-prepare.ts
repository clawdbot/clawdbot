/**
 * Owns the run deadline, compaction grace, and external abort listener.
 */
import { isSignalTimeoutReason } from "../../failover-error.js";
import type { AgentSession } from "../../sessions/index.js";
import { log } from "../logger.js";
import {
  resolveRunTimeoutDuringCompaction,
  shouldFlagCompactionTimeout,
} from "./compaction-timeout.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type AttemptCompactionState = {
  isCompacting(): boolean;
};

type EmbeddedAttemptTimeoutParams = Pick<
  EmbeddedRunAttemptParams,
  "abortSignal" | "onAttemptTimeoutArmed" | "runId" | "sessionId" | "timeoutMs"
>;

function getAbortReason(signal: AbortSignal): unknown {
  return "reason" in signal ? (signal as { reason?: unknown }).reason : undefined;
}

export function prepareEmbeddedAttemptTimeout(input: {
  attempt: EmbeddedAttemptTimeoutParams;
  activeSession: Pick<AgentSession, "isCompacting" | "isStreaming">;
  compactionState: AttemptCompactionState;
  compactionTimeoutMs: number;
  isProbeSession: boolean;
  abortRun: (isTimeout?: boolean, reason?: unknown) => void;
  markExternalAbort: () => void;
  markTimedOutDuringCompaction: () => void;
  markTimedOutByRunBudget: () => void;
}) {
  const { activeSession, attempt } = input;
  let abortWarnTimer: NodeJS.Timeout | undefined;
  let abortTimer: NodeJS.Timeout | undefined;
  let runAbortDeadlineAtMs = Date.now() + attempt.timeoutMs;
  let compactionGraceUsed = false;

  const scheduleAbortTimer = (delayMs: number, reason: "initial" | "compaction-grace") => {
    runAbortDeadlineAtMs = Date.now() + Math.max(1, delayMs);
    abortTimer = setTimeout(
      () => {
        const timeoutAction = resolveRunTimeoutDuringCompaction({
          isCompactionPendingOrRetrying: input.compactionState.isCompacting(),
          isCompactionInFlight: activeSession.isCompacting,
          graceAlreadyUsed: compactionGraceUsed,
        });
        if (timeoutAction === "extend") {
          compactionGraceUsed = true;
          if (!input.isProbeSession) {
            log.warn(
              `embedded run timeout reached during compaction; extending deadline: ` +
                `runId=${attempt.runId} sessionId=${attempt.sessionId} extraMs=${input.compactionTimeoutMs}`,
            );
          }
          scheduleAbortTimer(input.compactionTimeoutMs, "compaction-grace");
          return;
        }

        if (!input.isProbeSession) {
          log.warn(
            reason === "compaction-grace"
              ? `embedded run timeout after compaction grace: runId=${attempt.runId} sessionId=${attempt.sessionId} timeoutMs=${attempt.timeoutMs} compactionGraceMs=${input.compactionTimeoutMs}`
              : `embedded run timeout: runId=${attempt.runId} sessionId=${attempt.sessionId} timeoutMs=${attempt.timeoutMs}`,
          );
        }
        if (
          shouldFlagCompactionTimeout({
            isTimeout: true,
            isCompactionPendingOrRetrying: input.compactionState.isCompacting(),
            isCompactionInFlight: activeSession.isCompacting,
          })
        ) {
          input.markTimedOutDuringCompaction();
        }
        input.markTimedOutByRunBudget();
        input.abortRun(true);
        if (!abortWarnTimer) {
          abortWarnTimer = setTimeout(() => {
            if (!activeSession.isStreaming) {
              return;
            }
            if (!input.isProbeSession) {
              log.warn(
                `embedded run abort still streaming: runId=${attempt.runId} sessionId=${attempt.sessionId}`,
              );
            }
          }, 10_000);
        }
      },
      Math.max(1, delayMs),
    );
  };

  scheduleAbortTimer(attempt.timeoutMs, "initial");
  attempt.onAttemptTimeoutArmed?.();

  const onAbort = () => {
    input.markExternalAbort();
    const reason = attempt.abortSignal ? getAbortReason(attempt.abortSignal) : undefined;
    const timeout = reason ? isSignalTimeoutReason(reason) : false;
    if (
      shouldFlagCompactionTimeout({
        isTimeout: timeout,
        isCompactionPendingOrRetrying: input.compactionState.isCompacting(),
        isCompactionInFlight: activeSession.isCompacting,
      })
    ) {
      input.markTimedOutDuringCompaction();
    }
    input.abortRun(timeout, reason);
  };
  if (attempt.abortSignal) {
    if (attempt.abortSignal.aborted) {
      onAbort();
    } else {
      attempt.abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  return {
    getRunAbortDeadlineAtMs: () => runAbortDeadlineAtMs,
    clearTimers: () => {
      if (abortTimer) {
        clearTimeout(abortTimer);
      }
      if (abortWarnTimer) {
        clearTimeout(abortWarnTimer);
      }
    },
    removeAbortSignalListener: () => {
      attempt.abortSignal?.removeEventListener("abort", onAbort);
    },
  };
}
