import {
  getChannelStreamingConfigObject,
  resolveChannelStreamingNativeTransport,
} from "openclaw/plugin-sdk/channel-streaming";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";

export type StreamingMode = "off" | "partial" | "block" | "progress";
export type SlackLegacyDraftStreamMode = "replace" | "status_final" | "append";

function normalizeStreamingMode(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized =
    normalizeOptionalString(value) == null ? "" : normalizeLowercaseStringOrEmpty(value);
  return normalized || null;
}

function parseStreamingMode(value: unknown): StreamingMode | null {
  const normalized = normalizeStreamingMode(value);
  if (
    normalized === "off" ||
    normalized === "partial" ||
    normalized === "block" ||
    normalized === "progress"
  ) {
    return normalized;
  }
  return null;
}

function parseSlackLegacyDraftStreamMode(value: unknown): SlackLegacyDraftStreamMode | null {
  const normalized = normalizeStreamingMode(value);
  if (normalized === "replace" || normalized === "status_final" || normalized === "append") {
    return normalized;
  }
  return null;
}

function mapSlackLegacyDraftStreamModeToStreaming(mode: SlackLegacyDraftStreamMode): StreamingMode {
  if (mode === "append") {
    return "block";
  }
  if (mode === "status_final") {
    return "progress";
  }
  return "partial";
}

export function mapStreamingModeToSlackLegacyDraftStreamMode(mode: StreamingMode) {
  if (mode === "block") {
    return "append" as const;
  }
  if (mode === "progress") {
    return "status_final" as const;
  }
  return "replace" as const;
}

export function resolveSlackStreamingMode(
  params: {
    streamMode?: unknown;
    streaming?: unknown;
  } = {},
): StreamingMode {
  const parsedStreaming = parseStreamingMode(
    getChannelStreamingConfigObject(params)?.mode ?? params.streaming,
  );
  if (parsedStreaming) {
    return parsedStreaming;
  }
  const legacyStreamMode = parseSlackLegacyDraftStreamMode(params.streamMode);
  if (legacyStreamMode) {
    return mapSlackLegacyDraftStreamModeToStreaming(legacyStreamMode);
  }
  if (typeof params.streaming === "boolean") {
    return params.streaming ? "partial" : "off";
  }
  return "partial";
}

export function resolveSlackNativeStreaming(
  params: {
    nativeStreaming?: unknown;
    streaming?: unknown;
  } = {},
): boolean {
  const canonical = resolveChannelStreamingNativeTransport(params);
  if (typeof canonical === "boolean") {
    return canonical;
  }
  if (typeof params.streaming === "boolean") {
    return params.streaming;
  }
  return true;
}
