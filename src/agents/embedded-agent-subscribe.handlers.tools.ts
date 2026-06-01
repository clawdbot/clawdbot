import {
  asOptionalObjectRecord,
  asOptionalRecord as readRecordField,
} from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import {
  HEARTBEAT_RESPONSE_TOOL_NAME,
  normalizeHeartbeatToolResponse,
} from "../auto-reply/heartbeat-tool-response.js";
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
import { normalizeInteractiveReply, normalizeMessagePresentation } from "../interactive/payload.js";
import type { PluginHookAfterToolCallEvent } from "../plugins/types.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { truncateUtf16Safe } from "../utils.js";
import { normalizeAcceptedSessionSpawnResult } from "./accepted-session-spawn.js";
import { REQUIRED_PARAM_GROUPS, type RequiredParamGroup } from "./agent-tools.params.js";
import type { ApplyPatchSummary } from "./apply-patch.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import { sanitizeForConsole } from "./console-sanitize.js";
import { normalizeTextForComparison } from "./embedded-agent-helpers.js";
import { isMessagingTool, isMessagingToolSendAction } from "./embedded-agent-messaging.js";
import type { MessagingToolSourceReplyPayload } from "./embedded-agent-messaging.types.js";
import { mergeEmbeddedRunReplayState } from "./embedded-agent-runner/replay-state.js";
import type {
  ToolCallSummary,
  ToolHandlerContext,
} from "./embedded-agent-subscribe.handlers.types.js";
import { isPromiseLike } from "./embedded-agent-subscribe.promise.js";
import {
  extractToolResultMediaArtifact,
  extractToolErrorCode,
  extractMessagingToolSend,
  extractToolErrorMessage,
  extractToolResultText,
  filterToolResultMediaUrls,
  isToolResultError,
  isToolResultTimedOut,
  sanitizeToolArgs,
  sanitizeToolResult,
} from "./embedded-agent-subscribe.tools.js";
import { inferToolMetaFromArgs } from "./embedded-agent-utils.js";
import { parseExecApprovalResultText } from "./exec-approval-result.js";
import type { AgentEvent } from "./runtime/index.js";
import { buildToolMutationState, isSameToolMutationAction } from "./tool-mutation.js";
import { normalizeToolName } from "./tool-policy.js";

type ExecApprovalReplyModule = typeof import("../infra/exec-approval-reply.js");
type HookRunnerGlobalModule = typeof import("../plugins/hook-runner-global.js");
type BeforeToolCallModule = typeof import("./agent-tools.before-tool-call.js");
type ChannelToolProgress = {
  text: string;
};

const execApprovalReplyModuleLoader = createLazyImportLoader<ExecApprovalReplyModule>(
  () => import("../infra/exec-approval-reply.js"),
);
const hookRunnerGlobalModuleLoader = createLazyImportLoader<HookRunnerGlobalModule>(
  () => import("../plugins/hook-runner-global.js"),
);
const beforeToolCallModuleLoader = createLazyImportLoader<BeforeToolCallModule>(
  () => import("./agent-tools.before-tool-call.js"),
);
const LIVE_EXEC_OUTPUT_MAX_CHARS = 8000;
const LIVE_EXEC_UPDATE_MIN_INTERVAL_MS = 250;
const TRACE_REQUIRED_PARAM_GROUPS = {
  read: [{ keys: ["path", "file_path"], label: "path" }],
  write: REQUIRED_PARAM_GROUPS.write,
  edit: REQUIRED_PARAM_GROUPS.edit,
} satisfies Record<string, readonly RequiredParamGroup[]>;

function isMiddlewareToolResultError(result: unknown): boolean {
  if (!result || typeof result !== "object") {
    return false;
  }
  const details = (result as { details?: unknown }).details;
  return Boolean(
    details &&
    typeof details === "object" &&
    !Array.isArray(details) &&
    (details as { middlewareError?: unknown }).middlewareError === true,
  );
}

