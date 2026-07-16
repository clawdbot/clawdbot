/**
 * Handles embedded-agent tool execution events and turns them into channel UI,
 * replay state, hook calls, approval prompts, media queues, and agent-event
 * telemetry.
 */
import {
  asOptionalObjectRecord,
  asOptionalRecord as readRecordField,
} from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  HEARTBEAT_RESPONSE_TOOL_NAME,
  normalizeHeartbeatToolResponse,
} from "../auto-reply/heartbeat-tool-response.js";
import { type AgentPlanStep, normalizeAgentPlanSteps } from "../channels/streaming.js";
import { parseSessionThreadInfoFast } from "../config/sessions/thread-info.js";
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
import { consumeRootOptionToken } from "../infra/cli-root-options.js";
import type { ExecApprovalDecision } from "../infra/exec-approvals.js";
import {
  parseInteractiveParam,
  parseJsonMessageParam,
} from "../infra/outbound/message-action-params.js";
import { hasReplyPayloadContent } from "../interactive/payload.js";
import type { PluginHookAfterToolCallEvent } from "../plugins/types.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { hasTopLevelShellControlOperator, splitShellArgs } from "../utils/shell-argv.js";
import { normalizeAcceptedSessionSpawnResult } from "./accepted-session-spawn.js";
import {
  consumeAdjustedParamsForToolCall,
  consumePreExecutionBlockedToolCall,
  consumeStructuredReplaySafeToolCall,
  consumeTrackedToolExecutionStarted,
} from "./agent-tools.before-tool-call.state.js";
import { REQUIRED_PARAM_GROUPS, type RequiredParamGroup } from "./agent-tools.params.js";
import type { ApplyPatchSummary } from "./apply-patch.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import { sanitizeForConsole } from "./console-sanitize.js";
import { normalizeTextForComparison } from "./embedded-agent-helpers.js";
import {
  isDeliveredMessageToolOnlySourceReplyResult,
  isDeliveredMessagingToolResult,
} from "./embedded-agent-message-tool-source-reply.js";
import {
  isMessagingTool,
  isMessagingToolSendAction,
  isMessagingToolTargetEvidenceAction,
} from "./embedded-agent-messaging.js";
import { mergeEmbeddedRunReplayState } from "./embedded-agent-runner/replay-state.js";
import { runBestEffortCallback } from "./embedded-agent-subscribe.callback.js";
import type {
  ToolCallSummary,
  ToolHandlerContext,
} from "./embedded-agent-subscribe.handlers.types.js";
import { isPromiseLike } from "./embedded-agent-subscribe.promise.js";
import {
  collectMessagingMediaUrlsFromRecord,
  collectMessagingMediaUrlsFromToolResult,
  capLiveExecResult,
  extractMessagingToolSourceReplyPayload,
  extractToolResultMediaArtifact,
  extractToolErrorCode,
  extractMessagingToolSend,
  extractMessagingToolSendResult,
  extractToolErrorMessage,
  extractToolResultText,
  filterToolResultMediaUrls,
  isToolResultError,
  isToolResultTimedOut,
  sanitizeToolArgs,
  sanitizeToolResult,
  truncateLiveExecOutput,
} from "./embedded-agent-subscribe.tools.js";
import { inferToolMetaFromArgs } from "./embedded-agent-utils.js";
import { parseExecApprovalResultText } from "./exec-approval-result.js";
import type { AgentEvent } from "./runtime/index.js";
import {
  createToolValidationErrorSummary,
  summarizeToolValidationError,
} from "./tool-error-summary.js";
import { buildToolMutationState } from "./tool-mutation.js";
import { normalizeToolName } from "./tool-policy.js";
import { readToolResultDetails } from "./tool-result-error.js";
import { createToolTerminalObserver } from "./tool-terminal-outcome.js";

type ExecApprovalReplyModule = typeof import("../infra/exec-approval-reply.js");
type HookRunnerGlobalModule = typeof import("../plugins/hook-runner-global.js");
type ChannelToolProgress = {
  text: string;
};

