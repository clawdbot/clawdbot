/** Owns the execution deadline, approval pauses, and one compaction grace. */
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { observeAgentRunApprovalWait } from "../../agent-run-approval-wait.js";
import type { AgentSession } from "../../sessions/index.js";
import { log } from "../logger.js";
import {
  resolveRunTimeoutDuringCompaction,
  shouldFlagCompactionTimeout,
} from "./compaction-timeout.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type ExecutionDeadline =
  | { kind: "bounded"; deadlineAtMs: number; compactionGraceUsed: boolean }
  | { kind: "paused"; remainingMs: number; compactionGraceUsed: boolean }
  | { kind: "unlimited" }
  | { kind: "closed" };

type EmbeddedAttemptTimeoutParams = Pick<
  EmbeddedRunAttemptParams,
  "onAttemptDeadlineChanged" | "onAttemptTimeoutArmed" | "runId" | "sessionId" | "timeoutMs"
>;

export function prepareEmbeddedAttemptTimeout(input: {
  attempt: EmbeddedAttemptTimeoutParams;
  activeSession: Pick<AgentSession, "isCompacting" | "isStreaming">;
  compactionState: { isCompacting(): boolean };
  compactionTimeoutMs: number;
  runAbortSignal: AbortSignal;
  isProbeSession: boolean;
  abortRun: (isTimeout?: boolean, reason?: unknown) => void;
  markTimedOutDuringCompaction: () => void;
  markTimedOutByRunBudget: () => void;
}) {
  const { activeSession, attempt, runAbortSignal } = input;
  let deadline: ExecutionDeadline = { kind: "unlimited" };
  let abortTimer: NodeJS.Timeout | undefined;
  let abortWarnTimer: NodeJS.Timeout | undefined;
  const approvalWait = observeAgentRunApprovalWait(attempt);
  const clearTimers = () => {
    deadline = { kind: "closed" };
    approvalWait.dispose();
    runAbortSignal.removeEventListener("abort", clearTimers);
    clearTimeout(abortTimer);
    clearTimeout(abortWarnTimer);
  };
  const timeout = {
    getRunAbortDeadlineAtMs: () =>
      deadline.kind === "bounded" ? deadline.deadlineAtMs : undefined,
    clearTimers,
  };
  if (runAbortSignal.aborted) {
    clearTimers();
    return timeout;
  }
  runAbortSignal.addEventListener("abort", clearTimers, { once: true });

  const scheduleAbortTimer = (delayMs: number, compactionGraceUsed: boolean) => {
    const armed = {
      kind: "bounded" as const,
      deadlineAtMs: Date.now() + Math.max(1, delayMs),
      compactionGraceUsed,
    };
    deadline = armed;
    abortTimer = setTimeout(
      () => {
        if (deadline !== armed) {
          return;
        }
        const compaction = {
          isCompactionPendingOrRetrying: input.compactionState.isCompacting(),
          isCompactionInFlight: activeSession.isCompacting,
        };
        const timeoutAction = resolveRunTimeoutDuringCompaction({
          ...compaction,
          graceAlreadyUsed: armed.compactionGraceUsed,
        });
        if (timeoutAction === "extend") {
          if (!input.isProbeSession) {
            log.warn(
              `embedded run timeout reached during compaction; extending deadline: ` +
                `runId=${attempt.runId} sessionId=${attempt.sessionId} extraMs=${input.compactionTimeoutMs}`,
            );
          }
          scheduleAbortTimer(input.compactionTimeoutMs, true);
          return;
        }

        // Close scheduling before abort callbacks can resolve approvals or dispose
        // the attempt. Arm the warning first so synchronous cleanup can clear it.
        clearTimers();
        abortWarnTimer = setTimeout(() => {
          if (activeSession.isStreaming && !input.isProbeSession) {
            log.warn(
              `embedded run abort still streaming: runId=${attempt.runId} sessionId=${attempt.sessionId}`,
            );
          }
        }, 10_000);
        if (!input.isProbeSession) {
          log.warn(
            armed.compactionGraceUsed
              ? `embedded run timeout after compaction grace: runId=${attempt.runId} sessionId=${attempt.sessionId} timeoutMs=${attempt.timeoutMs} compactionGraceMs=${input.compactionTimeoutMs}`
              : `embedded run timeout: runId=${attempt.runId} sessionId=${attempt.sessionId} timeoutMs=${attempt.timeoutMs}`,
          );
        }
        if (shouldFlagCompactionTimeout({ isTimeout: true, ...compaction })) {
          input.markTimedOutDuringCompaction();
        }
        // Settlement revalidates timeout ownership before publishing partial output.
        input.markTimedOutByRunBudget();
        input.abortRun(true);
      },
      Math.max(1, delayMs),
    );
    attempt.onAttemptDeadlineChanged?.({ kind: "bounded", deadlineAtMs: armed.deadlineAtMs });
  };

  approvalWait.onChange = (pending) => {
    if (pending && deadline.kind === "bounded") {
      // Human review preserves the unused execution or compaction-grace budget;
      // the lane and async-task waiter must not retain its old wall-clock deadline.
      deadline = {
        kind: "paused",
        remainingMs: Math.max(1, deadline.deadlineAtMs - Date.now()),
        compactionGraceUsed: deadline.compactionGraceUsed,
      };
      clearTimeout(abortTimer);
      attempt.onAttemptDeadlineChanged?.({ kind: "unlimited" });
    } else if (!pending && deadline.kind === "paused") {
      scheduleAbortTimer(deadline.remainingMs, deadline.compactionGraceUsed);
    }
  };
  if (attempt.timeoutMs >= MAX_TIMER_TIMEOUT_MS) {
    attempt.onAttemptDeadlineChanged?.({ kind: "unlimited" });
  } else {
    scheduleAbortTimer(attempt.timeoutMs, false);
  }
  if (!runAbortSignal.aborted) {
    attempt.onAttemptTimeoutArmed?.();
  }
  return timeout;
}
