import { normalizeOptionalString } from "../../shared/string-coerce.js";

export type InboundMediaContext = {
  StickerMediaIncluded?: unknown;
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