const execApprovalReplyModuleLoader = createLazyImportLoader<ExecApprovalReplyModule>(
  () => import("../infra/exec-approval-reply.js"),
);
const hookRunnerGlobalModuleLoader = createLazyImportLoader<HookRunnerGlobalModule>(
  () => import("../plugins/hook-runner-global.js"),
);
const fallbackToolTerminalObservers = new WeakMap<
  ToolHandlerContext["state"],
  ReturnType<typeof createToolTerminalObserver>
>();

function resolveFallbackToolTerminalObserver(ctx: ToolHandlerContext) {
  const existing = fallbackToolTerminalObservers.get(ctx.state);
  if (existing) {
    return existing;
  }
  const created = createToolTerminalObserver(ctx.params.runId);
  fallbackToolTerminalObservers.set(ctx.state, created);
  return created;
}
const LIVE_EXEC_UPDATE_MIN_INTERVAL_MS = 250;
const TRACE_REQUIRED_PARAM_GROUPS = {
  read: [{ keys: ["path", "file_path"], label: "path" }],
  write: REQUIRED_PARAM_GROUPS.write,
  edit: REQUIRED_PARAM_GROUPS.edit,
} satisfies Record<string, readonly RequiredParamGroup[]>;

function readUpdatePlanResult(
  result: unknown,
): { explanation?: string; steps: AgentPlanStep[] } | undefined {
  const details = readToolResultDetails(result);
  if (details?.status !== "updated" || !Array.isArray(details.plan)) {
    return undefined;
  }
  const steps = normalizeAgentPlanSteps(details.plan) ?? [];
  const explanation = readStringValue(details.explanation);
  return { ...(explanation ? { explanation } : {}), steps };
}

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
const toolStartData = new Map<string, ToolStartRecord>();

