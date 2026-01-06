import path from "node:path";

import { fileTypeFromBuffer } from "file-type";
import { type MediaKind, mediaKindFromMime } from "./constants.js";

// Map common mimes to preferred file extensions.
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "video/mp4": ".mp4",
  "application/pdf": ".pdf",
  "application/json": ".json",
  "application/zip": ".zip",
  "application/gzip": ".gz",
  "application/x-tar": ".tar",
  "application/x-7z-compressed": ".7z",
  "application/vnd.rar": ".rar",
  "application/msword": ".doc",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    ".pptx",
  "text/csv": ".csv",
  "text/plain": ".txt",
  "text/markdown": ".md",
};

const MIME_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_BY_MIME).map(([mime, ext]) => [ext, mime]),
);

function normalizeHeaderMime(mime?: string | null): string | undefined {
  if (!mime) return undefined;
  const cleaned = mime.split(";")[0]?.trim().toLowerCase();
  return cleaned || undefined;
}

async function sniffMime(buffer?: Buffer): Promise<string | undefined> {
  if (!buffer) return undefined;
  try {
    const type = await fileTypeFromBuffer(buffer);
    return type?.mime ?? undefined;
  } catch {
    return undefined;
  }
}

function extFromPath(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  try {
    if (/^https?:\/\//i.test(filePath)) {
      const url = new URL(filePath);
      return path.extname(url.pathname).toLowerCase() || undefined;
    }
  } catch {
    // fall back to plain path parsing
  }
  const ext = path.extname(filePath).toLowerCase();
  return ext || undefined;
}

export function detectMime(opts: {
  buffer?: Buffer;
  headerMime?: string | null;
  filePath?: string;
}): Promise<string | undefined> {
  return detectMimeImpl(opts);
}

function isGenericMime(mime?: string): boolean {
  if (!mime) return true;
  const m = mime.toLowerCase();
  return m === "application/octet-stream" || m === "application/zip";
}

async function detectMimeImpl(opts: {
  buffer?: Buffer;
  headerMime?: string | null;
  filePath?: string;
}): Promise<string | undefined> {
  const ext = extFromPath(opts.filePath);
  const extMime = ext ? MIME_BY_EXT[ext] : undefined;

  const headerMime = normalizeHeaderMime(opts.headerMime);
  const sniffed = await sniffMime(opts.buffer);

  // Prefer sniffed types, but don't let generic container types override a more
  // specific extension mapping (e.g. XLSX vs ZIP).
  if (sniffed && (!isGenericMime(sniffed) || !extMime)) return sniffed;
  if (extMime) return extMime;
  if (headerMime && !isGenericMime(headerMime)) return headerMime;
  if (sniffed) return sniffed;
  if (headerMime) return headerMime;

  return undefined;
}

export function extensionForMime(mime?: string | null): string | undefined {
  if (!mime) return undefined;
  return EXT_BY_MIME[mime.toLowerCase()];
}

export function isGifMedia(opts: {
  contentType?: string | null;
  fileName?: string | null;
}): boolean {
  if (opts.contentType?.toLowerCase() === "image/gif") return true;
  const ext = opts.fileName
    ? path.extname(opts.fileName).toLowerCase()
    : undefined;
  return ext === ".gif";
}

export function imageMimeFromFormat(
  format?: string | null,
): string | undefined {
  if (!format) return undefined;
  switch (format.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return undefined;
  }
}

export function kindFromMime(mime?: string | null): MediaKind {
  return mediaKindFromMime(mime);
}
