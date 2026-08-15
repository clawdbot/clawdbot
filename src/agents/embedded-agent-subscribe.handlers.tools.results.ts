import {
  asOptionalObjectRecord,
  asOptionalRecord as readRecordField,
} from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { type AgentPlanStep, normalizeAgentPlanSteps } from "../channels/streaming.js";
import { consumeRootOptionToken } from "../infra/cli-root-options.js";
import type { ExecApprovalDecision } from "../infra/exec-approvals.js";
import {
  parseInteractiveParam,
  parseJsonMessageParam,
} from "../infra/outbound/message-action-params.js";
import { hasReplyPayloadContent } from "../interactive/payload.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { hasTopLevelShellControlOperator, splitShellArgs } from "../utils/shell-argv.js";
import type { ApplyPatchSummary } from "./apply-patch.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import type { ToolHandlerContext } from "./embedded-agent-subscribe.handlers.types.js";
import {
  extractToolResultMediaArtifact,
  filterToolResultMediaUrls,
} from "./embedded-agent-tool-media.js";
import { extractToolResultText, truncateLiveExecOutput } from "./embedded-agent-tool-results.js";
import type { ProcessTerminalDiagnostic } from "./tool-error-summary.js";
import { readToolResultDetails } from "./tool-result-error.js";
import { createToolTerminalObserver } from "./tool-terminal-outcome.js";

type ExecApprovalReplyModule = typeof import("../infra/exec-approval-reply.js");

type HookRunnerGlobalModule = typeof import("../plugins/hook-runner-global.js");

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

export function resolveFallbackToolTerminalObserver(ctx: ToolHandlerContext) {
  const existing = fallbackToolTerminalObservers.get(ctx.state);
  if (existing) {
    return existing;
  }
  const created = createToolTerminalObserver(ctx.params.runId);
  fallbackToolTerminalObservers.set(ctx.state, created);
  return created;
}

