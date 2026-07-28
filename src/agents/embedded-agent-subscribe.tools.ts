/** Sanitizes, extracts, and classifies embedded-agent tool execution results. */
import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import type { ChannelMessageActionName } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeTargetForProvider } from "../infra/outbound/target-normalization.js";
import {
  normalizeLegacyInteractiveReply,
  normalizeMessagePresentation,
} from "../interactive/payload.js";
import {
  redactSecrets,
  redactSensitiveFieldValue,
  redactToolPayloadText,
} from "../logging/redact.js";
import { truncateUtf16Safe } from "../utils.js";
import { collectTextContentBlocks } from "./content-blocks.js";
import { isMessagingToolTargetEvidenceAction } from "./embedded-agent-messaging.js";
import type {
  MessagingToolSend,
  MessagingToolSourceReplyPayload,
} from "./embedded-agent-messaging.types.js";
import { normalizeToolName } from "./tool-policy.js";
import {
  isToolResultError,
  readToolResultDetails,
  readToolResultStatus,
} from "./tool-result-error.js";

export { isToolResultError };

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
  details: Record<string, unknown>;
} {
  const errorRecord = readRecord(error);
  const rawDetails = readRecord(errorRecord?.details);
  const nodeError = readRecord(rawDetails?.nodeError);
  const gatewayCode =
    readErrorCodeField(errorRecord?.gatewayCode) ?? readErrorCodeField(errorRecord?.code);
  const message = error instanceof Error ? error.message : String(error);
  return {
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
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] =
        typeof child === "string"
          ? redactSensitiveFieldValue(key, child)
          : redactStringsDeep(child, seen);
    }
    return out;
  }
  return value;
}

export function sanitizeToolArgs(args: unknown): unknown {
  return redactStringsDeep(args);
}

