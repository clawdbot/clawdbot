// Media Core module implements mime behavior.
import path from "node:path";
import { type MediaKind, mediaKindFromMime } from "./constants.js";
import { createLazyImportLoader } from "./lazy-import.js";

/** Maximum byte prefix passed to dependency MIME sniffers for bounded memory/CPU work. */
export const FILE_TYPE_SNIFF_MAX_BYTES = 1024 * 1024;

// Map common mimes to preferred file extensions.
const EXT_BY_MIME: Record<string, string> = {
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/bmp": ".bmp",
  "image/jpg": ".jpg",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/wave": ".wav",
  "audio/x-wav": ".wav",
  "audio/flac": ".flac",
  "audio/aac": ".aac",
  "audio/opus": ".opus",
  "audio/webm": ".webm",
  "audio/x-m4a": ".m4a",
  "audio/mp4": ".m4a",
  "audio/x-caf": ".caf",
  "video/x-msvideo": ".avi",
  "video/mp4": ".mp4",
  "video/x-matroska": ".mkv",
  "video/webm": ".webm",
  "video/x-flv": ".flv",
  "video/x-ms-wmv": ".wmv",
  "video/quicktime": ".mov",
  "application/pdf": ".pdf",
  "application/json": ".json",
  "application/yaml": ".yaml",
  "application/zip": ".zip",
  "application/gzip": ".gz",
  "application/x-tar": ".tar",
  "application/x-7z-compressed": ".7z",
  "application/vnd.rar": ".rar",
  "application/msword": ".doc",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "text/csv": ".csv",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/html": ".html",
  "text/xml": ".xml",
  "text/css": ".css",
  "application/xml": ".xml",
};

function buildMimeByExt(): Record<string, string> {
  const byExt: Record<string, string> = {};
  for (const [mime, ext] of Object.entries(EXT_BY_MIME)) {
    byExt[ext] ??= mime;
  }
  return byExt;
}

const MIME_BY_EXT: Record<string, string> = {
  ...buildMimeByExt(),
  // Canonical extension mappings for common MIME aliases
  ".jpg": "image/jpeg",
  ".m2a": "audio/mpeg",
  ".mp3": "audio/mpeg",
  ".oga": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  // Additional extension aliases
  ".jpeg": "image/jpeg",
  ".js": "text/javascript",
  ".log": "text/plain",
  ".htm": "text/html",
  ".xml": "text/xml",
  ".yml": "application/yaml",
};

const fileTypeModuleLoader = createLazyImportLoader(() => import("file-type"));

/** Normalizes MIME strings by dropping parameters, lowercasing, and folding APNG to PNG. */
export function normalizeMimeType(mime?: string | null): string | undefined {
  if (!mime) {
    return undefined;
  }
  const cleaned = mime.split(";")[0]?.trim().toLowerCase();
  if (cleaned === "image/apng") {
    return "image/png";
  }
  return cleaned || undefined;
}

/** Returns the bounded buffer prefix used for dependency MIME sniffing. */
export function sliceMimeSniffBuffer(buffer: Buffer): Buffer {
  if (buffer.byteLength <= FILE_TYPE_SNIFF_MAX_BYTES) {
    return buffer;
  }
  return buffer.subarray(0, FILE_TYPE_SNIFF_MAX_BYTES);
}

async function sniffMime(buffer?: Buffer): Promise<string | undefined> {
  if (!buffer) {
    return undefined;
  }
  try {
    const { fileTypeFromBuffer } = await fileTypeModuleLoader.load();
    const type = await fileTypeFromBuffer(sliceMimeSniffBuffer(buffer));
    if (type?.mime) {
      return normalizeMimeType(type.mime);
    }
  } catch {
    // fall through to manual magic-byte sniffs
  }
  return sniffKnownAudioMagic(buffer);
}

// Fallbacks for audio containers `file-type` doesn't recognize natively (e.g.
// Apple's CAF, used by iMessage voice memos when produced by `afconvert`).
// Without this the host-local-media validator drops these buffers as unknown
// binary blobs because the sniff returns undefined, even though the file is
// a valid audio container.
function sniffKnownAudioMagic(buffer: Buffer): string | undefined {
  if (buffer.byteLength >= 4 && buffer.toString("ascii", 0, 4) === "caff") {
    return "audio/x-caf";
  }
  return undefined;
}

