import { extractBalancedJsonFragments } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { CliBackendConfig } from "../plugins/cli-backend.types.js";
import type { CliOutput, CliTerminalFailure, CliUsage } from "./cli-output-contracts.js";
import { normalizeUsage, type UsageLike } from "./usage.js";

function isClaudeCliProvider(providerId: string): boolean {
  return normalizeLowercaseStringOrEmpty(providerId) === "claude-cli";
}

function isGeminiCliProvider(providerId: string): boolean {
  return normalizeLowercaseStringOrEmpty(providerId) === "google-gemini-cli";
}

export function isGeminiStreamJsonDialect(params: {
  backend: CliBackendConfig;
  providerId: string;
}): boolean {
  return (
    params.backend.jsonlDialect === "gemini-stream-json" || isGeminiCliProvider(params.providerId)
  );
}

export function isClaudeStreamJsonDialect(params: {
  backend: CliBackendConfig;
  providerId: string;
}): boolean {
  if (params.backend.jsonlDialect) {
    return params.backend.jsonlDialect === "claude-stream-json";
  }
  return isClaudeCliProvider(params.providerId);
}

export function isStreamJsonDialect(params: {
  backend: CliBackendConfig;
  providerId: string;
}): boolean {
  return supportsCliJsonlToolEvents(params);
}

/** Returns whether JSONL output carries correlated provider tool events. */
export function supportsCliJsonlToolEvents(params: {
  backend: CliBackendConfig;
  providerId: string;
}): boolean {
  return (
    params.backend.jsonlDialect === "claude-stream-json" ||
    isClaudeCliProvider(params.providerId) ||
    isGeminiStreamJsonDialect(params)
  );
}

export function isClaudeStreamJsonResult(params: {
  backend: CliBackendConfig;
  providerId: string;
  parsed: Record<string, unknown>;
}): boolean {
  return supportsCliJsonlToolEvents(params) && params.parsed.type === "result";
}

function extractJsonObjectCandidates(raw: string): string[] {
  return extractBalancedJsonFragments(raw, { openers: ["{"] }).map((fragment) => fragment.json);
}

export function decodeCliRecords(raw: string): Record<string, unknown>[] {
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
  for (const parsed of decodeCliRecords(trimmed)) {
    const nested = readNestedErrorMessage(parsed);
    if (nested) {
      return nested;
    }
  }
  return trimmed;
}

function normalizeCliUsageRecord(raw: unknown): CliUsage | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const usageRaw = raw as UsageLike;
  const usage = normalizeUsage(usageRaw);
  if (!usage) {
    return undefined;
  }
  const reportedInputTotal = [
    usageRaw.inputTokens,
    usageRaw.input_tokens,
    usageRaw.promptTokens,
    usageRaw.prompt_tokens,
  ].some((value) => typeof value === "number" && value > 0);
  const cacheAdjustedInput =
    usage.input === 0 && reportedInputTotal && Boolean(usage.cacheRead || usage.cacheWrite);
  const cliUsage: CliUsage = {
    input: cacheAdjustedInput ? 0 : usage.input || undefined,
    output: usage.output || undefined,
    cacheRead: usage.cacheRead || undefined,
    cacheWrite: usage.cacheWrite || undefined,
    total: usage.total || undefined,
  };
  return Object.values(cliUsage).some((value) => typeof value === "number" && value > 0)
    ? cliUsage
    : undefined;
}

export function readCliUsage(parsed: Record<string, unknown>): CliUsage | undefined {
  return (
    normalizeCliUsageRecord(isRecord(parsed.message) ? parsed.message.usage : undefined) ??
    normalizeCliUsageRecord(parsed.usage) ??
    normalizeCliUsageRecord(parsed.stats)
  );
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

export function collectExplicitCliErrorText(parsed: Record<string, unknown>): string {
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

export function pickCliSessionId(
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

export function pickCliResumeCheckpointId(params: {
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

function hasExplicitCliErrorPayload(parsed: Record<string, unknown>): boolean {
  if (typeof parsed.error === "string") {
    return Boolean(parsed.error.trim());
  }
  if (isRecord(parsed.error)) {
    return Boolean(readNestedErrorMessage(parsed.error));
  }
  return false;
}

/** Parses a single JSON payload emitted by a CLI backend. */
export function parseCliJson(
  raw: string,
  backend: CliBackendConfig,
  providerId?: string,
): CliOutput | null {
  const parsedRecords = decodeCliRecords(raw);
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

export function parseClaudeCliJsonlResult(params: {
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
export function preferStreamedClaudeTextOverResult(params: {
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
export function missingMessageBoundarySeparator(previousText: string, nextDelta: string): string {
  if (!previousText) {
    return "";
  }
  const trailing = previousText.match(/\n*$/u)?.[0].length ?? 0;
  const leading = nextDelta.match(/^\n*/u)?.[0].length ?? 0;
  return "\n".repeat(Math.max(0, 2 - trailing - leading));
}

export function parseClaudeCliStreamingDelta(params: {
  backend: CliBackendConfig;
  providerId: string;
  parsed: Record<string, unknown>;
}): string | null {
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
  return delta.text;
}

const GEMINI_CLI_ERROR_EVENT_FALLBACK = "Gemini CLI emitted an error event.";
const GEMINI_CLI_RESULT_ERROR_FALLBACK = "Gemini CLI result status was error.";

function isFallbackGeminiCliStreamJsonError(errorText: string): boolean {
  return (
    errorText === GEMINI_CLI_ERROR_EVENT_FALLBACK || errorText === GEMINI_CLI_RESULT_ERROR_FALLBACK
  );
}

export function preferGeminiCliStreamJsonError(current: string | undefined, next: string): string {
  if (!current) {
    return next;
  }
  if (isFallbackGeminiCliStreamJsonError(current) && !isFallbackGeminiCliStreamJsonError(next)) {
    return next;
  }
  return current;
}

export function readGeminiCliStreamJsonError(parsed: Record<string, unknown>): string | undefined {
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
