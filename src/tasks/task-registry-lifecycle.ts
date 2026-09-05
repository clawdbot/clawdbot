import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "../agents/agent-run-terminal-outcome.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { hasAuthoritativeTaskBacking, readTaskBackingInstance } from "./task-backing-authority.js";
import { isTerminalTaskStatus } from "./task-executor-policy.js";
import { recordTaskActivityEvent } from "./task-registry-activity.js";
import {
  appendTaskEvent,
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

// Keep durable liveness well inside the 30-minute stale-task audit without writing every delta.
const ACTIVITY_LIVENESS_WRITE_MS = 60_000;

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
    const subagent = subagentRuns.get(evt.runId);
    const canonicalRunId = subagent?.taskRunId;
    // Replacement runs retain the original task identity. Follow the live
    // registry owner without changing event routing for other task runtimes.
    if (canonicalRunId && canonicalRunId !== evt.runId) {
      scopedTasks.push(
        ...getTasksByRunScope({
          runId: canonicalRunId,
          runtime: "subagent",
          sessionKey: evt.sessionKey,
        }).filter((task) => readTaskBackingInstance(task.detail)?.runtime === "subagent"),
      );
    }
    if (scopedTasks.length === 0) {
      return;
    }
    const now = evt.ts || Date.now();
    for (const current of scopedTasks) {
      const backing = readTaskBackingInstance(current.detail);
      const registryBackedSubagent =
        current.runtime === "subagent" && backing?.runtime === "subagent";
      if (
        isTerminalTaskStatus(current.status) ||
        !hasAuthoritativeTaskBacking(current) ||
        (registryBackedSubagent &&
          (subagent?.generation !== backing.generation ||
            subagent?.childSessionKey !== current.childSessionKey))
      ) {
        continue;
      }
      recordTaskActivityEvent(current, evt);
      const patch: Partial<TaskRecord> = {};
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
        } else if (phase === "end" || phase === "error") {
          // Registry-backed subagents keep task.runId across replacement runs.
          // Their registry owns terminal projection; predecessor events do not.
          if (registryBackedSubagent) {
            continue;
          }
          const terminal = buildAgentRunTerminalOutcomeFromLifecycleEvent({
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
            terminalReason: terminal.reason,
            error: terminal.error,
          });
          if (error || phase === "error") {
            patch.error = error ?? current.error;
          }
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
      const lastEventAt = current.lastEventAt ?? current.startedAt ?? current.createdAt;
      if (Object.keys(patch).length === 0 && now - lastEventAt < ACTIVITY_LIVENESS_WRITE_MS) {
        continue;
      }
      patch.lastEventAt = now;
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
