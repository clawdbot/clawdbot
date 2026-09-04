/** Sanitizes, extracts, and classifies embedded-agent tool execution results. */
import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import {
  redactModelVisibleSecrets,
  redactModelVisibleSensitiveFieldValueWithConfig,
  redactModelVisibleToolPayloadText,
  redactSensitiveFieldValue,
  redactToolPayloadText,
} from "../logging/redact.js";
import { truncateUtf16Safe } from "../utils.js";
import { collectTextContentBlocks } from "./content-blocks.js";
import {
  isToolResultError,
  readToolResultDetails,
  readToolResultStatus,
} from "./tool-result-error.js";

const TOOL_RESULT_MAX_CHARS = 8000;
const TOOL_ERROR_MAX_CHARS = 400;
const LIVE_EXEC_OUTPUT_MAX_CHARS = 8000;
const TOOL_DENIAL_ERROR_CODES = ["SYSTEM_RUN_DENIED", "INVALID_REQUEST"] as const;
const OPAQUE_STRUCTURED_RESULT_FIELDS = new Set(["encrypted_content", "encrypted_stdout"]);
const SENSITIVE_STRUCTURED_HEADER_FIELDS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
]);

function truncateToolText(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) {
    return text;
  }
  return `${truncateUtf16Safe(text, TOOL_RESULT_MAX_CHARS)}\n…(truncated)…`;
}

export function truncateLiveExecOutput(text: string): string {
  if (text.length <= LIVE_EXEC_OUTPUT_MAX_CHARS) {
    return text;
  }
  return `${truncateUtf16Safe(text, LIVE_EXEC_OUTPUT_MAX_CHARS)}\n...(live output truncated)...`;
}

export function capLiveExecResult(result: unknown): unknown {
  const details = readToolResultDetails(result);
  if (!details || typeof details.status !== "string" || typeof details.aggregated !== "string") {
    return result;
  }
  const aggregated = truncateLiveExecOutput(details.aggregated);
  if (aggregated === details.aggregated) {
    return result;
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }
  return {
    ...(result as Record<string, unknown>),
    details: {
      ...details,
      aggregated,
    },
  };
}

function normalizeToolErrorText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? "";
  if (!firstLine) {
    return undefined;
  }
  return firstLine.length > TOOL_ERROR_MAX_CHARS
    ? `${truncateUtf16Safe(firstLine, TOOL_ERROR_MAX_CHARS)}…`
    : firstLine;
}

function isErrorLikeStatus(status: string): boolean {
  const normalized = normalizeOptionalLowercaseString(status);
  if (!normalized) {
    return false;
  }
  if (
    normalized === "0" ||
    normalized === "ok" ||
    normalized === "success" ||
    normalized === "completed" ||
    normalized === "running"
  ) {
    return false;
  }
  return /error|fail|timeout|timed[_\s-]?out|denied|cancel|invalid|forbidden/.test(normalized);
}

function readErrorCandidate(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeToolErrorText(value);
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.message === "string") {
    return normalizeToolErrorText(record.message);
  }
  if (typeof record.error === "string") {
    return normalizeToolErrorText(record.error);
  }
  return undefined;
}

function extractErrorField(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const direct = extractDirectErrorField(record);
  if (direct) {
    return direct;
  }
  const status = normalizeOptionalString(record.status) ?? "";
  if (!status || !isErrorLikeStatus(status)) {
    return undefined;
  }
  return normalizeToolErrorText(status);
}

function extractDirectErrorField(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return (
    readErrorCandidate(record.error) ??
    readErrorCandidate(record.message) ??
    readErrorCandidate(record.reason)
  );
}

function readErrorCodeField(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeOptionalString(value) : undefined;
}

function readDenialErrorCodeFromMessage(value: unknown): string | undefined {
  const message = typeof value === "string" ? normalizeOptionalString(value) : undefined;
  if (!message) {
    return undefined;
  }
  for (const code of TOOL_DENIAL_ERROR_CODES) {
    if (message === code || message.startsWith(`${code}:`)) {
      return code;
    }
  }
  return undefined;
}

function readNestedErrorCodeField(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return (
    readDenialErrorCodeFromMessage(record.message) ??
    readDenialErrorCodeFromMessage(record.error) ??
    readErrorCodeField(record.code) ??
    readErrorCodeField(record.gatewayCode)
  );
}

function extractDirectErrorCodeField(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return (
    readNestedErrorCodeField(record.error) ??
    readNestedErrorCodeField(record.nodeError) ??
    readErrorCodeField(record.code) ??
    readErrorCodeField(record.gatewayCode)
  );
}

