import { onAgentEvent } from "../infra/agent-events.js";
import { isTerminalTaskStatus } from "./task-executor-policy.js";
import {
  appendTaskEvent,
  buildTaskLifecycleTerminalOutcome,
  mapAgentRunTerminalOutcomeToTaskStatus,
  resolveTaskLifecycleTerminalError,
} from "./task-registry-common.js";
import {
  maybeDeliverTaskStateChangeUpdate,
  maybeDeliverTaskTerminalUpdate,
} from "./task-registry-delivery.js";
import { updateTask } from "./task-registry-mutation.js";
import {
  claimTaskRegistryListenerStart,
  getTasksByRunScope,
  restoreTaskRegistryOnce,
  setTaskRegistryListenerStarter,
  setTaskRegistryListenerStop,
} from "./task-registry-state.js";
import type { TaskRecord } from "./task-registry.types.js";

function ensureListener() {
  if (!claimTaskRegistryListenerStart()) {
    return;
  }
  const stop = onAgentEvent((evt) => {
    restoreTaskRegistryOnce();
    const scopedTasks = getTasksByRunScope({
      runId: evt.runId,
      sessionKey: evt.sessionKey,
    });
    if (scopedTasks.length === 0) {
      return;
    }
    const now = evt.ts || Date.now();
    for (const current of scopedTasks) {
      if (isTerminalTaskStatus(current.status)) {
        continue;
      }
      const patch: Partial<TaskRecord> = {
        lastEventAt: now,
      };
      if (evt.stream === "lifecycle") {
        const phase = typeof evt.data?.phase === "string" ? evt.data.phase : undefined;
        const eventStartedAt = evt.data?.startedAt;
        const startedAt =
          typeof eventStartedAt === "number" && Number.isFinite(eventStartedAt)
            ? eventStartedAt
            : current.startedAt;
        const endedAt = typeof evt.data?.endedAt === "number" ? evt.data.endedAt : undefined;
        if (startedAt !== undefined) {
          patch.startedAt = startedAt;
        }
        if (phase === "start") {
          patch.status = "running";
        } else if (phase === "end") {
          const terminal = buildTaskLifecycleTerminalOutcome({
            phase,
            data: evt.data,
            startedAt,
            endedAt: endedAt ?? now,
          });
          patch.status = mapAgentRunTerminalOutcomeToTaskStatus(terminal);
          patch.endedAt = terminal.endedAt ?? now;
          const error = resolveTaskLifecycleTerminalError({
            runtime: current.runtime,
            status: patch.status,
            error: terminal.error,
          });
          if (error) {
            patch.error = error;
          }
        } else if (phase === "error") {
          const terminal = buildTaskLifecycleTerminalOutcome({
            phase,
            data: evt.data,
            startedAt,
            endedAt: endedAt ?? now,
          });
          patch.status = mapAgentRunTerminalOutcomeToTaskStatus(terminal);
          patch.endedAt = terminal.endedAt ?? now;
          patch.error =
            resolveTaskLifecycleTerminalError({
              runtime: current.runtime,
              status: patch.status,
              error: terminal.error,
            }) ?? current.error;
        }
      } else if (evt.stream === "error") {
        patch.error = typeof evt.data?.error === "string" ? evt.data.error : current.error;
      } else if (evt.stream === "tool" && evt.data?.phase === "start") {
        // Tool starts are the activity signal surfaced in task summaries; ends
        // and outputs only refresh lastEventAt.
        const toolName = typeof evt.data.name === "string" ? evt.data.name.trim() : "";
        if (toolName) {
          patch.toolUseCount = (current.toolUseCount ?? 0) + 1;
          patch.lastToolName = toolName;
        }
      }
      const stateChangeEvent =
        patch.status && patch.status !== current.status
          ? appendTaskEvent({
              at: now,
              kind: patch.status,
              summary:
                patch.status === "failed"
                  ? (patch.error ?? current.error)
                  : patch.status === "succeeded"
                    ? current.terminalSummary
                    : undefined,
            })
          : undefined;
      const updated = updateTask(current.taskId, patch);
      if (updated) {
        void maybeDeliverTaskStateChangeUpdate(current.taskId, stateChangeEvent);
        void maybeDeliverTaskTerminalUpdate(current.taskId);
      }
    }
  });
  setTaskRegistryListenerStop(stop);
}

setTaskRegistryListenerStarter(ensureListener);
