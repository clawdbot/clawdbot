/**
 * Owns the run deadline and compaction grace.
 */
import { observeAgentRunApprovalWait } from "../../agent-run-approval-wait.js";
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
  "onAttemptTimeoutArmed" | "runId" | "sessionId" | "timeoutMs"
>;

export function prepareEmbeddedAttemptTimeout(input: {
  attempt: EmbeddedAttemptTimeoutParams;
  activeSession: Pick<AgentSession, "isCompacting" | "isStreaming">;
  compactionState: AttemptCompactionState;
  compactionTimeoutMs: number;
  isProbeSession: boolean;
  abortRun: (isTimeout?: boolean, reason?: unknown) => void;
  markTimedOutDuringCompaction: () => void;
  markTimedOutByRunBudget: () => void;
}) {
  const { activeSession, attempt } = input;
  let abortWarnTimer: NodeJS.Timeout | undefined;
  let abortTimer: NodeJS.Timeout | undefined;
  let runAbortDeadlineAtMs = Date.now() + attempt.timeoutMs;
  let compactionGraceUsed = false;
  let pausedRemainingMs = 0;
  const approvalWait = observeAgentRunApprovalWait(attempt);

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
        // Settlement owns partial-output publication because abort or failure
        // can still supersede this timeout while queued events drain.
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

  approvalWait.onChange = (pending) => {
    if (pending) {
      // Human review consumes neither the run budget nor an active compaction grace window.
      pausedRemainingMs = Math.max(1, runAbortDeadlineAtMs - Date.now());
      clearTimeout(abortTimer);
    } else {
      scheduleAbortTimer(pausedRemainingMs, compactionGraceUsed ? "compaction-grace" : "initial");
    }
  };
  scheduleAbortTimer(attempt.timeoutMs, "initial");
  attempt.onAttemptTimeoutArmed?.();

  return {
    getRunAbortDeadlineAtMs: () => runAbortDeadlineAtMs,
    clearTimers: () => {
      approvalWait.dispose();
      if (abortTimer) {
        clearTimeout(abortTimer);
      }
      if (abortWarnTimer) {
        clearTimeout(abortWarnTimer);
      }
    },
  };
}