export function buildToolLifecycleErrorResult(error: unknown): {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
} {
  const errorRecord = readRecord(error);
  const rawDetails = readRecord(errorRecord?.details);
  const nodeError = readRecord(rawDetails?.nodeError);
  const gatewayCode =
    readErrorCodeField(errorRecord?.gatewayCode) ?? readErrorCodeField(errorRecord?.code);
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: message }],
    details: {
      status: "error",
      error: message,
      ...(gatewayCode ? { gatewayCode } : {}),
      ...(nodeError ? { nodeError } : {}),
    },
  };
}

function extractAggregatedErrorField(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return readErrorCandidate(record.aggregated);
}

function redactStringsDeep(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return redactToolPayloadText(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    return value.map((item) => redactStringsDeep(item, seen));
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    const entries = Object.entries(value as Record<string, unknown>);
    for (const entry of entries) {
      entry[1] =
        typeof entry[1] === "string"
          ? redactSensitiveFieldValue(entry[0], entry[1])
          : redactStringsDeep(entry[1], seen);
    }
    return Object.fromEntries(entries);
  }
  return value;
}

export function sanitizeToolArgs(args: unknown): unknown {
  return redactStringsDeep(args);
}

export function sanitizeToolResult(result: unknown): unknown {
  if (typeof result === "string") {
    return redactModelVisibleToolPayloadText(result);
  }
  if (Array.isArray(result)) {
    return redactModelVisibleSecrets(result);
  }
  if (!result || typeof result !== "object") {
    return result;
  }
  const record = result as Record<string, unknown>;
  // Strip image data first so the deep redaction pass doesn't waste work
  // scanning base64 payloads (and so we capture the original byte counts).
  const preCleaned: Record<string, unknown> = { ...record };
  const originalContent = Array.isArray(record.content) ? record.content : null;
  if (originalContent) {
    preCleaned.content = originalContent.map((item) => {
      if (!item || typeof item !== "object") {
        return item;
      }
      const entry = item as Record<string, unknown>;
      if (readStringValue(entry.type) === "image") {
        const data = readStringValue(entry.data);
        const existingBytes = typeof entry.bytes === "number" ? entry.bytes : undefined;
        const bytes = data === undefined ? existingBytes : estimateBase64DecodedBytes(data);
        const cleaned = { ...entry };
        delete cleaned.data;
        return Object.assign(cleaned, { bytes, omitted: true });
      }
      return entry;
    });
  }
  // Deep-redact the entire result so any top-level or nested string is
  // protected, not just `details` and text content blocks.
  const out = redactModelVisibleSecrets(preCleaned);
  const content = Array.isArray(out.content) ? out.content : null;
  if (content) {
    out.content = content.map((item) => {
      if (!item || typeof item !== "object") {
        return item;
      }
      const entry = item as Record<string, unknown>;
      if (readStringValue(entry.type) === "text" && typeof entry.text === "string") {
        const text = truncateToolText(entry.text);
        // Nonplain blocks can still be caller-owned; spread keeps JSON keys as own data.
        return Object.assign({ ...entry }, { text });
      }
      return entry;
    });
  }
  return out;
}

