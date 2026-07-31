/**
 * Runtime SDK helpers for agent harness task persistence and completion delivery.
 */
import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import { buildAnnounceIdempotencyKey } from "../agents/announce-idempotency.js";
import {
  AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION,
  type AgentInternalEventStatus,
} from "../agents/internal-event-contract.js";
import {
  formatAgentInternalEventsForPrompt,
  type AgentInternalEvent,
} from "../agents/internal-events.js";
import {
  deliverSubagentAnnouncement,
  isInternalAnnounceRequesterSession,
  loadRequesterSessionEntry,
} from "../agents/subagent-announce-delivery.js";
import {
  resolveAnnounceOrigin,
  resolveSubagentCompletionOrigin,
} from "../agents/subagent-announce-origin.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { PluginHookSubagentProgressEvent } from "../plugins/hook-types.js";
import {
  assertAgentHarnessTaskRuntimeScope,
  type AgentHarnessTaskRuntimeScope,
} from "../tasks/agent-harness-task-runtime-scope.js";
import {
  createRunningTaskRun,
  finalizeTaskRunByRunId,
  recordTaskRunProgressByRunId,
  setDetachedTaskDeliveryStatusByRunId,
} from "../tasks/detached-task-runtime.js";
import { listTaskRecords, type TaskRecord } from "../tasks/runtime-internal.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";

export type { TaskRecord as AgentHarnessTaskRecord };
export type { AgentHarnessTaskRuntimeScope };

type AgentHarnessTaskRuntimeId = Parameters<typeof createRunningTaskRun>[0]["runtime"];
type CreateRunningTaskRunParams = Parameters<typeof createRunningTaskRun>[0];
type RecordTaskRunProgressParams = Parameters<typeof recordTaskRunProgressByRunId>[0];
type FinalizeTaskRunParams = Parameters<typeof finalizeTaskRunByRunId>[0];
type SetDeliveryStatusParams = Parameters<typeof setDetachedTaskDeliveryStatusByRunId>[0];
type WithoutRequester<T> = T extends unknown ? Omit<T, "requester"> : never;
type AgentHarnessSubagentProgressOutcome = Extract<
  PluginHookSubagentProgressEvent,
  { phase: "ended" }
>["outcome"];

const log = createSubsystemLogger("agents/harness");
const AGENT_HARNESS_SUBAGENT_PROGRESS_OUTCOMES = new Set<AgentHarnessSubagentProgressOutcome>([
  "ok",
  "error",
  "timeout",
  "killed",
  "unknown",
]);

/** Scope and naming options used to bind task operations to one requester session. */
export type AgentHarnessTaskRuntimeScopeParams = {
  scope: AgentHarnessTaskRuntimeScope;
  runIdPrefix?: string;
} & (
  | {
      // Core identifies harness-owned subagent rows by the taskKind stamped here
      // (isHarnessOwnedSubagentTask); a subagent row created without one would be
      // read as an OpenClaw-owned child session and reclaimed on the short grace.
      runtime: Extract<AgentHarnessTaskRuntimeId, "subagent">;
      taskKind: string;
    }
  | {
      runtime: Exclude<AgentHarnessTaskRuntimeId, "subagent">;
      taskKind?: string;
    }
);

/** Create-task params with runtime and requester scope supplied by the scoped task runtime. */
export type AgentHarnessScopedCreateRunningTaskRunParams = Omit<
  CreateRunningTaskRunParams,
  "runtime" | "taskKind" | "requesterSessionKey" | "ownerKey" | "scopeKind"
> & {
  runId: string;
};

/** Progress params scoped to the requester session owned by the harness runtime. */
export type AgentHarnessScopedRecordTaskRunProgressParams = Omit<
  RecordTaskRunProgressParams,
  "runtime" | "sessionKey"
>;

/** Finalization params scoped to the requester session owned by the harness runtime. */
export type AgentHarnessScopedFinalizeTaskRunParams = Omit<
  FinalizeTaskRunParams,
  "runtime" | "sessionKey"
>;

/** Delivery-status params scoped to the requester session owned by the harness runtime. */
export type AgentHarnessScopedSetDeliveryStatusParams = Omit<
  SetDeliveryStatusParams,
  "runtime" | "sessionKey"
>;

/** Portable presentation event emitted explicitly by a native harness owner. */
export type AgentHarnessSubagentProgressParams = WithoutRequester<PluginHookSubagentProgressEvent>;