function loadExecApprovalReply(): Promise<ExecApprovalReplyModule> {
  return execApprovalReplyModuleLoader.load();
}

function loadHookRunnerGlobal(): Promise<HookRunnerGlobalModule> {
  return hookRunnerGlobalModuleLoader.load();
}

function loadBeforeToolCall(): Promise<BeforeToolCallModule> {
  return beforeToolCallModuleLoader.load();
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
const TOOL_START_WARNING_RAW_PREVIEW_MAX_CHARS = TOOL_START_WARNING_PREVIEW_MAX_CHARS + 1;

type ToolStartRecord = {
  startTime: number;
  args: unknown;
};

/** Track tool execution start data for after_tool_call hook. */
const toolStartData = new Map<string, ToolStartRecord>();

function buildToolStartKey(runId: string, toolCallId: string): string {
  return `${runId}:${toolCallId}`;
}

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
    fileTarget: mutation.fileTarget,
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
  return readRecordField(asOptionalObjectRecord(result)?.details);
}

function isAsyncStartedToolResult(result: unknown): boolean {
  const details = readToolResultDetailsRecord(result);
  return details?.async === true && details.status === "started";
}

function readAsyncStartedTaskIds(result: unknown): {
  asyncTaskRunId?: string;
  asyncTaskId?: string;
} {
  const details = readToolResultDetailsRecord(result);
  if (!details) {
    return {};
  }
  const nestedTask = readRecordField(details.task);
  const asyncTaskRunId = readStringValue(details.runId) ?? readStringValue(nestedTask?.runId);
  const asyncTaskId = readStringValue(details.taskId) ?? readStringValue(nestedTask?.taskId);
  return {
    ...(asyncTaskRunId ? { asyncTaskRunId } : {}),
    ...(asyncTaskId ? { asyncTaskId } : {}),
  };
}

function readExecToolDetails(result: unknown): ExecToolDetails | null {
  const details = readToolResultDetailsRecord(result);
  if (!details || typeof details.status !== "string") {
    return null;
  }
  return details as ExecToolDetails;
}

function truncateLiveExecOutput(text: string): string {
  if (text.length <= LIVE_EXEC_OUTPUT_MAX_CHARS) {
    return text;
  }
  return `${truncateUtf16Safe(text, LIVE_EXEC_OUTPUT_MAX_CHARS)}\n...(live output truncated)...`;
}

function capLiveExecResult(result: unknown): unknown {
  const execDetails = readExecToolDetails(result);
  if (
    !execDetails ||
    !("aggregated" in execDetails) ||
    typeof execDetails.aggregated !== "string"
  ) {
    return result;
  }
  const aggregated = truncateLiveExecOutput(execDetails.aggregated);
  if (aggregated === execDetails.aggregated) {
    return result;
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }
  const details = readToolResultDetailsRecord(result);
  return {
    ...(result as Record<string, unknown>),
    details: {
      ...details,
      aggregated,
    },
  };
}

function extractExecOutput(result: unknown): string | undefined {
  const execDetails = readExecToolDetails(result);
  const output =
    execDetails && "aggregated" in execDetails
      ? execDetails.aggregated
      : extractToolResultText(result);
  return typeof output === "string" ? output : undefined;
}

function extractLiveExecOutput(result: unknown): string | undefined {
  const output = extractExecOutput(result);
  return typeof output === "string" ? truncateLiveExecOutput(output) : undefined;
}

function readChannelToolProgress(result: unknown): ChannelToolProgress | undefined {
  const progress = readRecordField(asOptionalObjectRecord(result)?.progress);
  // Only an explicit typed progress field crosses into channel UI. Tool output
  // and details may contain fetched content or private args, so never infer.
  if (progress?.visibility !== "channel" || progress.privacy !== "public") {
    return undefined;
  }
  const text = readStringValue(progress.text)?.trim();
  if (!text) {
    return undefined;
  }
  return { text: truncateLiveExecOutput(text) };
}