const INLINE_DATA_URI_VALUE_PATTERN =
  /^data:(?:[a-z][a-z0-9.+-]*\/[a-z0-9.+-]+)?(?:;[a-z0-9.+-]+(?:=[^,;"'\s]+)?)*,/i;

function redactInlineDataUriValue(value: string): string {
  const trimmed = value.trimStart();
  if (!INLINE_DATA_URI_VALUE_PATTERN.test(trimmed)) {
    return value;
  }
  return `[inline data URI: ${value.length} chars]`;
}

function carriesBinaryData(record: Record<string, unknown>): boolean {
  const type = normalizeOptionalLowercaseString(record.type);
  if (type === "audio" || type === "image" || type === "base64") {
    return true;
  }
  const mediaType = normalizeOptionalLowercaseString(record.media_type ?? record.mimeType);
  return (
    mediaType?.startsWith("image/") === true ||
    mediaType?.startsWith("audio/") === true ||
    mediaType?.startsWith("video/") === true ||
    mediaType === "application/pdf"
  );
}

function sanitizeStructuredToolResultValue(
  value: unknown,
  key = "",
  parentCarriesBinaryData = false,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") {
    if (SENSITIVE_STRUCTURED_HEADER_FIELDS.has(key.toLowerCase())) {
      return "***";
    }
    if (key === "blob" || (key === "data" && parentCarriesBinaryData)) {
      return `[binary omitted: ${value.length} chars]`;
    }
    // Claude CLI result blocks carry replay-only ciphertext that is not useful display text.
    if (OPAQUE_STRUCTURED_RESULT_FIELDS.has(key)) {
      return `[opaque data omitted: ${value.length} chars]`;
    }
    return truncateToolText(
      redactInlineDataUriValue(redactModelVisibleSensitiveFieldValueWithConfig(key, value)),
    );
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    // Keep the owning key so arrays of credentials inherit the same redaction policy.
    return value.map((item) =>
      sanitizeStructuredToolResultValue(item, key, parentCarriesBinaryData, seen),
    );
  }
  const record = value as Record<string, unknown>;
  const hasBinaryData = carriesBinaryData(record);
  return Object.fromEntries(
    Object.entries(record).map(([childKey, child]) => [
      childKey,
      sanitizeStructuredToolResultValue(child, childKey, hasBinaryData, seen),
    ]),
  );
}

function stringifyStructuredToolResultContent(block: unknown): string | undefined {
  if (!block || typeof block !== "object") {
    return undefined;
  }
  const record = block as Record<string, unknown>;
  const type = readStringValue(record.type);
  if (type === "text" || type === "image" || type === "image_url" || type === "audio") {
    return undefined;
  }
  try {
    const serialized = JSON.stringify(sanitizeStructuredToolResultValue(record));
    const redacted = serialized ? redactModelVisibleToolPayloadText(serialized) : serialized;
    return redacted && redacted !== "{}" ? redacted : undefined;
  } catch {
    return undefined;
  }
}

function resolveToolResultContentBlocks(result: object): unknown[] {
  if (Array.isArray(result)) {
    return result;
  }
  const record = result as Record<string, unknown>;
  // Typed provider blocks own their `content`; only untyped tool-result envelopes unwrap it.
  if (readStringValue(record.type)) {
    return [record];
  }
  if (Array.isArray(record.content)) {
    return record.content;
  }
  if (record.content && typeof record.content === "object") {
    return [record.content];
  }
  return [record];
}

export function extractToolResultText(result: unknown): string | undefined {
  if (typeof result === "string") {
    const trimmed = redactModelVisibleToolPayloadText(redactInlineDataUriValue(result)).trim();
    return trimmed ? truncateToolText(trimmed) : undefined;
  }
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const content = resolveToolResultContentBlocks(result);
  const texts = collectTextContentBlocks(content)
    .map((item) => {
      const trimmed = item.trim();
      return trimmed ? trimmed : undefined;
    })
    .filter((value): value is string => Boolean(value));
  if (texts.length > 0) {
    return truncateToolText(texts.join("\n"));
  }
  const structuredTexts: string[] = [];
  for (const item of content) {
    const structured = stringifyStructuredToolResultContent(item);
    if (structured) {
      structuredTexts.push(structured);
    }
  }
  if (structuredTexts.length === 0) {
    return undefined;
  }
  return truncateToolText(structuredTexts.join("\n"));
}

export function extractToolErrorCode(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  return extractDirectErrorCodeField(record.details) ?? extractDirectErrorCodeField(record);
}

export function isToolResultTimedOut(result: unknown): boolean {
  const normalizedStatus = readToolResultStatus(result);
  if (normalizedStatus === "timeout") {
    return true;
  }
  return readToolResultDetails(result)?.timedOut === true;
}

export function extractToolErrorMessage(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  const fromDetails = extractDirectErrorField(record.details);
  if (fromDetails) {
    return fromDetails;
  }
  const fromDetailsAggregated = extractAggregatedErrorField(record.details);
  if (fromDetailsAggregated) {
    return fromDetailsAggregated;
  }
  const fromRoot = extractDirectErrorField(record);
  if (fromRoot) {
    return fromRoot;
  }
  const text = extractToolResultText(result);
  if (text) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const fromJson = extractErrorField(parsed);
      if (fromJson) {
        return fromJson;
      }
    } catch {
      // Fall through to status/text fallback.
    }
  }
  const fromDetailsStatus = extractErrorField(record.details);
  if (fromDetailsStatus) {
    return fromDetailsStatus;
  }
  const fromRootStatus = extractErrorField(record);
  if (fromRootStatus) {
    return fromRootStatus;
  }
  const status = readToolResultStatus(result);
  if (status && !isToolResultError(result)) {
    return undefined;
  }
  return text ? normalizeToolErrorText(text) : undefined;
}
