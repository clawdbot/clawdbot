import type { AgentEventPayload } from "../../../infra/agent-events.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../../process/gateway-work-admission.js";
import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "../../agent-run-terminal-outcome.js";
import { normalizeAgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import { classifySubagentTerminalOutcome } from "../subagent-terminal-outcome.js";
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
  persist: (...runIds: string[]) => void;
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
            if (typeof entry.sessionStartedAt !== "number") {
              entry.sessionStartedAt = startedAt;
            }
            entry.execution = { ...entry.execution, status: "running", startedAt };
            persist(entry.runId);
          }
          return;
        }
        if (phase !== "end" && phase !== "error") {
          return;
        }
        const endedAt = typeof evt.data?.endedAt === "number" ? evt.data.endedAt : Date.now();
        const startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : undefined;
        const terminalReply = normalizeAgentRunTerminalReplySnapshot(evt.data?.terminalReply);
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
              startedAt: startedAt ?? entry.execution.startedAt,
            })
          ) {
            persist(entry.runId);
          }
          return;
        }
        const terminalOutcome = buildAgentRunTerminalOutcomeFromLifecycleEvent({
          phase,
          data: evt.data,
          startedAt,
          endedAt,
        });
        const classification = classifySubagentTerminalOutcome(terminalOutcome);
        if (
          classification === "cancellation" &&
          evt.data?.aborted === true &&
          evt.data.stopReason === undefined &&
          evt.data.status === undefined &&
          evt.data.timeoutPhase === undefined
        ) {
          pendingLifecycle.scheduleCancellation({
            runId: evt.runId,
            endedAt,
            startedAt,
            terminalReply,
          });
          return;
        }
        if (classification === "timeout") {
          pendingLifecycle.scheduleTimeout({
            runId: evt.runId,
            endedAt,
            startedAt,
            terminalReply,
          });
          return;
        }
        if (phase === "error" && classification === "failure") {
          pendingLifecycle.scheduleError({
            runId: evt.runId,
            endedAt,
            startedAt,
            terminalReply,
            error: terminalOutcome.error,
          });
          return;
        }
        if (classification !== "success") {
          const cancelled = classification === "cancellation";
          pendingLifecycle.clear(evt.runId);
          await completeSubagentRunWithRecovery(
            {
              runId: evt.runId,
              endedAt,
              outcome: {
                status: "error" as const,
                error: cancelled ? "subagent run terminated" : terminalOutcome.error,
              },
              reason: cancelled ? SUBAGENT_ENDED_REASON_KILLED : SUBAGENT_ENDED_REASON_ERROR,
              sendFarewell: true,
              accountId: entry.requesterOrigin?.accountId,
              triggerCleanup: true,
              startedAt,
              terminalReply,
            },
            cancelled ? "lifecycle-killed-event" : `lifecycle-${terminalOutcome.reason}-event`,
          );
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
          terminalReply,
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
