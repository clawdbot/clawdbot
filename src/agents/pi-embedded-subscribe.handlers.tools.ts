import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  buildExecApprovalPendingReplyPayload,
  buildExecApprovalUnavailableReplyPayload,
} from "../infra/exec-approval-reply.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { PluginHookAfterToolCallEvent } from "../plugins/types.js";
import { normalizeTextForComparison } from "./pi-embedded-helpers.js";
import { isMessagingTool, isMessagingToolSendAction } from "./pi-embedded-messaging.js";
import type {
  ToolCallSummary,
  ToolHandlerContext,
} from "./pi-embedded-subscribe.handlers.types.js";
import {
  extractMessagingToolSend,
  extractToolErrorMessage,
  extractToolResultMediaPaths,
  extractToolResultText,
  filterToolResultMediaUrls,
  isToolResultError,
  sanitizeToolResult,
} from "./pi-embedded-subscribe.tools.js";
import { inferToolMetaFromArgs } from "./pi-embedded-utils.js";
import { consumeAdjustedParamsForToolCall } from "./pi-tools.before-tool-call.js";
import { buildToolMutationState, isSameToolMutationAction } from "./tool-mutation.js";
import { normalizeToolName } from "./tool-policy.js";

type ToolStartRecord = {
  startTime: number;
  args: unknown;
};

/** Track tool execution start data for after_tool_call hook. */
const toolStartData = new Map<string, ToolStartRecord>();

function buildToolStartKey(runId: string, toolCallId: string): string {
  return `${runId}:${toolCallId}`;
}

function isCronAddAction(args: unknown): boolean {
  if (!args || typeof args !== "object") {
    return false;
  }
  const action = (args as Record<string, unknown>).action;
  return typeof action === "string" && action.trim().toLowerCase() === "add";
}

function buildToolCallSummary(toolName: string, args: unknown, meta?: string): ToolCallSummary {
  const mutation = buildToolMutationState(toolName, args, meta);
  return {
    meta,
    mutatingAction: mutation.mutatingAction,
    actionFingerprint: mutation.actionFingerprint,
  };
}

function extendExecMeta(toolName: string, args: unknown, meta?: string): string | undefined {
  const normalized = toolName.trim().toLowerCase();
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

function pushUniqueMediaUrl(urls: string[], seen: Set<string>, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const normalized = value.trim();
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  urls.push(normalized);
}

function collectMessagingMediaUrlsFromRecord(record: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  pushUniqueMediaUrl(urls, seen, record.media);
  pushUniqueMediaUrl(urls, seen, record.mediaUrl);
  pushUniqueMediaUrl(urls, seen, record.path);
  pushUniqueMediaUrl(urls, seen, record.filePath);

  const mediaUrls = record.mediaUrls;
  if (Array.isArray(mediaUrls)) {
    for (const mediaUrl of mediaUrls) {
      pushUniqueMediaUrl(urls, seen, mediaUrl);
    }
  }

  return urls;
}

function collectMessagingMediaUrlsFromToolResult(result: unknown): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const appendFromRecord = (value: unknown) => {
    if (!value || typeof value !== "object") {
      return;
    }
    const extracted = collectMessagingMediaUrlsFromRecord(value as Record<string, unknown>);
    for (const url of extracted) {
      if (seen.has(url)) {
        continue;
      }
      seen.add(url);
      urls.push(url);
    }
  };

  appendFromRecord(result);
  if (result && typeof result === "object") {
    appendFromRecord((result as Record<string, unknown>).details);
  }

  const outputText = extractToolResultText(result);
  if (outputText) {
    try {
      appendFromRecord(JSON.parse(outputText));
    } catch {
      // Ignore non-JSON tool output.
    }
  }

  return urls;
}

