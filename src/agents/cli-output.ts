/**
 * Parses output from CLI-backed model providers. It supports plain text, JSON,
 * JSONL streaming, Claude stream-json dialects, usage metadata, and tool event
 * reconstruction.
 */
import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  createReasoningTagTextPartitioner,
  scanReasoningTags,
  type ReasoningTagTextDelta,
} from "../../packages/markdown-core/src/reasoning-tags.js";
import type { AgentPlanStep } from "../channels/streaming.js";
import { formatErrorMessage } from "../infra/errors.js";
import type {
  CliBackendConfig,
  CliBackendParseJsonlEvent,
  CliBackendParsedJsonlEvent,
} from "../plugins/cli-backend.types.js";
import { extractBalancedJsonFragments } from "../shared/balanced-json.js";
import type {
  MessagingToolSend,
  MessagingToolSourceReplyPayload,
} from "./embedded-agent-messaging.types.js";
import type { ToolSummaryTrace } from "./embedded-agent-runner/types.js";

export type CliUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

type CliProcessDiagnostics = {
  backendId: string;
  processReason: string;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | number | null;
  durationMs: number;
  stdoutBytes: number;
  stdoutHash: string;
  stderrBytes: number;
  stderrHash: string;
  useResume: boolean;
};

type CliTerminalFailure = {
  reason: "max_turns";
  limit?: number;
};

/** Normalized result from a CLI-backed model provider turn. */
export type CliOutput = {
  text: string;
  rawText?: string;
  sessionId?: string;
  /** Backend-owned assistant boundary that can safely anchor a later resumed fork. */
  resumeCheckpointId?: string;
  usage?: CliUsage;
  /** Terminal cumulative turn usage for diagnostics; reply accounting keeps using `usage`. */
  diagnosticUsage?: CliUsage;
  toolSummary?: ToolSummaryTrace;
  errorText?: string;
  terminalFailure?: CliTerminalFailure;
  diagnostics?: {
    process?: CliProcessDiagnostics;
  };
  finalPromptText?: string;
  didSendViaMessagingTool?: boolean;
  didDeliverSourceReplyViaMessageTool?: boolean;
  messagingToolSentTexts?: string[];
  messagingToolSentMediaUrls?: string[];
  messagingToolSentTargets?: MessagingToolSend[];
  messagingToolSourceReplyPayloads?: MessagingToolSourceReplyPayload[];
  yielded?: true;
};

function normalizeCliContextValue(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\s+/g, " ");
  return normalized ? truncateUtf16Safe(normalized, 200) : undefined;
}

export function formatCliOutputError(
  output: CliOutput,
  attribution: { runId?: string; sessionId?: string } = {},
): string {
  if (output.terminalFailure?.reason !== "max_turns") {
    return output.errorText || "CLI failed.";
  }

  const runId = normalizeCliContextValue(attribution.runId);
  const sessionId = normalizeCliContextValue(attribution.sessionId);
  const cliSessionId = normalizeCliContextValue(output.sessionId);
  const context = [
    runId ? `OpenClaw run: ${runId}.` : undefined,
    sessionId ? `OpenClaw session: ${sessionId}.` : undefined,
    cliSessionId ? `Claude session: ${cliSessionId}.` : undefined,
  ].filter((entry): entry is string => Boolean(entry));
  const limit = output.terminalFailure.limit;
  return [
    `Claude CLI stopped after reaching the maximum number of turns${limit ? ` (limit: ${limit})` : ""}.`,
    ...context,
    "Tool actions may already have run; verify their effects before retrying.",
    "Retry with a higher --max-turns value or a narrower task.",
  ].join(" ");
}

export const CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS = 8 * 1024 * 1024;
const CLI_STREAM_JSON_DEFAULT_MAX_TURN_LINES = 20_000;
const CLI_STREAM_JSON_MISSING_RESULT_ERROR = "CLI stream-json output ended without a result event.";

/** Incremental assistant text emitted while parsing a streaming CLI response. */
export type CliStreamingDelta = {
  text: string;
  delta: string;
  sessionId?: string;
  usage?: CliUsage;
};

export type CliStreamJsonOutputLimits = {
  maxTurnRawChars: number;
  maxPendingLineChars: number;
  maxTurnLines: number;
};

/** Incremental thinking text emitted while parsing a streaming CLI response. */
export type CliThinkingDelta = {
  text: string;
  delta: string;
  isReasoningSnapshot?: boolean;
};

export type CliThinkingProgress = {
  progressTokens: number;
};

export type CliPlanUpdate = {
  steps: AgentPlanStep[];
};

/** Tool-call start event reconstructed from CLI stream output. */
export type CliToolUseStartDelta = {
  toolCallId: string;
  name: string;
  // Preserve the producer kind: a server-native start without its result is not a failed local call.
  kind: "tool_use" | "server_tool_use" | "mcp_tool_use";
  args: Record<string, unknown>;
};

/** Tool-call result event reconstructed from CLI stream output. */
export type CliToolResultDelta = {
  toolCallId: string;
  name: string;
  isError: boolean;
  result?: unknown;
};

function isClaudeCliProvider(providerId: string): boolean {
  return normalizeLowercaseStringOrEmpty(providerId) === "claude-cli";
}

function isGeminiCliProvider(providerId: string): boolean {
  return normalizeLowercaseStringOrEmpty(providerId) === "google-gemini-cli";
}

function isGeminiStreamJsonDialect(params: {
  backend: CliBackendConfig;
  providerId: string;
}): boolean {
  return (
    params.backend.jsonlDialect === "gemini-stream-json" || isGeminiCliProvider(params.providerId)
  );
}

function isClaudeStreamJsonDialect(params: {
  backend: CliBackendConfig;
  providerId: string;
}): boolean {
  if (params.backend.jsonlDialect) {
    return params.backend.jsonlDialect === "claude-stream-json";
  }
  return isClaudeCliProvider(params.providerId);
}

function isStreamJsonDialect(params: { backend: CliBackendConfig; providerId: string }): boolean {
  return supportsCliJsonlToolEvents(params);
}

/** Returns whether JSONL output carries correlated provider tool events. */
function supportsCliJsonlToolEvents(params: {
  backend: CliBackendConfig;
  providerId: string;
}): boolean {
  return (
    params.backend.jsonlDialect === "claude-stream-json" ||
    isClaudeCliProvider(params.providerId) ||
    isGeminiStreamJsonDialect(params)
  );
}

function isClaudeStreamJsonResult(params: {
  backend: CliBackendConfig;
  providerId: string;
  parsed: Record<string, unknown>;
}): boolean {
  return supportsCliJsonlToolEvents(params) && params.parsed.type === "result";
}

function extractJsonObjectCandidates(raw: string): string[] {
  return extractBalancedJsonFragments(raw, { openers: ["{"] }).map((fragment) => fragment.json);
}

function parseJsonRecordCandidates(raw: string): Record<string, unknown>[] {
  const parsedRecords: Record<string, unknown>[] = [];
  const trimmed = raw.trim();
  if (!trimmed) {
    return parsedRecords;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      parsedRecords.push(parsed);
      return parsedRecords;
    }
  } catch {
    // Fall back to scanning for top-level JSON objects embedded in mixed output.
  }

  // Some CLIs prefix JSON with banners/logs; balanced scanning recovers structured records.
  for (const candidate of extractJsonObjectCandidates(trimmed)) {
    try {
      const parsed = JSON.parse(candidate);
      if (isRecord(parsed)) {
        parsedRecords.push(parsed);
      }
    } catch {
      // Ignore malformed fragments and keep scanning remaining objects.
    }
  }

  return parsedRecords;
}

