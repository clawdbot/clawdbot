/** Extracts and trust-filters media from embedded-agent tool results. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { extractToolResultText } from "./embedded-agent-tool-results.js";
import { normalizeToolPolicyName } from "./tool-policy.js";
import { readToolResultDetails } from "./tool-result-error.js";
import { AUTOMATIONS_TOOL_NAME } from "./tools/automations-tool-name.js";

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

const TRUSTED_TOOL_RESULT_MEDIA = new Set([
  "agents_list",
  "apply_patch",
  "browser",
  "canvas",
  AUTOMATIONS_TOOL_NAME,
  "edit",
  "exec",
  "gateway",
  "view_image",
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

export function isCoreToolResultMediaTrustedName(toolName?: string): boolean {
  if (!toolName) {
    return false;
  }
  return TRUSTED_TOOL_RESULT_MEDIA.has(normalizeToolPolicyName(toolName));
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
    normalizeToolPolicyName(toolName) !== "tts"
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
