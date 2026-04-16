import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type {
  AgentApprovalEventData,
  AgentCommandOutputEventData,
  AgentItemEventData,
  AgentPatchSummaryEventData,
} from "../infra/agent-events.js";
import {
  emitAgentApprovalEvent,
  emitAgentCommandOutputEvent,
  emitAgentEvent,
  emitAgentItemEvent,
  emitAgentPatchSummaryEvent,
} from "../infra/agent-events.js";
import type { ExecApprovalDecision } from "../infra/exec-approvals.js";
import type { PluginHookAfterToolCallEvent } from "../plugins/types.js";
import { normalizeOptionalLowercaseString, readStringValue } from "../shared/string-coerce.js";
import type { ApplyPatchSummary } from "./apply-patch.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import { parseExecApprovalResultText } from "./exec-approval-result.js";
import { normalizeTextForComparison } from "./pi-embedded-helpers.js";
import { isMessagingTool, isMessagingToolSendAction } from "./pi-embedded-messaging.js";
import { mergeEmbeddedRunReplayState } from "./pi-embedded-runner/replay-state.js";
import type {
  ToolCallSummary,
  ToolHandlerContext,
} from "./pi-embedded-subscribe.handlers.types.js";
import { isPromiseLike } from "./pi-embedded-subscribe.promise.js";
import {
  extractToolResultMediaArtifact,
  extractMessagingToolSend,
  extractToolErrorMessage,
  extractToolResultText,
  filterToolResultMediaUrls,
  isToolResultError,
  isToolResultTimedOut,
  sanitizeToolResult,
} from "./pi-embedded-subscribe.tools.js";
import { inferToolMetaFromArgs } from "./pi-embedded-utils.js";
import { buildToolMutationState, isSameToolMutationAction } from "./tool-mutation.js";
import { normalizeToolName } from "./tool-policy.js";

type ExecApprovalReplyModule = typeof import("../infra/exec-approval-reply.js");
type HookRunnerGlobalModule = typeof import("../plugins/hook-runner-global.js");
type MediaParseModule = typeof import("../media/parse.js");
type BeforeToolCallModule = typeof import("./pi-tools.before-tool-call.js");

let execApprovalReplyModulePromise: Promise<ExecApprovalReplyModule> | undefined;
let hookRunnerGlobalModulePromise: Promise<HookRunnerGlobalModule> | undefined;
let mediaParseModulePromise: Promise<MediaParseModule> | undefined;
let beforeToolCallModulePromise: Promise<BeforeToolCallModule> | undefined;

function loadExecApprovalReply(): Promise<ExecApprovalReplyModule> {
  execApprovalReplyModulePromise ??= import("../infra/exec-approval-reply.js");
  return execApprovalReplyModulePromise;
}

function loadHookRunnerGlobal(): Promise<HookRunnerGlobalModule> {
  hookRunnerGlobalModulePromise ??= import("../plugins/hook-runner-global.js");
  return hookRunnerGlobalModulePromise;
}

function loadMediaParse(): Promise<MediaParseModule> {
  mediaParseModulePromise ??= import("../media/parse.js");
  return mediaParseModulePromise;
}

function loadBeforeToolCall(): Promise<BeforeToolCallModule> {
  beforeToolCallModulePromise ??= import("./pi-tools.before-tool-call.js");
  return beforeToolCallModulePromise;
}

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
  return normalizeOptionalLowercaseString(action) === "add";
}

function buildToolCallSummary(toolName: string, args: unknown, meta?: string): ToolCallSummary {
  const mutation = buildToolMutationState(toolName, args, meta);
  return {
    meta,
    mutatingAction: mutation.mutatingAction,
    actionFingerprint: mutation.actionFingerprint,
  };
}

function buildToolItemId(toolCallId: string): string {
  return `tool:${toolCallId}`;
}

function buildToolItemTitle(toolName: string, meta?: string): string {
  return meta ? `${toolName} ${meta}` : toolName;
}

function isExecToolName(toolName: string): boolean {
  return toolName === "exec" || toolName === "bash";
}

function isPatchToolName(toolName: string): boolean {
  return toolName === "apply_patch";
}

function buildCommandItemId(toolCallId: string): string {
  return `command:${toolCallId}`;
}

function buildPatchItemId(toolCallId: string): string {
  return `patch:${toolCallId}`;
}

function buildCommandItemTitle(toolName: string, meta?: string): string {
  return meta ? `command ${meta}` : `${toolName} command`;
}

