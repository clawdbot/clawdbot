/**
 * Builds embedded-agent payload objects from attempt inputs and outcomes.
 */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { SourceReplyDeliveryMode } from "../../../auto-reply/get-reply-options.types.js";
import {
  createHeartbeatToolResponsePayload,
  type HeartbeatToolResponse,
} from "../../../auto-reply/heartbeat-tool-response.js";
import {
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
  type ReplyPayload,
  type ReplyPayloadMetadata,
} from "../../../auto-reply/reply-payload.js";
import { parseReplyDirectives } from "../../../auto-reply/reply/reply-directives.js";
import type { ReasoningLevel, ThinkLevel, VerboseLevel } from "../../../auto-reply/thinking.js";
import { isSilentReplyPayloadText, SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { formatToolAggregate } from "../../../auto-reply/tool-meta.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { hasReplyPayloadContent } from "../../../interactive/payload.js";
import type { AssistantMessage } from "../../../llm/types.js";
import { isCronSessionKey } from "../../../routing/session-key.js";
import {
  extractAssistantTextForPhase,
  parseAssistantTextSignature,
} from "../../../shared/chat-message-content.js";
import {
  sanitizeAssistantFinalAnswerText,
  sanitizeAssistantVisibleText,
} from "../../../shared/text/assistant-visible-text.js";
import { parseInlineDirectives } from "../../../utils/directive-tags.js";
import {
  BILLING_ERROR_USER_MESSAGE,
  formatAssistantErrorText,
  formatRawAssistantErrorForUi,
  formatUserFacingAssistantErrorText,
  getApiErrorPayloadFingerprint,
  isRawApiErrorPayload,
  normalizeTextForComparison,
} from "../../embedded-agent-helpers.js";
import type {
  MessagingToolSend,
  MessagingToolSourceReplyPayload,
} from "../../embedded-agent-messaging.types.js";
import type { ToolResultFormat } from "../../embedded-agent-subscribe.shared-types.js";
import {
  extractAssistantThinking,
  extractAssistantVisibleText,
  sanitizeAssistantVisibleStreamText,
} from "../../embedded-agent-utils.js";
import { isExecLikeToolName, type ToolErrorSummary } from "../../tool-error-summary.js";
import { isLikelyMutatingToolName } from "../../tool-mutation.js";
import { buildSourceReplyPayloadState } from "./source-reply-payloads.js";

type ToolMetaEntry = { toolName: string; meta?: string };
type ToolErrorWarningPolicy = {
  showWarning: boolean;
  includeDetails: boolean;
};

const RECOVERABLE_TOOL_ERROR_KEYWORDS = [
  "required",
  "missing",
  "invalid",
  "must be",
  "must have",
  "needs",
  "requires",
] as const;

const MUTATING_FAILURE_ACTION_PATTERN =
  "(?:write|edit|update|save|create|delete|remove|modify|change|apply|patch|move|rename|send|reply|message|run|execute|execution|command|script|shell|bash|exec|tool|action|operation)";

const MUTATING_FAILURE_INABILITY_PATTERN = new RegExp(
  `\\b(?:couldn't|could not|can't|cannot|unable to|am unable to|wasn't able to|was not able to|were unable to)\\b.{0,100}\\b${MUTATING_FAILURE_ACTION_PATTERN}\\b`,
  "u",
);
const MUTATING_FAILURE_ACTION_THEN_FAILURE_PATTERN = new RegExp(
  `\\b${MUTATING_FAILURE_ACTION_PATTERN}\\b.{0,100}\\b(?:failed|failure|errored)\\b`,
  "u",
);
const MUTATING_FAILURE_FAILURE_THEN_ACTION_PATTERN = new RegExp(
  `\\b(?:failed|failure)\\b.{0,100}\\b${MUTATING_FAILURE_ACTION_PATTERN}\\b`,
  "u",
);
const MUTATING_FAILURE_ERROR_WHILE_ACTION_PATTERN = new RegExp(
  `\\b(?:hit|encountered|ran into)\\b.{0,60}\\berror\\b.{0,100}\\b(?:while|trying to|when)\\b.{0,100}\\b${MUTATING_FAILURE_ACTION_PATTERN}\\b`,
  "u",
);
const DID_NOT_FAIL_PATTERN = /\b(?:did not|didn't)\s+fail\b/u;
const NEGATED_FAILURE_PATTERN = /\b(?:no|not|without)\s+(?:failures?|errors?)\b/u;

function isRecoverableToolError(error: string | undefined): boolean {
  const errorLower = normalizeOptionalLowercaseString(error) ?? "";
  return RECOVERABLE_TOOL_ERROR_KEYWORDS.some((keyword) => errorLower.includes(keyword));
}

function hasExplicitMutatingToolFailureAcknowledgement(text: string): boolean {
  const normalizedText = normalizeTextForComparison(text);
  if (!normalizedText) {
    return false;
  }
  if (DID_NOT_FAIL_PATTERN.test(normalizedText)) {
    return false;
  }
  if (MUTATING_FAILURE_INABILITY_PATTERN.test(normalizedText)) {
    return true;
  }
  if (NEGATED_FAILURE_PATTERN.test(normalizedText)) {
    return false;
  }
  return (
    MUTATING_FAILURE_ACTION_THEN_FAILURE_PATTERN.test(normalizedText) ||
    MUTATING_FAILURE_FAILURE_THEN_ACTION_PATTERN.test(normalizedText) ||
    MUTATING_FAILURE_ERROR_WHILE_ACTION_PATTERN.test(normalizedText)
  );
}

function isVerboseToolDetailEnabled(level?: VerboseLevel): boolean {
  return level === "full";
}

function isAssistantTextContentBlockType(value: unknown): boolean {
  return value === "text" || value === "input_text" || value === "output_text";
}

function resolveRawAssistantAnswerText(lastAssistant: AssistantMessage | undefined): string {
  if (!lastAssistant) {
    return "";
  }
  const finalAnswerText = extractAssistantTextForPhase(lastAssistant, {
    phase: "final_answer",
    sanitizeText: sanitizeAssistantFinalAnswerText,
  });
  if (finalAnswerText) {
    return normalizeOptionalString(finalAnswerText) ?? "";
  }
  if (Array.isArray(lastAssistant.content)) {
    const hasExplicitPhasedTextBlock = lastAssistant.content.some((block) => {
      if (!block || typeof block !== "object") {
        return false;
      }
      const record = block as { type?: unknown; textSignature?: unknown };
      return (
        isAssistantTextContentBlockType(record.type) &&
        Boolean(parseAssistantTextSignature(record.textSignature)?.phase)
      );
    });
    if (!hasExplicitPhasedTextBlock) {
      const signedUnphasedParts = lastAssistant.content
        .map((block) => {
          if (!block || typeof block !== "object") {
            return null;
          }
          const record = block as { type?: unknown; text?: unknown; textSignature?: unknown };
          const signature = parseAssistantTextSignature(record.textSignature);
          if (
            !isAssistantTextContentBlockType(record.type) ||
            typeof record.text !== "string" ||
            !signature?.id ||
            signature.phase
          ) {
            return null;
          }
          const text = sanitizeAssistantFinalAnswerText(record.text);
          return text.trim() ? text : null;
        })
        .filter((value): value is string => typeof value === "string");
      if (signedUnphasedParts.length) {
        return normalizeOptionalString(signedUnphasedParts.join("\n")) ?? "";
      }
    }
  }
  return (
    normalizeOptionalString(
      extractAssistantTextForPhase(lastAssistant, {
        sanitizeText: sanitizeAssistantVisibleText,
      }),
    ) ?? ""
  );
}

function normalizeReplyTextForComparison(text: string): string {
  return normalizeTextForComparison(parseReplyDirectives(text).text ?? "");
}

function shouldIncludeToolErrorDetails(params: {
  lastToolError: ToolErrorSummary;
  isCronTrigger?: boolean;
  isHeartbeatTrigger?: boolean;
  sessionKey: string;
  verboseLevel?: VerboseLevel;
}): boolean {
  if (isVerboseToolDetailEnabled(params.verboseLevel)) {
    return true;
  }
  if (!isExecLikeToolName(params.lastToolError.toolName)) {
    return false;
  }
  // Heartbeat runs usually have no assistant reply to carry the command
  // output, so keep exec details in the warning instead of a generic label.
  if (params.isHeartbeatTrigger === true) {
    return true;
  }
  return (
    params.lastToolError.timedOut === true &&
    (params.isCronTrigger === true || isCronSessionKey(params.sessionKey))
  );
}

function shouldMarkNonTerminalToolErrorWarning(lastToolError: ToolErrorSummary): boolean {
  return lastToolError.middlewareError === true;
}

function formatToolErrorWarningText(params: {
  lastToolError: ToolErrorSummary;
  includeDetails: boolean;
  useMarkdown: boolean;
}): string {
  if (isExecLikeToolName(params.lastToolError.toolName)) {
    const toolLabel = formatToolAggregate(params.lastToolError.toolName, undefined, {
      markdown: params.useMarkdown,
    });
    const subject = formatExecLikeFailureSubject(params.lastToolError.meta, params.useMarkdown);
    const conciseExitSuffix = params.includeDetails
      ? ""
      : formatConciseExecExitSuffix(params.lastToolError.error);
    const errorSuffix =
      params.includeDetails && params.lastToolError.error ? `: ${params.lastToolError.error}` : "";
    return subject
      ? `⚠️ ${toolLabel} failed: ${subject}${conciseExitSuffix}${errorSuffix}`
      : `⚠️ ${toolLabel} failed${conciseExitSuffix}${errorSuffix}`;
  }

  const toolSummary = formatToolAggregate(
    params.lastToolError.toolName,
    params.lastToolError.meta ? [params.lastToolError.meta] : undefined,
    { markdown: params.useMarkdown },
  );
  const errorSuffix =
    params.includeDetails && params.lastToolError.error ? `: ${params.lastToolError.error}` : "";
  return `⚠️ ${toolSummary} failed${errorSuffix}`;
}

function formatExecLikeFailureSubject(meta: string | undefined, markdown: boolean): string {
  const normalized = normalizeOptionalString(meta);
  if (!normalized) {
    return "";
  }

  const { flags, body } = splitExecLikeFailureMeta(normalized);
  if (!body) {
    return flags.join(" · ");
  }

  const { text, suffix } = splitDisplayContextSuffix(body);
  const literalCommand = extractLiteralExecCommand(text);
  const subject = `${maybeWrapInlineCode(literalCommand ?? text, markdown)}${suffix}`;
  return flags.length > 0 ? `${flags.join(" · ")} · ${subject}` : subject;
}

function splitExecLikeFailureMeta(meta: string): { flags: string[]; body: string } {
  const flags: string[] = [];
  const bodyParts: string[] = [];
  for (const part of meta
    .split(" · ")
    .map((candidate) => candidate.trim())
    .filter(Boolean)) {
    if (part === "elevated" || part === "pty") {
      flags.push(part);
      continue;
    }
    bodyParts.push(part);
  }
  return { flags, body: bodyParts.join(" · ") };
}

const SEMANTIC_RUN_SUMMARIES = new Set(["tests", "build", "lint", "script", "command"]);
const LITERAL_RUN_SUMMARY_PREFIXES = new Set([
  "python",
  "python3",
  "ruby",
  "php",
  "git",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "openclaw",
  "make",
  "cargo",
  "go",
  "docker",
  "npx",
  "uv",
  "poetry",
  "pytest",
  "vitest",
  "jest",
  "deno",
]);

function extractLiteralExecCommand(body: string): string | undefined {
  const rawCommand = extractRawExecCommand(body);
  if (rawCommand) {
    return rawCommand;
  }

  const nodeScript = body.match(/^run node script (.+)$/u);
  if (nodeScript?.[1]) {
    return `node ${nodeScript[1]}`;
  }

  const runSubject = body.match(/^run (.+)$/u)?.[1];
  if (runSubject && isKnownLiteralRunSummary(runSubject)) {
    return runSubject;
  }

  return undefined;
}

type RawExecContext = {
  leading: string[];
  trailing: string[];
};

function extractRawExecCommand(body: string): string | undefined {
  const codeSpan = extractTrailingMarkdownCodeSpan(body);
  if (!codeSpan) {
    return undefined;
  }
  const context = extractRawExecContext(codeSpan.prefix, codeSpan.value);
  const command = context.trailing.reduce((value, suffix) => `${value} ${suffix}`, codeSpan.value);
  return context.leading.length > 0 ? `${context.leading.join(" · ")} · ${command}` : command;
}

function extractTrailingMarkdownCodeSpan(
  body: string,
): { prefix: string | undefined; value: string } | undefined {
  const trimmed = body.trimEnd();
  if (!trimmed.endsWith("`")) {
    return undefined;
  }
  let delimiterLength = 0;
  for (let index = trimmed.length - 1; index >= 0 && trimmed[index] === "`"; index -= 1) {
    delimiterLength += 1;
  }
  const delimiter = "`".repeat(delimiterLength);
  const valueEnd = trimmed.length - delimiterLength;
  let searchIndex = 0;
  while (searchIndex < valueEnd) {
    const openIndex = trimmed.indexOf(delimiter, searchIndex);
    if (openIndex < 0 || openIndex >= valueEnd) {
      return undefined;
    }
    const prefixMatch = trimmed.slice(0, openIndex).match(/^(?:(.*)(?:,\s*| · ))?$/u);
    if (prefixMatch) {
      return {
        prefix: prefixMatch[1],
        value: unwrapMarkdownInlineCodePadding(
          trimmed.slice(openIndex + delimiterLength, valueEnd),
        ),
      };
    }
    searchIndex = openIndex + delimiterLength;
  }
  return undefined;
}

function unwrapMarkdownInlineCodePadding(value: string): string {
  if (value.length < 2 || !value.startsWith(" ") || !value.endsWith(" ")) {
    return value;
  }
  const unwrapped = value.slice(1, -1);
  return /\S/u.test(unwrapped) ? unwrapped : value;
}
function extractRawExecContext(prefix: string | undefined, inlineCode: string): RawExecContext {
  const value = prefix ?? "";
  const leading = [...value.matchAll(/(?:^|,\s*| · )(node:\s*[^,·]+)(?=,\s*| · |$)/gu)]
    .map((match) => match[1]?.trim())
    .filter((part): part is string => Boolean(part));
  const trailing = [
    ...value.matchAll(
      /(\((?:agent|repo|sandbox|workspace)\)|\(in [^)\r\n]+\))(?=\s*(?:,\s*| · |$))/gu,
    ),
  ]
    .filter((match) => shouldKeepRawExecTrailingContext(value, match, inlineCode))
    .map((match) => match[1]?.trim())
    .filter((part): part is string => Boolean(part));
  return { leading, trailing };
}
function shouldKeepRawExecTrailingContext(
  prefix: string,
  match: RegExpMatchArray,
  inlineCode: string,
): boolean {
  const suffix = match[1]?.trim();
  if (!suffix || inlineCode.includes(suffix)) {
    return false;
  }
  const segment = prefix
    .slice(0, match.index ?? 0)
    .trimEnd()
    .split(/,\s*| · /u)
    .at(-1)
    ?.trim();
  const segmentCommand = segment ? extractLiteralExecCommand(segment) : undefined;
  if (segmentCommand === inlineCode || segment === inlineCode) {
    return true;
  }
  if (isCompactCwdSuffix(suffix)) {
    return true;
  }
  return isPathLikeCwdSuffix(suffix);
}
function isCompactCwdSuffix(suffix: string): boolean {
  return /^\((?:agent|repo|workspace)\)$/u.test(suffix);
}
function isPathLikeCwdSuffix(suffix: string): boolean {
  const cwd = suffix.match(/^\(in ([^)\r\n]+)\)$/u)?.[1]?.trim();
  return Boolean(
    cwd && (/^(?:\/|~|\.{1,2}(?:\/|$)|[A-Za-z]:[\\/]|\\\\)/u.test(cwd) || cwd.includes("/")),
  );
}
function isKnownLiteralRunSummary(subject: string): boolean {
  if (
    SEMANTIC_RUN_SUMMARIES.has(subject) ||
    subject.includes("→") ||
    subject.includes("->") ||
    /^(?:node|python3?|ruby|php) inline script(?: \(heredoc\))?$/u.test(subject)
  ) {
    return false;
  }
  const match = subject.match(/^(\S+)\s+(.+)$/u);
  const command = match?.[1];
  const remainder = match?.[2];
  if (!command || !remainder || remainder === "command") {
    return false;
  }
  return LITERAL_RUN_SUMMARY_PREFIXES.has(command);
}
function splitDisplayContextSuffix(value: string): { text: string; suffix: string } {
  const match = /^(.*?)( \((?:agent|repo|workspace|sandbox)\))$/u.exec(value);
  if (!match) {
    return { text: value, suffix: "" };
  }
  return { text: match[1] ?? value, suffix: match[2] ?? "" };
}
function formatConciseExecExitSuffix(error: string | undefined): string {
  const normalized = normalizeOptionalString(error);
  const code = normalized?.match(
    /\b(?:command\s+)?(?:failed\s+with\s+exit\s+code|exited\s+with\s+code|exit(?:ed)?\s+code|exit\s+status)\s+(-?\d+)\b/iu,
  )?.[1];
  return code ? ` (exit ${code})` : "";
}
function maybeWrapInlineCode(value: string, markdown: boolean): string {
  if (!markdown) {
    return value;
  }
  const delimiter = "`".repeat(longestBacktickRun(value) + 1);
  const padding = value.startsWith("`") || value.endsWith("`") || value.includes("\n") ? " " : "";
  return `${delimiter}${padding}${value}${padding}${delimiter}`;
}
function longestBacktickRun(value: string): number {
  let longest = 0;
  let current = 0;
  for (const char of value) {
    if (char === "`") {
      current += 1;
      longest = Math.max(longest, current);
      continue;
    }
    current = 0;
  }
  return longest;
}
/**
 * Chooses whether a tool failure needs a separate user-visible warning and
 * whether to include raw details. Mutating failures are stricter because a
 * silent failed write/send/delete can make the assistant look successful.
 */
