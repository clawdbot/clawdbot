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
  resolveSubagentCompletionOrigin,
} from "../agents/subagent-announce-delivery.js";
import { resolveAnnounceOrigin } from "../agents/subagent-announce-origin.js";
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

export type AgentHarnessTaskRuntimeScopeParams = {
  runtime: AgentHarnessTaskRuntimeId;
  scope: AgentHarnessTaskRuntimeScope;
  taskKind?: string;
  runIdPrefix?: string;
};

export type AgentHarnessScopedCreateRunningTaskRunParams = Omit<
  CreateRunningTaskRunParams,
  "runtime" | "taskKind" | "requesterSessionKey" | "ownerKey" | "scopeKind"
> & {
  runId: string;
};

export type AgentHarnessScopedRecordTaskRunProgressParams = Omit<
  RecordTaskRunProgressParams,
  "runtime" | "sessionKey"
>;

export type AgentHarnessScopedFinalizeTaskRunParams = Omit<
  FinalizeTaskRunParams,
  "runtime" | "sessionKey"
>;

export type AgentHarnessScopedSetDeliveryStatusParams = Omit<
  SetDeliveryStatusParams,
  "runtime" | "sessionKey"
>;

export type AgentHarnessTaskRuntime = {
  createRunningTaskRun(params: AgentHarnessScopedCreateRunningTaskRunParams): TaskRecord;
  tryCreateRunningTaskRun(params: AgentHarnessScopedCreateRunningTaskRunParams): TaskRecord | null;
  recordTaskRunProgressByRunId(params: AgentHarnessScopedRecordTaskRunProgressParams): TaskRecord[];
  finalizeTaskRunByRunId(params: AgentHarnessScopedFinalizeTaskRunParams): TaskRecord[];
  setDetachedTaskDeliveryStatusByRunId(
    params: AgentHarnessScopedSetDeliveryStatusParams,
  ): TaskRecord[];
  listTaskRecords(): TaskRecord[];
};

export type AgentHarnessCompletionStatus = "succeeded" | "failed" | "cancelled";

export type AgentHarnessCompletionDelivery = Awaited<
  ReturnType<typeof deliverSubagentAnnouncement>
>;

const AGENT_HARNESS_COMPLETION_SOURCE_TOOL = "agent_harness_task";

export function createAgentHarnessTaskRuntime(
  params: AgentHarnessTaskRuntimeScopeParams,
): AgentHarnessTaskRuntime {
  const runtime = params.runtime;
  const scope = assertAgentHarnessTaskRuntimeScope(params.scope);
  const requesterSessionKey = scope.requesterSessionKey;
  const taskKind = normalizeOptionalString(params.taskKind);
  const runIdPrefix = normalizeOptionalString(params.runIdPrefix);
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
  };
}

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