function buildPatchItemTitle(meta?: string): string {
  return meta ? `patch ${meta}` : "apply patch";
}

function emitTrackedItemEvent(ctx: ToolHandlerContext, itemData: AgentItemEventData): void {
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
  void ctx.params.onAgentEvent?.({
    stream: "item",
    data: itemData,
  });
}

function readToolResultDetailsRecord(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const details = (result as { details?: unknown }).details;
  return details && typeof details === "object" && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : undefined;
}

function readExecToolDetails(result: unknown): ExecToolDetails | null {
  const details = readToolResultDetailsRecord(result);
  if (!details || typeof details.status !== "string") {
    return null;
  }
  return details as ExecToolDetails;
}

function readApplyPatchSummary(result: unknown): ApplyPatchSummary | null {
  const details = readToolResultDetailsRecord(result);
  const summary =
    details?.summary && typeof details.summary === "object" && !Array.isArray(details.summary)
      ? (details.summary as Record<string, unknown>)
      : null;
  if (!summary) {
    return null;
  }
  const added = Array.isArray(summary.added)
    ? summary.added.filter((entry): entry is string => typeof entry === "string")
    : [];
  const modified = Array.isArray(summary.modified)
    ? summary.modified.filter((entry): entry is string => typeof entry === "string")
    : [];
  const deleted = Array.isArray(summary.deleted)
    ? summary.deleted.filter((entry): entry is string => typeof entry === "string")
    : [];
  return { added, modified, deleted };
}

function buildPatchSummaryText(summary: ApplyPatchSummary): string {
  const parts: string[] = [];
  if (summary.added.length > 0) {
    parts.push(`${summary.added.length} added`);
  }
  if (summary.modified.length > 0) {
    parts.push(`${summary.modified.length} modified`);
  }
  if (summary.deleted.length > 0) {
    parts.push(`${summary.deleted.length} deleted`);
  }
  return parts.length > 0 ? parts.join(", ") : "no file changes recorded";
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

function queuePendingToolMedia(
  ctx: ToolHandlerContext,
  mediaReply: { mediaUrls: string[]; audioAsVoice?: boolean },
) {
  const seen = new Set(ctx.state.pendingToolMediaUrls);
  for (const mediaUrl of mediaReply.mediaUrls) {
    if (seen.has(mediaUrl)) {
      continue;
    }
    seen.add(mediaUrl);
    ctx.state.pendingToolMediaUrls.push(mediaUrl);
  }
  if (mediaReply.audioAsVoice) {
    ctx.state.pendingToolAudioAsVoice = true;
  }
}

async function collectEmittedToolOutputMediaUrls(
  toolName: string,
  outputText: string,
  result: unknown,
): Promise<string[]> {
  const { splitMediaFromOutput } = await loadMediaParse();
  const mediaUrls = splitMediaFromOutput(outputText).mediaUrls ?? [];
  if (mediaUrls.length === 0) {
    return [];
  }
  return filterToolResultMediaUrls(toolName, mediaUrls, result);
}

const COMPACT_PROVIDER_INVENTORY_TOOLS = new Set(["image_generate", "video_generate"]);

function hasProviderInventoryDetails(result: unknown): boolean {
  if (!result || typeof result !== "object") {
    return false;
  }
  const details = readToolResultDetailsRecord(result);
  return Array.isArray(details?.providers);
}

function shouldEmitCompactToolOutput(params: {
  toolName: string;
  result: unknown;
  outputText?: string;
}): boolean {
  if (!COMPACT_PROVIDER_INVENTORY_TOOLS.has(params.toolName)) {
    return false;
  }
  if (!hasProviderInventoryDetails(params.result)) {
    return false;
  }
  return Boolean(params.outputText?.trim());
}

function readExecApprovalPendingDetails(result: unknown): {
  approvalId: string;
  approvalSlug: string;
  expiresAtMs?: number;
  allowedDecisions?: readonly ExecApprovalDecision[];
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
  const approvalId = readStringValue(details.approvalId) ?? "";
  const approvalSlug = readStringValue(details.approvalSlug) ?? "";
  const command = typeof details.command === "string" ? details.command : "";
  const host = details.host === "node" ? "node" : details.host === "gateway" ? "gateway" : null;
  if (!approvalId || !approvalSlug || !command || !host) {
    return null;
  }
  return {
    approvalId,
    approvalSlug,
    expiresAtMs: typeof details.expiresAtMs === "number" ? details.expiresAtMs : undefined,
    allowedDecisions: Array.isArray(details.allowedDecisions)
      ? details.allowedDecisions.filter(
          (decision): decision is ExecApprovalDecision =>
            decision === "allow-once" || decision === "allow-always" || decision === "deny",
        )
      : undefined,
    host,
    command,
    cwd: readStringValue(details.cwd),
    nodeId: readStringValue(details.nodeId),
    warningText: readStringValue(details.warningText),
  };
}

function readExecApprovalUnavailableDetails(result: unknown): {
  reason: "initiating-platform-disabled" | "initiating-platform-unsupported" | "no-approval-route";
  warningText?: string;
  channel?: string;
  channelLabel?: string;
  accountId?: string;
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
    warningText: readStringValue(details.warningText),
    channel: readStringValue(details.channel),
    channelLabel: readStringValue(details.channelLabel),
    accountId: readStringValue(details.accountId),
    sentApproverDms: details.sentApproverDms === true,
  };
}

