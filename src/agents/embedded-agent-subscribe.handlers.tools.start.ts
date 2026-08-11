import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import {
  normalizeOptionalLowercaseString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { parseSessionThreadInfoFast } from "../config/sessions/thread-info.js";
import type { AgentItemEventData } from "../infra/agent-activity-events.js";
import { emitAgentItemEvent } from "../infra/agent-activity-events.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { REQUIRED_PARAM_GROUPS, type RequiredParamGroup } from "./agent-tools.params.js";
import { sanitizeForConsole } from "./console-sanitize.js";
import {
  isMessagingTool,
  isMessagingToolSendAction,
  isMessagingToolTargetEvidenceAction,
} from "./embedded-agent-messaging.js";
import { runBestEffortCallback } from "./embedded-agent-subscribe.callback.js";
import {
  applyCurrentMessageProvider,
  readMessagingText,
} from "./embedded-agent-subscribe.handlers.tools.results.js";
import type {
  ToolCallSummary,
  ToolHandlerContext,
} from "./embedded-agent-subscribe.handlers.types.js";
import {
  collectMessagingMediaUrlsFromRecord,
  extractMessagingToolSend,
  sanitizeToolArgs,
} from "./embedded-agent-subscribe.tools.js";
import { buildAgentHarnessQuestionPromptPayload } from "./harness/user-input-bridge.js";
import type { AgentEvent } from "./runtime/index.js";
import { inferToolMetaFromArgsCore, isCommandBearingToolCall } from "./tool-display.js";
import { resolveFileMutationToolName } from "./tool-mutation-names.js";
import { buildToolMutationState } from "./tool-mutation.js";
import { normalizeToolName } from "./tool-policy.js";
import {
  cancelAskUserPromptDelivery,
  normalizeAskUserParams,
  reserveAskUserPromptDelivery,
  settleAskUserPromptDelivery,
  waitForAskUserPromptReady,
} from "./tools/ask-user-tool.js";

const TRACE_REQUIRED_PARAM_GROUPS = {
  read: [{ keys: ["path", "file_path"], label: "path" }],
  write: REQUIRED_PARAM_GROUPS.write,
  edit: REQUIRED_PARAM_GROUPS.edit,
} satisfies Record<string, readonly RequiredParamGroup[]>;

function buildAskUserPromptPayload(
  toolCallId: string,
  sessionKey: string | undefined,
  runId: string,
  args: unknown,
) {
  try {
    const { questions, timeoutSeconds } = normalizeAskUserParams(args);
    const reservation = reserveAskUserPromptDelivery({
      toolCallId,
      sessionKey,
      runId,
      questions,
      timeoutSeconds,
    });
    if (!reservation) {
      return undefined;
    }
    return reservation;
  } catch {
    // Argument validation owns malformed calls; do not deliver an unusable prompt first.
    return undefined;
  }
}

function getRequiredParamGroupsForTool(
  toolName: string,
): readonly RequiredParamGroup[] | undefined {
  return TRACE_REQUIRED_PARAM_GROUPS[toolName as keyof typeof TRACE_REQUIRED_PARAM_GROUPS];
}

function collectMissingRequiredParamLabels(toolName: string, args: unknown): string[] {
  const groups = getRequiredParamGroupsForTool(toolName);
  if (!groups?.length) {
    return [];
  }
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : undefined;
  if (!record) {
    return groups.map((group) => group.label ?? group.keys.join(" or "));
  }
  return groups
    .filter((group) => {
      const satisfied =
        group.validator?.(record) ??
        group.keys.some((key) => {
          const value = record[key];
          return typeof value === "string" && (group.allowEmpty || value.trim().length > 0);
        });
      return !satisfied;
    })
    .map((group) => group.label ?? group.keys.join(" or "));
}

function buildToolExecutionStartTraceMeta(params: {
  ctx: ToolHandlerContext;
  toolName: string;
  toolCallId: string;
  args: unknown;
}): Record<string, unknown> {
  const args = params.args;
  const argsType = Array.isArray(args) ? "array" : typeof args;
  const argsKeys =
    args && typeof args === "object" && !Array.isArray(args)
      ? Object.keys(args as Record<string, unknown>).toSorted()
      : undefined;
  const requiredParamsMissing = collectMissingRequiredParamLabels(params.toolName, args);
  return {
    event: "embedded_tool_execution_start",
    tags: ["tool_start", "embedded", "trace"],
    runId: params.ctx.params.runId,
    toolName: params.toolName,
    toolCallId: params.toolCallId,
    argsType,
    ...(argsKeys?.length ? { argsKeys } : {}),
    ...(params.ctx.params.sessionKey ? { sessionKey: params.ctx.params.sessionKey } : {}),
    ...(params.ctx.params.sessionId ? { sessionId: params.ctx.params.sessionId } : {}),
    ...(params.ctx.params.agentId ? { agentId: params.ctx.params.agentId } : {}),
    ...(requiredParamsMissing.length ? { requiredParamsMissing } : {}),
  };
}

function traceToolExecutionStart(params: {
  ctx: ToolHandlerContext;
  toolName: string;
  toolCallId: string;
  args: unknown;
}) {
  if (!params.ctx.log.trace || params.ctx.log.isEnabled?.("trace") !== true) {
    return;
  }
  params.ctx.log.trace(
    "embedded run tool start",
    buildToolExecutionStartTraceMeta({
      ctx: params.ctx,
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      args: params.args,
    }),
  );
}

const TOOL_START_WARNING_PREVIEW_MAX_CHARS = 200;

function buildToolStartWarningArgsPreview(rawArgsPreview: string | undefined): string | undefined {
  if (rawArgsPreview == null) {
    return undefined;
  }
  // Bound before regex normalization so malformed tool args cannot make warning work unbounded.
  const wasTruncated = rawArgsPreview.length > TOOL_START_WARNING_PREVIEW_MAX_CHARS;
  const bounded = truncateUtf16Safe(rawArgsPreview, TOOL_START_WARNING_PREVIEW_MAX_CHARS);
  const preview = sanitizeForConsole(bounded, TOOL_START_WARNING_PREVIEW_MAX_CHARS);
  return wasTruncated && preview ? `${preview}…` : preview;
}

type ToolStartRecord = {
  startTime: number;
  args: unknown;
  hasRepliedRef?: { value: boolean };
};

/** Track tool execution start data for after_tool_call hook. */
export const toolStartData = new Map<string, ToolStartRecord>();

export function buildToolStartKey(runId: string, toolCallId: string): string {
  return `${runId}:${toolCallId}`;
}

/** Returns the number of active tool executions tracked for one embedded run. */
export function countActiveToolExecutions(runId: string): number {
  const prefix = `${runId}:`;
  let count = 0;
  for (const key of toolStartData.keys()) {
    if (key.startsWith(prefix)) {
      count += 1;
    }
  }
  return count;
}

/** Cleans up tool start data for a run that has been unsubscribed or aborted. */
export function cleanupRunToolStartData(runId: string): void {
  const prefix = `${runId}:`;
  for (const key of toolStartData.keys()) {
    if (key.startsWith(prefix)) {
      toolStartData.delete(key);
    }
  }
}

export function buildToolCallSummary(
  toolName: string,
  args: unknown,
  meta: string | undefined,
  instanceReplaySafe: boolean,
  structuredReplaySafe: boolean,
): ToolCallSummary {
  const mutation = buildToolMutationState(toolName, args, meta);
  return {
    meta,
    commandBearing: isCommandBearingToolCall(toolName, args),
    instanceReplaySafe,
    mutatingAction: mutation.mutatingAction,
    replaySafe:
      (instanceReplaySafe && !mutation.mutatingAction) ||
      (structuredReplaySafe && mutation.replaySafe),
    actionFingerprint: mutation.actionFingerprint,
    fileTarget: mutation.fileTarget,
  };
}

export function buildToolItemId(toolCallId: string): string {
  return `tool:${toolCallId}`;
}

export function buildToolItemTitle(toolName: string, meta?: string): string {
  return meta ? `${toolName} ${meta}` : toolName;
}

export function isExecToolName(toolName: string): boolean {
  return toolName === "exec" || toolName === "bash";
}

export function buildCommandItemId(toolCallId: string): string {
  return `command:${toolCallId}`;
}

export function buildPatchItemId(toolCallId: string): string {
  return `patch:${toolCallId}`;
}

export function buildCommandItemTitle(toolName: string, meta?: string): string {
  return meta ? `command ${meta}` : `${toolName} command`;
}

export function buildPatchItemTitle(meta?: string): string {
  return meta ? `patch ${meta}` : "apply patch";
}

export function emitTrackedItemEvent(ctx: ToolHandlerContext, itemData: AgentItemEventData): void {
  if (itemData.phase === "start") {
    ctx.state.itemActiveIds.add(itemData.itemId);
    ctx.state.itemStartedCount += 1;
  } else if (itemData.phase === "end") {
    ctx.state.itemActiveIds.delete(itemData.itemId);
    ctx.state.itemCompletedCount += 1;
  }
  emitAgentItemEvent({
    runId: ctx.params.runId,
    ...(ctx.params.sessionKey ? { sessionKey: ctx.params.sessionKey } : {}),
    data: itemData,
  });
  emitAgentEventCallbackBestEffort(ctx, {
    stream: "item",
    data: itemData,
  });
}

function emitExecutionPhaseBestEffort(
  ctx: ToolHandlerContext,
  info: Parameters<NonNullable<ToolHandlerContext["params"]["onExecutionPhase"]>>[0],
): void {
  runBestEffortCallback({
    label: "tool execution phase",
    log: ctx.log,
    callback: () => ctx.params.onExecutionPhase?.(info),
  });
}

export function emitAgentEventCallbackBestEffort(
  ctx: ToolHandlerContext,
  event: Parameters<NonNullable<ToolHandlerContext["params"]["onAgentEvent"]>>[0],
): void {
  runBestEffortCallback({
    label: "tool agent event",
    log: ctx.log,
    callback: () => ctx.params.onAgentEvent?.(event),
  });
}

function extendExecMeta(toolName: string, args: unknown, meta?: string): string | undefined {
  const normalized = normalizeOptionalLowercaseString(toolName);
  if (normalized !== "exec" && normalized !== "bash") {
    return meta;
  }
  if (!args || typeof args !== "object") {
    return meta;
  }
  const record = args as Record<string, unknown>;
  const flags: string[] = [];
  if (record.pty === true) {
    flags.push("pty");
  }
  if (record.elevated === true) {
    flags.push("elevated");
  }
  if (flags.length === 0) {
    return meta;
  }
  const suffix = flags.join(" · ");
  return meta ? `${meta} · ${suffix}` : suffix;
}

/** Handles a tool-execution start event and emits UI/telemetry start state. */
export function handleToolExecutionStart(
  ctx: ToolHandlerContext,
  evt: AgentEvent & {
    toolName: string;
    toolCallId: string;
    args: unknown;
    replaySafe?: boolean;
    hideFromChannelProgress?: boolean;
  },
): void | Promise<void> {
  const startToolName = normalizeToolName(evt.toolName);
  ctx.state.liveEditDiffStateById.delete(evt.toolCallId);
  const askUserPromptReservation =
    startToolName === "ask_user" && ctx.params.onToolResult
      ? buildAskUserPromptPayload(evt.toolCallId, ctx.params.sessionKey, ctx.params.runId, evt.args)
      : undefined;
  const cancelAskUserPromptReservation = () => {
    if (askUserPromptReservation) {
      cancelAskUserPromptDelivery(evt.toolCallId, ctx.params.sessionKey, ctx.params.runId);
    }
  };
  const continueAfterBlockReplyFlush = (): void | Promise<void> => {
    let onBlockReplyFlushResult: void | Promise<void>;
    try {
      onBlockReplyFlushResult = ctx.params.onBlockReplyFlush?.({
        reason: "tool_start",
        assistantMessageIndex: ctx.state.assistantMessageIndex,
      });
    } catch (error) {
      cancelAskUserPromptReservation();
      throw error;
    }
    if (isPromiseLike<void>(onBlockReplyFlushResult)) {
      return onBlockReplyFlushResult.then(
        () => continueToolExecutionStart(),
        (error: unknown) => {
          cancelAskUserPromptReservation();
          throw error;
        },
      );
    }
    return continueToolExecutionStart();
  };

  const continueToolExecutionStart = (): void | Promise<void> => {
    const rawToolName = evt.toolName;
    const toolName = normalizeToolName(rawToolName);
    const hideFromChannelProgress = evt.hideFromChannelProgress === true;
    const toolCallId = evt.toolCallId;
    const args = evt.args;
    const runId = ctx.params.runId;
    ctx.state.toolExecutionSinceLastBlockReply = true;
    emitExecutionPhaseBestEffort(ctx, {
      phase: "tool_execution_started",
      tool: toolName,
      toolCallId,
      source: "embedded-agent",
    });

    const startedAt = Date.now();
    toolStartData.set(buildToolStartKey(runId, toolCallId), {
      startTime: startedAt,
      args,
      ...(ctx.params.hasRepliedRef
        ? { hasRepliedRef: { value: ctx.params.hasRepliedRef.value } }
        : {}),
    });
    traceToolExecutionStart({ ctx, toolName, toolCallId, args });

    if (toolName === "read") {
      const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
      const filePathValue =
        typeof record.path === "string"
          ? record.path
          : typeof record.file_path === "string"
            ? record.file_path
            : "";
      const filePath = filePathValue.trim();
      if (!filePath) {
        const argsType = typeof args;
        const rawArgsPreview = readStringValue(args);
        const argsPreview = buildToolStartWarningArgsPreview(rawArgsPreview);
        const safeRunId = sanitizeForConsole(runId) ?? "-";
        const safeSessionKey = sanitizeForConsole(ctx.params.sessionKey);
        const safeSessionId = sanitizeForConsole(ctx.params.sessionId);
        const safeAgentId = sanitizeForConsole(ctx.params.agentId);
        const consoleMessageParts = [
          "read tool called without path:",
          `runId=${safeRunId}`,
          `toolCallId=${sanitizeForConsole(toolCallId) ?? "tool-call"}`,
          `argsType=${argsType}`,
        ];
        if (safeSessionKey) {
          consoleMessageParts.push(`sessionKey=${safeSessionKey}`);
        }
        if (safeSessionId) {
          consoleMessageParts.push(`sessionId=${safeSessionId}`);
        }
        if (safeAgentId) {
          consoleMessageParts.push(`agentId=${safeAgentId}`);
        }
        if (argsPreview) {
          consoleMessageParts.push(`argsPreview=${argsPreview}`);
        }
        const consoleMessage = consoleMessageParts.join(" ");
        const message = `read tool called without path: toolCallId=${toolCallId} argsType=${argsType}${
          argsPreview ? ` argsPreview=${argsPreview}` : ""
        }`;
        ctx.log.warn(message, {
          event: "embedded_read_tool_start_warning",
          tags: ["tool_start", "read", "embedded", "validation"],
          runId: ctx.params.runId,
          toolCallId,
          argsType,
          ...(safeSessionKey ? { sessionKey: ctx.params.sessionKey } : {}),
          ...(safeSessionId ? { sessionId: ctx.params.sessionId } : {}),
          ...(safeAgentId ? { agentId: ctx.params.agentId } : {}),
          ...(argsPreview ? { argsPreview } : {}),
          consoleMessage,
        });
      }
    }

    const meta = extendExecMeta(
      toolName,
      args,
      inferToolMetaFromArgsCore(toolName, args, {
        detailMode: ctx.params.toolProgressDetail ?? "explain",
      }),
    );
    const instanceReplaySafe =
      evt.replaySafe === true ||
      ctx.params.replaySafeToolNames?.has(rawToolName) === true ||
      ctx.params.replaySafeToolNames?.has(toolName) === true;
    const callSummary = buildToolCallSummary(toolName, args, meta, instanceReplaySafe, false);
    ctx.state.toolMetaById.set(toolCallId, callSummary);
    ctx.log.debug(
      `embedded run tool start: runId=${ctx.params.runId} tool=${toolName} toolCallId=${toolCallId}`,
    );

    const shouldEmitToolEvents = ctx.shouldEmitToolResult();
    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "tool",
      data: {
        phase: "start",
        name: toolName,
        toolCallId,
        args: sanitizeToolArgs(args) as Record<string, unknown>,
        ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
      },
    });
    const itemData: AgentItemEventData = {
      itemId: buildToolItemId(toolCallId),
      phase: "start",
      kind: "tool",
      title: buildToolItemTitle(toolName, meta),
      status: "running",
      name: toolName,
      meta,
      commandBearing: callSummary.commandBearing,
      toolCallId,
      startedAt,
      ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
      ...(callSummary.commandBearing && !isExecToolName(toolName)
        ? { suppressChannelProgress: true }
        : {}),
    };
    emitTrackedItemEvent(ctx, itemData);
    // Best-effort typing signal; do not block tool summaries on slow emitters.
    emitAgentEventCallbackBestEffort(ctx, {
      stream: "tool",
      data: {
        phase: "start",
        name: toolName,
        toolCallId,
        args: sanitizeToolArgs(args) as Record<string, unknown>,
        ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
      },
    });

    if (isExecToolName(toolName)) {
      emitTrackedItemEvent(ctx, {
        itemId: buildCommandItemId(toolCallId),
        phase: "start",
        kind: "command",
        title: buildCommandItemTitle(toolName, meta),
        status: "running",
        name: toolName,
        meta,
        toolCallId,
        startedAt,
      });
    } else if (resolveFileMutationToolName(toolName) === "apply_patch") {
      emitTrackedItemEvent(ctx, {
        itemId: buildPatchItemId(toolCallId),
        phase: "start",
        kind: "patch",
        title: buildPatchItemTitle(meta),
        status: "running",
        name: toolName,
        meta,
        toolCallId,
        startedAt,
      });
    }

    if (
      ctx.params.onToolResult &&
      shouldEmitToolEvents &&
      !ctx.state.toolSummaryById.has(toolCallId)
    ) {
      ctx.state.toolSummaryById.add(toolCallId);
      ctx.emitToolSummary(toolName, meta, callSummary.commandBearing);
    }

    // Track messaging tool sends (pending until confirmed in tool_execution_end).
    if (isMessagingTool(toolName)) {
      const argsRecord = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
      const isMessagingSend = isMessagingToolSendAction(toolName, argsRecord);
      if (isMessagingToolTargetEvidenceAction(toolName, argsRecord)) {
        const telemetryArgs = applyCurrentMessageProvider(
          toolName,
          argsRecord,
          ctx.params.messageChannel,
        );
        const sendTarget = extractMessagingToolSend(toolName, telemetryArgs, {
          config: ctx.params.config,
          currentChannelId: ctx.params.currentChannelId,
          currentMessagingTarget: ctx.params.currentMessagingTarget,
          currentThreadId:
            ctx.params.currentThreadId ??
            parseSessionThreadInfoFast(ctx.params.sessionKey).threadId,
          currentMessageId: ctx.params.currentMessageId,
          replyToMode: ctx.params.replyToMode,
          hasRepliedRef: ctx.params.hasRepliedRef,
        });
        if (sendTarget) {
          ctx.state.pendingMessagingTargets.set(toolCallId, sendTarget);
        }
      }
      if (isMessagingSend) {
        const text = readMessagingText(argsRecord);
        if (text) {
          ctx.state.pendingMessagingTexts.set(toolCallId, text);
          ctx.log.debug(`Tracking pending messaging text: tool=${toolName} len=${text.length}`);
        }
        // Track media URLs from messaging tool args (pending until tool_execution_end).
        const mediaUrls = collectMessagingMediaUrlsFromRecord(argsRecord);
        if (mediaUrls.length > 0) {
          ctx.state.pendingMessagingMediaUrls.set(toolCallId, mediaUrls);
        }
      }
    }

    if (toolName === "ask_user" && ctx.params.onToolResult) {
      const payload = askUserPromptReservation;
      if (payload) {
        const questionId = payload.questionId;
        void waitForAskUserPromptReady(questionId)
          .then((questions) => {
            if (!questions) {
              return;
            }
            return ctx.params.onToolResult?.(
              buildAgentHarnessQuestionPromptPayload({
                questionId,
                questions: questions.map(({ questionId: id, ...question }) => ({
                  ...question,
                  id,
                })),
                options: { intro: "Question for you:" },
              }),
            );
          })
          .then(
            () => settleAskUserPromptDelivery(questionId),
            (error: unknown) => {
              settleAskUserPromptDelivery(questionId, error);
              ctx.log.warn(`failed to deliver ask_user prompt: ${String(error)}`);
            },
          );
      }
    }
  };

  // Flush pending block replies to preserve message boundaries before tool execution.
  let flushBlockReplyBufferResult: void | Promise<void>;
  try {
    flushBlockReplyBufferResult = ctx.flushBlockReplyBuffer();
  } catch (error) {
    cancelAskUserPromptReservation();
    throw error;
  }
  if (isPromiseLike<void>(flushBlockReplyBufferResult)) {
    return flushBlockReplyBufferResult.then(
      () => continueAfterBlockReplyFlush(),
      (error: unknown) => {
        cancelAskUserPromptReservation();
        throw error;
      },
    );
  }
  return continueAfterBlockReplyFlush();
}