function resolveToolErrorWarningPolicy(params: {
  lastToolError: ToolErrorSummary;
  hasUserFacingReply: boolean;
  hasUserFacingErrorReply: boolean;
  hasUserFacingFailureAcknowledgement: boolean;
  suppressToolErrors: boolean;
  suppressToolErrorWarnings?: boolean | (() => boolean | undefined);
  isCronTrigger?: boolean;
  isHeartbeatTrigger?: boolean;
  sessionKey: string;
  verboseLevel?: VerboseLevel;
}): ToolErrorWarningPolicy {
  const normalizedToolName = normalizeOptionalLowercaseString(params.lastToolError.toolName) ?? "";
  let toolErrorWarningOverride: boolean | undefined;
  let dynamicToolErrorWarningsDisabled = false;
  if (typeof params.suppressToolErrorWarnings === "function") {
    toolErrorWarningOverride = params.suppressToolErrorWarnings();
    dynamicToolErrorWarningsDisabled = toolErrorWarningOverride === false;
  } else {
    toolErrorWarningOverride = params.suppressToolErrorWarnings;
  }
  const includeDetails = shouldIncludeToolErrorDetails({
    ...params,
    verboseLevel: dynamicToolErrorWarningsDisabled ? "off" : params.verboseLevel,
  });
  const suppressToolErrorWarnings = toolErrorWarningOverride === true;
  if (suppressToolErrorWarnings) {
    return { showWarning: false, includeDetails };
  }
  // sessions_send timeouts and errors are transient inter-session communication
  // issues — the message may still have been delivered. Suppress warnings to
  // prevent raw error text from leaking into the chat surface (#23989).
  if (normalizedToolName === "sessions_send") {
    return { showWarning: false, includeDetails };
  }
  if (params.suppressToolErrors) {
    return { showWarning: false, includeDetails };
  }
  // Mutating branch protects "assistant claims success while a user-visible mutation
  // silently failed". Shell/exec are the agent's own workspace actions: the model sees
  // the exit code in-context, and a successful final reply is recovery proof (#103574).
  // Deliberately ignores mutatingAction for exec: codex marks every commandExecution
  // mutating fail-closed (replay metadata, not display signal).
  if (isExecLikeToolName(params.lastToolError.toolName)) {
    // No recoverable-keyword suppression here: with no reply at all, the exec
    // warning may be the run's only failure signal.
    return { showWarning: !params.hasUserFacingReply, includeDetails };
  }
  const isMutatingToolError =
    params.lastToolError.mutatingAction ?? isLikelyMutatingToolName(params.lastToolError.toolName);
  if (isMutatingToolError) {
    return {
      showWarning: !params.hasUserFacingErrorReply && !params.hasUserFacingFailureAcknowledgement,
      includeDetails,
    };
  }
  return {
    showWarning: !params.hasUserFacingReply && !isRecoverableToolError(params.lastToolError.error),
    includeDetails,
  };
}
/**
 * Converts a completed embedded attempt into reply payloads for channels. This
 * is the boundary that suppresses duplicate source replies, filters raw API
 * errors, preserves directive metadata, and decides when tool failures must be
 * surfaced to the user.
 */
