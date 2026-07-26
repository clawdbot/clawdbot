import type { AgentEventPayload } from "../infra/agent-events.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import {
  formatAbandonedLivenessError,
  formatBlockedLivenessError,
  isAbandonedLivenessState,
  isBlockedLivenessState,
} from "../shared/agent-liveness.js";
import { isAbortedAgentStopReason } from "./run-termination.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { createPendingLifecycleScheduler } from "./subagent-registry-pending-lifecycle.js";
import { markSubagentRunPausedAfterYield } from "./subagent-registry-run-manager.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";

export function createSubagentRegistryListener(config: {
  runs: Map<string, SubagentRunRecord>;
  pendingLifecycle: ReturnType<typeof createPendingLifecycleScheduler>;
  onAgentEvent: (listener: (event: AgentEventPayload) => void) => () => void;
  persist: () => void;
  refreshFrozenResultFromSession: (sessionKey: string) => Promise<unknown>;
  completeSubagentRunWithRecovery: (
    params: SubagentCompletionRequest,
    source: string,
  ) => Promise<void>;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}) {
  const {
    runs,
    pendingLifecycle,
    onAgentEvent,
    persist,
    refreshFrozenResultFromSession,
    completeSubagentRunWithRecovery,
    warn,
  } = config;
  let listenerStarted = false;
  let listenerStop: (() => void) | null = null;

  function ensureListener() {
    if (listenerStarted) {
      return;
    }
    listenerStarted = true;
    listenerStop = onAgentEvent((evt) => {
      void (async () => {
        if (!evt || evt.stream !== "lifecycle") {
          return;
        }
        const phase = evt.data?.phase;
        const entry = runs.get(evt.runId);
        if (!entry) {
          if (phase === "end" && typeof evt.sessionKey === "string") {
            const sessionKey = evt.sessionKey;
            // A replacement generation can finish after its predecessor row is
            // terminal. Keep capture + persistence inside the suspension fence.
            await runWithGatewayIndependentRootWorkAdmission(async () => {
              await refreshFrozenResultFromSession(sessionKey);
            });
          }
          return;
        }
        if (phase === "start") {
          pendingLifecycle.clear(evt.runId);
          const startedAt =
            typeof evt.data?.startedAt === "number" ? evt.data.startedAt : undefined;
          if (startedAt) {
            entry.startedAt = startedAt;
            if (typeof entry.sessionStartedAt !== "number") {
              entry.sessionStartedAt = startedAt;
            }
            entry.execution = { ...entry.execution, status: "running", startedAt };
            persist();
          }
          return;
        }
        if (phase !== "end" && phase !== "error") {
          return;
        }
        const endedAt = typeof evt.data?.endedAt === "number" ? evt.data.endedAt : Date.now();
        const startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : undefined;
        const error = typeof evt.data?.error === "string" ? evt.data.error : undefined;
        const livenessState =
          typeof evt.data?.livenessState === "string" ? evt.data.livenessState : undefined;
        const stopReason =
          typeof evt.data?.stopReason === "string" ? evt.data.stopReason : undefined;
        // sessions_yield ends the turn by aborting the run signal, so a yielded
        // terminal can also look aborted. An explicit yield is authoritative — pause,
        // don't kill — else the tracking task settles `cancelled` with a false notice (#92448).
        if (evt.data?.yielded === true) {
          // Drop any grace timer from an earlier aborted/error terminal so it can't
          // later fire and settle this now-paused run with a false notice.
          pendingLifecycle.clear(evt.runId);
          if (
            markSubagentRunPausedAfterYield({
              entry,
              endedAt,
              startedAt: startedAt ?? entry.startedAt,
            })
          ) {
            persist();
          }
          return;
        }
        if (isAbortedAgentStopReason(stopReason)) {
          pendingLifecycle.clear(evt.runId);
          await completeSubagentRunWithRecovery(
            {
              runId: evt.runId,
              endedAt,
              outcome: {
                status: "error",
                error: "subagent run terminated",
              },
              reason: SUBAGENT_ENDED_REASON_KILLED,
              sendFarewell: true,
              accountId: entry.requesterOrigin?.accountId,
              triggerCleanup: true,
              startedAt,
            },
            "lifecycle-killed-event",
          );
          return;
        }
        if (phase === "error") {
          pendingLifecycle.scheduleError({
            runId: evt.runId,
            endedAt,
            startedAt,
            error,
          });
          return;
        }
        const blocked = isBlockedLivenessState(livenessState);
        const abandoned = isAbandonedLivenessState(livenessState);
        if (blocked || abandoned) {
          pendingLifecycle.clear(evt.runId);
          const blockedParams = {
            runId: evt.runId,
            endedAt,
            outcome: {
              status: "error" as const,
              error: blocked
                ? formatBlockedLivenessError(error)
                : formatAbandonedLivenessError(error),
            },
            reason: SUBAGENT_ENDED_REASON_ERROR,
            sendFarewell: true,
            accountId: entry.requesterOrigin?.accountId,
            triggerCleanup: true,
            startedAt,
          };
          await completeSubagentRunWithRecovery(
            blockedParams,
            blocked ? "lifecycle-blocked-event" : "lifecycle-abandoned-event",
          );
          return;
        }
        if (evt.data?.aborted) {
          pendingLifecycle.scheduleTimeout({
            runId: evt.runId,
            endedAt,
            startedAt,
          });
          return;
        }
        pendingLifecycle.clear(evt.runId);
        const completionParams = {
          runId: evt.runId,
          endedAt,
          outcome: { status: "ok" as const },
          reason: SUBAGENT_ENDED_REASON_COMPLETE,
          sendFarewell: true,
          accountId: entry.requesterOrigin?.accountId,
          triggerCleanup: true,
          startedAt,
        };
        await completeSubagentRunWithRecovery(completionParams, "lifecycle-ok-event");
      })().catch((err: unknown) => {
        warn("lifecycle event handler failed", { err, runId: evt.runId });
      });
    });
  }

  return {
    ensure: ensureListener,
    reset: () => {
      if (listenerStop) {
        listenerStop();
        listenerStop = null;
      }
      listenerStarted = false;
    },
  };
}
