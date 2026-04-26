import type { MsgContext } from "../auto-reply/templating.js";
import { assertNoWindowsNetworkPath, safeFileURLToPath } from "../infra/local-file-access.js";
import { getFileExtension, isAudioFileName, kindFromMime } from "../media/mime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { MediaAttachment } from "./types.js";

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

export function normalizeAttachments(ctx: MsgContext): MediaAttachment[] {
  const pathsFromArray = Array.isArray(ctx.MediaPaths) ? ctx.MediaPaths : undefined;
  const urlsFromArray = Array.isArray(ctx.MediaUrls) ? ctx.MediaUrls : undefined;
  const typesFromArray = Array.isArray(ctx.MediaTypes) ? ctx.MediaTypes : undefined;
  const transcribedIndexes = new Set(
    Array.isArray(ctx.MediaTranscribedIndexes)
      ? ctx.MediaTranscribedIndexes.filter((index) => Number.isInteger(index) && index >= 0)
      : [],
  );
  const resolveMime = (count: number, index: number) => {
    const typeHint = normalizeOptionalString(typesFromArray?.[index]);
    if (typeHint) {
      return typeHint;
    }
    return count === 1 ? ctx.MediaType : undefined;
  };

  if (pathsFromArray && pathsFromArray.length > 0) {
    const count = pathsFromArray.length;
    const urls = urlsFromArray && urlsFromArray.length > 0 ? urlsFromArray : undefined;
    return pathsFromArray
      .map((value, index) => ({
        path: normalizeOptionalString(value),
        url: urls?.[index] ?? ctx.MediaUrl,
        mime: resolveMime(count, index),
        index,
        alreadyTranscribed: transcribedIndexes.has(index),
      }))
      .filter((entry) => Boolean(entry.path ?? normalizeOptionalString(entry.url)));
  }

  if (urlsFromArray && urlsFromArray.length > 0) {
    const count = urlsFromArray.length;
    return urlsFromArray
      .map((value, index) => ({
        path: undefined,
        url: normalizeOptionalString(value),
        mime: resolveMime(count, index),
        index,
        alreadyTranscribed: transcribedIndexes.has(index),
      }))
      .filter((entry) => Boolean(entry.url));
  }

  const pathValue = normalizeOptionalString(ctx.MediaPath);
  const url = normalizeOptionalString(ctx.MediaUrl);
  if (!pathValue && !url) {
    return [];
  }
  return [
    {
      path: pathValue || undefined,
      url: url || undefined,
      mime: ctx.MediaType,
      index: 0,
      alreadyTranscribed: transcribedIndexes.has(0),
    },
  ];
}

export function resolveAttachmentKind(
  attachment: MediaAttachment,
): "image" | "audio" | "video" | "document" | "unknown" {
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

export function isVideoAttachment(attachment: MediaAttachment): boolean {
  return resolveAttachmentKind(attachment) === "video";
}

export function isAudioAttachment(attachment: MediaAttachment): boolean {
  return resolveAttachmentKind(attachment) === "audio";
}

export function isImageAttachment(attachment: MediaAttachment): boolean {
  return resolveAttachmentKind(attachment) === "image";
}