function readExecApprovalPendingDetails(result: unknown): {
  approvalId: string;
  approvalSlug: string;
  expiresAtMs?: number;
  host: "gateway" | "node";
  command: string;
  cwd?: string;
  nodeId?: string;
  warningText?: string;
} | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const outer = result as Record<string, unknown>;
  const details =
    outer.details && typeof outer.details === "object" && !Array.isArray(outer.details)
      ? (outer.details as Record<string, unknown>)
      : outer;
  if (details.status !== "approval-pending") {
    return null;
  }
  const approvalId = typeof details.approvalId === "string" ? details.approvalId.trim() : "";
  const approvalSlug = typeof details.approvalSlug === "string" ? details.approvalSlug.trim() : "";
  const command = typeof details.command === "string" ? details.command : "";
  const host = details.host === "node" ? "node" : details.host === "gateway" ? "gateway" : null;
  if (!approvalId || !approvalSlug || !command || !host) {
    return null;
  }
  return {
    approvalId,
    approvalSlug,
    expiresAtMs: typeof details.expiresAtMs === "number" ? details.expiresAtMs : undefined,
    host,
    command,
    cwd: typeof details.cwd === "string" ? details.cwd : undefined,
    nodeId: typeof details.nodeId === "string" ? details.nodeId : undefined,
    warningText: typeof details.warningText === "string" ? details.warningText : undefined,
  };
}

function readExecApprovalUnavailableDetails(result: unknown): {
  reason: "initiating-platform-disabled" | "initiating-platform-unsupported" | "no-approval-route";
  warningText?: string;
  channelLabel?: string;
  sentApproverDms?: boolean;
} | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const outer = result as Record<string, unknown>;
  const details =
    outer.details && typeof outer.details === "object" && !Array.isArray(outer.details)
      ? (outer.details as Record<string, unknown>)
      : outer;
  if (details.status !== "approval-unavailable") {
    return null;
  }
  const reason =
    details.reason === "initiating-platform-disabled" ||
    details.reason === "initiating-platform-unsupported" ||
    details.reason === "no-approval-route"
      ? details.reason
      : null;
  if (!reason) {
    return null;
  }
  return {
    reason,
    warningText: typeof details.warningText === "string" ? details.warningText : undefined,
    channelLabel: typeof details.channelLabel === "string" ? details.channelLabel : undefined,
    sentApproverDms: details.sentApproverDms === true,
  };
}

async function emitToolResultOutput(params: {
  ctx: ToolHandlerContext;
  toolName: string;
  meta?: string;
  isToolError: boolean;
  result: unknown;
  sanitizedResult: unknown;
}) {
  const { ctx, toolName, meta, isToolError, result, sanitizedResult } = params;
  if (!ctx.params.onToolResult) {
    return;
  }

  const approvalPending = readExecApprovalPendingDetails(result);
  if (!isToolError && approvalPending) {
    try {
      await ctx.params.onToolResult(
        buildExecApprovalPendingReplyPayload({
          approvalId: approvalPending.approvalId,
          approvalSlug: approvalPending.approvalSlug,
          command: approvalPending.command,
          cwd: approvalPending.cwd,
          host: approvalPending.host,
          nodeId: approvalPending.nodeId,
          expiresAtMs: approvalPending.expiresAtMs,
          warningText: approvalPending.warningText,
        }),
      );
      ctx.state.deterministicApprovalPromptSent = true;
    } catch {
      // ignore delivery failures
    }
    return;
  }

  const approvalUnavailable = readExecApprovalUnavailableDetails(result);
  if (!isToolError && approvalUnavailable) {
    try {
      await ctx.params.onToolResult?.(
        buildExecApprovalUnavailableReplyPayload({
          reason: approvalUnavailable.reason,
          warningText: approvalUnavailable.warningText,
          channelLabel: approvalUnavailable.channelLabel,
          sentApproverDms: approvalUnavailable.sentApproverDms,
        }),
      );
      ctx.state.deterministicApprovalPromptSent = true;
    } catch {
      // ignore delivery failures
    }
    return;
  }

  if (ctx.shouldEmitToolOutput()) {
    const outputText = extractToolResultText(sanitizedResult);
    if (outputText) {
      ctx.emitToolOutput(toolName, meta, outputText);
    }
    return;
  }

  if (isToolError) {
    return;
  }

  // emitToolOutput() already handles MEDIA: directives when enabled; this path
  // only sends raw media URLs for non-verbose delivery mode.
  const mediaPaths = filterToolResultMediaUrls(toolName, extractToolResultMediaPaths(result));
  if (mediaPaths.length === 0) {
    return;
  }
  try {
    void ctx.params.onToolResult({ mediaUrls: mediaPaths });
  } catch {
    // ignore delivery failures
  }
}