export function buildEmbeddedRunPayloads(params: {
  assistantTexts: string[];
  assistantMessageIndex?: number;
  assistantTranscriptOwned?: boolean;
  toolMetas: ToolMetaEntry[];
  lastAssistant: AssistantMessage | undefined;
  currentAssistant?: AssistantMessage | null;
  lastToolError?: ToolErrorSummary;
  config?: OpenClawConfig;
  isCronTrigger?: boolean;
  isHeartbeatTrigger?: boolean;
  sessionKey: string;
  provider?: string;
  model?: string;
  /** Credential auth mode for billing copy (#80877). */
  authMode?: string;
  verboseLevel?: VerboseLevel;
  reasoningLevel?: ReasoningLevel;
  thinkingLevel?: ThinkLevel;
  toolResultFormat?: ToolResultFormat;
  suppressToolErrorWarnings?: boolean | (() => boolean | undefined);
  inlineToolResultsAllowed: boolean;
  didSendViaMessagingTool?: boolean;
  didDeliverSourceReplyViaMessageTool?: boolean;
  messagingToolSentTargets?: MessagingToolSend[];
  messagingToolSourceReplyPayloads?: MessagingToolSourceReplyPayload[];
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  agentId?: string;
  runId?: string;
  runAborted?: boolean;
  didSendDeterministicApprovalPrompt?: boolean;
  heartbeatToolResponse?: HeartbeatToolResponse;
}): ReplyPayload[] {
  if (params.heartbeatToolResponse) {
    return [createHeartbeatToolResponsePayload(params.heartbeatToolResponse)];
  }
  // Internal source replies always need transcript/UI mirrors. Only a
  // message_tool_only run suppresses the separate automatic final answer.
  const {
    replyItems,
    hasSourceReplyPayload,
    deliveredSourceReplyViaMessageTool,
    explicitFinalSourceReply,
    completedSourceReplyViaMessageTool,
  } = buildSourceReplyPayloadState({
    payloads: params.messagingToolSourceReplyPayloads,
    sentTargets: params.messagingToolSentTargets,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    didDeliverSourceReplyViaMessageTool: params.didDeliverSourceReplyViaMessageTool,
    runId: params.runId,
  });
  const useMarkdown = params.toolResultFormat === "markdown";
  const suppressAssistantArtifacts =
    params.didSendDeterministicApprovalPrompt === true ||
    (params.sourceReplyDeliveryMode === "message_tool_only" && hasSourceReplyPayload) ||
    deliveredSourceReplyViaMessageTool;
  const suppressFailureArtifacts =
    params.didSendDeterministicApprovalPrompt === true ||
    (params.sourceReplyDeliveryMode === "message_tool_only" && completedSourceReplyViaMessageTool);
  const nonEmptyAssistantTexts = params.assistantTexts
    .map((text) => sanitizeAssistantVisibleStreamText(text))
    .filter((text) => text.trim().length > 0);
  const currentAssistant = params.currentAssistant ?? undefined;
  const assistantForPayload =
    currentAssistant ?? (nonEmptyAssistantTexts.length === 1 ? undefined : params.lastAssistant);
  const lastAssistantStopReason = assistantForPayload?.stopReason;
  const lastAssistantErrored = lastAssistantStopReason === "error";
  const lastAssistantAborted = lastAssistantStopReason === "aborted";
  const runAborted = params.runAborted === true || lastAssistantAborted;
  const lastAssistantNeedsErrorSurface = lastAssistantErrored || lastAssistantAborted;
  const rawErrorMessage = lastAssistantNeedsErrorSurface
    ? normalizeOptionalString(assistantForPayload?.errorMessage)
    : undefined;
  const errorText =
    assistantForPayload && lastAssistantNeedsErrorSurface
      ? suppressFailureArtifacts
        ? undefined
        : lastAssistantErrored || rawErrorMessage
          ? formatUserFacingAssistantErrorText(assistantForPayload, {
              cfg: params.config,
              sessionKey: params.sessionKey,
              provider: params.provider,
              model: params.model,
              authMode: params.authMode,
            })
          : formatAssistantErrorText(assistantForPayload, {
              cfg: params.config,
              sessionKey: params.sessionKey,
              provider: params.provider,
              model: params.model,
              authMode: params.authMode,
            })
      : undefined;
  const rawErrorFingerprint = rawErrorMessage
    ? getApiErrorPayloadFingerprint(rawErrorMessage)
    : null;
  const formattedRawErrorMessage = rawErrorMessage
    ? formatRawAssistantErrorForUi(rawErrorMessage)
    : null;
  const normalizedFormattedRawErrorMessage = formattedRawErrorMessage
    ? normalizeTextForComparison(formattedRawErrorMessage)
    : null;
  const normalizedRawErrorText = rawErrorMessage
    ? normalizeTextForComparison(rawErrorMessage)
    : null;
  const normalizedErrorText = errorText ? normalizeTextForComparison(errorText) : null;
  const normalizedGenericBillingErrorText = normalizeTextForComparison(BILLING_ERROR_USER_MESSAGE);
  const genericErrorText = "The AI service returned an error. Please try again.";
  if (errorText) {
    replyItems.push({ text: errorText, isError: true });
  }
  const inlineToolResults =
    params.inlineToolResultsAllowed && params.verboseLevel !== "off" && params.toolMetas.length > 0;
  if (inlineToolResults) {
    for (const { toolName, meta } of params.toolMetas) {
      const agg = formatToolAggregate(toolName, meta ? [meta] : [], {
        markdown: useMarkdown,
      });
      const parsedAggregate = parseInlineDirectives(agg, {
        stripAudioTag: true,
        stripReplyTags: true,
      });
      const cleanedText = parsedAggregate.text;
      if (cleanedText) {
        replyItems.push({
          text: cleanedText,
          audioAsVoice: parsedAggregate.audioAsVoice,
          replyToId: parsedAggregate.replyToId,
          replyToTag: parsedAggregate.hasReplyTag,
          replyToCurrent: parsedAggregate.replyToCurrent,
        });
      }
    }
  }
  const reasoningText =
    suppressAssistantArtifacts || runAborted
      ? ""
      : assistantForPayload && params.reasoningLevel === "on" && params.thinkingLevel !== "off"
        ? extractAssistantThinking(assistantForPayload)
        : "";
  if (reasoningText) {
    replyItems.push({ text: reasoningText, isReasoning: true });
  }
  const fallbackAnswerText = assistantForPayload
    ? extractAssistantVisibleText(assistantForPayload)
    : "";
  const fallbackRawAnswerText = resolveRawAssistantAnswerText(assistantForPayload);
  const shouldSuppressRawErrorText = (text: string) => {
    if (!lastAssistantNeedsErrorSurface) {
      return false;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }
    if (errorText) {
      const normalized = normalizeTextForComparison(trimmed);
      if (normalized && normalizedErrorText && normalized === normalizedErrorText) {
        return true;
      }
      if (trimmed === genericErrorText) {
        return true;
      }
      if (
        normalized &&
        normalizedGenericBillingErrorText &&
        normalized === normalizedGenericBillingErrorText
      ) {
        return true;
      }
    }
    if (rawErrorMessage && trimmed === rawErrorMessage) {
      return true;
    }
    if (formattedRawErrorMessage && trimmed === formattedRawErrorMessage) {
      return true;
    }
    if (normalizedRawErrorText) {
      const normalized = normalizeTextForComparison(trimmed);
      if (normalized && normalized === normalizedRawErrorText) {
        return true;
      }
    }
    if (normalizedFormattedRawErrorMessage) {
      const normalized = normalizeTextForComparison(trimmed);
      if (normalized && normalized === normalizedFormattedRawErrorMessage) {
        return true;
      }
    }
    if (rawErrorFingerprint) {
      const fingerprint = getApiErrorPayloadFingerprint(trimmed);
      if (fingerprint && fingerprint === rawErrorFingerprint) {
        return true;
      }
    }
    return isRawApiErrorPayload(trimmed);
  };
  const rawAnswerDirectiveState = fallbackRawAnswerText
    ? parseReplyDirectives(fallbackRawAnswerText)
    : null;
  const rawAnswerHasMedia =
    (rawAnswerDirectiveState?.mediaUrls?.length ?? 0) > 0 || rawAnswerDirectiveState?.audioAsVoice;
  const assistantTextsHaveMedia = params.assistantTexts.some((text) => {
    const parsed = parseReplyDirectives(text);
    return (parsed.mediaUrls?.length ?? 0) > 0 || parsed.audioAsVoice;
  });
  const normalizedAssistantTexts = normalizeTextForComparison(nonEmptyAssistantTexts.join("\n\n"));
  const normalizedRawAnswerText = normalizeTextForComparison(rawAnswerDirectiveState?.text ?? "");
  const shouldPreferRawAnswerText =
    rawAnswerHasMedia &&
    (!nonEmptyAssistantTexts.length ||
      (!assistantTextsHaveMedia &&
        normalizedAssistantTexts.length > 0 &&
        normalizedAssistantTexts === normalizedRawAnswerText));
  // When streamed text lost media directives but the canonical assistant answer
  // still contains them, keep the raw answer so attachments are not dropped.
  const fallbackAnswerSourceText =
    shouldPreferRawAnswerText && fallbackRawAnswerText ? fallbackRawAnswerText : fallbackAnswerText;
  const normalizedFallbackAnswerSourceText = fallbackAnswerSourceText
    ? normalizeReplyTextForComparison(fallbackAnswerSourceText)
    : "";
  const shouldUseCanonicalFinalAnswer =
    !lastAssistantNeedsErrorSurface &&
    fallbackAnswerSourceText.length > 0 &&
    normalizedFallbackAnswerSourceText.length > 0;
  const hasAssistantTextPayload = nonEmptyAssistantTexts.length > 0;
  const answerTexts =
    suppressAssistantArtifacts || runAborted
      ? []
      : (shouldUseCanonicalFinalAnswer
          ? [fallbackAnswerSourceText]
          : shouldPreferRawAnswerText && fallbackRawAnswerText
            ? [fallbackRawAnswerText]
            : hasAssistantTextPayload
              ? nonEmptyAssistantTexts
              : fallbackAnswerText
                ? [fallbackAnswerText]
                : []
        ).filter((text) => !shouldSuppressRawErrorText(text));
  let hasUserFacingAssistantReply = completedSourceReplyViaMessageTool;
  const hasUserFacingErrorReply = replyItems.some((item) => item.isError === true);
  let hasUserFacingFailureAcknowledgement = false;
  for (const text of answerTexts) {
    const {
      text: cleanedText,
      mediaUrls,
      audioAsVoice,
      replyToId,
      replyToTag,
      replyToCurrent,
    } = parseReplyDirectives(text);
    if (!cleanedText && (!mediaUrls || mediaUrls.length === 0) && !audioAsVoice) {
      continue;
    }
    replyItems.push({
      text: cleanedText,
      media: mediaUrls,
      audioAsVoice,
      replyToId,
      replyToTag,
      replyToCurrent,
    });
    hasUserFacingAssistantReply = true;
    if (cleanedText && hasExplicitMutatingToolFailureAcknowledgement(cleanedText)) {
      hasUserFacingFailureAcknowledgement = true;
    }
  }
  if (params.lastToolError) {
    const warningPolicy = resolveToolErrorWarningPolicy({
      lastToolError: params.lastToolError,
      hasUserFacingReply: hasUserFacingAssistantReply,
      hasUserFacingErrorReply,
      hasUserFacingFailureAcknowledgement,
      suppressToolErrors: Boolean(params.config?.messages?.suppressToolErrors),
      suppressToolErrorWarnings: params.suppressToolErrorWarnings,
      isCronTrigger: params.isCronTrigger,
      isHeartbeatTrigger: params.isHeartbeatTrigger,
      sessionKey: params.sessionKey,
      verboseLevel: params.verboseLevel,
    });
    // Surface mutating failures unless the assistant explicitly acknowledged the failed action.
    // Otherwise, keep the previous behavior and only surface non-recoverable failures when no reply exists.
    if (warningPolicy.showWarning) {
      const warningText = formatToolErrorWarningText({
        lastToolError: params.lastToolError,
        includeDetails: warningPolicy.includeDetails,
        useMarkdown,
      });
      const normalizedWarning = normalizeTextForComparison(warningText);
      const duplicateWarning = normalizedWarning
        ? replyItems.some((item) => {
            if (!item.text) {
              return false;
            }
            const normalizedExisting = normalizeTextForComparison(item.text);
            return normalizedExisting.length > 0 && normalizedExisting === normalizedWarning;
          })
        : false;
      if (!duplicateWarning) {
        replyItems.push({
          text: warningText,
          isError: true,
          nonTerminalToolErrorWarning:
            hasUserFacingAssistantReply &&
            shouldMarkNonTerminalToolErrorWarning(params.lastToolError),
        });
      }
    }
  }
  const hasAudioAsVoiceTag = replyItems.some((item) => item.audioAsVoice);
  return replyItems
    .map((item) => {
      const payload: ReplyPayload = {
        text: normalizeOptionalString(item.text),
      };
      const mediaUrl = item.mediaUrl ?? item.media?.[0];
      if (mediaUrl) {
        payload.mediaUrl = mediaUrl;
      }
      if (item.media?.length) {
        payload.mediaUrls = item.media;
      }
      if (item.isError !== undefined) {
        payload.isError = item.isError;
      }
      if (
        item.isError === true &&
        params.sourceReplyDeliveryMode === "message_tool_only" &&
        explicitFinalSourceReply === false
      ) {
        markReplyPayloadForSourceSuppressionDelivery(payload);
      }
      if (item.nonTerminalToolErrorWarning) {
        setReplyPayloadMetadata(payload, {
          nonTerminalToolErrorWarning: true,
        });
      }
      if (
        !item.isError &&
        !item.isReasoning &&
        (params.assistantMessageIndex !== undefined || params.assistantTranscriptOwned === true)
      ) {
        setReplyPayloadMetadata(payload, {
          ...(params.assistantMessageIndex !== undefined
            ? { assistantMessageIndex: params.assistantMessageIndex }
            : {}),
          ...(params.assistantTranscriptOwned === true ? { assistantTranscriptOwned: true } : {}),
        });
      }
      if (item.replyToId) {
        payload.replyToId = item.replyToId;
      }
      if (item.replyToTag !== undefined) {
        payload.replyToTag = item.replyToTag;
      }
      if (item.replyToCurrent !== undefined) {
        payload.replyToCurrent = item.replyToCurrent;
      }
      if (item.audioAsVoice || Boolean(hasAudioAsVoiceTag && item.media?.length)) {
        payload.audioAsVoice = true;
      }
      if (item.presentation) {
        payload.presentation = item.presentation;
      }
      if (item.interactive) {
        payload.interactive = item.interactive;
      }
      if (item.channelData) {
        payload.channelData = item.channelData;
      }
      if (item.sourceReplyMirror) {
        // Source-reply mirrors are transcript artifacts, not channel sends.
        markReplyPayloadForSourceSuppressionDelivery(payload);
        if (params.sessionKey) {
          const sourceReplyTranscriptMirror: NonNullable<
            ReplyPayloadMetadata["sourceReplyTranscriptMirror"]
          > = {
            sessionKey: params.sessionKey,
          };
          if (params.agentId) {
            sourceReplyTranscriptMirror.agentId = params.agentId;
          }
          if (payload.text) {
            sourceReplyTranscriptMirror.text = payload.text;
          }
          if (payload.mediaUrls?.length) {
            sourceReplyTranscriptMirror.mediaUrls = payload.mediaUrls;
          }
          if (item.sourceReplyMirror.idempotencyKey) {
            sourceReplyTranscriptMirror.idempotencyKey = item.sourceReplyMirror.idempotencyKey;
          }
          setReplyPayloadMetadata(payload, {
            sourceReplyTranscriptMirror,
          });
        }
      }
      if (payload.text && isSilentReplyPayloadText(payload.text, SILENT_REPLY_TOKEN)) {
        const silentText = payload.text;
        payload.text = undefined;
        if (hasReplyPayloadContent(payload)) {
          return payload;
        }
        payload.text = silentText;
      }
      return payload;
    })
    .filter((p) => {
      if (!hasReplyPayloadContent(p)) {
        return false;
      }
      if (p.text && isSilentReplyPayloadText(p.text, SILENT_REPLY_TOKEN)) {
        return false;
      }
      return true;
    });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
