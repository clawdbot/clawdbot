/**
 * Shared detached-task lifecycle for media generation tools.
 *
 * Image, video, and music generation use this to track tasks, wake sessions, and deliver generated media.
 */
import crypto from "node:crypto";
import { getCliSessionBinding } from "../../config/sessions/cli-session-binding.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseCronRunScopeSuffix } from "../../sessions/session-key-utils.js";
import { removeCronRunContinuationSessionIfIdle } from "../../tasks/cron-run-continuation-cleanup.js";
import {
  completeTaskRunByRunId,
  createRunningTaskRun,
  failTaskRunByRunId,
  recordTaskRunProgressByRunId,
} from "../../tasks/detached-task-runtime.js";
import {
  clearGeneratedMediaTaskActivity,
  registerGeneratedMediaTaskActivity,
} from "../../tasks/generated-media-task-activity.js";
import {
  resolveRequiredCompletionDeliveryFailureTerminalResult,
  type RequiredCompletionTerminalResult,
} from "../../tasks/task-completion-contract.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import {
  mediaUrlsFromGeneratedAttachments,
  type AgentGeneratedAttachment,
} from "../generated-attachments.js";
import { formatAgentInternalEventsForPrompt, type AgentInternalEvent } from "../internal-events.js";
import { MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS } from "../media-generation-task-status-shared.js";
import {
  deliverSubagentAnnouncement,
  loadRequesterSessionEntry,
} from "../subagent-announce-delivery.js";
import { resolveAnnounceOrigin } from "../subagent-announce-origin.js";

const log = createSubsystemLogger("agents/tools/media-generate-background-shared");
const MEDIA_GENERATION_TASK_KEEPALIVE_INTERVAL_MS = 60_000;
const MEDIA_GENERATION_COMPLETION_HANDOFF_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000] as const;
const MEDIA_GENERATION_COMPLETION_HANDOFF_TIMEOUT_MS = 120_000;

/** Handle for a detached media generation task registered in the task ledger. */
export type MediaGenerationTaskHandle = {
  taskId: string;
  runId: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  taskLabel: string;
};

/** Schedules detached media generation work. */
export type MediaGenerateBackgroundScheduler = (work: () => Promise<void>) => void;

/** Optional callback invoked when async media generation starts. */
export type MediaGenerateAsyncStartCallback = (message: string) => Promise<void> | void;

/** Returns whether a media generation request should detach for a session. */
export function shouldDetachMediaGenerationTask(sessionKey: string | undefined): boolean {
  const normalizedSessionKey = sessionKey?.trim();
  if (!normalizedSessionKey) {
    return false;
  }
  if (!parseCronRunScopeSuffix(normalizedSessionKey).runId) {
    return true;
  }
  try {
    const entry = loadSessionEntryReadOnly({
      sessionKey: normalizedSessionKey,
      clone: false,
      hydrateSkillPromptRefs: false,
      readConsistency: "latest",
    });
    const marker = entry?.cronRunContinuation;
    if (!marker) {
      // Exact cron work without a durable checkpoint cannot be resumed safely.
      return false;
    }
    const cliExecutionProvider = marker.cliExecutionProvider?.trim();
    return (
      !cliExecutionProvider || Boolean(getCliSessionBinding(entry, cliExecutionProvider)?.sessionId)
    );
  } catch {
    // Exact cron work without a readable continuation row cannot be resumed.
    return false;
  }
}