function readNestedErrorMessage(parsed: Record<string, unknown>): string | undefined {
  if (isRecord(parsed.error)) {
    const errorMessage = readNestedErrorMessage(parsed.error);
    if (errorMessage) {
      return errorMessage;
    }
  }
  if (typeof parsed.message === "string") {
    const trimmed = parsed.message.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  if (typeof parsed.error === "string") {
    const trimmed = parsed.error.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function unwrapCliErrorText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  for (const parsed of parseJsonRecordCandidates(trimmed)) {
    const nested = readNestedErrorMessage(parsed);
    if (nested) {
      return nested;
    }
  }
  return trimmed;
}

function toCliUsage(raw: Record<string, unknown>): CliUsage | undefined {
  const readNestedCached = (
    key: "input_tokens_details" | "prompt_tokens_details",
    field: "cached_tokens" | "cache_write_tokens" = "cached_tokens",
  ) => {
    const nested = raw[key];
    if (!isRecord(nested)) {
      return undefined;
    }
    return typeof nested[field] === "number" && nested[field] > 0 ? nested[field] : undefined;
  };
  const pick = (key: string) =>
    typeof raw[key] === "number" && raw[key] > 0 ? raw[key] : undefined;
  // Chat Completions calls these prompt/completion tokens; preserve existing CLI-field precedence.
  const totalInput =
    pick("input_tokens") ?? pick("inputTokens") ?? pick("prompt_tokens") ?? pick("promptTokens");
  const output =
    pick("output_tokens") ??
    pick("outputTokens") ??
    pick("completion_tokens") ??
    pick("completionTokens");
  const nestedCached =
    readNestedCached("input_tokens_details") ?? readNestedCached("prompt_tokens_details");
  const cacheRead =
    pick("cache_read_input_tokens") ??
    pick("cached_input_tokens") ??
    pick("cacheRead") ??
    pick("cached") ??
    nestedCached;
  const nestedCacheWrite =
    readNestedCached("input_tokens_details", "cache_write_tokens") ??
    readNestedCached("prompt_tokens_details", "cache_write_tokens");
  const cacheWrite =
    pick("cache_creation_input_tokens") ??
    pick("cache_write_input_tokens") ??
    pick("cacheWrite") ??
    nestedCacheWrite;
  const input =
    pick("input") ??
    ((Object.hasOwn(raw, "cached") ||
      Object.hasOwn(raw, "cached_input_tokens") ||
      Object.hasOwn(raw, "cache_write_input_tokens") ||
      nestedCached !== undefined ||
      nestedCacheWrite !== undefined) &&
    typeof totalInput === "number"
      ? Math.max(0, totalInput - (cacheRead ?? 0) - (cacheWrite ?? 0))
      : totalInput);
  const total = pick("total_tokens") ?? pick("total");
  if (!input && !output && !cacheRead && !cacheWrite && !total) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite, total };
}

function readCliUsage(parsed: Record<string, unknown>): CliUsage | undefined {
  if (isRecord(parsed.message) && isRecord(parsed.message.usage)) {
    const usage = toCliUsage(parsed.message.usage);
    if (usage) {
      return usage;
    }
  }
  if (isRecord(parsed.usage)) {
    const usage = toCliUsage(parsed.usage);
    if (usage) {
      return usage;
    }
  }
  if (isRecord(parsed.stats)) {
    return toCliUsage(parsed.stats);
  }
  return undefined;
}

function collectCliText(value: unknown): string {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => collectCliText(entry)).join("");
  }
  if (!isRecord(value)) {
    return "";
  }
  if (typeof value.response === "string") {
    return value.response;
  }
  if (typeof value.text === "string") {
    return value.text;
  }
  if (typeof value.result === "string") {
    return value.result;
  }
  if (typeof value.content === "string") {
    return value.content;
  }
  if (Array.isArray(value.content)) {
    return value.content.map((entry) => collectCliText(entry)).join("");
  }
  if (isRecord(value.message)) {
    return collectCliText(value.message);
  }
  return "";
}

function unwrapNestedCliResultText(raw: string): string {
  let text = raw;
  for (let depth = 0; depth < 8; depth += 1) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("{")) {
      return text;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (
        !isRecord(parsed) ||
        typeof parsed.type !== "string" ||
        parsed.type !== "result" ||
        typeof parsed.result !== "string"
      ) {
        return text;
      }
      // Claude can wrap a result payload inside repeated JSON-string result envelopes.
      text = parsed.result;
    } catch {
      return text;
    }
  }
  return text;
}

function collectExplicitCliErrorText(parsed: Record<string, unknown>): string {
  const subtype = typeof parsed.subtype === "string" ? parsed.subtype.trim() : "";
  const isResultError =
    parsed.is_error === true ||
    (parsed.type === "result" && (subtype.startsWith("error_") || parsed.status === "error"));
  if (isResultError) {
    const text =
      collectCliText(parsed.result) ||
      collectCliText(parsed.message) ||
      collectCliText(parsed.content);
    if (text) {
      return unwrapCliErrorText(text);
    }
    const nested = readNestedErrorMessage(parsed);
    if (nested) {
      return unwrapCliErrorText(nested);
    }
    if (subtype) {
      return `Claude CLI result subtype ${subtype}.`;
    }
    return "CLI result was marked as an error.";
  }

  const nested = readNestedErrorMessage(parsed);
  if (nested) {
    return unwrapCliErrorText(nested);
  }

  if (parsed.type === "assistant") {
    const text = collectCliText(parsed.message);
    if (/^\s*API Error:/i.test(text)) {
      return unwrapCliErrorText(text);
    }
  }

  if (parsed.type === "error") {
    const text =
      collectCliText(parsed.message) ||
      collectCliText(parsed.content) ||
      collectCliText(parsed.result) ||
      collectCliText(parsed);
    return unwrapCliErrorText(text);
  }

  return "";
}

function readClaudeMaxTurnsFailure(
  parsed: Record<string, unknown>,
): CliTerminalFailure | undefined {
  const subtype = typeof parsed.subtype === "string" ? parsed.subtype.trim() : "";
  const terminalReason =
    typeof parsed.terminal_reason === "string" ? parsed.terminal_reason.trim() : "";
  if (subtype !== "error_max_turns" && terminalReason !== "max_turns") {
    return undefined;
  }
  const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
  for (const error of errors) {
    if (typeof error !== "string") {
      continue;
    }
    const match = error.match(/maximum number of turns\s*\((\d+)\)/i);
    if (match) {
      const limit = Number.parseInt(match[1] ?? "", 10);
      if (Number.isSafeInteger(limit) && limit > 0) {
        return {
          reason: "max_turns",
          limit,
        };
      }
    }
  }
  return { reason: "max_turns" };
}

function readClaudeMaxTurnsErrorText(parsed: Record<string, unknown>): string | undefined {
  if (!Array.isArray(parsed.errors)) {
    return undefined;
  }
  for (const error of parsed.errors) {
    if (typeof error === "string" && error.trim()) {
      return error.trim();
    }
  }
  return undefined;
}

function resolveCliTerminalErrorText(
  parsed: Record<string, unknown>,
  terminalFailure: CliTerminalFailure | undefined,
): string {
  const explicitErrorText = collectExplicitCliErrorText(parsed);
  return (
    ((terminalFailure ? readClaudeMaxTurnsErrorText(parsed) : undefined) ?? explicitErrorText) ||
    (terminalFailure ? "Reached maximum number of turns." : "")
  );
}