async function emitToolResultOutput(params: {
  ctx: ToolHandlerContext;
  toolName: string;
  rawToolName: string;
  meta?: string;
  isToolError: boolean;
  result: unknown;
  sanitizedResult: unknown;
}) {
  const { ctx, toolName, rawToolName, meta, isToolError, result, sanitizedResult } = params;
  const hasStructuredMedia =
    result &&
    typeof result === "object" &&
    (result as { details?: unknown }).details &&
    typeof (result as { details?: unknown }).details === "object" &&
    !Array.isArray((result as { details?: unknown }).details) &&
    typeof ((result as { details?: { media?: unknown } }).details?.media ?? undefined) ===
      "object" &&
    !Array.isArray((result as { details?: { media?: unknown } }).details?.media);
  const approvalPending = readExecApprovalPendingDetails(result);
  let emittedToolOutputMediaUrls: string[] = [];
  if (!isToolError && approvalPending) {
    if (!ctx.params.onToolResult) {
      return;
    }
    ctx.state.deterministicApprovalPromptPending = true;
    try {
      const { buildExecApprovalPendingReplyPayload } = await loadExecApprovalReply();
      await ctx.params.onToolResult(
        buildExecApprovalPendingReplyPayload({
          approvalId: approvalPending.approvalId,
          approvalSlug: approvalPending.approvalSlug,
          allowedDecisions: approvalPending.allowedDecisions,
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
      ctx.state.deterministicApprovalPromptSent = false;
    } finally {
      ctx.state.deterministicApprovalPromptPending = false;
    }
    return;
  }

  const approvalUnavailable = readExecApprovalUnavailableDetails(result);
  if (!isToolError && approvalUnavailable) {
    if (!ctx.params.onToolResult) {
      return;
    }
    ctx.state.deterministicApprovalPromptPending = true;
    try {
      const { buildExecApprovalUnavailableReplyPayload } = await loadExecApprovalReply();
      await ctx.params.onToolResult?.(
        buildExecApprovalUnavailableReplyPayload({
          reason: approvalUnavailable.reason,
          warningText: approvalUnavailable.warningText,
          channel: approvalUnavailable.channel,
          channelLabel: approvalUnavailable.channelLabel,
          accountId: approvalUnavailable.accountId,
          sentApproverDms: approvalUnavailable.sentApproverDms,
        }),
      );
      ctx.state.deterministicApprovalPromptSent = true;
    } catch {
      ctx.state.deterministicApprovalPromptSent = false;
    } finally {
      ctx.state.deterministicApprovalPromptPending = false;
    }
    return;
  }

  const outputText = extractToolResultText(sanitizedResult);
  const shouldEmitOutput =
    ctx.shouldEmitToolOutput() || shouldEmitCompactToolOutput({ toolName, result, outputText });
  if (shouldEmitOutput) {
    if (outputText) {
      ctx.emitToolOutput(rawToolName, meta, outputText, result);
      if (ctx.params.toolResultFormat === "plain") {
        emittedToolOutputMediaUrls = await collectEmittedToolOutputMediaUrls(
          rawToolName,
          outputText,
          result,
        );
      }
    }
    if (!hasStructuredMedia) {
      return;
    }
  }

  if (isToolError) {
    return;
  }

  const mediaReply = extractToolResultMediaArtifact(result);
  if (!mediaReply) {
    return;
  }
  const mediaUrls = filterToolResultMediaUrls(
    rawToolName,
    mediaReply.mediaUrls,
    result,
    ctx.builtinToolNames,
  );
  const pendingMediaUrls =
    mediaReply.audioAsVoice || emittedToolOutputMediaUrls.length === 0
      ? mediaUrls
      : mediaUrls.filter((url) => !emittedToolOutputMediaUrls.includes(url));
  if (pendingMediaUrls.length === 0) {
    return;
  }
  queuePendingToolMedia(ctx, {
    mediaUrls: pendingMediaUrls,
    ...(mediaReply.audioAsVoice ? { audioAsVoice: true } : {}),
  });
}

export function handleToolExecutionStart(
  ctx: ToolHandlerContext,
  evt: AgentEvent & { toolName: string; toolCallId: string; args: unknown },
): void | Promise<void> {
  const continueAfterBlockReplyFlush = (): void | Promise<void> => {
    const onBlockReplyFlushResult = ctx.params.onBlockReplyFlush?.();
    if (isPromiseLike<void>(onBlockReplyFlushResult)) {
      return onBlockReplyFlushResult.then(() => {
        continueToolExecutionStart();
      });
    }
    continueToolExecutionStart();
    return undefined;
  };

  const continueToolExecutionStart = () => {
    const rawToolName = evt.toolName;
    const toolName = normalizeToolName(rawToolName);
    const toolCallId = evt.toolCallId;
    const args = evt.args;
    const runId = ctx.params.runId;

    // Track start time and args for after_tool_call hook.
    const startedAt = Date.now();
    toolStartData.set(buildToolStartKey(runId, toolCallId), { startTime: startedAt, args });

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
        const argsPreview = readStringValue(args)?.slice(0, 200);
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
    const itemData: AgentItemEventData = {
      itemId: buildToolItemId(toolCallId),
      phase: "start",
      kind: "tool",
      title: buildToolItemTitle(toolName, meta),
      status: "running",
      name: toolName,
      meta,
      toolCallId,
      startedAt,
    };
    emitTrackedItemEvent(ctx, itemData);
    // Best-effort typing signal; do not block tool summaries on slow emitters.
    void ctx.params.onAgentEvent?.({
      stream: "tool",
      data: { phase: "start", name: toolName, toolCallId },
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
    } else if (isPatchToolName(toolName)) {
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
  };

  // Flush pending block replies to preserve message boundaries before tool execution.
  const flushBlockReplyBufferResult = ctx.flushBlockReplyBuffer();
  if (isPromiseLike<void>(flushBlockReplyBufferResult)) {
    return flushBlockReplyBufferResult.then(() => continueAfterBlockReplyFlush());
  }
  return continueAfterBlockReplyFlush();
}

export function handleToolExecutionUpdate(
  ctx: ToolHandlerContext,
  evt: AgentEvent & {
    toolName: string;
    toolCallId: string;
    partialResult?: unknown;
  },
) {
  const toolName = normalizeToolName(evt.toolName);
  const toolCallId = evt.toolCallId;
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
  const itemData: AgentItemEventData = {
    itemId: buildToolItemId(toolCallId),
    phase: "update",
    kind: "tool",
    title: buildToolItemTitle(toolName, ctx.state.toolMetaById.get(toolCallId)?.meta),
    status: "running",
    name: toolName,
    meta: ctx.state.toolMetaById.get(toolCallId)?.meta,
    toolCallId,
  };
  emitTrackedItemEvent(ctx, itemData);
  void ctx.params.onAgentEvent?.({
    stream: "tool",
    data: {
      phase: "update",
      name: toolName,
      toolCallId,
    },
  });
  if (isExecToolName(toolName)) {
    const output = extractToolResultText(sanitized);
    const commandData: AgentItemEventData = {
      itemId: buildCommandItemId(toolCallId),
      phase: "update",
      kind: "command",
      title: buildCommandItemTitle(toolName, ctx.state.toolMetaById.get(toolCallId)?.meta),
      status: "running",
      name: toolName,
      meta: ctx.state.toolMetaById.get(toolCallId)?.meta,
      toolCallId,
      ...(output ? { progressText: output } : {}),
    };
    emitTrackedItemEvent(ctx, commandData);
    if (output) {
      const outputData: AgentCommandOutputEventData = {
        itemId: commandData.itemId,
        phase: "delta",
        title: commandData.title,
        toolCallId,
        name: toolName,
        output,
        status: "running",
      };
      emitAgentCommandOutputEvent({
        runId: ctx.params.runId,
        ...(ctx.params.sessionKey ? { sessionKey: ctx.params.sessionKey } : {}),
        data: outputData,
      });
      void ctx.params.onAgentEvent?.({
        stream: "command_output",
        data: outputData,
      });
    }
  }
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
  const rawToolName = evt.toolName;
  const toolName = normalizeToolName(rawToolName);
  const toolCallId = evt.toolCallId;
  const runId = ctx.params.runId;
  const isError = evt.isError;
  const result = evt.result;
  const isToolError = isError || isToolResultError(result);
  const sanitizedResult = sanitizeToolResult(result);
  const toolStartKey = buildToolStartKey(runId, toolCallId);
  const startData = toolStartData.get(toolStartKey);
  toolStartData.delete(toolStartKey);
  const callSummary = ctx.state.toolMetaById.get(toolCallId);
  const completedMutatingAction = !isToolError && Boolean(callSummary?.mutatingAction);
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
      timedOut: isToolResultTimedOut(sanitizedResult) || undefined,
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
  if (completedMutatingAction) {
    ctx.state.replayState = mergeEmbeddedRunReplayState(ctx.state.replayState, {
      replayInvalid: true,
      hadPotentialSideEffects: true,
    });
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
  const endedAt = Date.now();
  const itemId = buildToolItemId(toolCallId);
  const itemData: AgentItemEventData = {
    itemId,
    phase: "end",
    kind: "tool",
    title: buildToolItemTitle(toolName, meta),
    status: isToolError ? "failed" : "completed",
    name: toolName,
    meta,
    toolCallId,
    startedAt: startData?.startTime,
    endedAt,
    ...(isToolError && extractToolErrorMessage(sanitizedResult)
      ? { error: extractToolErrorMessage(sanitizedResult) }
      : {}),
  };
  emitTrackedItemEvent(ctx, itemData);
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

  if (isExecToolName(toolName)) {
    const execDetails = readExecToolDetails(result);
    const commandItemId = buildCommandItemId(toolCallId);
    if (
      execDetails?.status === "approval-pending" ||
      execDetails?.status === "approval-unavailable"
    ) {
      const approvalStatus = execDetails.status === "approval-pending" ? "pending" : "unavailable";
      const approvalData: AgentApprovalEventData = {
        phase: "requested",
        kind: "exec",
        status: approvalStatus,
        title:
          approvalStatus === "pending"
            ? "Command approval requested"
            : "Command approval unavailable",
        itemId: commandItemId,
        toolCallId,
        ...(execDetails.status === "approval-pending"
          ? {
              approvalId: execDetails.approvalId,
              approvalSlug: execDetails.approvalSlug,
            }
          : {}),
        command: execDetails.command,
        host: execDetails.host,
        ...(execDetails.status === "approval-unavailable" ? { reason: execDetails.reason } : {}),
        message: execDetails.warningText,
      };
      emitAgentApprovalEvent({
        runId: ctx.params.runId,
        ...(ctx.params.sessionKey ? { sessionKey: ctx.params.sessionKey } : {}),
        data: approvalData,
      });
      void ctx.params.onAgentEvent?.({
        stream: "approval",
        data: approvalData,
      });
      emitTrackedItemEvent(ctx, {
        itemId: commandItemId,
        phase: "end",
        kind: "command",
        title: buildCommandItemTitle(toolName, meta),
        status: "blocked",
        name: toolName,
        meta,
        toolCallId,
        startedAt: startData?.startTime,
        endedAt,
        ...(execDetails.status === "approval-pending"
          ? {
              approvalId: execDetails.approvalId,
              approvalSlug: execDetails.approvalSlug,
              summary: "Awaiting approval before command can run.",
            }
          : {
              summary: "Command is blocked because no interactive approval route is available.",
            }),
      });
    } else {
      const output =
        execDetails && "aggregated" in execDetails
          ? execDetails.aggregated
          : extractToolResultText(sanitizedResult);
      const commandStatus =
        execDetails?.status === "failed" || isToolError ? "failed" : "completed";
      emitTrackedItemEvent(ctx, {
        itemId: commandItemId,
        phase: "end",
        kind: "command",
        title: buildCommandItemTitle(toolName, meta),
        status: commandStatus,
        name: toolName,
        meta,
        toolCallId,
        startedAt: startData?.startTime,
        endedAt,
        ...(output ? { summary: output } : {}),
        ...(isToolError && extractToolErrorMessage(sanitizedResult)
          ? { error: extractToolErrorMessage(sanitizedResult) }
          : {}),
      });
      const outputData: AgentCommandOutputEventData = {
        itemId: commandItemId,
        phase: "end",
        title: buildCommandItemTitle(toolName, meta),
        toolCallId,
        name: toolName,
        ...(output ? { output } : {}),
        status: commandStatus,
        ...(execDetails && "exitCode" in execDetails ? { exitCode: execDetails.exitCode } : {}),
        ...(execDetails && "durationMs" in execDetails
          ? { durationMs: execDetails.durationMs }
          : {}),
        ...(execDetails && "cwd" in execDetails && typeof execDetails.cwd === "string"
          ? { cwd: execDetails.cwd }
          : {}),
      };
      emitAgentCommandOutputEvent({
        runId: ctx.params.runId,
        ...(ctx.params.sessionKey ? { sessionKey: ctx.params.sessionKey } : {}),
        data: outputData,
      });
      void ctx.params.onAgentEvent?.({
        stream: "command_output",
        data: outputData,
      });

      if (typeof output === "string") {
        const parsedApprovalResult = parseExecApprovalResultText(output);
        if (parsedApprovalResult.kind === "denied") {
          const approvalData: AgentApprovalEventData = {
            phase: "resolved",
            kind: "exec",
            status: normalizeOptionalLowercaseString(parsedApprovalResult.metadata)?.includes(
              "approval-request-failed",
            )
              ? "failed"
              : "denied",
            title: "Command approval resolved",
            itemId: commandItemId,
            toolCallId,
            message: parsedApprovalResult.body || parsedApprovalResult.raw,
          };
          emitAgentApprovalEvent({
            runId: ctx.params.runId,
            ...(ctx.params.sessionKey ? { sessionKey: ctx.params.sessionKey } : {}),
            data: approvalData,
          });
          void ctx.params.onAgentEvent?.({
            stream: "approval",
            data: approvalData,
          });
        }
      }
    }
  }

  if (isPatchToolName(toolName)) {
    const patchSummary = readApplyPatchSummary(result);
    const patchItemId = buildPatchItemId(toolCallId);
    const summaryText = patchSummary ? buildPatchSummaryText(patchSummary) : undefined;
    emitTrackedItemEvent(ctx, {
      itemId: patchItemId,
      phase: "end",
      kind: "patch",
      title: buildPatchItemTitle(meta),
      status: isToolError ? "failed" : "completed",
      name: toolName,
      meta,
      toolCallId,
      startedAt: startData?.startTime,
      endedAt,
      ...(summaryText ? { summary: summaryText } : {}),
      ...(isToolError && extractToolErrorMessage(sanitizedResult)
        ? { error: extractToolErrorMessage(sanitizedResult) }
        : {}),
    });
    if (patchSummary) {
      const patchData: AgentPatchSummaryEventData = {
        itemId: patchItemId,
        phase: "end",
        title: buildPatchItemTitle(meta),
        toolCallId,
        name: toolName,
        added: patchSummary.added,
        modified: patchSummary.modified,
        deleted: patchSummary.deleted,
        summary: summaryText ?? buildPatchSummaryText(patchSummary),
      };
      emitAgentPatchSummaryEvent({
        runId: ctx.params.runId,
        ...(ctx.params.sessionKey ? { sessionKey: ctx.params.sessionKey } : {}),
        data: patchData,
      });
      void ctx.params.onAgentEvent?.({
        stream: "patch",
        data: patchData,
      });
    }
  }

  ctx.log.debug(
    `embedded run tool end: runId=${ctx.params.runId} tool=${toolName} toolCallId=${toolCallId}`,
  );

  await emitToolResultOutput({
    ctx,
    toolName,
    rawToolName,
    meta,
    isToolError,
    result,
    sanitizedResult,
  });

  // Run after_tool_call plugin hook (fire-and-forget)
  const hookRunnerAfter = ctx.hookRunner ?? (await loadHookRunnerGlobal()).getGlobalHookRunner();
  if (hookRunnerAfter?.hasHooks("after_tool_call")) {
    const { consumeAdjustedParamsForToolCall } = await loadBeforeToolCall();
    const adjustedArgs = consumeAdjustedParamsForToolCall(toolCallId, runId);
    const afterToolCallArgs =
      adjustedArgs && typeof adjustedArgs === "object"
        ? (adjustedArgs as Record<string, unknown>)
        : startArgs;
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
      })
      .catch((err) => {
        ctx.log.warn(`after_tool_call hook failed: tool=${toolName} error=${String(err)}`);
      });
  }
}