/** Extracts a lowercase extension from a local path or HTTP URL pathname. */
export function getFileExtension(filePath?: string | null): string | undefined {
  if (!filePath) {
    return undefined;
  }
  try {
    if (/^https?:\/\//i.test(filePath)) {
      const url = new URL(filePath);
      let filename = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
      try {
        // Decode only the URL filename while keeping encoded separators literal.
        const decodable = filename.replace(/%2f/gi, "%252F").replace(/%5c/gi, "%255C");
        filename = decodeURIComponent(decodable);
      } catch {
        // Preserve the raw filename when its own percent encoding is malformed.
      }
      return path.posix.extname(filename).toLowerCase() || undefined;
    }
  } catch {
    // fall back to plain path parsing
  }
  const ext = path.extname(filePath).toLowerCase();
  return ext || undefined;
}

/** Maps a file path or URL extension to the preferred MIME type when known. */
export function mimeTypeFromFilePath(filePath?: string | null): string | undefined {
  const ext = getFileExtension(filePath);
  if (!ext) {
    return undefined;
  }
  return MIME_BY_EXT[ext];
}

/** Returns true when a filename extension is a supported audio container. */
export function isAudioFileName(fileName?: string | null): boolean {
  return mediaKindFromMime(mimeTypeFromFilePath(fileName)) === "audio";
}

/** Detects the best MIME type from bytes, file path, and header metadata. */
export function detectMime(opts: {
  buffer?: Buffer;
  headerMime?: string | null;
  filePath?: string;
}): Promise<string | undefined> {
  return detectMimeImpl(opts);
}

function isGenericMime(mime?: string): boolean {
  if (!mime) {
    return true;
  }
  const m = mime.toLowerCase();
  return m === "application/octet-stream" || m === "application/zip";
}

function isImageMime(mime?: string): boolean {
  return mediaKindFromMime(normalizeMimeType(mime)) === "image";
}

async function detectMimeImpl(opts: {
  buffer?: Buffer;
  headerMime?: string | null;
  filePath?: string;
}): Promise<string | undefined> {
  const ext = getFileExtension(opts.filePath);
  const extMime = ext ? MIME_BY_EXT[ext] : undefined;

  const headerMime = normalizeMimeType(opts.headerMime);
  const sniffed = await sniffMime(opts.buffer);
  const sniffedGenericContainer = sniffed && isGenericMime(sniffed);
  const trustedExtMime = sniffedGenericContainer && isImageMime(extMime) ? undefined : extMime;
  const trustedHeaderMime =
    sniffedGenericContainer && isImageMime(headerMime) ? undefined : headerMime;

  // Prefer sniffed types, but don't let generic container types override a more
  // specific extension mapping (e.g. XLSX vs ZIP).
  if (sniffed && (!isGenericMime(sniffed) || !trustedExtMime)) {
    return sniffed;
  }
  if (trustedExtMime) {
    return trustedExtMime;
  }
  if (trustedHeaderMime && !isGenericMime(trustedHeaderMime)) {
    return trustedHeaderMime;
  }
  if (sniffed) {
    return sniffed;
  }
  if (trustedHeaderMime) {
    return trustedHeaderMime;
  }

  return undefined;
}

/** Returns the preferred file extension for a normalized or raw MIME string. */
export function extensionForMime(mime?: string | null): string | undefined {
  const normalized = normalizeMimeType(mime);
  if (!normalized) {
    return undefined;
  }
  return EXT_BY_MIME[normalized];
}

/** Returns true when content type or filename identifies GIF media. */
export function isGifMedia(opts: {
  contentType?: string | null;
  fileName?: string | null;
}): boolean {
  if (normalizeMimeType(opts.contentType) === "image/gif") {
    return true;
  }
  const ext = getFileExtension(opts.fileName);
  return ext === ".gif";
}

/** Maps image format labels from encoders/probes to MIME types. */
export function imageMimeFromFormat(format?: string | null): string | undefined {
  if (!format) {
    return undefined;
  }
  switch (format.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "heic":
      return "image/heic";
    case "heif":
      return "image/heif";
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

/** Normalizes a MIME string before classifying it into a media family. */
export function kindFromMime(mime?: string | null): MediaKind | undefined {
  return mediaKindFromMime(normalizeMimeType(mime));
}