/** Scoped task runtime that prevents callers from mutating tasks outside their harness scope. */
export type AgentHarnessTaskRuntime = {
  createRunningTaskRun(params: AgentHarnessScopedCreateRunningTaskRunParams): TaskRecord;
  tryCreateRunningTaskRun(params: AgentHarnessScopedCreateRunningTaskRunParams): TaskRecord | null;
  recordTaskRunProgressByRunId(params: AgentHarnessScopedRecordTaskRunProgressParams): TaskRecord[];
  finalizeTaskRunByRunId(params: AgentHarnessScopedFinalizeTaskRunParams): TaskRecord[];
  setDetachedTaskDeliveryStatusByRunId(
    params: AgentHarnessScopedSetDeliveryStatusParams,
  ): TaskRecord[];
  listTaskRecords(): TaskRecord[];
  emitSubagentProgress(params: AgentHarnessSubagentProgressParams): void;
};

/** Completion states a harness task can report to its requester. */
export type AgentHarnessCompletionStatus = "succeeded" | "failed" | "cancelled";

/** Delivery result returned after routing a harness task completion announcement. */
export type AgentHarnessCompletionDelivery = Awaited<
  ReturnType<typeof deliverSubagentAnnouncement>
>;

const AGENT_HARNESS_COMPLETION_SOURCE_TOOL = "agent_harness_task";