function pickCliSessionId(
  parsed: Record<string, unknown>,
  backend: CliBackendConfig,
): string | undefined {
  const fields = backend.sessionIdFields ?? [
    "session_id",
    "sessionId",
    "conversation_id",
    "conversationId",
  ];
  for (const field of fields) {
    const value = parsed[field];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function pickCliResumeCheckpointId(params: {
  backend: CliBackendConfig;
  providerId: string;
  parsed: Record<string, unknown>;
}): string | undefined {
  if (
    !isClaudeStreamJsonDialect(params) ||
    params.parsed.type !== "assistant" ||
    params.parsed.parent_tool_use_id != null
  ) {
    return undefined;
  }
  const checkpointId = typeof params.parsed.uuid === "string" ? params.parsed.uuid.trim() : "";
  return checkpointId || undefined;
}

function shouldUnwrapNestedCliResultText(params: {
  providerId?: string;
  parsed: Record<string, unknown>;
}): boolean {
  if (!params.providerId || !isClaudeCliProvider(params.providerId)) {
    return false;
  }
  return !Object.hasOwn(params.parsed, "type") || params.parsed.type === "result";
}

export function resolveCliStreamJsonOutputLimits(
  _backend: CliBackendConfig,
): CliStreamJsonOutputLimits {
  return {
    maxTurnRawChars: CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS,
    maxPendingLineChars: CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS,
    maxTurnLines: CLI_STREAM_JSON_DEFAULT_MAX_TURN_LINES,
  };
}

/** Frames arbitrary stdout chunks while bounding each individual raw JSONL line. */
export function frameBoundedCliJsonlChunk(
  state: { pending: string },
  chunk: string,
  maxLineChars: number,
  onLine: (line: string) => boolean | void,
): boolean {
  for (let offset = 0; offset < chunk.length;) {
    const newlineIndex = chunk.indexOf("\n", offset);
    const lineEnd = newlineIndex === -1 ? chunk.length : newlineIndex;
    if (state.pending.length + (lineEnd - offset) > maxLineChars) {
      state.pending = "";
      return false;
    }
    state.pending += chunk.slice(offset, lineEnd);
    if (newlineIndex === -1) {
      return true;
    }
    const line = state.pending;
    // Control-response writes can synchronously reenter stdout framing.
    state.pending = "";
    offset = newlineIndex + 1;
    if (onLine(line) === false) {
      return true;
    }
  }
  return true;
}

/** Drops Claude's echoed binary bytes before they enter retained tool/transcript state. */
export function normalizeClaudeCliStreamJsonRecord(
  parsed: Record<string, unknown>,
): { line: string; omittedRawChars: number } | undefined {
  if (parsed.type !== "user" || !isRecord(parsed.message)) {
    return undefined;
  }
  const content = Array.isArray(parsed.message.content) ? parsed.message.content : [];
  let normalized = false;
  let omittedRawChars = 0;
  for (const result of content) {
    if (!isRecord(result) || result.type !== "tool_result" || !Array.isArray(result.content)) {
      continue;
    }
    for (const block of result.content) {
      if (!isRecord(block) || !isRecord(block.source) || block.source.type !== "base64") {
        continue;
      }
      if (
        block.type !== "image" &&
        !(block.type === "document" && block.source.media_type === "application/pdf")
      ) {
        continue;
      }
      const { data, ...source } = block.source;
      if (typeof data !== "string") {
        continue;
      }
      block.source = source;
      block.omitted = true;
      block.bytes = estimateBase64DecodedBytes(data);
      omittedRawChars += data.length;
      normalized = true;
    }
  }
  return normalized ? { line: JSON.stringify(parsed), omittedRawChars } : undefined;
}

function streamJsonOutputLimitErrorText(kind: "raw" | "line" | "lines", limit: number): string {
  if (kind === "line") {
    return `CLI JSONL line exceeded ${limit} characters; refusing to parse output.`;
  }
  if (kind === "lines") {
    return `CLI JSONL output exceeded ${limit} lines; refusing to parse output.`;
  }
  return `CLI JSONL output exceeded ${limit} characters; refusing to parse output.`;
}

function hasExplicitCliErrorPayload(parsed: Record<string, unknown>): boolean {
  if (typeof parsed.error === "string") {
    return Boolean(parsed.error.trim());
  }
  if (isRecord(parsed.error)) {
    return Boolean(readNestedErrorMessage(parsed.error));
  }
  return false;
}

/** Parses JSON CLI output, including mixed stdout that contains embedded JSON objects. */
/** Parses a single JSON payload emitted by a CLI backend. */
function parseCliJson(
  raw: string,
  backend: CliBackendConfig,
  providerId?: string,
): CliOutput | null {
  const parsedRecords = parseJsonRecordCandidates(raw);
  if (parsedRecords.length === 0) {
    return null;
  }

  let sessionId: string | undefined;
  let usage: CliUsage | undefined;
  let text = "";
  let sawStructuredOutput = false;
  for (const parsed of parsedRecords) {
    sessionId = pickCliSessionId(parsed, backend) ?? sessionId;
    usage = readCliUsage(parsed) ?? usage;
    const terminalFailure = isClaudeStreamJsonDialect({
      backend,
      providerId: providerId ?? "",
    })
      ? readClaudeMaxTurnsFailure(parsed)
      : undefined;
    if (terminalFailure) {
      return {
        text: "",
        sessionId,
        usage,
        errorText: resolveCliTerminalErrorText(parsed, terminalFailure),
        terminalFailure,
      };
    }
    const subtype = typeof parsed.subtype === "string" ? parsed.subtype.trim() : "";
    const shouldClassifyError =
      parsed.is_error === true ||
      parsed.type === "error" ||
      (parsed.type === "result" &&
        (subtype.startsWith("error_") ||
          parsed.status === "error" ||
          hasExplicitCliErrorPayload(parsed)));
    const errorText = shouldClassifyError ? collectExplicitCliErrorText(parsed) : "";
    if (errorText) {
      return { text: "", sessionId, usage, errorText };
    }
    const nextText =
      collectCliText(parsed.message) ||
      collectCliText(parsed.content) ||
      collectCliText(parsed.result) ||
      collectCliText(parsed.response) ||
      collectCliText(parsed);
    const trimmedText = (
      shouldUnwrapNestedCliResultText({ providerId, parsed })
        ? unwrapNestedCliResultText(nextText)
        : nextText
    ).trim();
    if (trimmedText) {
      text = trimmedText;
      sawStructuredOutput = true;
      continue;
    }
    if (sessionId || usage) {
      sawStructuredOutput = true;
    }
  }

  if (!text && !sawStructuredOutput) {
    return null;
  }
  return { text, sessionId, usage };
}

function parseClaudeCliJsonlResult(params: {
  backend: CliBackendConfig;
  providerId: string;
  parsed: Record<string, unknown>;
  sessionId?: string;
  usage?: CliUsage;
}): CliOutput | null {
  if (!supportsCliJsonlToolEvents(params)) {
    return null;
  }
  if (typeof params.parsed.type === "string" && params.parsed.type === "result") {
    const terminalFailure = isClaudeStreamJsonDialect(params)
      ? readClaudeMaxTurnsFailure(params.parsed)
      : undefined;
    const errorText = resolveCliTerminalErrorText(params.parsed, terminalFailure);
    if (errorText) {
      return {
        text: "",
        sessionId: params.sessionId,
        usage: params.usage,
        errorText,
        ...(terminalFailure ? { terminalFailure } : {}),
      };
    }
    if (typeof params.parsed.result !== "string") {
      return null;
    }
    const resultText = unwrapNestedCliResultText(params.parsed.result).trim();
    if (resultText) {
      return { text: resultText, sessionId: params.sessionId, usage: params.usage };
    }
    // Claude may finish with an empty result after tool-only work. Keep the
    // resolved session handle and usage instead of dropping them.
    return { text: "", sessionId: params.sessionId, usage: params.usage };
  }
  return null;
}

// A tool-split turn streams pre-tool answer text the terminal result envelope
// omits (it carries only the final message). Prefer the fuller streamed text so
// final delivery cannot erase already-streamed content (#106760). The result
// must match the complete final streamed message: a bare suffix match inside a
// single divergent message defers to the authoritative result envelope.
function preferStreamedClaudeTextOverResult(params: {
  streamedText: string;
  finalMessageText: string;
  resultText: string;
}): boolean {
  return (
    Boolean(params.resultText) &&
    params.streamedText !== params.resultText &&
    params.finalMessageText === params.resultText
  );
}

// Assistant-message boundaries join with one blank line; add only the missing
// newlines so messages that already end or start with breaks are not
// double-spaced.
function missingMessageBoundarySeparator(previousText: string, nextDelta: string): string {
  if (!previousText) {
    return "";
  }
  const trailing = previousText.match(/\n*$/u)?.[0].length ?? 0;
  const leading = nextDelta.match(/^\n*/u)?.[0].length ?? 0;
  return "\n".repeat(Math.max(0, 2 - trailing - leading));
}

function parseClaudeCliStreamingDelta(params: {
  backend: CliBackendConfig;
  providerId: string;
  parsed: Record<string, unknown>;
  textSoFar: string;
  sessionId?: string;
  usage?: CliUsage;
}): CliStreamingDelta | null {
  if (!supportsCliJsonlToolEvents(params)) {
    return null;
  }
  if (params.parsed.type !== "stream_event" || !isRecord(params.parsed.event)) {
    return null;
  }
  const event = params.parsed.event;
  if (event.type !== "content_block_delta" || !isRecord(event.delta)) {
    return null;
  }
  const delta = event.delta;
  if (delta.type !== "text_delta" || typeof delta.text !== "string") {
    return null;
  }
  if (!delta.text) {
    return null;
  }
  return {
    text: `${params.textSoFar}${delta.text}`,
    delta: delta.text,
    sessionId: params.sessionId,
    usage: params.usage,
  };
}

type PendingToolUse = {
  toolCallId: string;
  name: string;
  kind: CliToolUseStartDelta["kind"];
  inputJsonParts: string[];
};

type ToolUseTracker = {
  pendingByIndex: Map<number, PendingToolUse>;
  nameById: Map<string, string>;
  startedIds: Set<string>;
  resultDeliveredIds: Set<string>;
};

function createToolUseTracker(): ToolUseTracker {
  return {
    pendingByIndex: new Map(),
    nameById: new Map(),
    startedIds: new Set(),
    resultDeliveredIds: new Set(),
  };
}

function emitToolStartOnce(
  tracker: ToolUseTracker,
  toolCallId: string,
  name: string,
  kind: CliToolUseStartDelta["kind"],
  args: Record<string, unknown>,
  onToolUseStart?: (delta: CliToolUseStartDelta) => void,
): void {
  // Streaming and final assistant records may both describe the same tool call.
  if (tracker.startedIds.has(toolCallId)) {
    return;
  }
  tracker.startedIds.add(toolCallId);
  tracker.nameById.set(toolCallId, name);
  onToolUseStart?.({ toolCallId, name, kind, args });
}

function emitToolResultOnce(
  tracker: ToolUseTracker,
  toolCallId: string,
  isError: boolean,
  result: unknown,
  onToolResult?: (delta: CliToolResultDelta) => void,
): void {
  // Tool results can arrive as assistant result blocks or echoed user tool_result blocks.
  if (tracker.resultDeliveredIds.has(toolCallId)) {
    return;
  }
  tracker.resultDeliveredIds.add(toolCallId);
  onToolResult?.({
    toolCallId,
    name: tracker.nameById.get(toolCallId) ?? "",
    isError,
    result,
  });
}

function isClaudeToolUseBlockType(type: unknown): type is CliToolUseStartDelta["kind"] {
  return type === "tool_use" || type === "server_tool_use" || type === "mcp_tool_use";
}

function isClaudeAssistantToolResultBlockType(type: unknown): boolean {
  return typeof type === "string" && type.endsWith("_tool_result") && type !== "tool_result";
}

function isClaudeToolResultError(content: unknown): boolean {
  return isRecord(content) && typeof content.type === "string" && content.type.endsWith("_error");
}

function parseToolInputJson(parts: string[]): Record<string, unknown> {
  if (parts.length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(parts.join(""));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function dispatchClaudeCliStreamingToolEvent(params: {
  backend: CliBackendConfig;
  providerId: string;
  parsed: Record<string, unknown>;
  tracker: ToolUseTracker;
  onToolUseStart?: (delta: CliToolUseStartDelta) => void;
  onToolResult?: (delta: CliToolResultDelta) => void;
}): void {
  if (!supportsCliJsonlToolEvents(params)) {
    return;
  }
  const tracker = params.tracker;

  if (params.parsed.type === "stream_event" && isRecord(params.parsed.event)) {
    const event = params.parsed.event;
    if (
      event.type === "content_block_start" &&
      typeof event.index === "number" &&
      isRecord(event.content_block)
    ) {
      const block = event.content_block;
      if (isClaudeToolUseBlockType(block.type)) {
        const toolCallId = typeof block.id === "string" ? block.id.trim() : "";
        const name = typeof block.name === "string" ? block.name.trim() : "";
        if (toolCallId && name) {
          tracker.pendingByIndex.set(event.index, {
            toolCallId,
            name,
            kind: block.type,
            inputJsonParts: [],
          });
        }
      } else if (isClaudeAssistantToolResultBlockType(block.type)) {
        const toolCallId = typeof block.tool_use_id === "string" ? block.tool_use_id.trim() : "";
        if (toolCallId) {
          emitToolResultOnce(
            tracker,
            toolCallId,
            block.is_error === true || isClaudeToolResultError(block.content),
            block.content,
            params.onToolResult,
          );
        }
      }
      return;
    }
    if (
      event.type === "content_block_delta" &&
      typeof event.index === "number" &&
      isRecord(event.delta)
    ) {
      if (event.delta.type === "input_json_delta" && typeof event.delta.partial_json === "string") {
        tracker.pendingByIndex.get(event.index)?.inputJsonParts.push(event.delta.partial_json);
      }
      return;
    }
    if (event.type === "content_block_stop" && typeof event.index === "number") {
      const pending = tracker.pendingByIndex.get(event.index);
      tracker.pendingByIndex.delete(event.index);
      if (pending) {
        emitToolStartOnce(
          tracker,
          pending.toolCallId,
          pending.name,
          pending.kind,
          parseToolInputJson(pending.inputJsonParts),
          params.onToolUseStart,
        );
      }
      return;
    }
    return;
  }

  if (params.parsed.type === "assistant" && isRecord(params.parsed.message)) {
    const message = params.parsed.message;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!isRecord(block)) {
        continue;
      }
      if (isClaudeToolUseBlockType(block.type)) {
        const toolCallId = typeof block.id === "string" ? block.id.trim() : "";
        const name = typeof block.name === "string" ? block.name.trim() : "";
        if (!toolCallId || !name) {
          continue;
        }
        const args: Record<string, unknown> = isRecord(block.input) ? block.input : {};
        emitToolStartOnce(tracker, toolCallId, name, block.type, args, params.onToolUseStart);
      } else if (isClaudeAssistantToolResultBlockType(block.type)) {
        const toolCallId = typeof block.tool_use_id === "string" ? block.tool_use_id.trim() : "";
        if (!toolCallId) {
          continue;
        }
        emitToolResultOnce(
          tracker,
          toolCallId,
          block.is_error === true || isClaudeToolResultError(block.content),
          block.content,
          params.onToolResult,
        );
      }
    }
    return;
  }

  if (params.parsed.type === "user" && isRecord(params.parsed.message)) {
    const message = params.parsed.message;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!isRecord(block) || block.type !== "tool_result") {
        continue;
      }
      const toolCallId = typeof block.tool_use_id === "string" ? block.tool_use_id.trim() : "";
      if (!toolCallId) {
        continue;
      }
      emitToolResultOnce(
        tracker,
        toolCallId,
        block.is_error === true,
        block.content,
        params.onToolResult,
      );
    }
  }
}

