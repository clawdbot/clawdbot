import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
} from "./subagent-lifecycle-events.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";

const LIFECYCLE_RETRY_GRACE_MS = 15_000;
const PENDING_LIFECYCLE_TERMINAL_TTL_MS = 5 * 60_000;

type PendingLifecycleKind = "error" | "timeout";

type PendingLifecycleTerminal = {
  kind: PendingLifecycleKind;
  timer: NodeJS.Timeout;
  endedAt: number;
  startedAt?: number;
  error?: string;
};

export function createPendingLifecycleScheduler(params: {
  runs: Map<string, SubagentRunRecord>;
  completeInBackground: (completion: SubagentCompletionRequest, source: string) => void;
}) {
  const pendingByRunId = new Map<string, PendingLifecycleTerminal>();

  function clearKind(runId: string, kind?: PendingLifecycleKind) {
    const pending = pendingByRunId.get(runId);
    if (!pending || (kind && pending.kind !== kind)) {
      return;
    }
    clearTimeout(pending.timer);
    pendingByRunId.delete(runId);
  }

  function clearAll() {
    pendingByRunId.forEach(({ timer }) => clearTimeout(timer));
    pendingByRunId.clear();
  }

  function schedule(
    kind: PendingLifecycleKind,
    scheduleParams: { runId: string; endedAt: number; startedAt?: number; error?: string },
  ) {
    clearKind(scheduleParams.runId);
    const timer = setTimeout(() => {
      const pending = pendingByRunId.get(scheduleParams.runId);
      if (!pending || pending.timer !== timer) {
        return;
      }
      pendingByRunId.delete(scheduleParams.runId);
      const entry = params.runs.get(scheduleParams.runId);
      if (!entry) {
        return;
      }
      if (
        kind === "error"
          ? entry.endedReason === SUBAGENT_ENDED_REASON_COMPLETE || entry.outcome?.status === "ok"
          : entry.outcome?.status === "ok" || entry.pauseReason === "sessions_yield"
      ) {
        return;
      }
      params.completeInBackground(
        {
          runId: scheduleParams.runId,
          endedAt: pending.endedAt,
          outcome:
            kind === "error" ? { status: "error", error: pending.error } : { status: "timeout" },
          reason: kind === "error" ? SUBAGENT_ENDED_REASON_ERROR : SUBAGENT_ENDED_REASON_COMPLETE,
          sendFarewell: true,
          accountId: entry.requesterOrigin?.accountId,
          triggerCleanup: true,
          startedAt: pending.startedAt,
        },
        `lifecycle-${kind}-grace`,
      );
    }, LIFECYCLE_RETRY_GRACE_MS);
    timer.unref?.();
    pendingByRunId.set(scheduleParams.runId, { ...scheduleParams, kind, timer });
  }

  return {
    clear: clearKind,
    clearError: (runId: string) => clearKind(runId, "error"),
    clearTimeout: (runId: string) => clearKind(runId, "timeout"),
    clearAll,
    scheduleError: (scheduleParams: Parameters<typeof schedule>[1]) =>
      schedule("error", scheduleParams),
    scheduleTimeout: (scheduleParams: Parameters<typeof schedule>[1]) =>
      schedule("timeout", scheduleParams),
    sweepExpired(now: number) {
      for (const [runId, pending] of pendingByRunId) {
        if (now - pending.endedAt > PENDING_LIFECYCLE_TERMINAL_TTL_MS) {
          clearKind(runId, pending.kind);
        }
      }
    },
  };
}
