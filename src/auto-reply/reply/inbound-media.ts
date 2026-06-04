/** Detects inbound media and audio markers in channel message context. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** Minimal inbound media fields used by media/audio detection. */
export type InboundMediaContext = {
  Body?: unknown;
  BodyForCommands?: unknown;
  CommandBody?: unknown;
  MediaType?: unknown;
  StickerMediaIncluded?: unknown;
  Sticker?: unknown;
  MediaPath?: unknown;
  MediaUrl?: unknown;
  MediaPaths?: readonly unknown[];
  MediaUrls?: readonly unknown[];
  MediaTypes?: readonly unknown[];
  RawBody?: unknown;
};

function hasNormalizedStringEntry(values: readonly unknown[] | undefined): boolean {
  return Array.isArray(values) && values.some((value) => normalizeOptionalString(value));
}

/** Returns true when the context carries current-turn media or sticker data. */
export function hasInboundMedia(ctx: InboundMediaContext): boolean {
  return Boolean(
    ctx.StickerMediaIncluded ||
    ctx.Sticker ||
    normalizeOptionalString(ctx.MediaPath) ||
    normalizeOptionalString(ctx.MediaUrl) ||
    hasNormalizedStringEntry(ctx.MediaPaths) ||
    hasNormalizedStringEntry(ctx.MediaUrls) ||
    (Array.isArray(ctx.MediaTypes) && ctx.MediaTypes.length > 0),
  );
}

const AUDIO_PLACEHOLDER_RE = /^<media:audio>(\s*\([^)]*\))?$/i;
const AUDIO_HEADER_RE = /^\[Audio\b/i;

function normalizeMediaType(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized?.split(";", 1)[0]?.toLowerCase();
}

/** Returns true when media fields or body placeholders indicate inbound audio. */
export function hasInboundAudio(ctx: InboundMediaContext): boolean {
  const mediaTypes = [
    normalizeMediaType(ctx.MediaType),
    ...(Array.isArray(ctx.MediaTypes)
      ? ctx.MediaTypes.map((type) => normalizeMediaType(type))
      : []),
  ].filter((type): type is string => Boolean(type));
  if (mediaTypes.some((type) => type === "audio" || type.startsWith("audio/"))) {
    return true;
  }

  const body =
    normalizeOptionalString(ctx.BodyForCommands) ??
    normalizeOptionalString(ctx.CommandBody) ??
    normalizeOptionalString(ctx.RawBody) ??
    normalizeOptionalString(ctx.Body) ??
    "";
  const trimmed = body.trim();
  if (!trimmed) {
    return false;
  }
  return AUDIO_PLACEHOLDER_RE.test(trimmed) || AUDIO_HEADER_RE.test(trimmed);
}