export function sanitizeToolResult(result: unknown): unknown {
  if (typeof result === "string") {
    return redactToolPayloadText(result);
  }
  if (Array.isArray(result)) {
    return redactSecrets(result);
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
        return Object.assign({}, cleaned, { bytes, omitted: true });
      }
      return entry;
    });
  }
  // Deep-redact the entire result so any top-level or nested string is
  // protected, not just `details` and text content blocks.
  const baseline = redactSecrets(preCleaned);
  const out: Record<string, unknown> = { ...baseline };
  const content = Array.isArray(baseline.content) ? baseline.content : null;
  if (content) {
    out.content = content.map((item) => {
      if (!item || typeof item !== "object") {
        return item;
      }
      const entry = item as Record<string, unknown>;
      if (readStringValue(entry.type) === "text" && typeof entry.text === "string") {
        return Object.assign({}, entry, { text: truncateToolText(entry.text) });
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
    return truncateToolText(redactInlineDataUriValue(redactSensitiveFieldValue(key, value)));
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
    const redacted = serialized ? redactToolPayloadText(serialized) : serialized;
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
    const trimmed = redactToolPayloadText(redactInlineDataUriValue(result)).trim();
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

function pushUniqueMessagingMediaUrl(urls: string[], seen: Set<string>, value: unknown): void {
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

/** Collects messaging attachment references from tool-call arguments or result records. */
export function collectMessagingMediaUrlsFromRecord(record: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const pushAttachment = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return;
    }
    const attachment = value as Record<string, unknown>;
    for (const candidate of [
      attachment.media,
      attachment.mediaUrl,
      attachment.path,
      attachment.filePath,
      attachment.fileUrl,
      attachment.url,
    ]) {
      pushUniqueMessagingMediaUrl(urls, seen, candidate);
    }
  };

  for (const candidate of [
    record.media,
    record.mediaUrl,
    record.path,
    record.filePath,
    record.fileUrl,
  ]) {
    pushUniqueMessagingMediaUrl(urls, seen, candidate);
  }
  if (Array.isArray(record.mediaUrls)) {
    for (const mediaUrl of record.mediaUrls) {
      pushUniqueMessagingMediaUrl(urls, seen, mediaUrl);
    }
  }
  if (Array.isArray(record.attachments)) {
    for (const attachment of record.attachments) {
      pushAttachment(attachment);
    }
  }
  return urls;
}

/** Collects messaging attachment references from a completed tool result. */
export function collectMessagingMediaUrlsFromToolResult(result: unknown): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const appendFromRecord = (value: unknown) => {
    if (!value || typeof value !== "object") {
      return;
    }
    for (const url of collectMessagingMediaUrlsFromRecord(value as Record<string, unknown>)) {
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
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

/** Extract an internal source-reply payload from a completed message tool result. */
export function extractMessagingToolSourceReplyPayload(
  result: unknown,
): MessagingToolSourceReplyPayload | undefined {
  const details = readToolResultDetails(result);
  if (!details || details.sourceReplySink !== "internal-ui") {
    return undefined;
  }
  const status = normalizeOptionalLowercaseString(details.deliveryStatus);
  if (status && status !== "sent") {
    return undefined;
  }
  const sourceReply = readRecord(details.sourceReply) ?? details;
  const payload: MessagingToolSourceReplyPayload = {};
  const text = readStringValue(sourceReply.text) ?? readStringValue(details.message);
  if (text) {
    payload.text = text;
  }
  const mediaUrl = readStringValue(sourceReply.mediaUrl) ?? readStringValue(details.mediaUrl);
  if (mediaUrl) {
    payload.mediaUrl = mediaUrl;
  }
  const rawMediaUrls = Array.isArray(sourceReply.mediaUrls)
    ? sourceReply.mediaUrls
    : Array.isArray(details.mediaUrls)
      ? details.mediaUrls
      : [];
  const mediaUrls = uniqueStrings(
    rawMediaUrls.filter((value): value is string => typeof value === "string"),
  );
  if (mediaUrls.length > 0) {
    payload.mediaUrls = mediaUrls;
  }
  if (sourceReply.audioAsVoice === true || details.audioAsVoice === true) {
    payload.audioAsVoice = true;
  }
  const presentation = normalizeMessagePresentation(sourceReply.presentation);
  if (presentation) {
    payload.presentation = presentation;
  }
  const interactive = normalizeLegacyInteractiveReply(sourceReply.interactive);
  if (interactive) {
    payload.interactive = interactive;
  }
  const channelData = readRecord(sourceReply.channelData);
  if (channelData) {
    payload.channelData = { ...channelData };
  }
  const idempotencyKey =
    readStringValue(sourceReply.idempotencyKey) ?? readStringValue(details.idempotencyKey);
  if (idempotencyKey) {
    payload.idempotencyKey = idempotencyKey;
  }
  return Object.keys(payload).length > 0 ? payload : undefined;
}

// Core tool names that are allowed to emit trusted local media artifacts.
// Plugin tools must be explicitly passed as trusted run-local names by the caller.
const TRUSTED_TOOL_RESULT_MEDIA = new Set([
  "agents_list",
  "apply_patch",
  "browser",
  "canvas",
  "cron",
  "edit",
  "exec",
  "gateway",
  "image",
  "image_generate",
  "memory_get",
  "memory_search",
  "message",
  "music_generate",
  "nodes",
  "process",
  "read",
  "session_status",
  "sessions_history",
  "sessions_list",
  "sessions_search",
  "sessions_send",
  "sessions_spawn",
  "subagents",
  "tts",
  "video_generate",
  "web_fetch",
  "web_search",
  "x_search",
  "write",
]);
const HTTP_URL_RE = /^https?:\/\//i;

function isCoreToolResultMediaTrustedName(toolName?: string): boolean {
  if (!toolName) {
    return false;
  }
  return TRUSTED_TOOL_RESULT_MEDIA.has(normalizeToolName(toolName));
}

function isExternalToolResult(result: unknown): boolean {
  const details = readToolResultDetails(result);
  if (!details) {
    return false;
  }
  return typeof details.mcpServer === "string" || typeof details.mcpTool === "string";
}

function isToolResultMediaTrusted(
  toolName?: string,
  result?: unknown,
  trustedLocalMediaToolNames?: ReadonlySet<string>,
): boolean {
  if (!toolName || isExternalToolResult(result)) {
    return false;
  }
  const registeredName = toolName.trim();
  if (registeredName && trustedLocalMediaToolNames?.has(registeredName) === true) {
    return true;
  }
  return isCoreToolResultMediaTrustedName(toolName);
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.embeddedSubscribeToolsTestApi")
  ] = { isToolResultMediaTrusted };
}

function isTrustedOwnedTtsLocalMedia(
  toolName: string | undefined,
  result: unknown,
  trustedLocalMediaToolNames?: ReadonlySet<string>,
): boolean {
  if (
    !toolName ||
    !isToolResultMediaTrusted(toolName, result, trustedLocalMediaToolNames) ||
    normalizeToolName(toolName) !== "tts"
  ) {
    return false;
  }
  const media = readToolResultDetails(result)?.media;
  if (!media || typeof media !== "object" || Array.isArray(media)) {
    return false;
  }
  return (media as Record<string, unknown>).trustedLocalMedia === true;
}

export function filterToolResultMediaUrls(
  toolName: string | undefined,
  mediaUrls: string[],
  result?: unknown,
  trustedLocalMediaToolNames?: ReadonlySet<string>,
): string[] {
  if (mediaUrls.length === 0) {
    return mediaUrls;
  }
  const trustedOwnedTtsLocalMedia = isTrustedOwnedTtsLocalMedia(
    toolName,
    result,
    trustedLocalMediaToolNames,
  );
  if (isToolResultMediaTrusted(toolName, result, trustedLocalMediaToolNames)) {
    // When the current run provides its exact trusted local-media tool names,
    // require the raw emitted tool name to match one of them before allowing
    // local media paths.
    // This blocks normalized aliases and case-variant collisions such as
    // "Bash" -> "bash" or "Web_Search" -> "web_search" from inheriting a
    // registered tool's media trust. TTS-generated local files carry a
    // separate trusted-media flag from the owned tool result, so they can
    // survive runs whose exact trusted set omitted the raw tts name.
    if (trustedLocalMediaToolNames !== undefined) {
      if (!trustedOwnedTtsLocalMedia) {
        const registeredName = toolName?.trim();
        if (!registeredName || !trustedLocalMediaToolNames.has(registeredName)) {
          return mediaUrls.filter((url) => HTTP_URL_RE.test(url.trim()));
        }
      }
    }
    return mediaUrls;
  }
  return mediaUrls.filter((url) => HTTP_URL_RE.test(url.trim()));
}

/**
 * Extract media file paths from a tool result.
 *
 * Strategy (first match wins):
 * 1. Read structured `details.media` attachments from tool details.
 * 2. Fall back to `details.path` when image content exists (legacy imageResult).
 *
 * Returns an empty array when no media is found (e.g. embedded `read` tool
 * returns base64 image data but no file path; those need a different delivery
 * path like saving to a temp file).
 */
type ToolResultMediaArtifact = {
  mediaUrls: string[];
  audioAsVoice?: boolean;
  trustedLocalMedia?: boolean;
};

function readToolResultDetailsMedia(
  result: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const details = readToolResultDetails(result);
  const media =
    details?.media && typeof details.media === "object" && !Array.isArray(details.media)
      ? (details.media as Record<string, unknown>)
      : undefined;
  return media;
}

function collectStructuredMediaUrls(media: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const pushString = (value: unknown) => {
    if (typeof value !== "string") {
      return;
    }
    const normalized = value.trim();
    if (normalized) {
      urls.push(normalized);
    }
  };
  const pushAttachment = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return;
    }
    const attachment = value as Record<string, unknown>;
    pushString(attachment.media);
    pushString(attachment.path);
    pushString(attachment.url);
    pushString(attachment.mediaUrl);
    pushString(attachment.filePath);
    pushString(attachment.fileUrl);
  };
  pushString(media.media);
  pushString(media.path);
  pushString(media.url);
  pushString(media.mediaUrl);
  pushString(media.filePath);
  pushString(media.fileUrl);
  if (Array.isArray(media.mediaUrls)) {
    for (const value of media.mediaUrls) {
      pushString(value);
    }
  }
  if (Array.isArray(media.attachments)) {
    for (const attachment of media.attachments) {
      pushAttachment(attachment);
    }
  }
  return uniqueStrings(urls);
}

function isNonOutboundToolResultMedia(media: Record<string, unknown>): boolean {
  return media.outbound === false;
}

function hasImageContentBlock(content: unknown[]): boolean {
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (entry.type === "image") {
      return true;
    }
  }
  return false;
}

export function extractToolResultMediaArtifact(
  result: unknown,
): ToolResultMediaArtifact | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  const detailsMedia = readToolResultDetailsMedia(record);
  if (detailsMedia) {
    if (isNonOutboundToolResultMedia(detailsMedia)) {
      return undefined;
    }
    const mediaUrls = collectStructuredMediaUrls(detailsMedia);
    if (mediaUrls.length > 0) {
      return {
        mediaUrls,
        ...(detailsMedia.audioAsVoice === true ? { audioAsVoice: true } : {}),
        ...(detailsMedia.trustedLocalMedia === true ? { trustedLocalMedia: true } : {}),
      };
    }
  }

  const content = Array.isArray(record.content) ? record.content : null;
  if (!content) {
    return undefined;
  }

  // Fall back to legacy details.path when image content exists but no
  // structured media details.
  if (hasImageContentBlock(content)) {
    const details = record.details as Record<string, unknown> | undefined;
    const p = normalizeOptionalString(details?.path) ?? "";
    if (p) {
      return { mediaUrls: [p] };
    }
  }

  return undefined;
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

function resolveMessageToolTarget(params: {
  action: string;
  args: Record<string, unknown>;
  providerId: string | null;
  currentChannelId?: string;
  currentMessagingTarget?: string;
}): string | undefined {
  const directTarget =
    normalizeOptionalString(params.args.target) ??
    normalizeOptionalString(params.args.to) ??
    normalizeOptionalString(params.args.channelId);
  if (directTarget) {
    return directTarget;
  }
  const aliases = params.providerId
    ? getChannelPlugin(params.providerId)?.actions?.messageActionTargetAliases?.[
        params.action as ChannelMessageActionName
      ]?.deliveryTargetAliases
    : undefined;
  for (const alias of aliases ?? []) {
    const aliasTarget = normalizeOptionalStringifiedId(params.args[alias]);
    if (aliasTarget) {
      return aliasTarget;
    }
  }
  return params.currentMessagingTarget ?? params.currentChannelId;
}

function resolveMessagingToolThreadEvidence(params: {
  providerId: string;
  to: string;
  accountId?: string;
  threadId?: string;
  replyToId?: string;
  allowImplicitThread: boolean;
  threadSuppressed: boolean;
  options?: {
    config?: OpenClawConfig;
    currentChannelId?: string;
    currentMessagingTarget?: string;
    currentThreadId?: string;
    currentMessageId?: string | number;
    replyToMode?: "off" | "first" | "all" | "batched";
    hasRepliedRef?: { value: boolean };
  };
}): Pick<MessagingToolSend, "threadId" | "threadImplicit" | "threadSuppressed"> {
  const threading = getChannelPlugin(params.providerId)?.threading;
  const autoThreadResolver = params.allowImplicitThread
    ? threading?.resolveAutoThreadId
    : undefined;
  const replyTransport = params.replyToId
    ? threading?.resolveReplyTransport?.({
        cfg: params.options?.config ?? {},
        accountId: params.accountId,
        threadId: params.threadId,
        replyToId: params.replyToId,
      })
    : undefined;
  const transportThreadId = normalizeOptionalStringifiedId(replyTransport?.threadId);
  const replyToThreadId =
    replyTransport?.threadId === null
      ? normalizeOptionalString(replyTransport.replyToId)
      : undefined;
  const explicitThreadId = transportThreadId ?? replyToThreadId ?? params.threadId;
  const currentChannelId = normalizeOptionalString(params.options?.currentChannelId);
  const currentMessagingTarget = normalizeOptionalString(params.options?.currentMessagingTarget);
  const currentThreadId = normalizeOptionalString(params.options?.currentThreadId);
  const replyToMode = params.options?.replyToMode ?? (currentThreadId ? "all" : undefined);
  const canResolveCurrentThread = Boolean(
    (currentChannelId || currentMessagingTarget) && currentThreadId,
  );
  const resolvedCurrentThreadId =
    !explicitThreadId && !params.threadSuppressed && autoThreadResolver && canResolveCurrentThread
      ? autoThreadResolver({
          cfg: params.options?.config ?? {},
          accountId: params.accountId,
          to: params.to,
          replyToId: params.replyToId,
          toolContext: {
            currentChannelId,
            currentMessagingTarget,
            currentThreadTs: currentThreadId,
            currentMessageId: params.options?.currentMessageId,
            replyToMode,
            hasRepliedRef: params.options?.hasRepliedRef,
          },
        })
      : undefined;
  const threadImplicit =
    !explicitThreadId &&
    !params.threadSuppressed &&
    Boolean(autoThreadResolver) &&
    (!canResolveCurrentThread || Boolean(resolvedCurrentThreadId));
  return {
    ...((explicitThreadId ?? resolvedCurrentThreadId)
      ? { threadId: explicitThreadId ?? resolvedCurrentThreadId }
      : {}),
    ...(threadImplicit ? { threadImplicit: true } : {}),
    ...(params.threadSuppressed ? { threadSuppressed: true } : {}),
  };
}

export function extractMessagingToolSend(
  toolName: string,
  args: Record<string, unknown>,
  options?: {
    config?: OpenClawConfig;
    currentChannelId?: string;
    currentMessagingTarget?: string;
    currentThreadId?: string;
    currentMessageId?: string | number;
    replyToMode?: "off" | "first" | "all" | "batched";
    hasRepliedRef?: { value: boolean };
  },
): MessagingToolSend | undefined {
  // Provider docking: new provider tools must implement plugin.actions.extractToolSend.
  const action = normalizeOptionalString(args.action) ?? "";
  const accountId = normalizeOptionalString(args.accountId);
  if (toolName === "conversations_send" || toolName === "conversations_turn") {
    const conversationRef = normalizeOptionalString(args.conversationRef);
    return conversationRef
      ? {
          tool: toolName,
          provider: "conversation",
          to: conversationRef,
        }
      : undefined;
  }
  if (toolName === "message") {
    if (!isMessagingToolTargetEvidenceAction(toolName, args)) {
      return undefined;
    }
    const providerRaw = normalizeOptionalString(args.provider) ?? "";
    const channelRaw = normalizeOptionalString(args.channel) ?? "";
    const providerHint = providerRaw || channelRaw;
    const providerId = providerHint ? normalizeChannelId(providerHint) : null;
    const toRaw = resolveMessageToolTarget({
      action,
      args,
      providerId,
      currentChannelId: options?.currentChannelId,
      currentMessagingTarget: options?.currentMessagingTarget,
    });
    if (!toRaw) {
      return undefined;
    }
    const provider = providerId ?? normalizeOptionalLowercaseString(providerHint) ?? "message";
    const to = normalizeTargetForProvider(provider, toRaw);
    const pluginExtractionArgs = { ...args, to: toRaw };
    const pluginExtracted = providerId
      ? getChannelPlugin(providerId)?.actions?.extractToolSend?.({ args: pluginExtractionArgs })
      : null;
    const resolvedAccountId = normalizeOptionalString(pluginExtracted?.accountId) ?? accountId;
    const threadId =
      normalizeOptionalString(pluginExtracted?.threadId) ?? normalizeOptionalString(args.threadId);
    const replyToId = normalizeOptionalString(args.replyTo);
    // Normal sends use prepared core delivery, where provider transport owns
    // reply/thread precedence. Other send-like actions use plugin dispatch.
    const outboundReplyToId = action === "send" ? replyToId : undefined;
    const threadSuppressed =
      pluginExtracted?.threadSuppressed === true ||
      args.topLevel === true ||
      args.threadId === null;
    return to
      ? {
          tool: toolName,
          provider,
          accountId: resolvedAccountId,
          to,
          ...(providerId
            ? resolveMessagingToolThreadEvidence({
                providerId,
                to,
                accountId: resolvedAccountId,
                threadId,
                replyToId: outboundReplyToId,
                allowImplicitThread: pluginExtracted
                  ? pluginExtracted.threadImplicit === true
                  : true,
                threadSuppressed,
                options,
              })
            : {
                ...(threadId ? { threadId } : {}),
                ...(threadSuppressed ? { threadSuppressed: true } : {}),
              }),
        }
      : undefined;
  }

  const providerId = normalizeChannelId(toolName);
  if (!providerId) {
    return undefined;
  }
  const plugin = getChannelPlugin(providerId);
  const extracted = plugin?.actions?.extractToolSend?.({ args });
  if (!extracted?.to) {
    return undefined;
  }
  const to = normalizeTargetForProvider(providerId, extracted.to);
  const threadId = normalizeOptionalString(extracted.threadId);
  const threadSuppressed = extracted.threadSuppressed === true;
  const extractedAccountId = normalizeOptionalString(extracted.accountId) ?? accountId;
  const nativeReplyToMode = options?.replyToMode;
  const nativeSingleUseMode = nativeReplyToMode === "first" || nativeReplyToMode === "batched";
  const canResolveNativeImplicitThread =
    extracted.threadImplicit === true &&
    nativeReplyToMode !== undefined &&
    (!nativeSingleUseMode || options?.hasRepliedRef !== undefined);
  return to
    ? {
        tool: toolName,
        provider: providerId,
        accountId: extractedAccountId,
        to,
        ...resolveMessagingToolThreadEvidence({
          providerId,
          to,
          accountId: extractedAccountId,
          threadId,
          allowImplicitThread: canResolveNativeImplicitThread,
          threadSuppressed,
          options,
        }),
      }
    : undefined;
}

/** Reconciles pending send evidence with the provider's successful action result. */
export function extractMessagingToolSendResult(
  pending: MessagingToolSend,
  result: unknown,
): MessagingToolSend {
  const providerId = normalizeChannelId(pending.provider);
  const extracted = providerId
    ? getChannelPlugin(providerId)?.actions?.extractToolSendResult?.({
        result,
        send: {
          to: pending.to ?? "",
          accountId: pending.accountId,
          threadId: pending.threadId,
          threadImplicit: pending.threadImplicit,
          threadSuppressed: pending.threadSuppressed,
        },
      })
    : null;
  if (!extracted?.to) {
    return pending;
  }
  const extractedThreadId = normalizeOptionalString(extracted.threadId);
  const providerReportedThread =
    extractedThreadId != null ||
    extracted.threadImplicit === true ||
    extracted.threadSuppressed === true;
  // Thread route fields are one state. Mixing provider and pending values can
  // create contradictory implicit and suppressed evidence.
  const threadEvidence = providerReportedThread ? extracted : pending;
  return {
    ...pending,
    ...extracted,
    accountId: normalizeOptionalString(extracted.accountId) ?? pending.accountId,
    to: normalizeTargetForProvider(providerId ?? pending.provider, extracted.to),
    threadId: normalizeOptionalString(threadEvidence.threadId),
    threadImplicit: threadEvidence.threadImplicit === true ? true : undefined,
    threadSuppressed: threadEvidence.threadSuppressed === true ? true : undefined,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
