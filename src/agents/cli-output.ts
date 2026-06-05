/**
 * Parses output from CLI-backed model providers. It supports plain text, JSON,
 * JSONL streaming, Claude stream-json dialects, usage metadata, and tool event
 * reconstruction.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { CliBackendConfig } from "../config/types.js";
import { extractBalancedJsonFragments } from "../shared/balanced-json.js";
import { isRecord } from "../utils.js";

type CliUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

/** Normalized result from a CLI-backed model provider turn. */
export type CliOutput = {
  text: string;
  rawText?: string;
  sessionId?: string;
  usage?: CliUsage;
  finalPromptText?: string;
};

/** Incremental assistant text emitted while parsing a streaming CLI response. */
export type CliStreamingDelta = {
  text: string;
  delta: string;
  sessionId?: string;
  usage?: CliUsage;
};

/** Tool-call start event reconstructed from CLI stream output. */
export type CliToolUseStartDelta = {
  toolCallId: string;
  name: string;
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

function usesClaudeStreamJsonDialect(params: {
  backend: CliBackendConfig;
  providerId: string;
}): boolean {
  return (
    params.backend.jsonlDialect === "claude-stream-json" || isClaudeCliProvider(params.providerId)
  );
}

function isClaudeStreamJsonResult(params: {
  backend: CliBackendConfig;
  providerId: string;
  parsed: Record<string, unknown>;
}): boolean {
  return usesClaudeStreamJsonDialect(params) && params.parsed.type === "result";
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
  const nested = readNestedErrorMessage(parsed);
  if (nested) {
    return unwrapCliErrorText(nested);
  }

  if (parsed.is_error === true && typeof parsed.result === "string") {
    return unwrapCliErrorText(parsed.result);
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

/** Parses JSON CLI output, including mixed stdout that contains embedded JSON objects. */
/** Parses a single JSON payload emitted by a CLI backend. */
export function parseCliJson(
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
  if (!usesClaudeStreamJsonDialect(params)) {
    return null;
  }
  if (
    typeof params.parsed.type === "string" &&
    params.parsed.type === "result" &&
    typeof params.parsed.result === "string"
  ) {
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
  if (!usesClaudeStreamJsonDialect(params)) {
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
  args: Record<string, unknown>,
  onToolUseStart?: (delta: CliToolUseStartDelta) => void,
): void {
  // Streaming and final assistant records may both describe the same tool call.
  if (tracker.startedIds.has(toolCallId)) {
    return;
  }
  tracker.startedIds.add(toolCallId);
  tracker.nameById.set(toolCallId, name);
  onToolUseStart?.({ toolCallId, name, args });
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

function isClaudeToolUseBlockType(type: unknown): boolean {
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
  if (!usesClaudeStreamJsonDialect(params)) {
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
          tracker.pendingByIndex.set(event.index, { toolCallId, name, inputJsonParts: [] });
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
        emitToolStartOnce(tracker, toolCallId, name, args, params.onToolUseStart);
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

/** Creates an incremental JSONL parser for CLI streaming responses and tool events. */
/** Creates a stateful parser for streaming JSONL CLI backend output. */
export function createCliJsonlStreamingParser(params: {
  backend: CliBackendConfig;
  providerId: string;
  onAssistantDelta: (delta: CliStreamingDelta) => void;
  onToolUseStart?: (delta: CliToolUseStartDelta) => void;
  onToolResult?: (delta: CliToolResultDelta) => void;
}) {
  let lineBuffer = "";
  let assistantText = "";
  let sessionId: string | undefined;
  let usage: CliUsage | undefined;
  let output: CliOutput | null = null;
  const texts: string[] = [];
  const toolTracker = createToolUseTracker();

  const handleParsedRecord = (parsed: Record<string, unknown>) => {
    sessionId = pickCliSessionId(parsed, params.backend) ?? sessionId;
    if (!sessionId && typeof parsed.thread_id === "string") {
      sessionId = parsed.thread_id.trim();
    }
    const nextUsage = readCliUsage(parsed);
    const shouldUseUsage =
      !isClaudeStreamJsonResult({
        backend: params.backend,
        providerId: params.providerId,
        parsed,
      }) || !usage;
    if (shouldUseUsage) {
      usage = nextUsage ?? usage;
    }

    const result = parseClaudeCliJsonlResult({
      backend: params.backend,
      providerId: params.providerId,
      parsed,
      sessionId,
      usage,
    });
    if (result) {
      output = result;
      return;
    }

    const item = isRecord(parsed.item) ? parsed.item : null;
    if (item && typeof item.text === "string") {
      const type = normalizeLowercaseStringOrEmpty(item.type);
      if (!type || type.includes("message")) {
        texts.push(item.text);
      }
    }

    if (params.onToolUseStart || params.onToolResult) {
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
      return;
    }
    assistantText = delta.text;
    params.onAssistantDelta(delta);
  };

  const flushLines = (flushPartial: boolean) => {
    while (true) {
      const newlineIndex = lineBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      const line = lineBuffer.slice(0, newlineIndex).trim();
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
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
      if (!chunk) {
        return;
      }
      lineBuffer += chunk;
      flushLines(false);
    },
    finish() {
      flushLines(true);
    },
    getOutput() {
      if (output) {
        return output;
      }
      const text = texts.join("\n").trim();
      return text ? { text, sessionId, usage } : null;
    },
  };
}

/** Parses complete JSONL CLI output into the final assistant result and metadata. */
/** Parses complete JSONL output from a CLI backend into normalized text and metadata. */
export function parseCliJsonl(
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

      const claudeResult = parseClaudeCliJsonlResult({
        backend,
        providerId,
        parsed,
        sessionId,
        usage,
      });
      if (claudeResult) {
        return claudeResult;
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
    return (
      parseCliJsonl(params.raw, params.backend, params.providerId) ?? {
        text: params.raw.trim(),
        sessionId: params.fallbackSessionId,
      }
    );
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