function shouldEmitLiveExecUpdate(ctx: ToolHandlerContext, toolCallId: string): boolean {
  const now = Date.now();
  const state = ctx.state.execLiveUpdateStateById ?? new Map<string, { lastEmittedAtMs: number }>();
  ctx.state.execLiveUpdateStateById = state;
  const previous = state.get(toolCallId);
  if (previous && now - previous.lastEmittedAtMs < LIVE_EXEC_UPDATE_MIN_INTERVAL_MS) {
    return false;
  }
  state.set(toolCallId, { lastEmittedAtMs: now });
  return true;
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

function shouldSuppressStructuredMediaToolOutput(params: {
  toolName: string;
  rawToolName: string;
  isToolError: boolean;
  hasDeliverableStructuredMedia: boolean;
  builtinToolNames?: ReadonlySet<string>;
}): boolean {
  return (
    params.toolName === "tts" &&
    params.rawToolName.trim() === "tts" &&
    params.builtinToolNames?.has("tts") === true &&
    !params.isToolError &&
    params.hasDeliverableStructuredMedia
  );
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
  const pushAttachment = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return;
    }
    const attachment = value as Record<string, unknown>;
    pushUniqueMediaUrl(urls, seen, attachment.media);
    pushUniqueMediaUrl(urls, seen, attachment.mediaUrl);
    pushUniqueMediaUrl(urls, seen, attachment.path);
    pushUniqueMediaUrl(urls, seen, attachment.filePath);
    pushUniqueMediaUrl(urls, seen, attachment.fileUrl);
    pushUniqueMediaUrl(urls, seen, attachment.url);
  };

  pushUniqueMediaUrl(urls, seen, record.media);
  pushUniqueMediaUrl(urls, seen, record.mediaUrl);
  pushUniqueMediaUrl(urls, seen, record.path);
  pushUniqueMediaUrl(urls, seen, record.filePath);
  pushUniqueMediaUrl(urls, seen, record.fileUrl);

  const mediaUrls = record.mediaUrls;
  if (Array.isArray(mediaUrls)) {
    for (const mediaUrl of mediaUrls) {
      pushUniqueMediaUrl(urls, seen, mediaUrl);
    }
  }
  const attachments = record.attachments;
  if (Array.isArray(attachments)) {
    for (const attachment of attachments) {
      pushAttachment(attachment);
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

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readStringArrayField(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  return strings.length ? strings : undefined;
}

function copyRecordField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return readRecordField(value) ? { ...(value as Record<string, unknown>) } : undefined;
}

function extractMessagingToolSourceReplyPayload(
  result: unknown,
): MessagingToolSourceReplyPayload | undefined {
  const details = readToolResultDetailsRecord(result);
  if (!details || details.sourceReplySink !== "internal-ui") {
    return undefined;
  }
  const status = normalizeOptionalLowercaseString(details.deliveryStatus);
  if (status && status !== "sent") {
    return undefined;
  }
  const sourceReply = readRecordField(details.sourceReply) ?? details;
  const payload: MessagingToolSourceReplyPayload = {};
  const text = readStringField(sourceReply, "text") ?? readStringField(details, "message");
  if (text) {
    payload.text = text;
  }
  const mediaUrl = readStringField(sourceReply, "mediaUrl") ?? readStringField(details, "mediaUrl");
  if (mediaUrl) {
    payload.mediaUrl = mediaUrl;
  }
  const mediaUrls =
    readStringArrayField(sourceReply, "mediaUrls") ?? readStringArrayField(details, "mediaUrls");
  if (mediaUrls) {
    payload.mediaUrls = mediaUrls;
  }
  const audioAsVoice =
    sourceReply.audioAsVoice === true || details.audioAsVoice === true ? true : undefined;
  if (audioAsVoice) {
    payload.audioAsVoice = true;
  }
  const presentation = normalizeMessagePresentation(sourceReply.presentation);
  if (presentation) {
    payload.presentation = presentation;
  }
  const interactive = normalizeInteractiveReply(sourceReply.interactive);
  if (interactive) {
    payload.interactive = interactive;
  }
  const channelData = copyRecordField(sourceReply, "channelData");
  if (channelData) {
    payload.channelData = channelData;
  }
  const idempotencyKey =
    readStringField(sourceReply, "idempotencyKey") ?? readStringField(details, "idempotencyKey");
  if (idempotencyKey) {
    payload.idempotencyKey = idempotencyKey;
  }
  return Object.keys(payload).length > 0 ? payload : undefined;
}

function queuePendingToolMedia(
  ctx: ToolHandlerContext,
  mediaReply: { mediaUrls: string[]; audioAsVoice?: boolean; trustedLocalMedia?: boolean },
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
  if (mediaReply.trustedLocalMedia) {
    ctx.state.pendingToolTrustedLocalMedia = true;
  }
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
  const hasStructuredMedia = Boolean(
    result &&
    typeof result === "object" &&
    (result as { details?: unknown }).details &&
    typeof (result as { details?: unknown }).details === "object" &&
    !Array.isArray((result as { details?: unknown }).details) &&
    typeof ((result as { details?: { media?: unknown } }).details?.media ?? undefined) ===
      "object" &&
    !Array.isArray((result as { details?: { media?: unknown } }).details?.media),
  );
  const approvalPending = readExecApprovalPendingDetails(result);
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
  const mediaReply = isToolError ? undefined : extractToolResultMediaArtifact(result);
  const mediaUrls = mediaReply
    ? filterToolResultMediaUrls(
        rawToolName,
        mediaReply.mediaUrls,
        result,
        ctx.trustedLocalMediaToolNames,
      )
    : [];
  const shouldEmitOutput =
    !shouldSuppressStructuredMediaToolOutput({
      toolName,
      rawToolName,
      isToolError,
      hasDeliverableStructuredMedia: hasStructuredMedia && mediaUrls.length > 0,
      builtinToolNames: ctx.builtinToolNames,
    }) && ctx.shouldEmitToolOutput();
  if (shouldEmitOutput) {
    if (outputText) {
      ctx.emitToolOutput(rawToolName, meta, outputText, hasStructuredMedia ? undefined : result);
    }
    if (!hasStructuredMedia) {
      return;
    }
  }

  if (isToolError) {
    return;
  }

  if (!mediaReply) {
    return;
  }
  if (mediaUrls.length === 0) {
    return;
  }
  queuePendingToolMedia(ctx, {
    mediaUrls,
    ...(mediaReply.audioAsVoice ? { audioAsVoice: true } : {}),
    ...(mediaReply.trustedLocalMedia ? { trustedLocalMedia: true } : {}),
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
    ctx.state.toolExecutionSinceLastBlockReply = true;
    ctx.params.onExecutionPhase?.({
      phase: "tool_execution_started",
      tool: toolName,
      toolCallId,
      source: "embedded-agent",
    });

    // Track start time and args for after_tool_call hook.
    const startedAt = Date.now();
    toolStartData.set(buildToolStartKey(runId, toolCallId), { startTime: startedAt, args });
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
        const argsPreview = sanitizeForConsole(
          rawArgsPreview?.slice(0, TOOL_START_WARNING_RAW_PREVIEW_MAX_CHARS),
          TOOL_START_WARNING_PREVIEW_MAX_CHARS,
        );
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
      inferToolMetaFromArgs(toolName, args, {
        detailMode: ctx.params.toolProgressDetail ?? "explain",
      }),
    );
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
        args: sanitizeToolArgs(args) as Record<string, unknown>,
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
      data: {
        phase: "start",
        name: toolName,
        toolCallId,
        args: sanitizeToolArgs(args) as Record<string, unknown>,
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
  const isExecTool = isExecToolName(toolName);
  const liveResult = isExecTool ? capLiveExecResult(sanitized) : sanitized;
  const toolProgress = isExecTool ? undefined : readChannelToolProgress(liveResult);
  // Typed progress already has a sanitized item update path. Suppress the raw
  // partial-result event for those updates to avoid duplicate preview lines.
  const emitDetailedLiveUpdate =
    !toolProgress && (!isExecTool || shouldEmitLiveExecUpdate(ctx, toolCallId));
  if (emitDetailedLiveUpdate) {
    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "tool",
      data: {
        phase: "update",
        name: toolName,
        toolCallId,
        partialResult: liveResult,
      },
    });
  }
  const itemData: AgentItemEventData = {
    itemId: buildToolItemId(toolCallId),
    phase: "update",
    kind: "tool",
    title: buildToolItemTitle(toolName, ctx.state.toolMetaById.get(toolCallId)?.meta),
    status: "running",
    name: toolName,
    toolCallId,
    ...(toolProgress
      ? { progressText: toolProgress.text }
      : { meta: ctx.state.toolMetaById.get(toolCallId)?.meta }),
  };
  emitTrackedItemEvent(ctx, itemData);
  if (!toolProgress) {
    void ctx.params.onAgentEvent?.({
      stream: "tool",
      data: {
        phase: "update",
        name: toolName,
        toolCallId,
      },
    });
  }
  if (isExecTool) {
    const output = extractLiveExecOutput(liveResult);
    const commandData: AgentItemEventData = {
      itemId: buildCommandItemId(toolCallId),
      phase: "update",
      kind: "command",
      title: buildCommandItemTitle(toolName, ctx.state.toolMetaById.get(toolCallId)?.meta),
      status: "running",
      name: toolName,
      meta: ctx.state.toolMetaById.get(toolCallId)?.meta,
      toolCallId,
      ...(emitDetailedLiveUpdate && output ? { progressText: output } : {}),
    };
    emitTrackedItemEvent(ctx, commandData);
    if (emitDetailedLiveUpdate && output) {
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
  const eventResult = isExecToolName(toolName)
    ? capLiveExecResult(sanitizedResult)
    : sanitizedResult;
  const toolStartKey = buildToolStartKey(runId, toolCallId);
  const startData = toolStartData.get(toolStartKey);
  toolStartData.delete(toolStartKey);
  ctx.state.execLiveUpdateStateById?.delete(toolCallId);
  const callSummary = ctx.state.toolMetaById.get(toolCallId);
  const completedMutatingAction = !isToolError && Boolean(callSummary?.mutatingAction);
  const meta = callSummary?.meta;
  const asyncStarted = !isToolError && isAsyncStartedToolResult(sanitizedResult);
  const asyncTaskIds = asyncStarted ? readAsyncStartedTaskIds(sanitizedResult) : {};
  ctx.state.toolMetas.push({
    toolName,
    meta,
    ...(asyncStarted ? { asyncStarted: true, ...asyncTaskIds } : {}),
  });
  const acceptedSessionSpawn =
    toolName === "sessions_spawn" && !isToolError
      ? normalizeAcceptedSessionSpawnResult(sanitizedResult)
      : null;
  if (acceptedSessionSpawn) {
    ctx.state.acceptedSessionSpawns.push(acceptedSessionSpawn);
  }
  ctx.state.toolMetaById.delete(toolCallId);
  ctx.state.toolSummaryById.delete(toolCallId);
  if (isToolError) {
    const errorMessage = extractToolErrorMessage(sanitizedResult);
    const errorCode = extractToolErrorCode(sanitizedResult);
    ctx.state.lastToolError = {
      toolName,
      meta,
      ...(errorCode ? { errorCode } : {}),
      error: errorMessage,
      timedOut: isToolResultTimedOut(sanitizedResult) || undefined,
      middlewareError: isMiddlewareToolResultError(sanitizedResult) || undefined,
      mutatingAction: callSummary?.mutatingAction,
      actionFingerprint: callSummary?.actionFingerprint,
      fileTarget: callSummary?.fileTarget,
    };
  } else if (ctx.state.lastToolError) {
    // Keep unresolved mutating failures until the same action succeeds.
    if (ctx.state.lastToolError.mutatingAction) {
      if (
        isSameToolMutationAction(ctx.state.lastToolError, {
          toolName,
          meta,
          actionFingerprint: callSummary?.actionFingerprint,
          fileTarget: callSummary?.fileTarget,
        })
      ) {
        ctx.state.lastToolError = undefined;
      }
    } else {
      ctx.state.lastToolError = undefined;
    }
  }
  if (asyncStarted) {
    ctx.state.hadDeterministicSideEffect = true;
  }
  if (completedMutatingAction || acceptedSessionSpawn || asyncStarted) {
    ctx.state.replayState = mergeEmbeddedRunReplayState(ctx.state.replayState, {
      replayInvalid: true,
      hadPotentialSideEffects: true,
    });
  }

  // Commit messaging tool evidence on success, discard on error.
  const pendingText = ctx.state.pendingMessagingTexts.get(toolCallId);
  const pendingTarget = ctx.state.pendingMessagingTargets.get(toolCallId);
  const pendingMediaUrls = ctx.state.pendingMessagingMediaUrls.get(toolCallId) ?? [];
  const startArgs =
    startData?.args && typeof startData.args === "object"
      ? (startData.args as Record<string, unknown>)
      : {};
  const isMessagingSend =
    pendingMediaUrls.length > 0 ||
    (isMessagingTool(toolName) && isMessagingToolSendAction(toolName, startArgs));
  const committedMediaUrls =
    !isToolError && isMessagingSend
      ? [...pendingMediaUrls, ...collectMessagingMediaUrlsFromToolResult(result)]
      : [];
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
      ctx.state.messagingToolSentTargets.push({
        ...pendingTarget,
        ...(pendingText ? { text: pendingText } : {}),
        ...(committedMediaUrls.length > 0 ? { mediaUrls: committedMediaUrls.slice() } : {}),
      });
      ctx.trimMessagingToolSent();
    }
  }
  ctx.state.pendingMessagingMediaUrls.delete(toolCallId);
  if (!isToolError && isMessagingSend) {
    if (committedMediaUrls.length > 0) {
      ctx.state.messagingToolSentMediaUrls.push(...committedMediaUrls);
      ctx.trimMessagingToolSent();
    }
    const sourceReplyPayload = extractMessagingToolSourceReplyPayload(result);
    if (sourceReplyPayload) {
      ctx.state.messagingToolSourceReplyPayloads.push(sourceReplyPayload);
      ctx.trimMessagingToolSent();
    }
  }

  // Track committed reminders only when cron.add completed successfully.
  if (!isToolError && toolName === "cron" && isCronAddAction(startData?.args)) {
    ctx.state.successfulCronAdds += 1;
  }
  if (!isToolError && toolName === HEARTBEAT_RESPONSE_TOOL_NAME) {
    const details =
      result && typeof result === "object" ? (result as { details?: unknown }).details : undefined;
    const response = normalizeHeartbeatToolResponse(details);
    if (response) {
      const isFirstHeartbeatResponse = ctx.state.heartbeatToolResponse === undefined;
      ctx.state.heartbeatToolResponse = response;
      if (isFirstHeartbeatResponse) {
        void ctx.params.onHeartbeatToolResponse?.(response);
      }
    }
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
      result: eventResult,
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
    // Use sanitizedResult so `aggregated` is redacted before reaching command_output.
    const execDetails = readExecToolDetails(sanitizedResult);
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
      const output = extractLiveExecOutput(eventResult);
      const rawOutput = extractExecOutput(sanitizedResult);
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

      if (typeof rawOutput === "string") {
        const parsedApprovalResult = parseExecApprovalResultText(rawOutput);
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
    const patchSummary = readApplyPatchSummary(sanitizedResult);
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
      .catch((err: unknown) => {
        ctx.log.warn(`after_tool_call hook failed: tool=${toolName} error=${String(err)}`);
      });
  }
}