/** Successful media generation output used to complete and wake detached tasks. */
type MediaGenerationExecutionResult = {
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

type MediaGenerationCompletionWakeOutcome =
  | { status: "delivered" }
  | { status: "pending" }
  | { status: "permanent_failure" };

type MediaGenerationTaskLifecycle = {
  createTaskRun: (params: CreateMediaGenerationTaskRunParams) => MediaGenerationTaskHandle | null;
  recordTaskProgress: (params: RecordMediaGenerationTaskProgressParams) => void;
  completeTaskRun: (params: CompleteMediaGenerationTaskRunParams) => void;
  failTaskRun: (params: FailMediaGenerationTaskRunParams) => void;
  wakeTaskCompletion: (
    params: WakeMediaGenerationTaskCompletionParams,
  ) => Promise<MediaGenerationCompletionWakeOutcome>;
};

function waitForMediaGenerationCompletionHandoffRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

async function wakeMediaGenerationTaskCompletionWithRetry(params: {
  wake: () => Promise<MediaGenerationCompletionWakeOutcome>;
  beforeRetry?: () => void;
}): Promise<MediaGenerationCompletionWakeOutcome> {
  const deadline = Date.now() + MEDIA_GENERATION_COMPLETION_HANDOFF_TIMEOUT_MS;
  let outcome = await params.wake();
  let retryIndex = 0;
  while (outcome.status === "pending") {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error("cron continuation did not become ready before the handoff deadline");
    }
    // Pending means the original cron run still owns the continuation. Keep the
    // task live and cap backoff until delivery, unavailability, or the deadline.
    const delayMs =
      MEDIA_GENERATION_COMPLETION_HANDOFF_RETRY_DELAYS_MS[
        Math.min(retryIndex, MEDIA_GENERATION_COMPLETION_HANDOFF_RETRY_DELAYS_MS.length - 1)
      ] ?? 2_000;
    await waitForMediaGenerationCompletionHandoffRetry(Math.min(delayMs, remainingMs));
    params.beforeRetry?.();
    outcome = await params.wake();
    retryIndex += 1;
  }
  return outcome;
}