export function readUpdatePlanResult(
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

export function isMiddlewareToolResultError(result: unknown): boolean {
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

export function hasTerminalControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

const PROCESS_TERMINATION_REASONS = new Set([
  "manual-cancel",
  "overall-timeout",
  "no-output-timeout",
  "spawn-error",
  "signal",
  "exit",
]);

function readSafeProcessSessionId(value: unknown): string | undefined {
  const sessionId = readStringValue(value)?.trim();
  if (!sessionId || sessionId.length > 160 || hasTerminalControlCharacter(sessionId)) {
    return undefined;
  }
  return sessionId;
}

export function buildProcessTerminalDiagnostic(
  toolName: string,
  args: Record<string, unknown>,
  sanitizedResult: unknown,
): ProcessTerminalDiagnostic | undefined {
  if (toolName !== "process") {
    return undefined;
  }
  const action = normalizeOptionalLowercaseString(args.action);
  if (action !== "poll" && action !== "log") {
    return undefined;
  }
  const details = readToolResultDetails(sanitizedResult);
  const sessionId = readSafeProcessSessionId(details?.sessionId);
  if (!sessionId) {
    return undefined;
  }

  const exitReason = normalizeOptionalLowercaseString(details?.exitReason);
  const hasCanonicalExitReason = PROCESS_TERMINATION_REASONS.has(exitReason ?? "");
  if (action === "log" && !hasCanonicalExitReason) {
    return undefined;
  }
  const timeoutKind =
    exitReason === "overall-timeout" || exitReason === "no-output-timeout" ? exitReason : undefined;
  let reason: ProcessTerminalDiagnostic["reason"] | undefined;
  if (details?.timedOut === true || timeoutKind) {
    reason = { kind: "timeout", ...(timeoutKind ? { timeoutKind } : {}) };
  } else if (
    (typeof details?.exitSignal === "string" &&
      details.exitSignal.trim().length > 0 &&
      details.exitSignal.trim().length <= 32) ||
    (typeof details?.exitSignal === "number" && Number.isFinite(details.exitSignal))
  ) {
    const signal =
      typeof details.exitSignal === "string" ? details.exitSignal.trim() : details.exitSignal;
    if (!hasTerminalControlCharacter(String(signal))) {
      reason = { kind: "signal", signal };
    }
  } else if (
    typeof details?.exitCode === "number" &&
    Number.isSafeInteger(details.exitCode) &&
    details.exitCode !== 0
  ) {
    reason = { kind: "exit", exitCode: details.exitCode };
  }
  if (!reason) {
    return undefined;
  }

  return {
    kind: "process",
    sessionId,
    reason,
  };
}

function loadExecApprovalReply(): Promise<ExecApprovalReplyModule> {
  return execApprovalReplyModuleLoader.load();
}

export function loadHookRunnerGlobal(): Promise<HookRunnerGlobalModule> {
  return hookRunnerGlobalModuleLoader.load();
}

export function isCronAddAction(args: unknown): boolean {
  if (!args || typeof args !== "object") {
    return false;
  }
  const action = (args as Record<string, unknown>).action;
  return normalizeOptionalLowercaseString(action) === "add";
}

export function applyCurrentMessageProvider(
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

export function applyToolSendReceiptForExtraction(
  result: unknown,
  receiptResult: unknown,
): unknown {
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

export function isAsyncStartedToolResult(result: unknown): boolean {
  const details = readToolResultDetails(result);
  return details?.async === true && details.status === "started";
}

/**
 * Whether a tool result is a pending approval prompt awaiting a human decision. This is a
 * lighter sibling of readExecApprovalPendingDetails below: that extracts the full payload
 * needed to render the prompt message, while callers that only need the yes/no continuation
 * fact (e.g. CLI-backed yield tracking, which has no reason to render the prompt itself) can
 * use this instead of duplicating the field shape.
 *
 * Deliberately excludes "approval-unavailable": that status is an error/no-approval-route
 * outcome, not a future completion, so it must never count as continuation evidence — a
 * yield right after one still has no automatic wake and needs the no-continuation diagnostic.
 */
export function isPendingApprovalToolResult(result: unknown): boolean {
  const details = readToolResultDetails(result);
  return details?.status === "approval-pending";
}

export function readAsyncStartedTaskIds(result: unknown): {
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

export function readExecToolDetails(result: unknown): ExecToolDetails | null {
  const details = readToolResultDetails(result);
  if (!details || typeof details.status !== "string") {
    return null;
  }
  return details as ExecToolDetails;
}

export function extractExecOutput(result: unknown): string | undefined {
  const execDetails = readExecToolDetails(result);
  const output =
    execDetails && "aggregated" in execDetails
      ? execDetails.aggregated
      : extractToolResultText(result);
  return typeof output === "string" ? output : undefined;
}

export function extractLiveExecOutput(result: unknown): string | undefined {
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
    (normalizeOptionalLowercaseString(tokens[cliArgIndex]) === "cron" ||
      normalizeOptionalLowercaseString(tokens[cliArgIndex]) === "automations") &&
    (action === "add" || action === "create") &&
    !actionArgs.some((token) => token === "-h" || token === "--help")
  );
}

export function didShellCronAddSucceed(args: unknown, result: unknown): boolean {
  if (!isOpenClawCronAddShellCommand(args)) {
    return false;
  }
  const details = readExecToolDetails(result);
  return details?.status === "completed" && details.exitCode === 0;
}

export function readApplyPatchSummary(result: unknown): ApplyPatchSummary | null {
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

export function buildPatchSummaryText(summary: ApplyPatchSummary): string {
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

export function readMessagingText(record: Record<string, unknown>): string | undefined {
  for (const key of ["content", "message", "text", "body"]) {
    const value = readStringValue(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function hasMessagingRichContent(record: Record<string, unknown>): boolean {
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
  const seen = new Set(ctx.state.pendingToolMediaUrls.map((url) => url.trim()));
  for (const mediaUrl of mediaReply.mediaUrls) {
    const normalized = mediaUrl.trim();
    if (!normalized) {
      continue;
    }
    if (mediaReply.trustedLocalMedia) {
      ctx.state.pendingToolMediaTrustByUrl.set(normalized, true);
    } else if (!ctx.state.pendingToolMediaTrustByUrl.has(normalized)) {
      ctx.state.pendingToolMediaTrustByUrl.set(normalized, false);
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ctx.state.pendingToolMediaUrls.push(normalized);
  }
  if (mediaReply.audioAsVoice) {
    ctx.state.pendingToolAudioAsVoice = true;
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

export async function emitToolResultOutput(params: {
  ctx: ToolHandlerContext;
  toolName: string;
  rawToolName: string;
  meta?: string;
  isToolError: boolean;
  result: unknown;
  sanitizedResult: unknown;
}) {
  const { ctx, toolName, rawToolName, meta, isToolError, result, sanitizedResult } = params;
  const recordApprovalPromptDeliveryFailure = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    ctx.log.warn(`failed to deliver exec approval prompt: ${message}`);
    const approvalMeta = meta ? `${meta} · approval prompt delivery` : "approval prompt delivery";
    const terminal = (ctx.params.observeToolTerminal ?? resolveFallbackToolTerminalObserver(ctx))({
      toolName,
      meta: approvalMeta,
      executionStarted: false,
      outcome: "failure",
      failure: { error: `Approval prompt delivery failed: ${message}` },
    });
    ctx.state.lastToolError = terminal.lastToolError;
    ctx.state.lastToolRecovery = terminal.lastToolRecovery;
    ctx.state.deterministicApprovalPromptSent = false;
  };
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
    } catch (error) {
      recordApprovalPromptDeliveryFailure(error);
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
    } catch (error) {
      recordApprovalPromptDeliveryFailure(error);
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
