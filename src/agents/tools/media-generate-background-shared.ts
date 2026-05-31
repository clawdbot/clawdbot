import crypto from "node:crypto";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  completeTaskRunByRunId,
  createRunningTaskRun,
  failTaskRunByRunId,
  recordTaskRunProgressByRunId,
} from "../../tasks/detached-task-runtime.js";
import {
  resolveRequiredCompletionDeliveryFailureTerminalResult,
  type RequiredCompletionTerminalResult,
} from "../../tasks/task-completion-contract.js";
import { normalizeDeliveryContext, type DeliveryContext } from "../../utils/delivery-context.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
} from "../../utils/message-channel.js";
import {
  mediaUrlsFromGeneratedAttachments,
  type AgentGeneratedAttachment,
} from "../generated-attachments.js";
import { formatAgentInternalEventsForPrompt, type AgentInternalEvent } from "../internal-events.js";
import { deliverSubagentAnnouncement } from "../subagent-announce-delivery.js";
import type { SubagentAnnounceDeliveryFailureReason } from "../subagent-announce-dispatch.js";

const log = createSubsystemLogger("agents/tools/media-generate-background-shared");
const MEDIA_GENERATION_TASK_KEEPALIVE_INTERVAL_MS = 60_000;
const MEDIA_DIRECT_FALLBACK_DELIVERY_REASONS = new Set<SubagentAnnounceDeliveryFailureReason>([
  "generated_media_missing",
  "message_tool_delivery_missing",
  "visible_reply_missing",
]);

export type MediaGenerationTaskHandle = {
  taskId: string;
  runId: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  taskLabel: string;
};

export type MediaGenerateBackgroundScheduler = (work: () => Promise<void>) => void;

export type MediaGenerateAsyncStartCallback = (message: string) => Promise<void> | void;

export type MediaGenerationExecutionResult = {
  provider: string;
  model: string;
  count: number;
  paths: string[];
  wakeResult: string;
  attachments?: AgentGeneratedAttachment[];
  mediaUrls?: string[];
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
  terminalResult?: RequiredCompletionTerminalResult;
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
  attachments?: AgentGeneratedAttachment[];
  mediaUrls?: string[];
  statsLine?: string;
};

type MediaGenerationTaskLifecycle = {
  createTaskRun: (params: CreateMediaGenerationTaskRunParams) => MediaGenerationTaskHandle | null;
  recordTaskProgress: (params: RecordMediaGenerationTaskProgressParams) => void;
  completeTaskRun: (params: CompleteMediaGenerationTaskRunParams) => void;
  failTaskRun: (params: FailMediaGenerationTaskRunParams) => void;
  wakeTaskCompletion: (params: WakeMediaGenerationTaskCompletionParams) => Promise<boolean>;
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
  terminalResult?: RequiredCompletionTerminalResult;
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
      terminalSummary:
        params.terminalResult?.terminalSummary ??
        `Generated ${params.count} ${params.generatedLabel}${params.count === 1 ? "" : "s"} with ${params.provider}/${params.model}${target ? ` -> ${target}` : ""}.`,
      terminalOutcome: params.terminalResult?.terminalOutcome,
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
}) {
  if (params.status === "ok") {
    return [
      `The ${params.completionLabel} is ready for the original chat.`,
      'Use the current visible-reply contract: if this session requires message-tool replies, call message(action="send") with a short caption and every structured attachment from the internal event, then reply only NO_REPLY.',
      "Otherwise, write the normal final reply and attach every generated media path with final-reply MEDIA lines.",
    ].join(" ");
  }
  return [
    `${params.completionLabel[0]?.toUpperCase() ?? "T"}${params.completionLabel.slice(1)} generation task failed for the original chat.`,
    'Use the current visible-reply contract: call message(action="send") when message-tool replies are required, otherwise write the normal final reply.',
    "Keep internal task/session details private and do not copy the internal event text verbatim.",
  ].join(" ");
}

export function createDefaultMediaGenerateBackgroundScheduler(params: {
  toolName: string;
  onCrash: (message: string, meta?: Record<string, unknown>) => void;
}): MediaGenerateBackgroundScheduler {
  return (work) => {
    queueMicrotask(() => {
      void work().catch((error) => {
        params.onCrash(`Detached ${params.toolName} job crashed`, { error });
      });
    });
  };
}

