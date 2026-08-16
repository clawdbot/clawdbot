// Attachment normalization converts message context media fields into typed
// attachment records and classifies media kind from MIME or filename.
import type { MediaKind } from "@openclaw/media-core/constants";
import { kindFromMime, mimeTypeFromFilePath, normalizeMimeType } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { RuntimeMsgContext as MsgContext } from "../auto-reply/templating.js";
import { assertNoWindowsNetworkPath, safeFileURLToPath } from "../infra/local-file-access.js";
import {
  isGenericBinaryMediaContentType,
  isImageMediaFact,
  normalizeMediaFacts,
} from "../media/media-facts.js";
import type { MediaAttachment } from "./types.js";

/** Normalizes a local attachment path while rejecting remote file URLs and Windows UNC paths. */
export function normalizeAttachmentPath(raw?: string | null): string | undefined {
  const value = normalizeOptionalString(raw);
  if (!value) {
    return undefined;
  }
  if (/^file:/iu.test(value)) {
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

/** Converts ordered media facts into indexed attachment records. */
export function normalizeAttachments(ctx: MsgContext): MediaAttachment[] {
  return normalizeMediaFacts(ctx.media)
    .map((fact, index) => {
      const attachment: MediaAttachment = {
        path: normalizeOptionalString(fact.path),
        url: normalizeOptionalString(fact.url),
        mime: normalizeOptionalString(fact.contentType),
        index,
        alreadyTranscribed: fact.transcribed === true,
      };
      if (fact.kind) {
        attachment.kind = fact.kind;
      }
      if (fact.workspaceDir) {
        attachment.workspaceDir = fact.workspaceDir;
      }
      return attachment;
    })
    .filter((entry) => Boolean(entry.path ?? entry.url));
}

/** Classifies an attachment by authoritative kind, MIME, then canonical filename metadata. */
export function resolveAttachmentKind(attachment: MediaAttachment): Exclude<MediaKind, "sticker"> {
  if (
    isImageMediaFact({
      path: attachment.path,
      url: attachment.url,
      contentType: attachment.mime,
      kind: attachment.kind,
    })
  ) {
    return "image";
  }
  if (attachment.kind === "audio" || attachment.kind === "video") {
    return attachment.kind;
  }
  if (attachment.kind === "document") {
    return "unknown";
  }
  const mime = normalizeMimeType(attachment.mime);
  const kind = kindFromMime(mime);
  if (kind === "audio" || kind === "video") {
    return kind;
  }
  if (mime && !isGenericBinaryMediaContentType(mime)) {
    return "unknown";
  }

  const inferredKind = kindFromMime(mimeTypeFromFilePath(attachment.path ?? attachment.url));
  return inferredKind === "audio" || inferredKind === "video" ? inferredKind : "unknown";
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
