// Runner attachment facade keeps media attachment normalization/cache creation
// available from the public runner module without exposing implementation files.
import type { MsgContext } from "../auto-reply/templating.js";
import {
  MediaAttachmentCache,
  type MediaAttachmentCacheOptions,
  normalizeAttachments,
} from "./attachments.js";
import type { MediaAttachment } from "./types.js";

/** Normalizes message context media fields for the media-understanding runner. */
export function normalizeMediaAttachments(ctx: MsgContext): MediaAttachment[] {
  const attachments = normalizeAttachments(ctx);
  // Cached Telegram sticker descriptions already cover the current attachment,
  // but supplemental quote media still needs normal understanding.
  return ctx.SkipStickerMediaUnderstanding
    ? attachments.filter((attachment) => attachment.index !== 0)
    : attachments;
}

/** Creates the lazy attachment cache used by image, audio, video, and document providers. */
export function createMediaAttachmentCache(
  attachments: MediaAttachment[],
  options?: MediaAttachmentCacheOptions,
): MediaAttachmentCache {
  return new MediaAttachmentCache(attachments, options);
}