type ThinkingTracker = {
  currentMessageId?: string;
  // Thinking text already streamed via thinking_delta, keyed by the Anthropic
  // content-block index. Snapshot frames repeat streamed thinking, so each block
  // is deduped against its own index; a single global concatenation misfires
  // once a message carries more than one thinking block (re-emits or reorders).
  streamedByIndex: Map<number, string>;
  // Full thinking already emitted for the message in block order. The callback
  // contract exposes this as the running snapshot text for downstream coalescing,
  // so it stays a message-level concatenation, not a per-index value.
  emittedText: string;
  currentSyntheticBlockIndex?: number;
  nextSyntheticBlockIndex: number;
  progressTokens: number;
};

function createThinkingTracker(): ThinkingTracker {
  return {
    streamedByIndex: new Map(),
    emittedText: "",
    nextSyntheticBlockIndex: 0,
    progressTokens: 0,
  };
}

function resetThinkingBlockState(tracker: ThinkingTracker): void {
  tracker.streamedByIndex.clear();
  tracker.emittedText = "";
  tracker.currentSyntheticBlockIndex = undefined;
  tracker.nextSyntheticBlockIndex = 0;
  tracker.progressTokens = 0;
}

function resetThinkingTrackerForMessage(
  tracker: ThinkingTracker,
  messageId: string | undefined,
): void {
  if (messageId && messageId === tracker.currentMessageId) {
    return;
  }
  if (messageId && tracker.currentMessageId === undefined) {
    tracker.currentMessageId = messageId;
    return;
  }
  // Anthropic content-block indexes restart at 0 for each message, so a prior
  // tool-round message's per-index thinking must not bleed into the next one.
  resetThinkingBlockState(tracker);
  tracker.currentMessageId = messageId;
}

function beginClaudeContentBlock(tracker: ThinkingTracker, index: unknown): void {
  if (typeof index === "number") {
    tracker.currentSyntheticBlockIndex = index;
    tracker.nextSyntheticBlockIndex = Math.max(tracker.nextSyntheticBlockIndex, index + 1);
    return;
  }
  if (index !== undefined) {
    tracker.currentSyntheticBlockIndex = undefined;
    return;
  }
  tracker.currentSyntheticBlockIndex = tracker.nextSyntheticBlockIndex;
  tracker.nextSyntheticBlockIndex += 1;
}

function stopClaudeContentBlock(tracker: ThinkingTracker): void {
  tracker.currentSyntheticBlockIndex = undefined;
}

function resolveClaudeContentBlockIndex(tracker: ThinkingTracker, index: unknown): number | null {
  if (typeof index === "number") {
    tracker.nextSyntheticBlockIndex = Math.max(tracker.nextSyntheticBlockIndex, index + 1);
    return index;
  }
  if (index !== undefined) {
    return null;
  }
  return tracker.currentSyntheticBlockIndex ?? null;
}

function assembleThinkingTextByIndex(streamedByIndex: Map<number, string>): string {
  return [...streamedByIndex.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([, text]) => text)
    .join("");
}

function emitClaudeThinking(
  tracker: ThinkingTracker,
  index: number,
  streamed: string,
  delta: string,
  onThinkingDelta: (delta: CliThinkingDelta) => void,
): void {
  tracker.streamedByIndex.set(index, `${streamed}${delta}`);
  tracker.emittedText = assembleThinkingTextByIndex(tracker.streamedByIndex);
  onThinkingDelta({ text: tracker.emittedText, delta, isReasoningSnapshot: true });
}

function readThinkingProgressTokens(delta: Record<string, unknown>): number | undefined {
  if (delta.type !== "thinking_delta" || delta.thinking !== "") {
    return undefined;
  }
  const estimatedTokens = delta.estimated_tokens;
  if (typeof estimatedTokens !== "number" || !Number.isFinite(estimatedTokens)) {
    return undefined;
  }
  return estimatedTokens > 0 ? estimatedTokens : undefined;
}

function emitClaudeThinkingProgress(
  tracker: ThinkingTracker,
  progressTokensDelta: number,
  onThinkingProgress: (progress: CliThinkingProgress) => void,
): void {
  tracker.progressTokens += progressTokensDelta;
  onThinkingProgress({ progressTokens: tracker.progressTokens });
}

function dispatchClaudeCliThinking(params: {
  backend: CliBackendConfig;
  providerId: string;
  parsed: Record<string, unknown>;
  tracker: ThinkingTracker;
  onThinkingDelta?: (delta: CliThinkingDelta) => void;
  onThinkingProgress?: (progress: CliThinkingProgress) => void;
}): void {
  if (!supportsCliJsonlToolEvents(params)) {
    return;
  }
  const tracker = params.tracker;

  if (params.parsed.type === "stream_event" && isRecord(params.parsed.event)) {
    const event = params.parsed.event;
    if (event.type === "message_start") {
      const message = isRecord(event.message) ? event.message : undefined;
      resetThinkingTrackerForMessage(
        tracker,
        typeof message?.id === "string" ? message.id : undefined,
      );
      return;
    }
    if (event.type === "content_block_start") {
      beginClaudeContentBlock(tracker, event.index);
      return;
    }
    if (event.type === "content_block_stop") {
      stopClaudeContentBlock(tracker);
      return;
    }
    if (event.type !== "content_block_delta" || !isRecord(event.delta)) {
      return;
    }
    // Thinking state is per content-block; when the CLI omits indexes, the
    // surrounding block start/stop stream supplies the ordering slot.
    const blockIndex = resolveClaudeContentBlockIndex(tracker, event.index);
    if (blockIndex === null) {
      return;
    }
    const progressTokensDelta = readThinkingProgressTokens(event.delta);
    if (progressTokensDelta !== undefined && params.onThinkingProgress) {
      emitClaudeThinkingProgress(tracker, progressTokensDelta, params.onThinkingProgress);
      return;
    }
    // signature_delta carries opaque continuation material; the Claude CLI owns
    // its own session transcript, so it never enters the thinking text lane.
    if (event.delta.type !== "thinking_delta" || typeof event.delta.thinking !== "string") {
      return;
    }
    if (!event.delta.thinking) {
      return;
    }
    if (!params.onThinkingDelta) {
      return;
    }
    const streamed = tracker.streamedByIndex.get(blockIndex) ?? "";
    emitClaudeThinking(tracker, blockIndex, streamed, event.delta.thinking, params.onThinkingDelta);
    return;
  }

  if (params.parsed.type === "assistant" && isRecord(params.parsed.message)) {
    resetThinkingTrackerForMessage(
      tracker,
      typeof params.parsed.message.id === "string" ? params.parsed.message.id : undefined,
    );
    const content = Array.isArray(params.parsed.message.content)
      ? params.parsed.message.content
      : [];
    for (const [index, block] of content.entries()) {
      // redacted_thinking blocks are opaque provider material with no text lane.
      if (!isRecord(block) || block.type !== "thinking" || typeof block.thinking !== "string") {
        continue;
      }
      if (!params.onThinkingDelta) {
        continue;
      }
      tracker.streamedByIndex.set(index, block.thinking);
      const text = assembleThinkingTextByIndex(tracker.streamedByIndex);
      if (text === tracker.emittedText) {
        continue;
      }
      tracker.emittedText = text;
      params.onThinkingDelta({ text, delta: block.thinking, isReasoningSnapshot: true });
    }
  }
}

