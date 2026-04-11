import type { CliBackendConfig } from "../config/types.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { isRecord } from "../utils.js";

type CliUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

export type CliOutput = {
  text: string;
  sessionId?: string;
  usage?: CliUsage;
};

export type CliStreamingDelta = {
  text: string;
  delta: string;
  sessionId?: string;
  usage?: CliUsage;
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

function extractJsonObjectCandidates(raw: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      if (inString) {
        escaped = true;
      }
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(raw.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return candidates;
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
  const pick = (key: string) =>
    typeof raw[key] === "number" && raw[key] > 0 ? raw[key] : undefined;
  const totalInput = pick("input_tokens") ?? pick("inputTokens");
  const output = pick("output_tokens") ?? pick("outputTokens");
  const cacheRead =
    pick("cache_read_input_tokens") ??
    pick("cached_input_tokens") ??
    pick("cacheRead") ??
    pick("cached");
  const input =
    pick("input") ??
    (Object.hasOwn(raw, "cached") && typeof totalInput === "number"
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

export function parseCliJson(raw: string, backend: CliBackendConfig): CliOutput | null {
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
    const trimmedText = nextText.trim();
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
    const resultText = params.parsed.result.trim();
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

export function createCliJsonlStreamingParser(params: {
  backend: CliBackendConfig;
  providerId: string;
  onAssistantDelta: (delta: CliStreamingDelta) => void;
}) {
  let lineBuffer = "";
  let assistantText = "";
  let sessionId: string | undefined;
  let usage: CliUsage | undefined;

  const handleParsedRecord = (parsed: Record<string, unknown>) => {
    sessionId = pickCliSessionId(parsed, params.backend) ?? sessionId;
    if (!sessionId && typeof parsed.thread_id === "string") {
      sessionId = parsed.thread_id.trim();
    }
    if (isRecord(parsed.usage)) {
      usage = toCliUsage(parsed.usage) ?? usage;
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
  };
}

export function parseCliJsonl(
  raw: string,
  backend: CliBackendConfig,
  providerId: string,
): CliOutput | null {
  const lines = raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return null;
  }
  let sessionId: string | undefined;
  let usage: CliUsage | undefined;
  const texts: string[] = [];
  for (const line of lines) {
    for (const parsed of parseJsonRecordCandidates(line)) {
      if (!sessionId) {
        sessionId = pickCliSessionId(parsed, backend);
      }
      if (!sessionId && typeof parsed.thread_id === "string") {
        sessionId = parsed.thread_id.trim();
      }
      usage = readCliUsage(parsed) ?? usage;

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
    parseCliJson(params.raw, params.backend) ?? {
      text: params.raw.trim(),
      sessionId: params.fallbackSessionId,
    }
  );
}

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