export function buildMediaGenerationStartedToolResult(params: {
  toolName: string;
  generationLabel: string;
  completionLabel: string;
  taskHandle: MediaGenerationTaskHandle | null;
  detailExtras?: Record<string, unknown>;
  messages?: Array<string | undefined>;
}) {
  return {
    content: [
      {
        type: "text" as const,
        text: [
          `Background task started for ${params.generationLabel} generation (${params.taskHandle?.taskId ?? "unknown"}). Do not call ${params.toolName} again for this request. Wait for the completion event; the completion agent will send the finished ${params.completionLabel} here when it's ready.`,
          ...(params.messages ?? []),
        ]
          .filter((entry): entry is string => Boolean(entry))
          .join("\n"),
      },
    ],
    details: {
      async: true,
      status: "started",
      ...(params.taskHandle
        ? {
            taskId: params.taskHandle.taskId,
            runId: params.taskHandle.runId,
            task: {
              taskId: params.taskHandle.taskId,
              runId: params.taskHandle.runId,
            },
          }
        : {}),
      ...params.detailExtras,
    },
    terminate: true,
  };
}

export async function notifyMediaGenerationAsyncTaskStarted(params: {
  callback?: MediaGenerateAsyncStartCallback;
  message: string;
  toolName: string;
  handle: MediaGenerationTaskHandle | null;
  onFailure: (message: string, meta?: Record<string, unknown>) => void;
}) {
  if (!params.callback) {
    return;
  }
  try {
    await params.callback(params.message);
  } catch (error) {
    params.onFailure("Media generation async-start callback failed", {
      toolName: params.toolName,
      taskId: params.handle?.taskId,
      runId: params.handle?.runId,
      error,
    });
  }
}

export function scheduleMediaGenerationTaskCompletion<
  T extends MediaGenerationExecutionResult,
>(params: {
  lifecycle: MediaGenerationTaskLifecycle;
  handle: MediaGenerationTaskHandle | null;
  scheduleBackgroundWork: MediaGenerateBackgroundScheduler;
  progressSummary: string;
  config?: OpenClawConfig;
  toolName: string;
  run: () => Promise<T>;
  onWakeFailure: (message: string, meta?: Record<string, unknown>) => void;
}) {
  params.scheduleBackgroundWork(async () => {
    let executed: T;
    try {
      executed = await withMediaGenerationTaskKeepalive({
        handle: params.handle,
        progressSummary: params.progressSummary,
        run: params.run,
      });
    } catch (error) {
      params.lifecycle.failTaskRun({
        handle: params.handle,
        error,
      });
      await params.lifecycle.wakeTaskCompletion({
        config: params.config,
        handle: params.handle,
        status: "error",
        statusLabel: "failed",
        result: formatErrorMessage(error),
      });
      return;
    }

    try {
      params.lifecycle.recordTaskProgress({
        handle: params.handle,
        progressSummary: "Generated media; delivering completion",
      });
    } catch (error) {
      params.onWakeFailure(`${params.toolName} completion progress update failed`, {
        taskId: params.handle?.taskId,
        runId: params.handle?.runId,
        error,
      });
    }
    let terminalResult: RequiredCompletionTerminalResult | undefined;
    try {
      const completionDelivered = await params.lifecycle.wakeTaskCompletion({
        config: params.config,
        handle: params.handle,
        status: "ok",
        statusLabel: "completed successfully",
        result: executed.wakeResult,
        attachments: executed.attachments,
        mediaUrls: executed.mediaUrls,
      });
      if (!completionDelivered) {
        terminalResult = resolveRequiredCompletionDeliveryFailureTerminalResult(
          "completion delivery was not confirmed after successful generation",
        );
        params.onWakeFailure(
          `${params.toolName} completion delivery was not confirmed after successful generation`,
          {
            taskId: params.handle?.taskId,
            runId: params.handle?.runId,
          },
        );
      }
    } catch (error) {
      terminalResult = resolveRequiredCompletionDeliveryFailureTerminalResult(
        formatErrorMessage(error),
      );
      if (params.handle) {
        const mediaUrls = Array.from(
          new Set([
            ...(executed.mediaUrls ?? []),
            ...mediaUrlsFromGeneratedAttachments(executed.attachments),
          ]),
        );
        const delivered = await tryDeliverMediaGenerationDirect({
          config: params.config,
          handle: params.handle,
          toolName: params.toolName,
          content: `${params.toolName} completed.`,
          mediaUrls,
          idempotencySuffix: "blocked",
        });
        if (delivered) {
          terminalResult = undefined;
        }
      }
      params.onWakeFailure(
        `${params.toolName} completion wake failed after successful generation`,
        {
          taskId: params.handle?.taskId,
          runId: params.handle?.runId,
          error,
        },
      );
    }
    try {
      params.lifecycle.completeTaskRun({
        handle: params.handle,
        provider: executed.provider,
        model: executed.model,
        count: executed.count,
        paths: executed.paths,
        terminalResult,
      });
    } catch (error) {
      params.onWakeFailure(`${params.toolName} completion state update failed`, {
        taskId: params.handle?.taskId,
        runId: params.handle?.runId,
        error,
      });
      params.lifecycle.failTaskRun({
        handle: params.handle,
        error,
      });
    }
  });
}

