/**
 * Parses output from CLI-backed model providers. It supports plain text, JSON,
 * JSONL streaming, Claude stream-json dialects, usage metadata, and tool event
 * reconstruction.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { AgentPlanStep } from "../channels/streaming.js";
import type { CliBackendConfig } from "../config/types.js";
import { extractBalancedJsonFragments } from "../shared/balanced-json.js";
import { isRecord } from "../utils.js";
import type {
  MessagingToolSend,
  MessagingToolSourceReplyPayload,
} from "./embedded-agent-messaging.types.js";

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
  usage?: CliUsage;
  /** Terminal cumulative turn usage for diagnostics; reply accounting keeps using `usage`. */
  diagnosticUsage?: CliUsage;
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
  const readNestedCached = (key: "input_tokens_details" | "prompt_tokens_details") => {
    const nested = raw[key];
    if (!isRecord(nested)) {
      return undefined;
    }
    return typeof nested.cached_tokens === "number" && nested.cached_tokens > 0
      ? nested.cached_tokens
      : undefined;
  };
  const pick = (key: string) =>
    typeof raw[key] === "number" && raw[key] > 0 ? raw[key] : undefined;
  const totalInput = pick("input_tokens") ?? pick("inputTokens");
  const output = pick("output_tokens") ?? pick("outputTokens");
  const nestedCached =
    readNestedCached("input_tokens_details") ?? readNestedCached("prompt_tokens_details");
  const cacheRead =
    pick("cache_read_input_tokens") ??
    pick("cached_input_tokens") ??
    pick("cacheRead") ??
    pick("cached") ??
    nestedCached;
  const input =
    pick("input") ??
    ((Object.hasOwn(raw, "cached") || nestedCached !== undefined) && typeof totalInput === "number"
      ? Math.max(0, totalInput - (cacheRead ?? 0))
      : totalInput);
  const cacheWrite =
    pick("cache_creation_input_tokens") ?? pick("cache_write_input_tokens") ?? pick("cacheWrite");
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