function dispatchGeminiCliStreamingToolEvent(params: {
  backend: CliBackendConfig;
  providerId: string;
  parsed: Record<string, unknown>;
  tracker: ToolUseTracker;
  onToolUseStart?: (delta: CliToolUseStartDelta) => void;
  onToolResult?: (delta: CliToolResultDelta) => void;
}): void {
  if (!isGeminiStreamJsonDialect(params)) {
    return;
  }
  if (params.parsed.type === "tool_use") {
    const toolCallId =
      typeof params.parsed.tool_id === "string" ? params.parsed.tool_id.trim() : "";
    const name = typeof params.parsed.tool_name === "string" ? params.parsed.tool_name.trim() : "";
    if (!toolCallId || !name) {
      return;
    }
    const args = isRecord(params.parsed.parameters) ? params.parsed.parameters : {};
    emitToolStartOnce(params.tracker, toolCallId, name, "tool_use", args, params.onToolUseStart);
    return;
  }
  if (params.parsed.type === "tool_result") {
    const toolCallId =
      typeof params.parsed.tool_id === "string" ? params.parsed.tool_id.trim() : "";
    if (!toolCallId) {
      return;
    }
    const result =
      params.parsed.status === "error" && isRecord(params.parsed.error)
        ? params.parsed.error
        : params.parsed.output;
    emitToolResultOnce(
      params.tracker,
      toolCallId,
      params.parsed.status === "error",
      result,
      params.onToolResult,
    );
  }
}

const GEMINI_CLI_ERROR_EVENT_FALLBACK = "Gemini CLI emitted an error event.";
const GEMINI_CLI_RESULT_ERROR_FALLBACK = "Gemini CLI result status was error.";

function isFallbackGeminiCliStreamJsonError(errorText: string): boolean {
  return (
    errorText === GEMINI_CLI_ERROR_EVENT_FALLBACK || errorText === GEMINI_CLI_RESULT_ERROR_FALLBACK
  );
}

function preferGeminiCliStreamJsonError(current: string | undefined, next: string): string {
  if (!current) {
    return next;
  }
  if (isFallbackGeminiCliStreamJsonError(current) && !isFallbackGeminiCliStreamJsonError(next)) {
    return next;
  }
  return current;
}

function readGeminiCliStreamJsonError(parsed: Record<string, unknown>): string | undefined {
  if (parsed.type === "error" && parsed.severity === "error") {
    return collectExplicitCliErrorText(parsed) || GEMINI_CLI_ERROR_EVENT_FALLBACK;
  }
  if (parsed.type === "result" && parsed.status === "error") {
    return collectExplicitCliErrorText(parsed) || GEMINI_CLI_RESULT_ERROR_FALLBACK;
  }
  return undefined;
}

// A possible leading block stays buffered until visible prose or the message
// boundary proves where private reasoning ends. Later tags remain literal.
function partitionLeadingTaggedReasoning(
  text: string,
  final: boolean,
): { pending: true } | { pending: false; reasoningText: string; visibleText: string } {
  const first = text.search(/\S/u);
  if (first === -1) {
    return final ? { pending: false, reasoningText: "", visibleText: text } : { pending: true };
  }
  if (text.charAt(first) !== "<") {
    return { pending: false, reasoningText: "", visibleText: text };
  }

  const scan = scanReasoningTags(text, final);
  let depth = 0;
  let end = -1;
  for (const tag of scan.tags) {
    if (depth === 0) {
      const expectedStart = end === -1 ? first : end;
      if (text.slice(expectedStart, tag.index).trim() || tag.isClose || tag.isSelfClosing) {
        break;
      }
    }
    depth += tag.isClose ? -1 : tag.isSelfClosing ? 0 : 1;
    if (depth === 0 && tag.isClose) {
      end = tag.index + tag.text.length;
    }
  }

  const pendingTagAfterBlock =
    end !== -1 && scan.pendingStart !== undefined && !text.slice(end, scan.pendingStart).trim();
  if (end === -1) {
    const pendingLeadingTag =
      scan.pendingStart !== undefined && !text.slice(first, scan.pendingStart).trim();
    return !final && (depth > 0 || pendingLeadingTag)
      ? { pending: true }
      : { pending: false, reasoningText: "", visibleText: text };
  }
  if (!final && (depth > 0 || pendingTagAfterBlock || !text.slice(end).trim())) {
    return { pending: true };
  }

  const partitioner = createReasoningTagTextPartitioner();
  const deltas = [...partitioner.pushVisible(text.slice(0, end)), ...partitioner.flush()];
  const reasoningText = deltas
    .filter((delta) => delta.kind === "thinking")
    .map((delta) => delta.text)
    .join("");
  return reasoningText
    ? { pending: false, reasoningText, visibleText: text.slice(end) }
    : { pending: false, reasoningText: "", visibleText: text };
}

function createLeadingTaggedReasoningRouter() {
  let pending = "";
  let settled = false;
  const consume = (chunk: string, final: boolean): ReasoningTagTextDelta[] => {
    if (settled) {
      return chunk ? [{ kind: "text", text: chunk }] : [];
    }
    pending += chunk;
    const result = partitionLeadingTaggedReasoning(pending, final);
    if (result.pending) {
      return [];
    }
    settled = true;
    pending = "";
    return [
      ...(result.reasoningText
        ? ([{ kind: "thinking", text: result.reasoningText }] as const)
        : []),
      ...(result.visibleText ? ([{ kind: "text", text: result.visibleText }] as const) : []),
    ];
  };
  return {
    push: (chunk: string) => consume(chunk, false),
    finish: () => consume("", true),
  };
}