async function wakeMediaGenerationTaskCompletion(params: {
  config?: OpenClawConfig;
  handle: MediaGenerationTaskHandle | null;
  status: "ok" | "error";
  statusLabel: string;
  result: string;
  attachments?: AgentGeneratedAttachment[];
  mediaUrls?: string[];
  statsLine?: string;
  eventSource: AgentInternalEvent["source"];
  announceType: string;
  toolName: string;
  completionLabel: string;
}): Promise<boolean> {
  if (!params.handle) {
    return true;
  }
  const announceId = `${params.toolName}:${params.handle.taskId}:${params.status}`;
  const mediaUrls = Array.from(
    new Set([
      ...(params.mediaUrls ?? []),
      ...mediaUrlsFromGeneratedAttachments(params.attachments),
    ]),
  );
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
      ...(params.attachments?.length ? { attachments: params.attachments } : {}),
      ...(mediaUrls.length ? { mediaUrls } : {}),
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
  if (delivery.delivered) {
    return true;
  }
  if (delivery.terminal) {
    log.warn("Media generation completion delivery stopped after terminal fallback", {
      taskId: params.handle.taskId,
      runId: params.handle.runId,
      toolName: params.toolName,
      error: delivery.error,
    });
    return true;
  }
  const canTryDirectCompletionFallback =
    delivery.reason != null && MEDIA_DIRECT_FALLBACK_DELIVERY_REASONS.has(delivery.reason);
  if (params.status === "ok" && canTryDirectCompletionFallback) {
    const label = `${params.completionLabel[0]?.toUpperCase() ?? "M"}${params.completionLabel.slice(1)}`;
    const delivered = await tryDeliverMediaGenerationDirect({
      config: params.config,
      handle: params.handle,
      toolName: params.toolName,
      content:
        mediaUrls.length > 0
          ? `${label} generation completed.`
          : `${label} generation completed, but the generated media could not be attached here.`,
      mediaUrls,
      idempotencySuffix: "ok",
    });
    if (delivered) {
      return true;
    }
  }
  if (params.status === "error") {
    const label = `${params.completionLabel[0]?.toUpperCase() ?? "M"}${params.completionLabel.slice(1)}`;
    const delivered = await tryDeliverMediaGenerationDirect({
      config: params.config,
      handle: params.handle,
      toolName: params.toolName,
      content: `${label} generation failed: ${params.result}`,
      idempotencySuffix: "error",
    });
    if (delivered) {
      return true;
    }
  }
  if (delivery.error) {
    log.error("Media generation completion wake failed; requester session was not woken", {
      taskId: params.handle.taskId,
      runId: params.handle.runId,
      toolName: params.toolName,
      error: delivery.error,
    });
  }
  return false;
}

async function tryDeliverMediaGenerationDirect(params: {
  config?: OpenClawConfig;
  handle: MediaGenerationTaskHandle;
  toolName: string;
  content: string;
  mediaUrls?: string[];
  idempotencySuffix: string;
}): Promise<boolean> {
  const origin = normalizeDeliveryContext(params.handle.requesterOrigin);
  if (!origin?.channel || !origin.to || !isDeliverableMessageChannel(origin.channel)) {
    return false;
  }
  const agentId = resolveAgentIdFromSessionKey(params.handle.requesterSessionKey);
  const idempotencyKey = `${params.toolName}:${params.handle.taskId}:${params.idempotencySuffix}:direct`;
  try {
    const { sendMessage } = await import("../../tasks/task-registry-delivery-runtime.js");
    await sendMessage({
      cfg: params.config,
      channel: origin.channel,
      to: origin.to,
      accountId: origin.accountId,
      threadId: origin.threadId,
      content: params.content,
      mediaUrls: params.mediaUrls,
      requesterSessionKey: params.handle.requesterSessionKey,
      agentId,
      idempotencyKey,
      mirror: {
        sessionKey: params.handle.requesterSessionKey,
        agentId,
        idempotencyKey,
      },
    });
    return true;
  } catch (error) {
    log.warn("Direct media generation failure delivery failed; falling back to agent wake", {
      taskId: params.handle.taskId,
      runId: params.handle.runId,
      toolName: params.toolName,
      error,
    });
    return false;
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
}): MediaGenerationTaskLifecycle {
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
      return await wakeMediaGenerationTaskCompletion({
        ...completionParams,
        eventSource: params.eventSource,
        announceType: params.announceType,
        toolName: params.toolName,
        completionLabel: params.completionLabel,
      });
    },
  };
}
