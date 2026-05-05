import crypto from "node:crypto";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { deriveSessionChatTypeFromKey } from "../../sessions/session-chat-type-shared.js";
import {
  completeTaskRunByRunId,
  createRunningTaskRun,
  failTaskRunByRunId,
  recordTaskRunProgressByRunId,
} from "../../tasks/detached-task-runtime.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { formatAgentInternalEventsForPrompt, type AgentInternalEvent } from "../internal-events.js";
import { deliverSubagentAnnouncement } from "../subagent-announce-delivery.js";

const log = createSubsystemLogger("agents/tools/media-generate-background-shared");
const MEDIA_GENERATION_TASK_KEEPALIVE_INTERVAL_MS = 60_000;

export type MediaGenerationTaskHandle = {
  taskId: string;
  runId: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  taskLabel: string;
};

type CreateMediaGenerationTaskRunParams = {
  sessionKey?: string;
  requesterOrigin?: DeliveryContext;
  prompt: string;
  providerId?: string;
};

type RecordMediaGenerationTaskProgressParams = {
  handle: MediaGenerationTaskHandle | null;
  progressSummary: string;
  eventSummary?: string;
};

type CompleteMediaGenerationTaskRunParams = {
  handle: MediaGenerationTaskHandle | null;
  provider: string;
  model: string;
  count: number;
  paths: string[];
};

type FailMediaGenerationTaskRunParams = {
  handle: MediaGenerationTaskHandle | null;
  error: unknown;
};

type WakeMediaGenerationTaskCompletionParams = {
  config?: OpenClawConfig;
  handle: MediaGenerationTaskHandle | null;
  status: "ok" | "error";
  statusLabel: string;
  result: string;
  mediaUrls?: string[];
  statsLine?: string;
};

function touchMediaGenerationTaskRunContext(handle: MediaGenerationTaskHandle) {
  registerAgentRunContext(handle.runId, {
    sessionKey: handle.requesterSessionKey,
    lastActiveAt: Date.now(),
  });
}

function createMediaGenerationTaskRun(params: {
  sessionKey?: string;
  requesterOrigin?: DeliveryContext;
  prompt: string;
  providerId?: string;
  toolName: string;
  taskKind: string;
  label: string;
  queuedProgressSummary: string;
}): MediaGenerationTaskHandle | null {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return null;
  }
  const runId = `tool:${params.toolName}:${crypto.randomUUID()}`;
  try {
    const task = createRunningTaskRun({
      runtime: "cli",
      taskKind: params.taskKind,
      sourceId: params.providerId ? `${params.toolName}:${params.providerId}` : params.toolName,
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      scopeKind: "session",
      requesterOrigin: params.requesterOrigin,
      childSessionKey: sessionKey,
      runId,
      label: params.label,
      task: params.prompt,
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      progressSummary: params.queuedProgressSummary,
    });
    const handle = {
      taskId: task.taskId,
      runId,
      requesterSessionKey: sessionKey,
      requesterOrigin: params.requesterOrigin,
      taskLabel: params.prompt,
    };
    touchMediaGenerationTaskRunContext(handle);
    return handle;
  } catch (error) {
    log.warn("Failed to create media generation task ledger record", {
      sessionKey,
      toolName: params.toolName,
      providerId: params.providerId,
      error,
    });
    return null;
  }
}

function recordMediaGenerationTaskProgress(params: {
  handle: MediaGenerationTaskHandle | null;
  progressSummary: string;
  eventSummary?: string;
}) {
  if (!params.handle) {
    return;
  }
  touchMediaGenerationTaskRunContext(params.handle);
  recordTaskRunProgressByRunId({
    runId: params.handle.runId,
    runtime: "cli",
    sessionKey: params.handle.requesterSessionKey,
    lastEventAt: Date.now(),
    progressSummary: params.progressSummary,
    eventSummary: params.eventSummary,
  });
}

export async function withMediaGenerationTaskKeepalive<T>(params: {
  handle: MediaGenerationTaskHandle | null;
  progressSummary: string;
  eventSummary?: string;
  run: () => Promise<T>;
}): Promise<T> {
  if (!params.handle) {
    return await params.run();
  }
  const interval = setInterval(() => {
    recordMediaGenerationTaskProgress({
      handle: params.handle,
      progressSummary: params.progressSummary,
      eventSummary: params.eventSummary,
    });
  }, MEDIA_GENERATION_TASK_KEEPALIVE_INTERVAL_MS);
  interval.unref?.();
  try {
    return await params.run();
  } finally {
    clearInterval(interval);
  }
}

