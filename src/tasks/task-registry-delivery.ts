import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { shouldRouteCompletionThroughRequesterSession } from "../auto-reply/reply/completion-delivery-policy.js";
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import {
  isGatewayRestartDraining,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";
import {
  formatTaskBlockedFollowupMessage,
  formatTaskStateChangeMessage,
  formatTaskTerminalMessage,
  shouldAutoDeliverTaskStateChange,
  shouldAutoDeliverTaskTerminalUpdate,
  shouldSuppressDuplicateTerminalDelivery,
  shouldUseParentReviewTaskTerminalMessage,
} from "./task-executor-policy.js";
import { getTaskFlowById } from "./task-flow-runtime-internal.js";
import type { TaskDeliveryOwner } from "./task-registry-common.js";
import {
  getTaskDeliveryState,
  updateTask,
  upsertTaskDeliveryState,
} from "./task-registry-mutation.js";
import { cloneTaskRecord } from "./task-registry-records.js";
import {
  ensureTaskRegistryReady,
  getPeerTasksForDelivery,
  loadTaskRegistryDeliveryRuntime,
  log,
  pickPreferredRunIdTask,
  taskDeliveryStates,
  tasks,
  tasksWithPendingDelivery,
} from "./task-registry-state.js";
import type {
  TaskDeliveryState,
  TaskDeliveryStatus,
  TaskEventRecord,
  TaskRecord,
} from "./task-registry.types.js";

function taskTerminalDeliveryIdempotencyKey(task: TaskRecord): string {
  const outcome = task.status === "succeeded" ? (task.terminalOutcome ?? "default") : "default";
  return `task-terminal:${task.taskId}:${task.status}:${outcome}`;
}

function resolveTaskStateChangeIdempotencyKey(params: {
  task: TaskRecord;
  latestEvent: TaskEventRecord;
  owner: TaskDeliveryOwner;
}): string {
  if (params.owner.flowId) {
    return `flow-event:${params.owner.flowId}:${params.task.taskId}:${params.latestEvent.at}:${params.latestEvent.kind}`;
  }
  return `task-event:${params.task.taskId}:${params.latestEvent.at}:${params.latestEvent.kind}`;
}

function resolveTaskTerminalIdempotencyKey(task: TaskRecord): string {
  const owner = resolveTaskDeliveryOwner(task);
  if (owner.flowId) {
    const outcome = task.status === "succeeded" ? (task.terminalOutcome ?? "default") : "default";
    return `flow-terminal:${owner.flowId}:${task.taskId}:${task.status}:${outcome}`;
  }
  return taskTerminalDeliveryIdempotencyKey(task);
}

function getLinkedFlowForDelivery(task: TaskRecord) {
  const flowId = task.parentFlowId?.trim();
  if (!flowId || task.scopeKind !== "session") {
    return undefined;
  }
  const flow = getTaskFlowById(flowId);
  if (!flow) {
    return undefined;
  }
  if (normalizeOptionalString(flow.ownerKey) !== normalizeOptionalString(task.ownerKey)) {
    return undefined;
  }
  return flow;
}

function resolveTaskDeliveryOwner(task: TaskRecord): TaskDeliveryOwner {
  const flow = getLinkedFlowForDelivery(task);
  if (flow) {
    return {
      sessionKey: flow.ownerKey.trim(),
      requesterOrigin: normalizeDeliveryContext(
        flow.requesterOrigin ?? taskDeliveryStates.get(task.taskId)?.requesterOrigin,
      ),
      flowId: flow.flowId,
    };
  }
  if (task.scopeKind !== "session") {
    return {};
  }
  return {
    sessionKey: task.ownerKey.trim(),
    requesterOrigin: normalizeDeliveryContext(taskDeliveryStates.get(task.taskId)?.requesterOrigin),
  };
}

function canDeliverTaskToRequesterOrigin(task: TaskRecord): boolean {
  const owner = resolveTaskDeliveryOwner(task);
  if (shouldRouteCompletionThroughRequesterSession(owner.sessionKey)) {
    return false;
  }
  return canDeliverToRequesterOrigin(owner.requesterOrigin);
}

function canDeliverToRequesterOrigin(origin: TaskDeliveryState["requesterOrigin"]): boolean {
  const channel = origin?.channel?.trim();
  const to = origin?.to?.trim();
  return Boolean(channel && to && isDeliverableMessageChannel(channel));
}

function canDeliverParentReviewTaskToBoundDiscordThread(task: TaskRecord): boolean {
  if (!shouldUseParentReviewTaskTerminalMessage(task)) {
    return false;
  }
  const owner = resolveTaskDeliveryOwner(task);
  const origin = owner.requesterOrigin;
  const channel = origin?.channel?.trim().toLowerCase();
  const to = origin?.to?.trim().toLowerCase();
  const threadId = String(origin?.threadId ?? "").trim();
  // This is a narrow transport exception for explicitly bound Discord threads,
  // not a general parent-review direct-delivery relaxation.
  return Boolean(
    channel === "discord" &&
    to?.startsWith("channel:") &&
    threadId &&
    canDeliverToRequesterOrigin(origin),
  );
}

function resolveMissingOwnerDeliveryStatus(task: TaskRecord): TaskDeliveryStatus {
  return task.scopeKind === "system" ? "not_applicable" : "parent_missing";
}

function queueTaskSystemEvent(task: TaskRecord, text: string) {
  const owner = resolveTaskDeliveryOwner(task);
  const ownerKey = owner.sessionKey?.trim();
  if (!ownerKey) {
    return false;
  }
  enqueueSystemEvent(text, {
    sessionKey: ownerKey,
    contextKey: `task:${task.taskId}`,
    deliveryContext: owner.requesterOrigin,
  });
  requestHeartbeat({
    source: "background-task",
    intent: "immediate",
    reason: "background-task",
    sessionKey: ownerKey,
  });
  return true;
}

function queueBlockedTaskFollowup(task: TaskRecord) {
  const followupText = formatTaskBlockedFollowupMessage(task);
  if (!followupText) {
    return false;
  }
  const owner = resolveTaskDeliveryOwner(task);
  const ownerKey = owner.sessionKey?.trim();
  if (!ownerKey) {
    return false;
  }
  enqueueSystemEvent(followupText, {
    sessionKey: ownerKey,
    contextKey: `task:${task.taskId}:blocked-followup`,
    deliveryContext: owner.requesterOrigin,
  });
  requestHeartbeat({
    source: "background-task-blocked",
    intent: "immediate",
    reason: "background-task-blocked",
    sessionKey: ownerKey,
  });
  return true;
}

export async function maybeDeliverTaskTerminalUpdate(taskId: string): Promise<TaskRecord | null> {
  return await runTaskDeliveryWithIndependentAdmission(taskId, async () =>
    maybeDeliverTaskTerminalUpdateUnderAdmission(taskId),
  );
}

async function runTaskDeliveryWithIndependentAdmission(
  taskId: string,
  deliver: () => Promise<TaskRecord | null>,
): Promise<TaskRecord | null> {
  ensureTaskRegistryReady();
  let admitted = false;
  try {
    return await runWithGatewayIndependentRootWorkAdmission(async () => {
      admitted = true;
      return await deliver();
    });
  } catch (error) {
    // Late lifecycle callbacks must not leak a rejected detached promise after
    // restart closes admission. An already-admitted delivery still reports its
    // own failures instead of hiding them behind a concurrent restart.
    if (!admitted && isGatewayRestartDraining()) {
      ensureTaskRegistryReady();
      const current = tasks.get(taskId);
      return current ? cloneTaskRecord(current) : null;
    }
    throw error;
  }
}

async function maybeDeliverTaskTerminalUpdateUnderAdmission(
  taskId: string,
): Promise<TaskRecord | null> {
  ensureTaskRegistryReady();
  const current = tasks.get(taskId);
  if (!current || !shouldAutoDeliverTaskTerminalUpdate(current)) {
    return current ? cloneTaskRecord(current) : null;
  }
  if (tasksWithPendingDelivery.has(taskId)) {
    return cloneTaskRecord(current);
  }
  tasksWithPendingDelivery.add(taskId);
  try {
    const latest = tasks.get(taskId);
    if (!latest || !shouldAutoDeliverTaskTerminalUpdate(latest)) {
      return latest ? cloneTaskRecord(latest) : null;
    }
    const peers = latest.runId ? getPeerTasksForDelivery(latest) : [];
    const isSubagentCancellation = latest.runtime === "subagent" && latest.status === "cancelled";
    const preferred = pickPreferredRunIdTask(
      isSubagentCancellation
        ? peers.filter((candidate) => shouldAutoDeliverTaskTerminalUpdate(candidate))
        : peers,
    );
    const peerDeliveryCovered =
      isSubagentCancellation &&
      peers.some(
        (candidate) =>
          candidate.taskId !== latest.taskId &&
          (candidate.deliveryStatus === "delivered" ||
            candidate.deliveryStatus === "session_queued"),
      );
    if (
      shouldSuppressDuplicateTerminalDelivery({
        task: latest,
        preferredTaskId: preferred?.taskId,
        peerDeliveryCovered,
      })
    ) {
      return updateTask(taskId, {
        deliveryStatus: "not_applicable",
        lastEventAt: Date.now(),
      });
    }
    const owner = resolveTaskDeliveryOwner(latest);
    const ownerSessionKey = owner.sessionKey?.trim();
    if (!ownerSessionKey) {
      return updateTask(taskId, {
        deliveryStatus: resolveMissingOwnerDeliveryStatus(latest),
        lastEventAt: Date.now(),
      });
    }
    const shouldRouteParentReview = shouldUseParentReviewTaskTerminalMessage(latest);
    const shouldDeliverParentReviewDirect = canDeliverParentReviewTaskToBoundDiscordThread(latest);
    const canDeliverDirect =
      canDeliverTaskToRequesterOrigin(latest) || shouldDeliverParentReviewDirect;
    const directEventText = formatTaskTerminalMessage(latest);
    const sessionEventText = formatTaskTerminalMessage(
      latest,
      shouldRouteParentReview ? { surface: "parent_session" } : undefined,
    );
    if ((shouldRouteParentReview && !shouldDeliverParentReviewDirect) || !canDeliverDirect) {
      try {
        queueTaskSystemEvent(latest, sessionEventText);
        if (latest.terminalOutcome === "blocked") {
          queueBlockedTaskFollowup(latest);
        }
        return updateTask(taskId, {
          deliveryStatus:
            shouldRouteParentReview && canDeliverDirect ? "pending" : "session_queued",
          lastEventAt: Date.now(),
        });
      } catch (error) {
        log.warn("Failed to queue background task session delivery", {
          taskId,
          ownerKey: latest.ownerKey,
          error,
        });
        return updateTask(taskId, {
          deliveryStatus: "failed",
          lastEventAt: Date.now(),
        });
      }
    }
    try {
      const { sendMessage } = await loadTaskRegistryDeliveryRuntime();
      const beforeSend = tasks.get(taskId);
      if (!beforeSend || !shouldAutoDeliverTaskTerminalUpdate(beforeSend)) {
        return beforeSend ? cloneTaskRecord(beforeSend) : null;
      }
      const requesterAgentId = parseAgentSessionKey(ownerSessionKey)?.agentId;
      const idempotencyKey = resolveTaskTerminalIdempotencyKey(latest);
      await sendMessage({
        channel: owner.requesterOrigin?.channel,
        to: owner.requesterOrigin?.to ?? "",
        accountId: owner.requesterOrigin?.accountId,
        threadId: owner.requesterOrigin?.threadId,
        content: shouldDeliverParentReviewDirect ? sessionEventText : directEventText,
        agentId: requesterAgentId,
        idempotencyKey,
        mirror: {
          sessionKey: ownerSessionKey,
          agentId: requesterAgentId,
          idempotencyKey,
        },
      });
      const afterSend = tasks.get(taskId);
      if (!afterSend || !shouldAutoDeliverTaskTerminalUpdate(afterSend)) {
        return afterSend ? cloneTaskRecord(afterSend) : null;
      }
      if (afterSend.terminalOutcome === "blocked") {
        queueBlockedTaskFollowup(afterSend);
      }
      return updateTask(taskId, {
        deliveryStatus: "delivered",
        lastEventAt: Date.now(),
      });
    } catch (error) {
      log.warn("Failed to deliver background task update", {
        taskId,
        ownerKey: ownerSessionKey,
        requesterOrigin: owner.requesterOrigin,
        error,
      });
      const beforeFallback = tasks.get(taskId);
      if (!beforeFallback || !shouldAutoDeliverTaskTerminalUpdate(beforeFallback)) {
        return beforeFallback ? cloneTaskRecord(beforeFallback) : null;
      }
      try {
        queueTaskSystemEvent(beforeFallback, sessionEventText);
        if (beforeFallback.terminalOutcome === "blocked") {
          queueBlockedTaskFollowup(beforeFallback);
        }
      } catch (fallbackError) {
        log.warn("Failed to queue background task fallback event", {
          taskId,
          ownerKey: latest.ownerKey,
          error: fallbackError,
        });
      }
      return updateTask(taskId, {
        deliveryStatus: "failed",
        lastEventAt: Date.now(),
      });
    }
  } finally {
    tasksWithPendingDelivery.delete(taskId);
  }
}

export async function maybeDeliverTaskStateChangeUpdate(
  taskId: string,
  latestEvent?: TaskEventRecord,
): Promise<TaskRecord | null> {
  return await runTaskDeliveryWithIndependentAdmission(taskId, async () =>
    maybeDeliverTaskStateChangeUpdateUnderAdmission(taskId, latestEvent),
  );
}

async function maybeDeliverTaskStateChangeUpdateUnderAdmission(
  taskId: string,
  latestEvent?: TaskEventRecord,
): Promise<TaskRecord | null> {
  ensureTaskRegistryReady();
  const current = tasks.get(taskId);
  if (!current || !shouldAutoDeliverTaskStateChange(current)) {
    return current ? cloneTaskRecord(current) : null;
  }
  const deliveryState = getTaskDeliveryState(taskId);
  if (!latestEvent || (deliveryState?.lastNotifiedEventAt ?? 0) >= latestEvent.at) {
    return cloneTaskRecord(current);
  }
  const eventText = formatTaskStateChangeMessage(current, latestEvent);
  if (!eventText) {
    return cloneTaskRecord(current);
  }
  try {
    const owner = resolveTaskDeliveryOwner(current);
    const ownerSessionKey = owner.sessionKey?.trim();
    if (!ownerSessionKey) {
      return updateTask(taskId, {
        deliveryStatus: resolveMissingOwnerDeliveryStatus(current),
        lastEventAt: Date.now(),
      });
    }
    if (!canDeliverTaskToRequesterOrigin(current)) {
      queueTaskSystemEvent(current, eventText);
      upsertTaskDeliveryState({
        taskId,
        requesterOrigin: deliveryState?.requesterOrigin,
        lastNotifiedEventAt: latestEvent.at,
      });
      return updateTask(taskId, {
        lastEventAt: Date.now(),
      });
    }
    const { sendMessage } = await loadTaskRegistryDeliveryRuntime();
    const requesterAgentId = parseAgentSessionKey(ownerSessionKey)?.agentId;
    const idempotencyKey = resolveTaskStateChangeIdempotencyKey({
      task: current,
      latestEvent,
      owner,
    });
    await sendMessage({
      channel: owner.requesterOrigin?.channel,
      to: owner.requesterOrigin?.to ?? "",
      accountId: owner.requesterOrigin?.accountId,
      threadId: owner.requesterOrigin?.threadId,
      content: eventText,
      agentId: requesterAgentId,
      idempotencyKey,
      mirror: {
        sessionKey: ownerSessionKey,
        agentId: requesterAgentId,
        idempotencyKey,
      },
    });
    upsertTaskDeliveryState({
      taskId,
      requesterOrigin: deliveryState?.requesterOrigin,
      lastNotifiedEventAt: latestEvent.at,
    });
    return updateTask(taskId, {
      lastEventAt: Date.now(),
    });
  } catch (error) {
    log.warn("Failed to deliver background task state change", {
      taskId,
      ownerKey: current.ownerKey,
      error,
    });
    return cloneTaskRecord(current);
  }
}