/** Creates a stateful parser for streaming JSONL CLI backend output. */
export function createCliJsonlStreamingParser(params: {
  backend: CliBackendConfig;
  providerId: string;
  parseJsonlEvent?: CliBackendParseJsonlEvent;
  onAssistantDelta: (delta: CliStreamingDelta) => void;
  onThinkingDelta?: (delta: CliThinkingDelta) => void;
  onThinkingProgress?: (progress: CliThinkingProgress) => void;
  onPlanUpdate?: (update: CliPlanUpdate) => void;
  onToolUseStart?: (delta: CliToolUseStartDelta) => void;
  onToolResult?: (delta: CliToolResultDelta) => void;
  onDisplayToolUseStart?: (delta: CliToolUseStartDelta) => void;
  onDisplayToolResult?: (delta: CliToolResultDelta) => void;
  onCommentaryText?: (text: string) => void;
  onSessionId?: (sessionId: string) => void;
  onAssistantMessage?: (message: unknown) => void;
  onUsage?: (usage: CliUsage, terminal: boolean) => void;
}) {
  const lineBuffer = { pending: "" };
  let assistantText = "";
  let customThinkingText = "";
  let pendingClaudeText = "";
  let pendingMessageSeparator = false;
  let currentMessageStart = 0;
  let segmentStart = 0;
  // Streamed text from this offset on is still a candidate to outrank the
  // result envelope; every non-tool boundary or interim result restarts it.
  let preserveFrom = 0;
  let sawToolUseSinceText = false;
  let currentMessageHadToolUse = false;
  let previousMessageHadToolUse = false;
  let sessionId: string | undefined;
  let resumeCheckpointId: string | undefined;
  let usage: CliUsage | undefined;
  let diagnosticUsage: CliUsage | undefined;
  let output: CliOutput | null = null;
  let parseErrorText = "";
  let rawChars = 0;
  let rawLines = 0;
  const texts: string[] = [];
  let sawCustomJsonlEvent = false;
  const toolTracker = createToolUseTracker();
  const outputLimits = resolveCliStreamJsonOutputLimits(params.backend);
  // Classification is keyed on consumer presence so reclassified pre-tool text
  // always has a destination; a separate enable flag let it be dropped (#92092).
  const classifyClaudeCommentary =
    Boolean(params.onCommentaryText) && supportsCliJsonlToolEvents(params);
  const thinkingTracker = createThinkingTracker();
  const claudeStreamJson = isClaudeStreamJsonDialect(params);
  let taggedReasoningRouter = createLeadingTaggedReasoningRouter();
  let currentTaggedReasoningText = "";

  const flushPendingClaudeAssistantText = () => {
    if (!pendingClaudeText) {
      return;
    }
    const delta = pendingClaudeText;
    pendingClaudeText = "";
    assistantText = `${assistantText}${delta}`;
    params.onAssistantDelta({
      text: assistantText,
      delta,
      sessionId,
      usage,
    });
  };

  const flushPendingClaudeCommentaryText = () => {
    if (!pendingClaudeText) {
      return;
    }
    const text = pendingClaudeText.trim();
    pendingClaudeText = "";
    if (text) {
      params.onCommentaryText?.(text);
    }
  };

  const emitClaudeVisibleText = (delta: string) => {
    if (!delta) {
      return;
    }
    if (classifyClaudeCommentary) {
      pendingClaudeText = `${pendingClaudeText}${delta}`;
      return;
    }
    // A tool_use block starts a new post-tool segment even inside one assistant
    // message; only tool-split boundaries may later outrank the result envelope.
    // A message boundary is a tool split only when the PREVIOUS message used a
    // tool: a tool-first fresh message must not connect an earlier draft, while
    // a tool-using message keeps its text connected across its own boundary.
    const boundaryPending = pendingMessageSeparator || sawToolUseSinceText;
    const isToolSplitBoundary = pendingMessageSeparator
      ? previousMessageHadToolUse
      : sawToolUseSinceText;
    const separator =
      boundaryPending && assistantText ? missingMessageBoundarySeparator(assistantText, delta) : "";
    if (boundaryPending && assistantText) {
      currentMessageStart = assistantText.length + separator.length;
      // Text before a non-tool boundary may be a superseded draft; only text
      // connected to the result through tool splits stays a candidate.
      if (!isToolSplitBoundary) {
        preserveFrom = currentMessageStart;
      }
    }
    pendingMessageSeparator = false;
    sawToolUseSinceText = false;
    const deltaText = `${separator}${delta}`;
    assistantText = `${assistantText}${deltaText}`;
    params.onAssistantDelta({ text: assistantText, delta: deltaText, sessionId, usage });
  };

  const emitTaggedReasoning = (delta: string) => {
    if (!delta) {
      return;
    }
    currentTaggedReasoningText = `${currentTaggedReasoningText}${delta}`;
    // Native thinking is the provider-authored shape and remains authoritative
    // when a text block mirrors it with tags.
    if (!thinkingTracker.emittedText) {
      params.onThinkingDelta?.({
        text: currentTaggedReasoningText,
        delta,
        isReasoningSnapshot: true,
      });
    }
  };

  const routeTaggedReasoningDeltas = (deltas: readonly ReasoningTagTextDelta[]) => {
    for (const delta of deltas) {
      if (delta.kind === "thinking") {
        emitTaggedReasoning(delta.text);
      } else {
        emitClaudeVisibleText(delta.text);
      }
    }
  };

  const finishTaggedReasoningMessage = () => {
    if (claudeStreamJson) {
      routeTaggedReasoningDeltas(taggedReasoningRouter.finish());
    }
  };

  const beginTaggedReasoningMessage = () => {
    finishTaggedReasoningMessage();
    taggedReasoningRouter = createLeadingTaggedReasoningRouter();
    currentTaggedReasoningText = "";
  };

  const updateSessionId = (nextSessionId: string | undefined) => {
    const normalized = nextSessionId?.trim();
    if (!normalized || normalized === sessionId) {
      return;
    }
    sessionId = normalized;
    params.onSessionId?.(normalized);
  };

  const handleCustomJsonlEvent = (event: CliBackendParsedJsonlEvent) => {
    if (output?.errorText && event.kind !== "sessionId" && event.kind !== "result") {
      return;
    }
    sawCustomJsonlEvent = true;
    if (event.kind === "sessionId") {
      updateSessionId(event.sessionId);
      if (output) {
        output = { ...output, sessionId };
      }
      return;
    }
    if (event.kind === "text") {
      if (!event.text) {
        return;
      }
      assistantText = `${assistantText}${event.text}`;
      params.onAssistantDelta({
        text: assistantText,
        delta: event.text,
        sessionId,
        usage,
      });
      return;
    }
    if (event.kind === "thinking") {
      if (!event.text || !params.onThinkingDelta) {
        return;
      }
      customThinkingText = `${customThinkingText}${event.text}`;
      params.onThinkingDelta({
        text: customThinkingText,
        delta: event.text,
        isReasoningSnapshot: true,
      });
      return;
    }
    if (event.kind === "toolStart") {
      emitToolStartOnce(
        toolTracker,
        event.toolCallId,
        event.name,
        "tool_use",
        event.args ?? {},
        params.onDisplayToolUseStart ?? params.onToolUseStart,
      );
      return;
    }
    if (event.kind === "toolResult") {
      if (event.name) {
        toolTracker.nameById.set(event.toolCallId, event.name);
      }
      emitToolResultOnce(
        toolTracker,
        event.toolCallId,
        event.isError === true,
        event.result,
        params.onDisplayToolResult ?? params.onToolResult,
      );
      return;
    }
    updateSessionId(event.sessionId);
    if (event.usage) {
      usage = event.usage;
      params.onUsage?.(event.usage, true);
    }
    const existingErrorText = output?.errorText;
    const eventText = event.text?.trim() ?? "";
    const existingText = output?.text.trim() ?? "";
    const streamedText = assistantText.trim();
    const delegatedText = texts.join("\n").trim();
    const resultText = existingErrorText
      ? existingText || delegatedText || streamedText
      : eventText || existingText || delegatedText || streamedText;
    const errorText = existingErrorText || event.errorText;
    output = {
      ...output,
      text: resultText,
      sessionId,
      usage,
      ...(errorText ? { errorText } : {}),
    };
  };

  const accountClaudeJsonlLine = (lineChars: number): boolean => {
    rawChars += lineChars + 1;
    if (rawChars <= outputLimits.maxTurnRawChars) {
      return true;
    }
    parseErrorText = streamJsonOutputLimitErrorText("raw", outputLimits.maxTurnRawChars);
    lineBuffer.pending = "";
    return false;
  };

  const handleCustomJsonlLine = (line: string, rawLine: string): boolean => {
    if (parseErrorText) {
      return true;
    }
    if (!params.parseJsonlEvent) {
      return false;
    }
    let parsed: ReturnType<CliBackendParseJsonlEvent>;
    try {
      parsed = params.parseJsonlEvent(line, {
        backendId: params.providerId,
        backend: params.backend,
      });
    } catch (error) {
      parseErrorText = truncateUtf16Safe(
        `CLI backend ${params.providerId} JSONL parser failed: ${formatErrorMessage(error)}`,
        500,
      );
      return true;
    }
    if (parsed == null) {
      return false;
    }
    if (claudeStreamJson && !accountClaudeJsonlLine(rawLine.length)) {
      return true;
    }
    for (const event of Array.isArray(parsed) ? parsed : [parsed]) {
      handleCustomJsonlEvent(event);
    }
    return true;
  };

  const handleParsedRecord = (parsed: Record<string, unknown>) => {
    if (parseErrorText) {
      return;
    }
    const parsedSessionId =
      pickCliSessionId(parsed, params.backend) ??
      (!sessionId && typeof parsed.thread_id === "string" ? parsed.thread_id.trim() : undefined);
    if (parsedSessionId && parsedSessionId !== sessionId) {
      sessionId = parsedSessionId;
      params.onSessionId?.(parsedSessionId);
    }
    const nextUsage = readCliUsage(parsed);
    const isClaudeTerminalResult =
      isClaudeStreamJsonDialect({
        backend: params.backend,
        providerId: params.providerId,
      }) && parsed.type === "result";
    if (isClaudeTerminalResult && nextUsage && usage) {
      diagnosticUsage = nextUsage;
    }
    if (nextUsage) {
      params.onUsage?.(nextUsage, isClaudeTerminalResult);
    }
    const shouldUseUsage =
      !isClaudeStreamJsonResult({
        backend: params.backend,
        providerId: params.providerId,
        parsed,
      }) || !usage;
    if (shouldUseUsage) {
      usage = nextUsage ?? usage;
    }
    if (parsed.type === "assistant" && isRecord(parsed.message)) {
      resumeCheckpointId = pickCliResumeCheckpointId({ ...params, parsed }) ?? resumeCheckpointId;
      params.onAssistantMessage?.(parsed.message);
    }
    const geminiErrorText = isGeminiStreamJsonDialect(params)
      ? readGeminiCliStreamJsonError(parsed)
      : undefined;
    if (geminiErrorText) {
      output = {
        text: "",
        sessionId,
        usage,
        errorText: preferGeminiCliStreamJsonError(output?.errorText, geminiErrorText),
      };
      return;
    }

    if (classifyClaudeCommentary && parsed.type === "result") {
      finishTaggedReasoningMessage();
      flushPendingClaudeAssistantText();
    } else if (parsed.type === "result") {
      finishTaggedReasoningMessage();
    }

    let result = parseClaudeCliJsonlResult({
      backend: params.backend,
      providerId: params.providerId,
      parsed,
      sessionId,
      usage,
    });
    if (result) {
      if (result.errorText) {
        output = result;
        return;
      }
      if (claudeStreamJson && result.text) {
        const taggedResult = partitionLeadingTaggedReasoning(result.text, true);
        if (!taggedResult.pending && taggedResult.reasoningText) {
          if (
            !thinkingTracker.emittedText &&
            taggedResult.reasoningText !== currentTaggedReasoningText
          ) {
            currentTaggedReasoningText = "";
            emitTaggedReasoning(taggedResult.reasoningText);
          }
          result = { ...result, text: taggedResult.visibleText.trim() };
        }
      }
      // Empty terminal result can follow already-streamed text; keep that text.
      const streamedText = assistantText.slice(segmentStart).trim();
      const preservedCandidate = assistantText.slice(preserveFrom).trim();
      const keepStreamed = preferStreamedClaudeTextOverResult({
        streamedText: preservedCandidate,
        finalMessageText: assistantText.slice(currentMessageStart).trim(),
        resultText: result.text,
      });
      const nextText = (
        keepStreamed ? preservedCandidate : result.text || streamedText || texts.join("\n").trim()
      ).trim();
      const previousText = output?.text?.trim() ?? "";
      // Claude Code may emit an interim result while background agents run, then
      // a second result after task-notification. Preserve earlier result text
      // when the later envelope does not already include it.
      let text = nextText;
      if (
        previousText &&
        nextText &&
        previousText !== nextText &&
        !nextText.startsWith(previousText)
      ) {
        text = `${previousText}\n${nextText}`;
      } else if (!nextText) {
        text = previousText;
      }
      output = {
        ...result,
        text,
        ...(resumeCheckpointId ? { resumeCheckpointId } : {}),
        ...(diagnosticUsage ? { diagnosticUsage } : {}),
      };
      // An interim result commits its segment. Rebase boundary state so later
      // text is judged on its own, while delta snapshots stay cumulative.
      segmentStart = assistantText.length;
      currentMessageStart = segmentStart;
      preserveFrom = segmentStart;
      pendingMessageSeparator = false;
      sawToolUseSinceText = false;
      currentMessageHadToolUse = false;
      previousMessageHadToolUse = false;
      return;
    }

    const item = isRecord(parsed.item) ? parsed.item : null;
    if (item?.type === "todo_list" && Array.isArray(item.items)) {
      const steps = item.items.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.text !== "string") {
          return [];
        }
        return [
          {
            step: entry.text,
            // codex exec JSONL exposes only a completed boolean for todo items.
            status: entry.completed === true ? ("completed" as const) : ("pending" as const),
          },
        ];
      });
      if (steps.length > 0) {
        params.onPlanUpdate?.({ steps });
      }
    }
    if (item && typeof item.text === "string") {
      const type = normalizeLowercaseStringOrEmpty(item.type);
      if (!type || type.includes("message")) {
        texts.push(item.text);
      }
    }

    if (parsed.type === "stream_event" && isRecord(parsed.event)) {
      const evt = parsed.event;
      // Tool-split turns stream as separate assistant messages. Mark the
      // boundary so accumulated text joins with a paragraph break instead of
      // gluing the pre-tool text to the next message's first delta.
      if (evt.type === "message_start") {
        beginTaggedReasoningMessage();
        pendingMessageSeparator = true;
        previousMessageHadToolUse = currentMessageHadToolUse;
        currentMessageHadToolUse = false;
      } else if (evt.type === "message_stop") {
        finishTaggedReasoningMessage();
      }
      const isToolUseBlockStart =
        evt.type === "content_block_start" &&
        isRecord(evt.content_block) &&
        isClaudeToolUseBlockType(evt.content_block.type);
      if (isToolUseBlockStart) {
        sawToolUseSinceText = true;
        currentMessageHadToolUse = true;
      }
      if (classifyClaudeCommentary) {
        if (isToolUseBlockStart) {
          flushPendingClaudeCommentaryText();
        } else if (evt.type === "content_block_start" || evt.type === "message_stop") {
          flushPendingClaudeAssistantText();
        }
      }
    }

    if (params.onThinkingDelta || params.onThinkingProgress) {
      dispatchClaudeCliThinking({
        backend: params.backend,
        providerId: params.providerId,
        parsed,
        tracker: thinkingTracker,
        onThinkingDelta: params.onThinkingDelta,
        onThinkingProgress: params.onThinkingProgress,
      });
    }

    if (params.onToolUseStart || params.onToolResult) {
      dispatchGeminiCliStreamingToolEvent({
        backend: params.backend,
        providerId: params.providerId,
        parsed,
        tracker: toolTracker,
        onToolUseStart: params.onToolUseStart,
        onToolResult: params.onToolResult,
      });
      dispatchClaudeCliStreamingToolEvent({
        backend: params.backend,
        providerId: params.providerId,
        parsed,
        tracker: toolTracker,
        onToolUseStart: params.onToolUseStart,
        onToolResult: params.onToolResult,
      });
    }

    const delta = parseClaudeCliStreamingDelta({
      backend: params.backend,
      providerId: params.providerId,
      parsed,
      textSoFar: assistantText,
      sessionId,
      usage,
    });
    if (!delta) {
      if (
        isGeminiStreamJsonDialect(params) &&
        parsed.type === "message" &&
        parsed.role === "assistant" &&
        typeof parsed.content === "string"
      ) {
        const deltaText = parsed.content;
        if (deltaText) {
          assistantText = `${assistantText}${deltaText}`;
          params.onAssistantDelta({
            text: assistantText,
            delta: deltaText,
            sessionId,
            usage,
          });
        }
      } else if (
        isGeminiStreamJsonDialect(params) &&
        parsed.type === "result" &&
        parsed.status === "success"
      ) {
        output = {
          text: assistantText.trim(),
          sessionId,
          usage,
        };
      }
      return;
    }
    if (claudeStreamJson) {
      routeTaggedReasoningDeltas(taggedReasoningRouter.push(delta.delta));
      return;
    }
    emitClaudeVisibleText(delta.delta);
  };

  const handleJsonlLine = (rawLine: string) => {
    if (parseErrorText) {
      return;
    }
    const line = rawLine.trim();
    if (!line && !claudeStreamJson) {
      return;
    }
    rawLines += 1;
    if (rawLines > outputLimits.maxTurnLines) {
      parseErrorText = streamJsonOutputLimitErrorText("lines", outputLimits.maxTurnLines);
      lineBuffer.pending = "";
      return;
    }
    if (!line) {
      accountClaudeJsonlLine(rawLine.length);
      return;
    }
    if (handleCustomJsonlLine(line, rawLine)) {
      return;
    }
    const parsedRecords = parseJsonRecordCandidates(line);
    if (claudeStreamJson) {
      const normalized =
        parsedRecords.length === 1
          ? normalizeClaudeCliStreamJsonRecord(parsedRecords[0]!)
          : undefined;
      // Exempt actual media bytes only; JSON serialization must not erase wire whitespace.
      const retainedChars = normalized
        ? Math.max(normalized.line.length, rawLine.length - normalized.omittedRawChars)
        : rawLine.length;
      if (!accountClaudeJsonlLine(retainedChars)) {
        return;
      }
    }
    for (const parsed of parsedRecords) {
      handleParsedRecord(parsed);
    }
  };

  return {
    push(chunk: string) {
      if (!chunk || parseErrorText) {
        return;
      }
      if (!claudeStreamJson) {
        rawChars += chunk.length;
        if (rawChars > outputLimits.maxTurnRawChars) {
          parseErrorText = streamJsonOutputLimitErrorText("raw", outputLimits.maxTurnRawChars);
          lineBuffer.pending = "";
          return;
        }
      }
      if (
        !frameBoundedCliJsonlChunk(lineBuffer, chunk, outputLimits.maxPendingLineChars, (line) => {
          handleJsonlLine(line);
          return !parseErrorText;
        })
      ) {
        parseErrorText = streamJsonOutputLimitErrorText("line", outputLimits.maxPendingLineChars);
      }
    },
    finish() {
      if (parseErrorText) {
        return;
      }
      const tail = lineBuffer.pending;
      lineBuffer.pending = "";
      if (tail) {
        handleJsonlLine(tail);
      }
      finishTaggedReasoningMessage();
      if (classifyClaudeCommentary) {
        flushPendingClaudeAssistantText();
      }
    },
    getErrorText() {
      return parseErrorText || null;
    },
    getOutput() {
      if (parseErrorText) {
        return {
          text: "",
          sessionId,
          usage,
          ...(diagnosticUsage ? { diagnosticUsage } : {}),
          errorText: parseErrorText,
        };
      }
      if (output) {
        return output;
      }
      if (sawCustomJsonlEvent) {
        return { text: texts.join("\n").trim() || assistantText.trim(), sessionId, usage };
      }
      if (isStreamJsonDialect(params) && assistantText.trim()) {
        return {
          text: assistantText.trim(),
          sessionId,
          usage,
          ...(resumeCheckpointId ? { resumeCheckpointId } : {}),
        };
      }
      const text = texts.join("\n").trim();
      return text
        ? { text, sessionId, usage, ...(resumeCheckpointId ? { resumeCheckpointId } : {}) }
        : null;
    },
  };
}