/** Creates a task runtime whose run ids and task records are constrained to one scope. */
export function createAgentHarnessTaskRuntime(
  params: AgentHarnessTaskRuntimeScopeParams,
): AgentHarnessTaskRuntime {
  const runtime = params.runtime;
  const scope = assertAgentHarnessTaskRuntimeScope(params.scope);
  const requesterSessionKey = scope.requesterSessionKey;
  const taskKind = normalizeOptionalString(params.taskKind);
  const runIdPrefix = normalizeOptionalString(params.runIdPrefix);
  const progressDispatchByRunId = new Map<string, Promise<void>>();
  const assertRunId = (runId: string) => assertScopedRunId(runId, runIdPrefix);
  const tryCreateRunningTaskRun = (
    taskParams: AgentHarnessScopedCreateRunningTaskRunParams,
  ): TaskRecord | null => {
    assertRunId(taskParams.runId);
    return createRunningTaskRun({
      ...taskParams,
      runtime,
      ...(taskKind ? { taskKind } : {}),
      requesterSessionKey,
      ownerKey: requesterSessionKey,
      scopeKind: "session",
    });
  };
  return {
    createRunningTaskRun(taskParams) {
      const task = tryCreateRunningTaskRun(taskParams);
      if (!task) {
        throw new Error("Task persistence failed.");
      }
      return task;
    },
    tryCreateRunningTaskRun,
    recordTaskRunProgressByRunId(taskParams) {
      assertRunId(taskParams.runId);
      return recordTaskRunProgressByRunId({
        ...taskParams,
        runtime,
        sessionKey: requesterSessionKey,
      });
    },
    finalizeTaskRunByRunId(taskParams) {
      assertRunId(taskParams.runId);
      return finalizeTaskRunByRunId({
        ...taskParams,
        runtime,
        sessionKey: requesterSessionKey,
      });
    },
    setDetachedTaskDeliveryStatusByRunId(taskParams) {
      assertRunId(taskParams.runId);
      return setDetachedTaskDeliveryStatusByRunId({
        ...taskParams,
        runtime,
        sessionKey: requesterSessionKey,
      });
    },
    listTaskRecords() {
      return listTaskRecords().filter(
        (task) =>
          task.runtime === runtime &&
          (!taskKind || task.taskKind === taskKind) &&
          task.scopeKind === "session" &&
          task.ownerKey === requesterSessionKey &&
          (!runIdPrefix || task.runId?.startsWith(runIdPrefix)),
      );
    },
    emitSubagentProgress(progressParams) {
      assertRunId(progressParams.runId);
      const event = normalizeHarnessSubagentProgress(progressParams);
      const hookRunner = getGlobalHookRunner();
      if (!hookRunner?.hasHooks("subagent_progress")) {
        return;
      }
      const dispatch = async () => {
        try {
          await hookRunner.runSubagentProgress(
            {
              ...event,
              ...(scope.requesterPresentation ? { requester: scope.requesterPresentation } : {}),
            },
            {
              runId: event.runId,
              childSessionKey: event.childSessionKey,
              requesterSessionKey,
            },
          );
        } catch (error: unknown) {
          log.warn(
            `failed to emit harness subagent progress for run ${event.runId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      };
      const previous = progressDispatchByRunId.get(event.runId);
      const current = previous ? previous.then(dispatch) : dispatch();
      progressDispatchByRunId.set(event.runId, current);
      void current.then(() => {
        if (progressDispatchByRunId.get(event.runId) === current) {
          progressDispatchByRunId.delete(event.runId);
        }
      });
    },
  };
}

/** Delivers a completed harness task result back to the requester or parent session. */
export async function deliverAgentHarnessTaskCompletion(params: {
  scope: AgentHarnessTaskRuntimeScope;
  childSessionKey: string;
  childSessionId: string;
  announceId: string;
  status: AgentHarnessCompletionStatus;
  statusLabel?: string;
  result: string;
  taskLabel?: string;
  announceType?: string;
  replyInstruction?: string;
  signal?: AbortSignal;
}): Promise<AgentHarnessCompletionDelivery> {
  const scope = assertAgentHarnessTaskRuntimeScope(params.scope);
  const requesterSessionKey = scope.requesterSessionKey;
  const childSessionKey = params.childSessionKey.trim();
  const childSessionId = params.childSessionId.trim();
  const taskLabel = params.taskLabel?.trim() || "Agent harness task";
  const announceType = params.announceType?.trim() || "Agent harness task";
  const statusLabel = params.statusLabel?.trim() || params.status;
  const eventStatus = mapHarnessCompletionStatus(params.status);
  const requesterIsSubagent = isInternalAnnounceRequesterSession(requesterSessionKey);
  let directOrigin = scope.requesterOrigin;
  if (!requesterIsSubagent) {
    const { entry } = loadRequesterSessionEntry(requesterSessionKey);
    directOrigin = resolveAnnounceOrigin(entry, scope.requesterOrigin);
  }
  const completionDirectOrigin =
    requesterIsSubagent || !directOrigin
      ? directOrigin
      : await resolveSubagentCompletionOrigin({
          childSessionKey,
          requesterSessionKey,
          requesterOrigin: directOrigin,
          childRunId: childSessionKey,
          spawnMode: "run",
          expectsCompletionMessage: true,
        });
  const internalEvents: AgentInternalEvent[] = [
    {
      type: AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION,
      source: "subagent",
      childSessionKey,
      childSessionId,
      announceType,
      taskLabel,
      status: eventStatus,
      statusLabel,
      result: params.result,
      replyInstruction:
        params.replyInstruction?.trim() ||
        "Use the completed harness task result to continue or wrap up the parent task. If this is a channel session, send the visible response with the message tool instead of only writing a transcript final answer.",
    },
  ];
  const prompt = formatAgentInternalEventsForPrompt(internalEvents);
  return await deliverSubagentAnnouncement({
    requesterSessionKey,
    announceId: params.announceId,
    triggerMessage: prompt,
    steerMessage: prompt,
    internalEvents,
    summaryLine: taskLabel,
    requesterSessionOrigin: scope.requesterOrigin,
    requesterOrigin: completionDirectOrigin ?? directOrigin,
    completionDirectOrigin: completionDirectOrigin ?? directOrigin,
    directOrigin,
    sourceSessionKey: childSessionKey,
    sourceChannel: INTERNAL_MESSAGE_CHANNEL,
    sourceTool: AGENT_HARNESS_COMPLETION_SOURCE_TOOL,
    targetRequesterSessionKey: requesterSessionKey,
    requesterIsSubagent,
    expectsCompletionMessage: true,
    bestEffortDeliver: true,
    directIdempotencyKey: buildAnnounceIdempotencyKey(params.announceId),
    signal: params.signal,
  });
}

function mapHarnessCompletionStatus(
  status: AgentHarnessCompletionStatus,
): AgentInternalEventStatus {
  if (status === "succeeded") {
    return "ok";
  }
  return "error";
}

/** Returns true when completion delivery reached a persistent direct or steered path. */
export function isDurableAgentHarnessCompletionDelivery(
  delivery: AgentHarnessCompletionDelivery,
): boolean {
  if (!delivery.delivered) {
    return false;
  }
  if (delivery.path === "steered") {
    return true;
  }
  if (delivery.path !== "direct") {
    return false;
  }
  const phases = Array.isArray(delivery.phases) ? delivery.phases : undefined;
  if (!phases) {
    return true;
  }
  return phases.some(
    (phase) => phase.phase === "direct-primary" && phase.delivered && phase.path === "direct",
  );
}

function assertScopedRunId(runId: string, runIdPrefix: string | undefined): void {
  const normalized = runId.trim();
  if (!normalized) {
    throw new Error("Agent harness task runtime requires runId");
  }
  if (runIdPrefix && !normalized.startsWith(runIdPrefix)) {
    throw new Error("Agent harness task runId is outside the configured scope");
  }
}

function normalizeHarnessSubagentProgress(
  params: AgentHarnessSubagentProgressParams,
): AgentHarnessSubagentProgressParams {
  const runId = params.runId.trim();
  const childSessionKey = params.childSessionKey.trim();
  if (!childSessionKey) {
    throw new Error("Agent harness subagent progress requires childSessionKey");
  }
  if (params.phase === "started") {
    return { phase: "started", runId, childSessionKey };
  }
  if (params.phase === "ended") {
    if (!AGENT_HARNESS_SUBAGENT_PROGRESS_OUTCOMES.has(params.outcome)) {
      throw new Error("Agent harness subagent progress requires a supported outcome");
    }
    return {
      phase: "ended",
      runId,
      childSessionKey,
      outcome: params.outcome,
    };
  }
  throw new Error("Agent harness subagent progress requires a supported phase");
}
