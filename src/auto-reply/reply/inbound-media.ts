/** Detects inbound media and audio facts in channel message context. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** Minimal inbound media fields used by media/audio detection. */
type InboundMediaContext = {
  Body?: unknown;
  MediaType?: unknown;
  StickerMediaIncluded?: unknown;
  SkipStickerMediaUnderstanding?: unknown;
  Sticker?: unknown;
  MediaPath?: unknown;
  MediaUrl?: unknown;
  MediaPaths?: readonly unknown[];
  MediaUrls?: readonly unknown[];
  MediaTypes?: readonly unknown[];
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

/** Returns true when current-turn media still needs automatic understanding. */
export function hasInboundMediaForUnderstanding(ctx: InboundMediaContext): boolean {
  if (!ctx.SkipStickerMediaUnderstanding) {
    return hasInboundMedia(ctx);
  }
  return [ctx.MediaPaths, ctx.MediaUrls, ctx.MediaTypes].some(
    (values) => Array.isArray(values) && values.length > 1,
  );
}

function normalizeMediaType(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
}

/** Returns true when the current turn carries structured audio media facts. */
export function hasInboundAudio(ctx: InboundMediaContext): boolean {
  const mediaTypes = [
    normalizeMediaType(ctx.MediaType),
    ...(Array.isArray(ctx.MediaTypes)
      ? ctx.MediaTypes.map((type) => normalizeMediaType(type))
      : []),
  ].filter((type): type is string => Boolean(type));
  return mediaTypes.some((type) => type === "audio" || type.startsWith("audio/"));
}