export async function handleToolExecutionStart(
  ctx: ToolHandlerContext,
  evt: AgentEvent & { toolName: string; toolCallId: string; args: unknown },
) {
  // Flush pending block replies to preserve message boundaries before tool execution.
  ctx.flushBlockReplyBuffer();
  if (ctx.params.onBlockReplyFlush) {
    await ctx.params.onBlockReplyFlush();
  }

  const rawToolName = String(evt.toolName);
  const toolName = normalizeToolName(rawToolName);
  const toolCallId = String(evt.toolCallId);
  const args = evt.args;
  const runId = ctx.params.runId;

  // Track start time and args for after_tool_call hook
  toolStartData.set(buildToolStartKey(runId, toolCallId), { startTime: Date.now(), args });

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
      const argsPreview = typeof args === "string" ? args.slice(0, 200) : undefined;
      ctx.log.warn(
        `read tool called without path: toolCallId=${toolCallId} argsType=${typeof args}${argsPreview ? ` argsPreview=${argsPreview}` : ""}`,
      );
    }
  }

  const meta = extendExecMeta(toolName, args, inferToolMetaFromArgs(toolName, args));
  ctx.state.toolMetaById.set(toolCallId, buildToolCallSummary(toolName, args, meta));
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
      args: args as Record<string, unknown>,
    },
  });
  // Best-effort typing signal; do not block tool summaries on slow emitters.
  void ctx.params.onAgentEvent?.({
    stream: "tool",
    data: { phase: "start", name: toolName, toolCallId },
  });

  if (
    ctx.params.onToolResult &&
    shouldEmitToolEvents &&
    !ctx.state.toolSummaryById.has(toolCallId)
  ) {
    ctx.state.toolSummaryById.add(toolCallId);
    ctx.emitToolSummary(toolName, meta);
  }

  // Track messaging tool sends (pending until confirmed in tool_execution_end).
  if (isMessagingTool(toolName)) {
    const argsRecord = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const isMessagingSend = isMessagingToolSendAction(toolName, argsRecord);
    if (isMessagingSend) {
      const sendTarget = extractMessagingToolSend(toolName, argsRecord);
      if (sendTarget) {
        ctx.state.pendingMessagingTargets.set(toolCallId, sendTarget);
      }
      // Field names vary by tool: Discord/Slack use "content", sessions_send uses "message"
      const text = (argsRecord.content as string) ?? (argsRecord.message as string);
      if (text && typeof text === "string") {
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
}

export function handleToolExecutionUpdate(
  ctx: ToolHandlerContext,
  evt: AgentEvent & {
    toolName: string;
    toolCallId: string;
    partialResult?: unknown;
  },
) {
  const toolName = normalizeToolName(String(evt.toolName));
  const toolCallId = String(evt.toolCallId);
  const partial = evt.partialResult;
  const sanitized = sanitizeToolResult(partial);
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "tool",
    data: {
      phase: "update",
      name: toolName,
      toolCallId,
      partialResult: sanitized,
    },
  });
  void ctx.params.onAgentEvent?.({
    stream: "tool",
    data: {
      phase: "update",
      name: toolName,
      toolCallId,
    },
  });
}