/** Parses complete JSONL CLI output into the final assistant result and metadata. */
/** Parses complete JSONL output from a CLI backend into normalized text and metadata. */
function parseCliJsonl(
  raw: string,
  backend: CliBackendConfig,
  providerId: string,
): CliOutput | null {
  const lines = normalizeStringEntries(raw.split(/\r?\n/g));
  if (lines.length === 0) {
    return null;
  }
  let sessionId: string | undefined;
  let resumeCheckpointId: string | undefined;
  let usage: CliUsage | undefined;
  let diagnosticUsage: CliUsage | undefined;
  const texts: string[] = [];
  let streamJsonText = "";
  let pendingMessageSeparator = false;
  let currentMessageStart = 0;
  let segmentStart = 0;
  let preserveFrom = 0;
  let sawToolUseSinceText = false;
  let currentMessageHadToolUse = false;
  let previousMessageHadToolUse = false;
  let committedResult: CliOutput | null = null;
  let geminiErrorText: string | undefined;
  let sawGeminiStructuredOutput = false;
  const streamJsonDialect = isStreamJsonDialect({ backend, providerId });
  for (const line of lines) {
    for (const parsed of parseJsonRecordCandidates(line)) {
      sessionId = pickCliSessionId(parsed, backend) ?? sessionId;
      if (!sessionId && typeof parsed.thread_id === "string") {
        sessionId = parsed.thread_id.trim();
      }
      resumeCheckpointId =
        pickCliResumeCheckpointId({ backend, providerId, parsed }) ?? resumeCheckpointId;
      const nextUsage = readCliUsage(parsed);
      const isClaudeTerminalResult =
        isClaudeStreamJsonDialect({ backend, providerId }) && parsed.type === "result";
      if (isClaudeTerminalResult && nextUsage && usage) {
        diagnosticUsage = nextUsage;
      }
      const shouldUseUsage = !isClaudeStreamJsonResult({ backend, providerId, parsed }) || !usage;
      if (shouldUseUsage) {
        usage = nextUsage ?? usage;
      }

      if (isGeminiStreamJsonDialect({ backend, providerId })) {
        const nextGeminiErrorText = readGeminiCliStreamJsonError(parsed);
        if (nextGeminiErrorText) {
          geminiErrorText = preferGeminiCliStreamJsonError(geminiErrorText, nextGeminiErrorText);
          sawGeminiStructuredOutput = true;
          continue;
        }
        if (
          parsed.type === "message" &&
          parsed.role === "assistant" &&
          typeof parsed.content === "string"
        ) {
          streamJsonText = `${streamJsonText}${parsed.content}`;
          sawGeminiStructuredOutput = true;
          continue;
        }
        if (
          parsed.type === "tool_use" ||
          parsed.type === "tool_result" ||
          parsed.type === "result"
        ) {
          sawGeminiStructuredOutput = true;
        }
      }

      const claudeResult = parseClaudeCliJsonlResult({
        backend,
        providerId,
        parsed,
        sessionId,
        usage,
      });
      if (claudeResult) {
        if (claudeResult.errorText) {
          return {
            ...claudeResult,
            ...(resumeCheckpointId ? { resumeCheckpointId } : {}),
          };
        }
        // Live sessions reparse the completed JSONL transcript, so preserve
        // streamed text here as well as in the incremental parser above, and
        // keep scanning: an interim result can be followed by more stream
        // events and the actual terminal result.
        const streamedText = streamJsonText.slice(segmentStart).trim();
        const preservedCandidate = streamJsonText.slice(preserveFrom).trim();
        const keepStreamed = preferStreamedClaudeTextOverResult({
          streamedText: preservedCandidate,
          finalMessageText: streamJsonText.slice(currentMessageStart).trim(),
          resultText: claudeResult.text,
        });
        const nextText = (
          keepStreamed
            ? preservedCandidate
            : claudeResult.text || streamedText || texts.join("\n").trim()
        ).trim();
        const previousText = committedResult?.text?.trim() ?? "";
        let text = nextText;
        if (
          previousText &&
          nextText &&
          previousText !== nextText &&
          !nextText.startsWith(previousText)
        ) {
          text = `${previousText}\n${nextText}`;
        } else if (!nextText) {
          text = previousText;
        }
        committedResult = {
          ...claudeResult,
          text,
          ...(resumeCheckpointId ? { resumeCheckpointId } : {}),
          ...(diagnosticUsage ? { diagnosticUsage } : {}),
        };
        segmentStart = streamJsonText.length;
        currentMessageStart = segmentStart;
        preserveFrom = segmentStart;
        pendingMessageSeparator = false;
        sawToolUseSinceText = false;
        currentMessageHadToolUse = false;
        previousMessageHadToolUse = false;
        continue;
      }

      if (parsed.type === "stream_event" && isRecord(parsed.event)) {
        // Same boundary contracts as the incremental parser above.
        if (parsed.event.type === "message_start") {
          pendingMessageSeparator = true;
          previousMessageHadToolUse = currentMessageHadToolUse;
          currentMessageHadToolUse = false;
        }
        if (
          parsed.event.type === "content_block_start" &&
          isRecord(parsed.event.content_block) &&
          isClaudeToolUseBlockType(parsed.event.content_block.type)
        ) {
          sawToolUseSinceText = true;
          currentMessageHadToolUse = true;
        }
      }
      const claudeDelta = parseClaudeCliStreamingDelta({
        backend,
        providerId,
        parsed,
        textSoFar: streamJsonText,
        sessionId,
        usage,
      });
      if (claudeDelta) {
        const boundaryPending = pendingMessageSeparator || sawToolUseSinceText;
        const isToolSplitBoundary = pendingMessageSeparator
          ? previousMessageHadToolUse
          : sawToolUseSinceText;
        const separator =
          boundaryPending && streamJsonText
            ? missingMessageBoundarySeparator(streamJsonText, claudeDelta.delta)
            : "";
        if (boundaryPending && streamJsonText) {
          currentMessageStart = streamJsonText.length + separator.length;
          if (!isToolSplitBoundary) {
            preserveFrom = currentMessageStart;
          }
        }
        pendingMessageSeparator = false;
        sawToolUseSinceText = false;
        streamJsonText = `${streamJsonText}${separator}${claudeDelta.delta}`;
        continue;
      }

      const item = isRecord(parsed.item) ? parsed.item : null;
      if (item && typeof item.text === "string") {
        const type = normalizeLowercaseStringOrEmpty(item.type);
        if (!type || type.includes("message")) {
          texts.push(item.text);
        }
      }
    }
  }
  if (committedResult) {
    return committedResult;
  }
  if (isGeminiStreamJsonDialect({ backend, providerId }) && geminiErrorText) {
    return { text: "", sessionId, usage, errorText: geminiErrorText };
  }
  if (streamJsonDialect && (streamJsonText.trim() || sawGeminiStructuredOutput)) {
    return {
      text: streamJsonText.trim(),
      sessionId,
      usage,
      ...(resumeCheckpointId ? { resumeCheckpointId } : {}),
    };
  }
  if (streamJsonDialect) {
    return { text: "", sessionId, usage, errorText: CLI_STREAM_JSON_MISSING_RESULT_ERROR };
  }
  const text = texts.join("\n").trim();
  if (!text) {
    return null;
  }
  return { text, sessionId, usage };
}

