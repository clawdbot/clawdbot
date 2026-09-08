import path from "node:path";
import { mergeInboundPathRoots } from "@openclaw/media-core/inbound-path-policy";
// Runner attachment facade keeps media attachment normalization/cache creation
// available from the public runner module without exposing implementation files.
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveChannelInboundAttachmentRoots } from "../media/channel-inbound-roots.js";
import { getDefaultMediaLocalRoots } from "../media/local-roots.js";
import { normalizeMediaFacts } from "../media/media-facts.js";
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

export function resolveMediaAttachmentLocalRoots(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
  workspaceDir?: string;
}): readonly string[] {
  const workspaceDirs = normalizeMediaFacts(params.ctx.media).flatMap((fact) =>
    fact.workspaceDir ? [path.resolve(fact.workspaceDir)] : [],
  );
  return mergeInboundPathRoots(
    getDefaultMediaLocalRoots(),
    workspaceDirs,
    params.workspaceDir ? [path.resolve(params.workspaceDir)] : undefined,
    resolveChannelInboundAttachmentRoots(params),
  );
}
