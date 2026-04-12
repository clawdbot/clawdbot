import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { normalizeTargetForProvider } from "../infra/outbound/target-normalization.js";
import { splitMediaFromOutput } from "../media/parse.js";
import { pluginRegistrationContractRegistry } from "../plugins/contracts/registry.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  readStringValue,
} from "../shared/string-coerce.js";
import { truncateUtf16Safe } from "../utils.js";
import { collectTextContentBlocks } from "./content-blocks.js";
import type { MessagingToolSend } from "./pi-embedded-messaging.types.js";
import { normalizeToolName } from "./tool-policy.js";

const TOOL_RESULT_MAX_CHARS = 8000;
const TOOL_ERROR_MAX_CHARS = 400;

function truncateToolText(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) {
    return text;
  }
  return `${truncateUtf16Safe(text, TOOL_RESULT_MAX_CHARS)}\n…(truncated)…`;
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
  const direct =
    readErrorCandidate(record.error) ??
    readErrorCandidate(record.message) ??
    readErrorCandidate(record.reason);
  if (direct) {
    return direct;
  }
  const status = normalizeOptionalString(record.status) ?? "";
  if (!status || !isErrorLikeStatus(status)) {
    return undefined;
  }
  return normalizeToolErrorText(status);
}

export function sanitizeToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }
  const record = result as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : null;
  if (!content) {
    return record;
  }
  const sanitized = content.map((item) => {
    if (!item || typeof item !== "object") {
      return item;
    }
    const entry = item as Record<string, unknown>;
    const type = readStringValue(entry.type);
    if (type === "text" && typeof entry.text === "string") {
      return { ...entry, text: truncateToolText(entry.text) };
    }
    if (type === "image") {
      const data = readStringValue(entry.data);
      const bytes = data ? data.length : undefined;
      const cleaned = { ...entry };
      delete cleaned.data;
      return { ...cleaned, bytes, omitted: true };
    }
    return entry;
  });
  return { ...record, content: sanitized };
}

export function extractToolResultText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  const texts = collectTextContentBlocks(record.content)
    .map((item) => {
      const trimmed = item.trim();
      return trimmed ? trimmed : undefined;
    })
    .filter((value): value is string => Boolean(value));
  if (texts.length === 0) {
    return undefined;
  }
  return texts.join("\n");
}

// Core tool names that are allowed to emit local MEDIA: paths.
// Plugin/MCP tools are intentionally excluded to prevent untrusted file reads.
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
const TRUSTED_BUNDLED_PLUGIN_MEDIA_TOOLS = new Set(
  pluginRegistrationContractRegistry.flatMap((entry) => entry.toolNames),
);
const HTTP_URL_RE = /^https?:\/\//i;

function readToolResultDetails(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  return record.details && typeof record.details === "object" && !Array.isArray(record.details)
    ? (record.details as Record<string, unknown>)
    : undefined;
}

function readToolResultStatus(result: unknown): string | undefined {
  const status = readToolResultDetails(result)?.status;
  return normalizeOptionalLowercaseString(status);
}

function isExternalToolResult(result: unknown): boolean {
  const details = readToolResultDetails(result);
  if (!details) {
    return false;
  }
  return typeof details.mcpServer === "string" || typeof details.mcpTool === "string";
}

export function isToolResultMediaTrusted(toolName?: string, result?: unknown): boolean {
  if (!toolName || isExternalToolResult(result)) {
    return false;
  }
  const normalized = normalizeToolName(toolName);
  return (
    TRUSTED_TOOL_RESULT_MEDIA.has(normalized) || TRUSTED_BUNDLED_PLUGIN_MEDIA_TOOLS.has(normalized)
  );
}

export function filterToolResultMediaUrls(
  toolName: string | undefined,
  mediaUrls: string[],
  result?: unknown,
): string[] {
  if (mediaUrls.length === 0) {
    return mediaUrls;
  }
  if (isToolResultMediaTrusted(toolName, result)) {
    return mediaUrls;
  }
  return mediaUrls.filter((url) => HTTP_URL_RE.test(url.trim()));
}