function completeMediaGenerationTaskRun(params: {
  handle: MediaGenerationTaskHandle | null;
  provider: string;
  model: string;
  count: number;
  paths: string[];
  generatedLabel: string;
}) {
  if (!params.handle) {
    return;
  }
  try {
    const endedAt = Date.now();
    const target = params.count === 1 ? params.paths[0] : `${params.count} files`;
    completeTaskRunByRunId({
      runId: params.handle.runId,
      runtime: "cli",
      sessionKey: params.handle.requesterSessionKey,
      endedAt,
      lastEventAt: endedAt,
      progressSummary: `Generated ${params.count} ${params.generatedLabel}${params.count === 1 ? "" : "s"}`,
      terminalSummary: `Generated ${params.count} ${params.generatedLabel}${params.count === 1 ? "" : "s"} with ${params.provider}/${params.model}${target ? ` -> ${target}` : ""}.`,
    });
  } finally {
    clearAgentRunContext(params.handle.runId);
  }
}

function failMediaGenerationTaskRun(params: {
  handle: MediaGenerationTaskHandle | null;
  error: unknown;
  progressSummary: string;
}) {
  if (!params.handle) {
    return;
  }
  try {
    const endedAt = Date.now();
    const errorText = formatErrorMessage(params.error);
    failTaskRunByRunId({
      runId: params.handle.runId,
      runtime: "cli",
      sessionKey: params.handle.requesterSessionKey,
      endedAt,
      lastEventAt: endedAt,
      error: errorText,
      progressSummary: params.progressSummary,
      terminalSummary: errorText,
    });
  } finally {
    clearAgentRunContext(params.handle.runId);
  }
}

function buildMediaGenerationReplyInstruction(params: {
  status: "ok" | "error";
  completionLabel: string;
  requiresMessageToolDelivery: boolean;
}) {
  if (params.status === "ok") {
    if (params.requiresMessageToolDelivery) {
      return [
        `The ${params.completionLabel} is ready for the original channel/group chat.`,
        "This route requires message-tool delivery: the user will NOT see your normal assistant final reply.",
        'Call the message tool with action="send" to the original/current chat, put a short caption in the message, and attach the generated media paths from the result.',
        `After the message tool succeeds, reply only ${SILENT_REPLY_TOKEN}.`,
        "Do not put MEDIA: lines only in your final answer; that final answer is private in this chat.",
      ].join(" ");
    }
    return `Tell the user the ${params.completionLabel} is ready. If visible source delivery requires the message tool, send it there with the generated media attached.`;
  }
  return [
    `${params.completionLabel[0]?.toUpperCase() ?? "T"}${params.completionLabel.slice(1)} generation task failed.`,
    "Reply in your normal assistant voice with the failure summary now.",
    "Keep internal task/session details private and do not copy the internal event text verbatim.",
  ].join(" ");
}

function inferMediaGenerationCompletionChatType(
  handle: MediaGenerationTaskHandle,
): "direct" | "group" | "channel" | "unknown" {
  const sessionKeyChatType = deriveSessionChatTypeFromKey(handle.requesterSessionKey);
  if (sessionKeyChatType !== "unknown") {
    return sessionKeyChatType;
  }
  const to = handle.requesterOrigin?.to?.trim().toLowerCase();
  if (to?.startsWith("group:")) {
    return "group";
  }
  if (to?.startsWith("channel:")) {
    return "channel";
  }
  if (to?.startsWith("dm:") || to?.startsWith("direct:")) {
    return "direct";
  }
  return "unknown";
}

function mediaGenerationCompletionRequiresMessageToolDelivery(params: {
  config?: OpenClawConfig;
  handle: MediaGenerationTaskHandle;
}): boolean {
  const chatType = inferMediaGenerationCompletionChatType(params.handle);
  if (chatType === "group" || chatType === "channel") {
    const configuredMode =
      params.config?.messages?.groupChat?.visibleReplies ?? params.config?.messages?.visibleReplies;
    return configuredMode !== "automatic";
  }
  return params.config?.messages?.visibleReplies === "message_tool";
}

