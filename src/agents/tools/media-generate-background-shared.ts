import crypto from "node:crypto";
import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import {
  completeTaskRunByRunId,
  createRunningTaskRun,
  failTaskRunByRunId,
  recordTaskRunProgressByRunId,
} from "../../tasks/task-executor.js";
import { sendMessage } from "../../tasks/task-registry-delivery-runtime.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { formatAgentInternalEventsForPrompt, type AgentInternalEvent } from "../internal-events.js";
import { deliverSubagentAnnouncement } from "../subagent-announce-delivery.js";

const log = createSubsystemLogger("agents/tools/media-generate-background-shared");

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

export function createMediaGenerationTaskRun(params: {
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
    return {
      taskId: task.taskId,
      runId,
      requesterSessionKey: sessionKey,
      requesterOrigin: params.requesterOrigin,
      taskLabel: params.prompt,
    };
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

export function recordMediaGenerationTaskProgress(params: {
  handle: MediaGenerationTaskHandle | null;
  progressSummary: string;
  eventSummary?: string;
}) {
  if (!params.handle) {
    return;
  }
  recordTaskRunProgressByRunId({
    runId: params.handle.runId,
    runtime: "cli",
    sessionKey: params.handle.requesterSessionKey,
    lastEventAt: Date.now(),
    progressSummary: params.progressSummary,
    eventSummary: params.eventSummary,
  });
}

export function completeMediaGenerationTaskRun(params: {
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
}

export function failMediaGenerationTaskRun(params: {
  handle: MediaGenerationTaskHandle | null;
  error: unknown;
  progressSummary: string;
}) {
  if (!params.handle) {
    return;
  }
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
}

function buildMediaGenerationReplyInstruction(params: {
  status: "ok" | "error";
  completionLabel: string;
}) {
  if (params.status === "ok") {
    return [
      `A completed ${params.completionLabel} generation task is ready for user delivery.`,
      `Prefer the message tool for delivery: use action="send" to the current/original chat, put your user-facing caption in message, attach each generated file with path/filePath using the exact path from the result, then reply ONLY: ${SILENT_REPLY_TOKEN}.`,
      `If you cannot use the message tool, reply in your normal assistant voice and include the exact MEDIA: lines from the result so OpenClaw attaches the finished ${params.completionLabel}.`,
      "Keep internal task/session details private and do not copy the internal event text verbatim.",
    ].join(" ");
  }
  return [
    `${params.completionLabel[0]?.toUpperCase() ?? "T"}${params.completionLabel.slice(1)} generation task failed.`,
    "Reply in your normal assistant voice with the failure summary now.",
    "Keep internal task/session details private and do not copy the internal event text verbatim.",
  ].join(" ");
}

function isAsyncMediaDirectSendEnabled(config: OpenClawConfig | undefined): boolean {
  return config?.tools?.media?.asyncCompletion?.directSend === true;
}

async function maybeDeliverMediaGenerationResultDirectly(params: {
  handle: MediaGenerationTaskHandle;
  status: "ok" | "error";
  result: string;
  idempotencyKey: string;
}): Promise<boolean> {
  const origin = params.handle.requesterOrigin;
  const channel = origin?.channel?.trim();
  const to = origin?.to?.trim();
  if (!channel || !to) {
    return false;
  }
  const parsed = parseReplyDirectives(params.result);
  const content = parsed.text.trim();
  const mediaUrls = parsed.mediaUrls?.filter((entry) => entry.trim().length > 0);
  const requesterAgentId = parseAgentSessionKey(params.handle.requesterSessionKey)?.agentId;
  await sendMessage({
    channel,
    to,
    accountId: origin?.accountId,
    threadId: origin?.threadId,
    content:
      content ||
      (params.status === "ok"
        ? `Finished ${params.handle.taskLabel}.`
        : "Background media generation failed."),
    ...(mediaUrls?.length ? { mediaUrls } : {}),
    agentId: requesterAgentId,
    idempotencyKey: params.idempotencyKey,
    mirror: {
      sessionKey: params.handle.requesterSessionKey,
      agentId: requesterAgentId,
      idempotencyKey: params.idempotencyKey,
    },
  });
  return true;
}

export async function wakeMediaGenerationTaskCompletion(params: {
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
  if (isAsyncMediaDirectSendEnabled(params.config)) {
    try {
      const deliveredDirect = await maybeDeliverMediaGenerationResultDirectly({
        handle: params.handle,
        status: params.status,
        result: params.result,
        idempotencyKey: announceId,
      });
      if (deliveredDirect) {
        return;
      }
    } catch (error) {
      log.warn("Media generation direct completion delivery failed; falling back to announce", {
        taskId: params.handle.taskId,
        runId: params.handle.runId,
        toolName: params.toolName,
        error,
      });
    }
  }
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