function touchMediaGenerationTaskRunContext(handle: MediaGenerationTaskHandle) {
  registerGeneratedMediaTaskActivity(handle.runId, handle.requesterSessionKey);
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
    // Pin the complete requester route when detached work starts. Completion-time
    // session state can move to another peer while generation is still running.
    const requesterOrigin = resolveAnnounceOrigin(
      loadRequesterSessionEntry(sessionKey).entry,
      params.requesterOrigin,
    );
    const task = createRunningTaskRun({
      runtime: "cli",
      taskKind: params.taskKind,
      sourceId: params.providerId ? `${params.toolName}:${params.providerId}` : params.toolName,
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      scopeKind: "session",
      requesterOrigin,
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
    if (!task) {
      return null;
    }
    const handle = {
      taskId: task.taskId,
      runId,
      requesterSessionKey: sessionKey,
      requesterOrigin,
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

function clearMediaGenerationTaskRunContext(handle: MediaGenerationTaskHandle): void {
  clearGeneratedMediaTaskActivity(handle.runId);
  clearAgentRunContext(handle.runId);
  // A one-shot cron job can be deleted before detached media settles, leaving no
  // later timer tick to reap its exact continuation row.
  void removeCronRunContinuationSessionIfIdle(handle.requesterSessionKey).catch(
    (error: unknown) => {
      log.warn("Failed to remove settled cron media continuation", {
        taskId: handle.taskId,
        runId: handle.runId,
        error: formatErrorMessage(error),
      });
    },
  );
}

/** Periodically refreshes task progress while a media generation operation runs. */
async function withMediaGenerationTaskKeepalive<T>(params: {
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
    clearMediaGenerationTaskRunContext(params.handle);
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
    clearMediaGenerationTaskRunContext(params.handle);
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

/** Creates the default microtask scheduler for detached media generation jobs. */
export function createDefaultMediaGenerateBackgroundScheduler(params: {
  toolName: string;
  onCrash: (message: string, meta?: Record<string, unknown>) => void;
}): MediaGenerateBackgroundScheduler {
  return (work) => {
    queueMicrotask(() => {
      void work().catch((error: unknown) => {
        params.onCrash(`Detached ${params.toolName} job crashed`, { error });
      });
    });
  };
}

/** Builds the immediate tool result returned after a background media task starts. */
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
  };
}

/** Notifies an optional async-start observer and logs callback failures. */
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

/** Schedules media generation work and wires result/failure handling into task lifecycle. */
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
  const runBackgroundWork = async () => {
    let executed: T;
    try {
      executed = await withMediaGenerationTaskKeepalive({
        handle: params.handle,
        progressSummary: params.progressSummary,
        run: params.run,
      });
    } catch (error) {
      try {
        const wakeOutcome = await wakeMediaGenerationTaskCompletionWithRetry({
          wake: async () =>
            await params.lifecycle.wakeTaskCompletion({
              config: params.config,
              handle: params.handle,
              status: "error",
              statusLabel: "failed",
              result: formatErrorMessage(error),
            }),
        });
        if (wakeOutcome.status !== "delivered") {
          params.onWakeFailure(`${params.toolName} failure completion delivery was not confirmed`, {
            taskId: params.handle?.taskId,
            runId: params.handle?.runId,
          });
        }
      } catch (wakeError) {
        params.onWakeFailure(`${params.toolName} failure wake failed`, {
          taskId: params.handle?.taskId,
          runId: params.handle?.runId,
          error: wakeError,
        });
      }
      params.lifecycle.failTaskRun({ handle: params.handle, error });
      return;
    }

    const recordCompletionDeliveryProgress = () => {
      try {
        params.lifecycle.recordTaskProgress({
          handle: params.handle,
          progressSummary: MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS,
        });
      } catch (error) {
        params.onWakeFailure(`${params.toolName} completion progress update failed`, {
          taskId: params.handle?.taskId,
          runId: params.handle?.runId,
          error,
        });
      }
    };
    recordCompletionDeliveryProgress();
    let terminalResult: RequiredCompletionTerminalResult | undefined;
    try {
      const wakeOutcome = await wakeMediaGenerationTaskCompletionWithRetry({
        wake: async () =>
          await params.lifecycle.wakeTaskCompletion({
            config: params.config,
            handle: params.handle,
            status: "ok",
            statusLabel: "completed successfully",
            result: executed.wakeResult,
            attachments: executed.attachments,
            mediaUrls: executed.mediaUrls,
          }),
        // Keep both the detached-task ledger and process-local activity fresh
        // while an exact cron continuation is still owned by its original run.
        beforeRetry: recordCompletionDeliveryProgress,
      });
      if (wakeOutcome.status !== "delivered") {
        const failureReason = "completion delivery was not confirmed after successful generation";
        terminalResult = resolveRequiredCompletionDeliveryFailureTerminalResult(failureReason);
        params.onWakeFailure(`${params.toolName} ${failureReason}`, {
          taskId: params.handle?.taskId,
          runId: params.handle?.runId,
        });
      }
    } catch (error) {
      terminalResult = resolveRequiredCompletionDeliveryFailureTerminalResult(
        formatErrorMessage(error),
      );
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
  };
  params.scheduleBackgroundWork(runBackgroundWork);
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
}): Promise<MediaGenerationCompletionWakeOutcome> {
  if (!params.handle) {
    return { status: "delivered" };
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
    durableGeneratedMediaHandoff: true,
    bestEffortDeliver: true,
    directIdempotencyKey: announceId,
  });
  if (delivery.delivered) {
    return { status: "delivered" };
  }
  if (delivery.reason === "completion_handoff_pending") {
    return { status: "pending" };
  }
  if (delivery.terminal) {
    log.warn("Media generation completion delivery stopped after terminal fallback", {
      taskId: params.handle.taskId,
      runId: params.handle.runId,
      toolName: params.toolName,
      error: delivery.error,
    });
    // Send evidence makes another attempt unsafe even when the transport's
    // terminal acknowledgment failed, so settle without risking a duplicate.
    return { status: "delivered" };
  }
  if (delivery.error) {
    log.error("Media generation completion wake failed; requester session was not woken", {
      taskId: params.handle.taskId,
      runId: params.handle.runId,
      toolName: params.toolName,
      error: delivery.error,
    });
  }
  return { status: "permanent_failure" };
}

/** Creates a tool-specific detached media generation lifecycle facade. */
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