/** Creates a stateful parser for streaming JSONL CLI backend output. */
export function createCliJsonlStreamingParser(params: {
  backend: CliBackendConfig;
  providerId: string;
  onAssistantDelta: (delta: CliStreamingDelta) => void;
  onThinkingDelta?: (delta: CliThinkingDelta) => void;
  onThinkingProgress?: (progress: CliThinkingProgress) => void;
  onPlanUpdate?: (update: CliPlanUpdate) => void;
  onToolUseStart?: (delta: CliToolUseStartDelta) => void;
  onToolResult?: (delta: CliToolResultDelta) => void;
  onCommentaryText?: (text: string) => void;
  onSessionId?: (sessionId: string) => void;
  onAssistantMessage?: (message: unknown) => void;
  onUsage?: (usage: CliUsage, terminal: boolean) => void;
}) {
  let lineBuffer = "";
  let assistantText = "";
  let pendingClaudeText = "";
  let sessionId: string | undefined;
  let usage: CliUsage | undefined;
  let diagnosticUsage: CliUsage | undefined;
  let output: CliOutput | null = null;
  let parseErrorText = "";
  let rawChars = 0;
  let rawLines = 0;
  const texts: string[] = [];
  const toolTracker = createToolUseTracker();
  const outputLimits = resolveCliStreamJsonOutputLimits(params.backend);
  // Classification is keyed on consumer presence so reclassified pre-tool text
  // always has a destination; a separate enable flag let it be dropped (#92092).
  const classifyClaudeCommentary =
    Boolean(params.onCommentaryText) && supportsCliJsonlToolEvents(params);
  const thinkingTracker = createThinkingTracker();

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
      flushPendingClaudeAssistantText();
    }

    const result = parseClaudeCliJsonlResult({
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
      // Empty terminal result can follow already-streamed text; keep that text.
      const nextText = (result.text || assistantText.trim() || texts.join("\n").trim()).trim();
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
        ...(diagnosticUsage ? { diagnosticUsage } : {}),
      };
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

    if (classifyClaudeCommentary && parsed.type === "stream_event" && isRecord(parsed.event)) {
      const evt = parsed.event;
      if (
        evt.type === "content_block_start" &&
        isRecord(evt.content_block) &&
        isClaudeToolUseBlockType(evt.content_block.type)
      ) {
        flushPendingClaudeCommentaryText();
      } else if (evt.type === "content_block_start" || evt.type === "message_stop") {
        flushPendingClaudeAssistantText();
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
    if (classifyClaudeCommentary) {
      pendingClaudeText = `${pendingClaudeText}${delta.delta}`;
      return;
    }
    assistantText = delta.text;
    params.onAssistantDelta(delta);
  };

  const flushLines = (flushPartial: boolean) => {
    while (true) {
      if (parseErrorText) {
        return;
      }
      const newlineIndex = lineBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      const line = lineBuffer.slice(0, newlineIndex).trim();
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      rawLines += 1;
      if (rawLines > outputLimits.maxTurnLines) {
        parseErrorText = streamJsonOutputLimitErrorText("lines", outputLimits.maxTurnLines);
        lineBuffer = "";
        return;
      }
      for (const parsed of parseJsonRecordCandidates(line)) {
        handleParsedRecord(parsed);
      }
    }
    if (!flushPartial) {
      return;
    }
    const tail = lineBuffer.trim();
    lineBuffer = "";
    if (!tail) {
      return;
    }
    for (const parsed of parseJsonRecordCandidates(tail)) {
      handleParsedRecord(parsed);
    }
  };

  return {
    push(chunk: string) {
      if (!chunk || parseErrorText) {
        return;
      }
      rawChars += chunk.length;
      if (rawChars > outputLimits.maxTurnRawChars) {
        parseErrorText = streamJsonOutputLimitErrorText("raw", outputLimits.maxTurnRawChars);
        lineBuffer = "";
        return;
      }
      if (lineBuffer.length + chunk.length > outputLimits.maxPendingLineChars) {
        parseErrorText = streamJsonOutputLimitErrorText("line", outputLimits.maxPendingLineChars);
        lineBuffer = "";
        return;
      }
      lineBuffer += chunk;
      flushLines(false);
    },
    finish() {
      if (parseErrorText) {
        return;
      }
      flushLines(true);
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
      if (isStreamJsonDialect(params) && assistantText.trim()) {
        return { text: assistantText.trim(), sessionId, usage };
      }
      const text = texts.join("\n").trim();
      return text ? { text, sessionId, usage } : null;
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
  let usage: CliUsage | undefined;
  const texts: string[] = [];
  let streamJsonText = "";
  let geminiErrorText: string | undefined;
  let sawGeminiStructuredOutput = false;
  const streamJsonDialect = isStreamJsonDialect({ backend, providerId });
  for (const line of lines) {
    for (const parsed of parseJsonRecordCandidates(line)) {
      sessionId = pickCliSessionId(parsed, backend) ?? sessionId;
      if (!sessionId && typeof parsed.thread_id === "string") {
        sessionId = parsed.thread_id.trim();
      }
      const nextUsage = readCliUsage(parsed);
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
        if (claudeResult.text || claudeResult.errorText) {
          return claudeResult;
        }
        // Live sessions reparse the completed JSONL transcript, so preserve
        // streamed text here as well as in the incremental parser above.
        return { ...claudeResult, text: streamJsonText.trim() || texts.join("\n").trim() };
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
        streamJsonText = claudeDelta.text;
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
  if (isGeminiStreamJsonDialect({ backend, providerId }) && geminiErrorText) {
    return { text: "", sessionId, usage, errorText: geminiErrorText };
  }
  if (streamJsonDialect && (streamJsonText.trim() || sawGeminiStructuredOutput)) {
    return { text: streamJsonText.trim(), sessionId, usage };
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