export async function handleToolExecutionEnd(
  ctx: ToolHandlerContext,
  evt: AgentEvent & {
    toolName: string;
    toolCallId: string;
    isError: boolean;
    result?: unknown;
  },
) {
  const toolName = normalizeToolName(String(evt.toolName));
  const toolCallId = String(evt.toolCallId);
  const runId = ctx.params.runId;
  const isError = Boolean(evt.isError);
  const result = evt.result;
  const isToolError = isError || isToolResultError(result);
  const sanitizedResult = sanitizeToolResult(result);
  const toolStartKey = buildToolStartKey(runId, toolCallId);
  const startData = toolStartData.get(toolStartKey);
  toolStartData.delete(toolStartKey);
  const callSummary = ctx.state.toolMetaById.get(toolCallId);
  const meta = callSummary?.meta;
  ctx.state.toolMetas.push({ toolName, meta });
  ctx.state.toolMetaById.delete(toolCallId);
  ctx.state.toolSummaryById.delete(toolCallId);
  if (isToolError) {
    const errorMessage = extractToolErrorMessage(sanitizedResult);
    ctx.state.lastToolError = {
      toolName,
      meta,
      error: errorMessage,
      mutatingAction: callSummary?.mutatingAction,
      actionFingerprint: callSummary?.actionFingerprint,
    };
  } else if (ctx.state.lastToolError) {
    // Keep unresolved mutating failures until the same action succeeds.
    if (ctx.state.lastToolError.mutatingAction) {
      if (
        isSameToolMutationAction(ctx.state.lastToolError, {
          toolName,
          meta,
          actionFingerprint: callSummary?.actionFingerprint,
        })
      ) {
        ctx.state.lastToolError = undefined;
      }
    } else {
      ctx.state.lastToolError = undefined;
    }
  }

  // Commit messaging tool text on success, discard on error.
  const pendingText = ctx.state.pendingMessagingTexts.get(toolCallId);
  const pendingTarget = ctx.state.pendingMessagingTargets.get(toolCallId);
  if (pendingText) {
    ctx.state.pendingMessagingTexts.delete(toolCallId);
    if (!isToolError) {
      ctx.state.messagingToolSentTexts.push(pendingText);
      ctx.state.messagingToolSentTextsNormalized.push(normalizeTextForComparison(pendingText));
      ctx.log.debug(`Committed messaging text: tool=${toolName} len=${pendingText.length}`);
      ctx.trimMessagingToolSent();
    }
  }
  if (pendingTarget) {
    ctx.state.pendingMessagingTargets.delete(toolCallId);
    if (!isToolError) {
      ctx.state.messagingToolSentTargets.push(pendingTarget);
      ctx.trimMessagingToolSent();
    }
  }
  const pendingMediaUrls = ctx.state.pendingMessagingMediaUrls.get(toolCallId) ?? [];
  ctx.state.pendingMessagingMediaUrls.delete(toolCallId);
  const startArgs =
    startData?.args && typeof startData.args === "object"
      ? (startData.args as Record<string, unknown>)
      : {};
  const adjustedArgs = consumeAdjustedParamsForToolCall(toolCallId, runId);
  const afterToolCallArgs =
    adjustedArgs && typeof adjustedArgs === "object"
      ? (adjustedArgs as Record<string, unknown>)
      : startArgs;
  const isMessagingSend =
    pendingMediaUrls.length > 0 ||
    (isMessagingTool(toolName) && isMessagingToolSendAction(toolName, startArgs));
  if (!isToolError && isMessagingSend) {
    const committedMediaUrls = [
      ...pendingMediaUrls,
      ...collectMessagingMediaUrlsFromToolResult(result),
    ];
    if (committedMediaUrls.length > 0) {
      ctx.state.messagingToolSentMediaUrls.push(...committedMediaUrls);
      ctx.trimMessagingToolSent();
    }
  }

  // Track committed reminders only when cron.add completed successfully.
  if (!isToolError && toolName === "cron" && isCronAddAction(startData?.args)) {
    ctx.state.successfulCronAdds += 1;
  }

  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "tool",
    data: {
      phase: "result",
      name: toolName,
      toolCallId,
      meta,
      isError: isToolError,
      result: sanitizedResult,
    },
  });
  void ctx.params.onAgentEvent?.({
    stream: "tool",
    data: {
      phase: "result",
      name: toolName,
      toolCallId,
      meta,
      isError: isToolError,
    },
  });

  ctx.log.debug(
    `embedded run tool end: runId=${ctx.params.runId} tool=${toolName} toolCallId=${toolCallId}`,
  );

  await emitToolResultOutput({ ctx, toolName, meta, isToolError, result, sanitizedResult });

  // Run after_tool_call plugin hook (fire-and-forget)
  const hookRunnerAfter = ctx.hookRunner ?? getGlobalHookRunner();
  if (hookRunnerAfter?.hasHooks("after_tool_call")) {
    const durationMs = startData?.startTime != null ? Date.now() - startData.startTime : undefined;
    const hookEvent: PluginHookAfterToolCallEvent = {
      toolName,
      params: afterToolCallArgs,
      runId,
      toolCallId,
      result: sanitizedResult,
      error: isToolError ? extractToolErrorMessage(sanitizedResult) : undefined,
      durationMs,
    };
    void hookRunnerAfter
      .runAfterToolCall(hookEvent, {
        toolName,
        agentId: ctx.params.agentId,
        sessionKey: ctx.params.sessionKey,
        sessionId: ctx.params.sessionId,
        runId,
        toolCallId,
        channelId: ctx.params.channelId,
      })
      .catch((err) => {
        ctx.log.warn(`after_tool_call hook failed: tool=${toolName} error=${String(err)}`);
      });
  }
}