/**
 * Extract media file paths from a tool result.
 *
 * Strategy (first match wins):
 * 1. Read structured `details.media` attachments from tool details.
 * 2. Parse legacy `MEDIA:` tokens from text content blocks.
 * 3. Fall back to `details.path` when image content exists (legacy imageResult).
 *
 * Returns an empty array when no media is found (e.g. Pi SDK `read` tool
 * returns base64 image data but no file path; those need a different delivery
 * path like saving to a temp file).
 */
export type ToolResultMediaArtifact = {
  mediaUrls: string[];
  audioAsVoice?: boolean;
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
  if (typeof media.mediaUrl === "string" && media.mediaUrl.trim()) {
    urls.push(media.mediaUrl.trim());
  }
  if (Array.isArray(media.mediaUrls)) {
    urls.push(
      ...media.mediaUrls
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    );
  }
  return Array.from(new Set(urls));
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
    const mediaUrls = collectStructuredMediaUrls(detailsMedia);
    if (mediaUrls.length > 0) {
      return {
        mediaUrls,
        ...(detailsMedia.audioAsVoice === true ? { audioAsVoice: true } : {}),
      };
    }
  }

  const content = Array.isArray(record.content) ? record.content : null;
  if (!content) {
    return undefined;
  }

  // Extract legacy MEDIA: paths from text content blocks using the shared
  // parser so directive matching and validation stay in sync with outbound
  // reply parsing.
  const paths: string[] = [];
  let hasImageContent = false;
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (entry.type === "image") {
      hasImageContent = true;
      continue;
    }
    if (entry.type === "text" && typeof entry.text === "string") {
      const parsed = splitMediaFromOutput(entry.text);
      if (parsed.mediaUrls?.length) {
        paths.push(...parsed.mediaUrls);
      }
    }
  }

  if (paths.length > 0) {
    return { mediaUrls: paths };
  }

  // Fall back to legacy details.path when image content exists but no
  // structured media details or MEDIA: text.
  if (hasImageContent) {
    const details = record.details as Record<string, unknown> | undefined;
    const p = normalizeOptionalString(details?.path) ?? "";
    if (p) {
      return { mediaUrls: [p] };
    }
  }

  return undefined;
}

export function extractToolResultMediaPaths(result: unknown): string[] {
  return extractToolResultMediaArtifact(result)?.mediaUrls ?? [];
}

export function isToolResultError(result: unknown): boolean {
  const normalized = readToolResultStatus(result);
  if (!normalized) {
    return false;
  }
  return normalized === "error" || normalized === "timeout";
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
  const fromDetails = extractErrorField(record.details);
  if (fromDetails) {
    return fromDetails;
  }
  const fromRoot = extractErrorField(record);
  if (fromRoot) {
    return fromRoot;
  }
  const text = extractToolResultText(result);
  if (!text) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    const fromJson = extractErrorField(parsed);
    if (fromJson) {
      return fromJson;
    }
  } catch {
    // Fall through to first-line text fallback.
  }
  return normalizeToolErrorText(text);
}

function resolveMessageToolTarget(args: Record<string, unknown>): string | undefined {
  const toRaw = readStringValue(args.to);
  if (toRaw) {
    return toRaw;
  }
  return readStringValue(args.target);
}

export function extractMessagingToolSend(
  toolName: string,
  args: Record<string, unknown>,
): MessagingToolSend | undefined {
  // Provider docking: new provider tools must implement plugin.actions.extractToolSend.
  const action = normalizeOptionalString(args.action) ?? "";
  const accountId = normalizeOptionalString(args.accountId);
  if (toolName === "message") {
    if (action !== "send" && action !== "thread-reply") {
      return undefined;
    }
    const toRaw = resolveMessageToolTarget(args);
    if (!toRaw) {
      return undefined;
    }
    const providerRaw = normalizeOptionalString(args.provider) ?? "";
    const channelRaw = normalizeOptionalString(args.channel) ?? "";
    const providerHint = providerRaw || channelRaw;
    const providerId = providerHint ? normalizeChannelId(providerHint) : null;
    const provider = providerId ?? normalizeOptionalLowercaseString(providerHint) ?? "message";
    const to = normalizeTargetForProvider(provider, toRaw);
    return to ? { tool: toolName, provider, accountId, to } : undefined;
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
  return to
    ? {
        tool: toolName,
        provider: providerId,
        accountId: extracted.accountId ?? accountId,
        to,
      }
    : undefined;
}
