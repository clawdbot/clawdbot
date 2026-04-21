import type {
  BlockStreamingChunkConfig,
  BlockStreamingCoalesceConfig,
  ChannelDeliveryStreamingConfig,
  ChannelPreviewStreamingConfig,
  ChannelStreamingConfig,
  SlackChannelStreamingConfig,
  TextChunkMode,
} from "../config/types.base.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";

export type {
  ChannelDeliveryStreamingConfig,
  ChannelPreviewStreamingConfig,
  ChannelStreamingBlockConfig,
  ChannelStreamingConfig,
  ChannelStreamingPreviewConfig,
  SlackChannelStreamingConfig,
  StreamingMode,
  TextChunkMode,
} from "../config/types.base.js";

type StreamingCompatEntry = {
  streaming?: unknown;
  streamMode?: unknown;
  chunkMode?: unknown;
  blockStreaming?: unknown;
  draftChunk?: unknown;
  blockStreamingCoalesce?: unknown;
  nativeStreaming?: unknown;
};

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTextChunkMode(value: unknown): TextChunkMode | undefined {
  return value === "length" || value === "newline" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeStreamingMode(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = normalizeOptionalLowercaseString(value);
  return normalized || null;
}

function parsePreviewStreamingMode(value: unknown): "off" | "partial" | "block" | null {
  const normalized = normalizeStreamingMode(value);
  if (
    normalized === "off" ||
    normalized === "partial" ||
    normalized === "block" ||
    normalized === "progress"
  ) {
    return normalized === "progress" ? "partial" : normalized;
  }
  return null;
}

function asBlockStreamingCoalesceConfig(value: unknown): BlockStreamingCoalesceConfig | undefined {
  return asObjectRecord(value) as BlockStreamingCoalesceConfig | undefined;
}

function asBlockStreamingChunkConfig(value: unknown): BlockStreamingChunkConfig | undefined {
  return asObjectRecord(value) as BlockStreamingChunkConfig | undefined;
}

export function getChannelStreamingConfigObject(
  entry: StreamingCompatEntry | null | undefined,
): ChannelStreamingConfig | undefined {
  const streaming = asObjectRecord(entry?.streaming);
  return streaming ? (streaming as ChannelStreamingConfig) : undefined;
}

export function resolveChannelStreamingChunkMode(
  entry: StreamingCompatEntry | null | undefined,
): TextChunkMode | undefined {
  return (
    asTextChunkMode(getChannelStreamingConfigObject(entry)?.chunkMode) ??
    asTextChunkMode(entry?.chunkMode)
  );
}

export function resolveChannelStreamingBlockEnabled(
  entry: StreamingCompatEntry | null | undefined,
): boolean | undefined {
  const config = getChannelStreamingConfigObject(entry);
  return asBoolean(config?.block?.enabled) ?? asBoolean(entry?.blockStreaming);
}

export function resolveChannelStreamingBlockCoalesce(
  entry: StreamingCompatEntry | null | undefined,
): BlockStreamingCoalesceConfig | undefined {
  const config = getChannelStreamingConfigObject(entry);
  return (
    asBlockStreamingCoalesceConfig(config?.block?.coalesce) ??
    asBlockStreamingCoalesceConfig(entry?.blockStreamingCoalesce)
  );
}

export function resolveChannelStreamingPreviewChunk(
  entry: StreamingCompatEntry | null | undefined,
): BlockStreamingChunkConfig | undefined {
  const config = getChannelStreamingConfigObject(entry);
  return (
    asBlockStreamingChunkConfig(config?.preview?.chunk) ??
    asBlockStreamingChunkConfig(entry?.draftChunk)
  );
}

export function resolveChannelStreamingPreviewToolProgress(
  entry: StreamingCompatEntry | null | undefined,
  defaultValue = true,
): boolean {
  const config = getChannelStreamingConfigObject(entry);
  return asBoolean(config?.preview?.toolProgress) ?? defaultValue;
}

export function resolveChannelStreamingNativeTransport(
  entry: StreamingCompatEntry | null | undefined,
): boolean | undefined {
  const config = getChannelStreamingConfigObject(entry);
  return asBoolean(config?.nativeTransport) ?? asBoolean(entry?.nativeStreaming);
}

export function resolveChannelPreviewStreamMode(
  entry: StreamingCompatEntry | null | undefined,
  defaultMode: "off" | "partial",
): "off" | "partial" | "block" {
  const parsedStreaming = parsePreviewStreamingMode(
    getChannelStreamingConfigObject(entry)?.mode ?? entry?.streaming,
  );
  if (parsedStreaming) {
    return parsedStreaming;
  }

  const legacy = parsePreviewStreamingMode(entry?.streamMode);
  if (legacy) {
    return legacy;
  }
  if (typeof entry?.streaming === "boolean") {
    return entry.streaming ? "partial" : "off";
  }
  return defaultMode;
}