function buildToolStartKey(runId: string, toolCallId: string): string {
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

function isCronAddAction(args: unknown): boolean {
  if (!args || typeof args !== "object") {
    return false;
  }
  const action = (args as Record<string, unknown>).action;
  return normalizeOptionalLowercaseString(action) === "add";
}

function buildToolCallSummary(
  toolName: string,
  args: unknown,
  meta: string | undefined,
  instanceReplaySafe: boolean,
  structuredReplaySafe: boolean,
): ToolCallSummary {
  const mutation = buildToolMutationState(toolName, args, meta);
  return {
    meta,
    instanceReplaySafe,
    mutatingAction: mutation.mutatingAction,
    replaySafe:
      (instanceReplaySafe && !mutation.mutatingAction) ||
      (structuredReplaySafe && mutation.replaySafe),
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

function emitAgentEventCallbackBestEffort(
  ctx: ToolHandlerContext,
  event: Parameters<NonNullable<ToolHandlerContext["params"]["onAgentEvent"]>>[0],
): void {
  runBestEffortCallback({
    label: "tool agent event",
    log: ctx.log,
    callback: () => ctx.params.onAgentEvent?.(event),
  });
}

function applyCurrentMessageProvider(
  toolName: string,
  args: Record<string, unknown>,
  currentProvider: string | undefined,
): Record<string, unknown> {
  if (
    toolName !== "message" ||
    readStringValue(args.provider) ||
    readStringValue(args.channel) ||
    !currentProvider
  ) {
    return args;
  }
  return { ...args, provider: currentProvider };
}

function applyToolSendReceiptForExtraction(result: unknown, receiptResult: unknown): unknown {
  const toolSend = readToolResultDetails(receiptResult)?.toolSend;
  if (toolSend === undefined) {
    return result;
  }
  return {
    ...readRecordField(result),
    details: {
      ...readToolResultDetails(result),
      toolSend,
    },
  };
}

function isAsyncStartedToolResult(result: unknown): boolean {
  const details = readToolResultDetails(result);
  return details?.async === true && details.status === "started";
}

function readAsyncStartedTaskIds(result: unknown): {
  asyncTaskRunId?: string;
  asyncTaskId?: string;
} {
  const details = readToolResultDetails(result);
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
  const details = readToolResultDetails(result);
  if (!details || typeof details.status !== "string") {
    return null;
  }
  return details as ExecToolDetails;
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

function isOpenClawExecutable(token: string | undefined): boolean {
  const executable = normalizeOptionalLowercaseString(token);
  return executable?.split(/[\\/]/).at(-1) === "openclaw";
}

function isOpenClawPackageSpec(token: string | undefined): boolean {
  const packageSpec = normalizeOptionalLowercaseString(token);
  return packageSpec?.startsWith("openclaw@") === true && packageSpec.length > "openclaw@".length;
}

function skipOpenClawPackageRunner(
  tokens: string[],
  startIndex: number,
): { commandIndex: number; acceptsPackageSpec: boolean } {
  let commandIndex = startIndex;
  let acceptsPackageSpec = false;
  let runner = normalizeOptionalLowercaseString(tokens[commandIndex]);
  if (
    runner === "corepack" &&
    normalizeOptionalLowercaseString(tokens[commandIndex + 1]) === "pnpm"
  ) {
    commandIndex += 1;
    runner = "pnpm";
  }
  if (runner === "pnpm") {
    const subcommand = normalizeOptionalLowercaseString(tokens[commandIndex + 1]);
    if (subcommand === "exec" || subcommand === "dlx") {
      commandIndex += 2;
      acceptsPackageSpec = subcommand === "dlx";
    } else {
      commandIndex = startIndex;
    }
  } else if (runner === "npx" || runner === "bunx") {
    commandIndex += 1;
    acceptsPackageSpec = true;
    while (true) {
      const option = normalizeOptionalLowercaseString(tokens[commandIndex]);
      if (
        option === "-y" ||
        option === "--yes" ||
        option === "--no-install" ||
        option === "--bun"
      ) {
        commandIndex += 1;
        continue;
      }
      if (option === "-p" || option === "--package") {
        commandIndex += 2;
        continue;
      }
      if (option?.startsWith("--package=") || option?.startsWith("--yes=")) {
        commandIndex += 1;
        continue;
      }
      break;
    }
  }
  if (tokens[commandIndex] === "--") {
    commandIndex += 1;
  }
  return { commandIndex, acceptsPackageSpec };
}

function isOpenClawCronAddShellCommand(args: unknown): boolean {
  const record = asOptionalObjectRecord(args);
  const command = readStringValue(record?.command) ?? readStringValue(record?.cmd);
  if (!command || hasTopLevelShellControlOperator(command)) {
    return false;
  }
  const tokens = splitShellArgs(command);
  if (!tokens || tokens.length < 3) {
    return false;
  }

  // Compound shell programs need a real shell AST; only count direct CLI invocations.
  let commandIndex = 0;
  if (normalizeOptionalLowercaseString(tokens[commandIndex]) === "env") {
    commandIndex += 1;
  }
  while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[commandIndex] ?? "")) {
    commandIndex += 1;
  }
  const packageRunner = skipOpenClawPackageRunner(tokens, commandIndex);
  commandIndex = packageRunner.commandIndex;

  let cliArgIndex = commandIndex + 1;
  for (
    let consumed = consumeRootOptionToken(tokens, cliArgIndex);
    consumed > 0;
    consumed = consumeRootOptionToken(tokens, cliArgIndex)
  ) {
    cliArgIndex += consumed;
  }
  const action = normalizeOptionalLowercaseString(tokens[cliArgIndex + 1]);
  const actionArgs = tokens.slice(cliArgIndex + 2);
  return (
    (isOpenClawExecutable(tokens[commandIndex]) ||
      (packageRunner.acceptsPackageSpec && isOpenClawPackageSpec(tokens[commandIndex]))) &&
    normalizeOptionalLowercaseString(tokens[cliArgIndex]) === "cron" &&
    (action === "add" || action === "create") &&
    !actionArgs.some((token) => token === "-h" || token === "--help")
  );
}

function didShellCronAddSucceed(args: unknown, result: unknown): boolean {
  if (!isOpenClawCronAddShellCommand(args)) {
    return false;
  }
  const details = readExecToolDetails(result);
  return details?.status === "completed" && details.exitCode === 0;
}

function readChannelToolProgress(result: unknown): ChannelToolProgress | undefined {
  const progress = readRecordField(asOptionalObjectRecord(result)?.progress);
  // Only typed progress crosses into UI; tool output/details may contain private data.
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
  const details = readToolResultDetails(result);
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

function readMessagingText(record: Record<string, unknown>): string | undefined {
  for (const key of ["content", "message", "text", "body"]) {
    const value = readStringValue(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function hasMessagingRichContent(record: Record<string, unknown>): boolean {
  const payload = {
    presentation: record.presentation,
    interactive: record.interactive,
    channelData: record.channelData,
  };
  try {
    parseJsonMessageParam(payload, "presentation");
    parseInteractiveParam(payload);
  } catch {
    return false;
  }
  return hasReplyPayloadContent(payload);
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
  host?: "gateway" | "node";
  nodeId?: string;
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
    host: details.host === "gateway" || details.host === "node" ? details.host : undefined,
    nodeId: readStringValue(details.nodeId),
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
      const { buildTypedExecApprovalPendingReplyPayload } = await loadExecApprovalReply();
      await ctx.params.onToolResult(
        buildTypedExecApprovalPendingReplyPayload({
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
          host: approvalUnavailable.host,
          nodeId: approvalUnavailable.nodeId,
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
  const continueAfterBlockReplyFlush = (): void | Promise<void> => {
    const onBlockReplyFlushResult = ctx.params.onBlockReplyFlush?.({
      reason: "tool_start",
      assistantMessageIndex: ctx.state.assistantMessageIndex,
    });
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
      inferToolMetaFromArgs(toolName, args, {
        detailMode: ctx.params.toolProgressDetail ?? "explain",
      }),
    );
    const instanceReplaySafe =
      evt.replaySafe === true ||
      ctx.params.replaySafeToolNames?.has(rawToolName) === true ||
      ctx.params.replaySafeToolNames?.has(toolName) === true;
    ctx.state.toolMetaById.set(
      toolCallId,
      buildToolCallSummary(toolName, args, meta, instanceReplaySafe, false),
    );
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
      toolCallId,
      startedAt,
      ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
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
  };

  // Flush pending block replies to preserve message boundaries before tool execution.
  const flushBlockReplyBufferResult = ctx.flushBlockReplyBuffer();
  if (isPromiseLike<void>(flushBlockReplyBufferResult)) {
    return flushBlockReplyBufferResult.then(() => continueAfterBlockReplyFlush());
  }
  return continueAfterBlockReplyFlush();
}

/** Handles partial tool output and emits throttled live UI updates. */
export function handleToolExecutionUpdate(
  ctx: ToolHandlerContext,
  evt: AgentEvent & {
    toolName: string;
    toolCallId: string;
    partialResult?: unknown;
    hideFromChannelProgress?: boolean;
  },
) {
  const toolName = normalizeToolName(evt.toolName);
  const toolCallId = evt.toolCallId;
  const hideFromChannelProgress = evt.hideFromChannelProgress === true;
  const partial = evt.partialResult;
  const sanitized = sanitizeToolResult(partial);
  const isExecTool = isExecToolName(toolName);
  const liveResult = isExecTool ? capLiveExecResult(sanitized) : sanitized;
  const toolProgress = isExecTool ? undefined : readChannelToolProgress(liveResult);
  // Typed progress already has a sanitized path; suppress duplicate raw previews.
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
        ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
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
    ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
    ...(toolProgress
      ? { progressText: toolProgress.text }
      : { meta: ctx.state.toolMetaById.get(toolCallId)?.meta }),
  };
  emitTrackedItemEvent(ctx, itemData);
  if (!toolProgress) {
    emitAgentEventCallbackBestEffort(ctx, {
      stream: "tool",
      data: {
        phase: "update",
        name: toolName,
        toolCallId,
        ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
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
      emitAgentEventCallbackBestEffort(ctx, {
        stream: "command_output",
        data: outputData,
      });
    }
  }
}

/** Handles a tool-execution result and commits replay, media, hook, and error state. */
export async function handleToolExecutionEnd(
  ctx: ToolHandlerContext,
  evt: Extract<AgentEvent, { type: "tool_execution_end" }>,
) {
  const rawToolName = evt.toolName;
  const toolName = normalizeToolName(rawToolName);
  const hideFromChannelProgress = evt.hideFromChannelProgress === true;
  const toolCallId = evt.toolCallId;
  const runId = ctx.params.runId;
  const isError = evt.isError;
  const result = evt.result;
  const toolSendReceiptResult = ctx.consumeToolSendReceipt?.(toolCallId);
  const observerIsError = isError || isToolResultError(result);
  const sanitizedResult = sanitizeToolResult(result);
  const approvalUnavailable =
    isExecToolName(toolName) &&
    readExecToolDetails(sanitizedResult)?.status === "approval-unavailable";
  const isToolError = observerIsError && !approvalUnavailable;
  try {
    ctx.params.onAgentToolResult?.({
      toolName,
      result: sanitizedResult,
      isError: observerIsError,
    });
  } catch (error) {
    ctx.log.warn(`onAgentToolResult handler failed: tool=${toolName} error=${String(error)}`);
  }
  const eventResult = isExecToolName(toolName)
    ? capLiveExecResult(sanitizedResult)
    : sanitizedResult;
  const toolStartKey = buildToolStartKey(runId, toolCallId);
  const startData = toolStartData.get(toolStartKey);
  toolStartData.delete(toolStartKey);
  ctx.state.execLiveUpdateStateById?.delete(toolCallId);
  const initialCallSummary = ctx.state.toolMetaById.get(toolCallId);
  const initialArgs =
    startData?.args && typeof startData.args === "object"
      ? (startData.args as Record<string, unknown>)
      : {};
  const adjustedArgs = consumeAdjustedParamsForToolCall(toolCallId, runId);
  const trackedExecutionStarted = consumeTrackedToolExecutionStarted(toolCallId, runId);
  const executionPrevented = consumePreExecutionBlockedToolCall(toolCallId, runId);
  const structuredReplaySafe = consumeStructuredReplaySafeToolCall(toolCallId, runId);
  const startArgs =
    adjustedArgs && typeof adjustedArgs === "object"
      ? (adjustedArgs as Record<string, unknown>)
      : initialArgs;
  const callSummary = buildToolCallSummary(
    toolName,
    startArgs,
    initialCallSummary?.meta,
    initialCallSummary?.instanceReplaySafe === true,
    structuredReplaySafe,
  );
  // A racing observer can consume the active wrapper boundary. Settled and
  // custom producers use their terminal fact, while policy blocks override it.
  const executionStarted =
    (trackedExecutionStarted ?? evt.executionStarted ?? true) && !executionPrevented;
  const attemptedPotentialSideEffect = !callSummary.replaySafe && executionStarted;
  const meta = callSummary.meta;
  const asyncStarted = !isToolError && isAsyncStartedToolResult(sanitizedResult);
  const asyncTaskIds = asyncStarted ? readAsyncStartedTaskIds(sanitizedResult) : {};
  ctx.state.toolMetas.push({
    toolName,
    meta,
    replaySafe: callSummary.replaySafe,
    ...(isToolError ? { isError: true } : {}),
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
  const errorMessage = isToolError ? extractToolErrorMessage(sanitizedResult) : undefined;
  const errorCode = isToolError ? extractToolErrorCode(sanitizedResult) : undefined;
  const validationErrorSummary =
    isToolError && evt.executionStarted === false && evt.errorKind === "argument-validation"
      ? createToolValidationErrorSummary(toolName)
      : undefined;
  const terminal = (ctx.params.observeToolTerminal ?? resolveFallbackToolTerminalObserver(ctx))({
    toolCallId,
    toolName,
    arguments: startArgs,
    ...(meta ? { meta } : {}),
    executionStarted,
    outcome: isToolError ? "failure" : "success",
    ...(isToolError
      ? {
          failure: {
            ...(errorCode ? { errorCode } : {}),
            ...(errorMessage ? { error: errorMessage } : {}),
            ...(validationErrorSummary ? { validationErrorSummary } : {}),
            timedOut: isToolResultTimedOut(sanitizedResult) || undefined,
            middlewareError: isMiddlewareToolResultError(sanitizedResult) || undefined,
          },
        }
      : {}),
  });
  ctx.state.lastToolError = terminal.lastToolError;
  const toolErrorSummary = ctx.state.lastToolError
    ? summarizeToolValidationError(ctx.state.lastToolError)
    : undefined;
  if (asyncStarted) {
    ctx.state.hadDeterministicSideEffect = true;
  }
  if (attemptedPotentialSideEffect || acceptedSessionSpawn || asyncStarted) {
    ctx.state.replayState = mergeEmbeddedRunReplayState(ctx.state.replayState, {
      replayInvalid: true,
      hadPotentialSideEffects: true,
    });
  }

  // Commit messaging tool evidence on success, discard on error.
  const messagingArgs = applyCurrentMessageProvider(toolName, startArgs, ctx.params.messageChannel);
  const isMessagingInvocation = isMessagingTool(toolName);
  const isMessagingSend = isMessagingInvocation && isMessagingToolSendAction(toolName, startArgs);
  const hasMessagingTargetEvidence =
    isMessagingInvocation && isMessagingToolTargetEvidenceAction(toolName, startArgs);
  const didDeliverMessagingResult =
    isMessagingInvocation &&
    isDeliveredMessagingToolResult({
      toolName,
      args: startArgs,
      result,
      hookResult: toolSendReceiptResult,
      isError: isToolError,
    });
  const messageText = isMessagingSend ? readMessagingText(startArgs) : undefined;
  const argumentMediaUrls = isMessagingSend ? collectMessagingMediaUrlsFromRecord(startArgs) : [];
  const hasRichContent = isMessagingSend && hasMessagingRichContent(startArgs);
  const messageTarget = hasMessagingTargetEvidence
    ? extractMessagingToolSend(toolName, messagingArgs, {
        config: ctx.params.config,
        currentChannelId: ctx.params.currentChannelId,
        currentMessagingTarget: ctx.params.currentMessagingTarget,
        currentThreadId:
          ctx.params.currentThreadId ?? parseSessionThreadInfoFast(ctx.params.sessionKey).threadId,
        currentMessageId: ctx.params.currentMessageId,
        replyToMode: ctx.params.replyToMode,
        hasRepliedRef: startData?.hasRepliedRef,
      })
    : undefined;
  const committedMediaUrls =
    didDeliverMessagingResult && isMessagingSend
      ? [...argumentMediaUrls, ...collectMessagingMediaUrlsFromToolResult(result)]
      : [];
  ctx.state.pendingMessagingTexts.delete(toolCallId);
  ctx.state.pendingMessagingTargets.delete(toolCallId);
  ctx.state.pendingMessagingMediaUrls.delete(toolCallId);
  if (didDeliverMessagingResult && messageText) {
    ctx.state.messagingToolSentTexts.push(messageText);
    ctx.state.messagingToolSentTextsNormalized.push(normalizeTextForComparison(messageText));
    ctx.log.debug(`Committed messaging text: tool=${toolName} len=${messageText.length}`);
    ctx.trimMessagingToolSent();
  }
  if (didDeliverMessagingResult && messageTarget) {
    const extractionResult = applyToolSendReceiptForExtraction(result, toolSendReceiptResult);
    const confirmedTarget = extractMessagingToolSendResult(messageTarget, extractionResult);
    ctx.state.messagingToolSentTargets.push({
      ...confirmedTarget,
      ...(messageText ? { text: messageText } : {}),
      ...(committedMediaUrls.length > 0 ? { mediaUrls: committedMediaUrls.slice() } : {}),
      ...(hasRichContent ? { hasRichContent: true as const } : {}),
    });
    ctx.trimMessagingToolSent();
  }
  if (didDeliverMessagingResult && isMessagingSend) {
    if (committedMediaUrls.length > 0) {
      ctx.state.messagingToolSentMediaUrls.push(...committedMediaUrls);
      ctx.trimMessagingToolSent();
    }
    if (
      isDeliveredMessageToolOnlySourceReplyResult({
        sourceReplyDeliveryMode: ctx.params.sourceReplyDeliveryMode,
        toolName,
        args: startArgs,
        result,
        isError: isToolError,
      })
    ) {
      ctx.state.messageToolOnlySourceReplyDelivered = true;
      ctx.params.onDeliveredMessageToolOnlySourceReply?.();
    }
    const sourceReplyPayload = extractMessagingToolSourceReplyPayload(result);
    if (sourceReplyPayload) {
      ctx.state.messagingToolSourceReplyPayloads.push(sourceReplyPayload);
      ctx.trimMessagingToolSent();
    }
  }
  // Track committed reminders only when cron.add completed successfully.
  if (
    !isToolError &&
    ((toolName === "cron" && isCronAddAction(startArgs)) ||
      (isExecToolName(toolName) && didShellCronAddSucceed(startArgs, result)))
  ) {
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
        runBestEffortCallback({
          label: "heartbeat tool response",
          log: ctx.log,
          callback: () => ctx.params.onHeartbeatToolResponse?.(response),
        });
      }
    }
  }

  const planUpdate =
    !isToolError && toolName === "update_plan" ? readUpdatePlanResult(sanitizedResult) : undefined;
  if (planUpdate) {
    const planEvent = {
      stream: "plan" as const,
      data: {
        phase: "update",
        title: "Plan updated",
        source: "openclaw",
        ...planUpdate,
      },
    };
    emitAgentEvent({ runId: ctx.params.runId, ...planEvent });
    emitAgentEventCallbackBestEffort(ctx, planEvent);
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
      ...(toolErrorSummary ? { toolErrorSummary } : {}),
      ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
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
    ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
    ...(isToolError && extractToolErrorMessage(sanitizedResult)
      ? { error: extractToolErrorMessage(sanitizedResult) }
      : {}),
  };
  emitTrackedItemEvent(ctx, itemData);
  emitAgentEventCallbackBestEffort(ctx, {
    stream: "tool",
    data: {
      phase: "result",
      name: toolName,
      toolCallId,
      meta,
      isError: isToolError,
      ...(toolErrorSummary ? { toolErrorSummary } : {}),
      ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
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
      emitAgentEventCallbackBestEffort(ctx, {
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
      emitAgentEventCallbackBestEffort(ctx, {
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
          emitAgentEventCallbackBestEffort(ctx, {
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
      emitAgentEventCallbackBestEffort(ctx, {
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
  await Promise.resolve(ctx.params.onToolStreamBoundary?.()).catch((error: unknown) => {
    ctx.log.debug(`embedded run tool stream boundary callback failed: ${String(error)}`);
  });

  // Run after_tool_call plugin hook (fire-and-forget)
  const hookRunnerAfter = ctx.hookRunner ?? (await loadHookRunnerGlobal()).getGlobalHookRunner();
  if (hookRunnerAfter?.hasHooks("after_tool_call")) {
    const durationMs = startData?.startTime != null ? Date.now() - startData.startTime : undefined;
    const hookEvent: PluginHookAfterToolCallEvent = {
      toolName,
      params: startArgs,
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