async function wakeMediaGenerationTaskCompletion(params: {
  config?: OpenClawConfig;
  handle: MediaGenerationTaskHandle | null;
  status: "ok" | "error";
  statusLabel: string;
  result: string;
  mediaUrls?: string[];
  statsLine?: string;
  eventSource: AgentInternalEvent["source"];
  announceType: string;
  toolName: string;
  completionLabel: string;
}) {
  if (!params.handle) {
    return;
  }
  const announceId = `${params.toolName}:${params.handle.taskId}:${params.status}`;
  const internalEvents: AgentInternalEvent[] = [
    {
      type: "task_completion",
      source: params.eventSource,
      childSessionKey: `${params.toolName}:${params.handle.taskId}`,
      childSessionId: params.handle.taskId,
      announceType: params.announceType,
      taskLabel: params.handle.taskLabel,
      status: params.status,
      statusLabel: params.statusLabel,
      result: params.result,
      ...(params.mediaUrls?.length ? { mediaUrls: params.mediaUrls } : {}),
      ...(params.statsLine?.trim() ? { statsLine: params.statsLine } : {}),
      replyInstruction: buildMediaGenerationReplyInstruction({
        status: params.status,
        completionLabel: params.completionLabel,
        requiresMessageToolDelivery: mediaGenerationCompletionRequiresMessageToolDelivery({
          config: params.config,
          handle: params.handle,
        }),
      }),
    },
  ];
  const triggerMessage =
    formatAgentInternalEventsForPrompt(internalEvents) ||
    `A ${params.completionLabel} generation task finished. Process the completion update now.`;
  const delivery = await deliverSubagentAnnouncement({
    requesterSessionKey: params.handle.requesterSessionKey,
    targetRequesterSessionKey: params.handle.requesterSessionKey,
    announceId,
    triggerMessage,
    steerMessage: triggerMessage,
    internalEvents,
    summaryLine: params.handle.taskLabel,
    requesterSessionOrigin: params.handle.requesterOrigin,
    requesterOrigin: params.handle.requesterOrigin,
    completionDirectOrigin: params.handle.requesterOrigin,
    directOrigin: params.handle.requesterOrigin,
    sourceSessionKey: `${params.toolName}:${params.handle.taskId}`,
    sourceChannel: INTERNAL_MESSAGE_CHANNEL,
    sourceTool: params.toolName,
    requesterIsSubagent: false,
    expectsCompletionMessage: true,
    bestEffortDeliver: true,
    directIdempotencyKey: announceId,
  });
  if (!delivery.delivered && delivery.error) {
    log.warn("Media generation completion wake failed", {
      taskId: params.handle.taskId,
      runId: params.handle.runId,
      toolName: params.toolName,
      error: delivery.error,
    });
  }
}

export function createMediaGenerationTaskLifecycle(params: {
  toolName: string;
  taskKind: string;
  label: string;
  queuedProgressSummary: string;
  generatedLabel: string;
  failureProgressSummary: string;
  eventSource: AgentInternalEvent["source"];
  announceType: string;
  completionLabel: string;
}) {
  return {
    createTaskRun(runParams: CreateMediaGenerationTaskRunParams): MediaGenerationTaskHandle | null {
      return createMediaGenerationTaskRun({
        ...runParams,
        toolName: params.toolName,
        taskKind: params.taskKind,
        label: params.label,
        queuedProgressSummary: params.queuedProgressSummary,
      });
    },

    recordTaskProgress(progressParams: RecordMediaGenerationTaskProgressParams) {
      recordMediaGenerationTaskProgress(progressParams);
    },

    completeTaskRun(completionParams: CompleteMediaGenerationTaskRunParams) {
      completeMediaGenerationTaskRun({
        ...completionParams,
        generatedLabel: params.generatedLabel,
      });
    },

    failTaskRun(failureParams: FailMediaGenerationTaskRunParams) {
      failMediaGenerationTaskRun({
        ...failureParams,
        progressSummary: params.failureProgressSummary,
      });
    },

    async wakeTaskCompletion(completionParams: WakeMediaGenerationTaskCompletionParams) {
      await wakeMediaGenerationTaskCompletion({
        ...completionParams,
        eventSource: params.eventSource,
        announceType: params.announceType,
        toolName: params.toolName,
        completionLabel: params.completionLabel,
      });
    },
  };
}
