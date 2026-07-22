// Attachment normalization converts message context media fields into typed
// attachment records and classifies media kind from MIME or filename.
import type { MediaKind } from "@openclaw/media-core/constants";
import { getFileExtension, isAudioFileName, kindFromMime } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { MsgContext } from "../auto-reply/templating.js";
import { assertNoWindowsNetworkPath, safeFileURLToPath } from "../infra/local-file-access.js";
import { hasStagedMediaProjection, resolveMediaFacts } from "../media/media-facts.js";
import type { MediaAttachment } from "./types.js";

/** Normalizes a local attachment path while rejecting remote file URLs and Windows UNC paths. */
export function normalizeAttachmentPath(raw?: string | null): string | undefined {
  const value = normalizeOptionalString(raw);
  if (!value) {
    return undefined;
  }
  if (value.startsWith("file://")) {
    try {
      return safeFileURLToPath(value);
    } catch {
      return undefined;
    }
  }
  try {
    assertNoWindowsNetworkPath(value, "Attachment path");
  } catch {
    return undefined;
  }
  return value;
}

/** Flattens legacy single-value and array media fields into indexed attachment records. */
export function normalizeAttachments(ctx: MsgContext): MediaAttachment[] {
  const mediaSource = hasStagedMediaProjection(ctx) ? { ...ctx, media: undefined } : ctx;
  return resolveMediaFacts(mediaSource)
    .map((fact, index) => ({
      path: normalizeOptionalString(fact.path),
      url: normalizeOptionalString(fact.url),
      mime: normalizeOptionalString(fact.contentType) ?? fact.kind,
      workspaceDir: normalizeOptionalString(fact.workspaceDir),
      index,
      alreadyTranscribed: fact.transcribed === true,
    }))
    .filter((entry) => Boolean(entry.path ?? entry.url));
}

/** Classifies an attachment by MIME first, then by filename/URL extension fallback. */
export function resolveAttachmentKind(attachment: MediaAttachment): Exclude<MediaKind, "sticker"> {
  const kind = kindFromMime(attachment.mime);
  if (kind === "image" || kind === "audio" || kind === "video") {
    return kind;
  }

  const ext = getFileExtension(attachment.path ?? attachment.url);
  if (!ext) {
    return "unknown";
  }
  if ([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"].includes(ext)) {
    return "video";
  }
  if (isAudioFileName(attachment.path ?? attachment.url)) {
    return "audio";
  }
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif"].includes(ext)) {
    return "image";
  }
  return "unknown";
}

/** Returns true when the attachment is classified as video media. */
export function isVideoAttachment(attachment: MediaAttachment): boolean {
  return resolveAttachmentKind(attachment) === "video";
}

/** Returns true when the attachment is classified as audio media. */
export function isAudioAttachment(attachment: MediaAttachment): boolean {
  return resolveAttachmentKind(attachment) === "audio";
}

/** Returns true when the attachment is classified as image media. */
export function isImageAttachment(attachment: MediaAttachment): boolean {
  return resolveAttachmentKind(attachment) === "image";
}