/** Parses CLI output according to the backend output mode with text fallback. */
/** Parses CLI backend output using the configured JSON/JSONL/plain-text mode. */
export function parseCliOutput(params: {
  raw: string;
  backend: CliBackendConfig;
  providerId: string;
  outputMode?: "json" | "jsonl" | "text";
  fallbackSessionId?: string;
}): CliOutput {
  const outputMode = params.outputMode ?? "text";
  if (outputMode === "text") {
    return { text: params.raw.trim(), sessionId: params.fallbackSessionId };
  }
  if (outputMode === "jsonl") {
    const parsed = parseCliJsonl(params.raw, params.backend, params.providerId);
    if (parsed) {
      return parsed;
    }
    if (isStreamJsonDialect(params)) {
      return {
        text: "",
        sessionId: params.fallbackSessionId,
        errorText: CLI_STREAM_JSON_MISSING_RESULT_ERROR,
      };
    }
    return { text: params.raw.trim(), sessionId: params.fallbackSessionId };
  }
  return (
    parseCliJson(params.raw, params.backend, params.providerId) ?? {
      text: params.raw.trim(),
      sessionId: params.fallbackSessionId,
    }
  );
}

/** Extracts the most specific structured CLI error message from mixed or JSON output. */
/** Extracts a human-readable error message from mixed CLI stderr/stdout text. */
export function extractCliErrorMessage(raw: string): string | null {
  const parsedRecords = parseJsonRecordCandidates(raw);
  if (parsedRecords.length === 0) {
    return null;
  }

  let errorText = "";
  for (const parsed of parsedRecords) {
    const next = collectExplicitCliErrorText(parsed);
    if (next) {
      errorText = next;
    }
  }

  return errorText || null;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
