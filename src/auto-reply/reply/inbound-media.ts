/** Detects inbound media and audio facts in channel message context. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveMediaFacts, resolveMeaningfulMediaFacts } from "../../media/media-facts.js";
import type { RuntimeMsgContext as MsgContext } from "../templating.js";

/** Minimal inbound media fields used by media/audio detection. */
type InboundMediaContext = Pick<MsgContext, "media"> & {
  Body?: unknown;
  StickerMediaIncluded?: unknown;
  SkipStickerMediaUnderstanding?: unknown;
  Sticker?: unknown;
};

/** Returns true when the context carries current-turn media or sticker data. */
export function hasInboundMedia(ctx: InboundMediaContext): boolean {
  return Boolean(
    ctx.StickerMediaIncluded || ctx.Sticker || resolveMeaningfulMediaFacts(ctx).length > 0,
  );
}

/** Returns true when current-turn media still needs automatic understanding. */
export function hasInboundMediaForUnderstanding(ctx: InboundMediaContext): boolean {
  if (!ctx.SkipStickerMediaUnderstanding) {
    return hasInboundMedia(ctx);
  }
  return resolveMeaningfulMediaFacts(ctx).length > 1;
}

function normalizeMediaType(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
}

/** Returns true when the current turn carries structured audio media facts. */
export function hasInboundAudio(ctx: InboundMediaContext): boolean {
  const isAudio = (type: string | undefined) =>
    type === "audio" || type?.startsWith("audio/") === true;
  return resolveMediaFacts(ctx).some(
    (media) => media.kind === "audio" || isAudio(normalizeMediaType(media.contentType)),
  );
}
