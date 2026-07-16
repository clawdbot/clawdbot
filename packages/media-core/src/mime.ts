// Media Core module implements mime behavior.
import path from "node:path";
import { type MediaKind, mediaKindFromMime } from "./constants.js";
import { extnameFromAnyPath } from "./file-name.js";

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

const AMBIGUOUS_VIDEO_MIME_BY_AUDIO_MIME: Readonly<Record<string, string>> = {
  "audio/mp4": "video/mp4",
  "audio/webm": "video/webm",
};

// file-type can return generic ZIP when package metadata is outside its sniff window.
// Only ZIP-backed MIME families may refine that result; arbitrary headers cannot.
const ZIP_CONTAINER_MIMES = new Set([
  "application/java-archive",
  "application/vnd.android.package-archive",
  "application/vnd.apple.keynote",
  "application/vnd.apple.numbers",
  "application/vnd.apple.pages",
  "application/vnd.google-earth.kmz",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/vnd.ms-excel.template.macroenabled.12",
  "application/vnd.ms-powerpoint.presentation.macroenabled.12",
  "application/vnd.ms-powerpoint.slideshow.macroenabled.12",
  "application/vnd.ms-powerpoint.template.macroenabled.12",
  "application/vnd.ms-visio.drawing",
  "application/vnd.ms-visio.drawing.macroenabled.12",
  "application/vnd.ms-visio.stencil",
  "application/vnd.ms-visio.stencil.macroenabled.12",
  "application/vnd.ms-visio.template",
  "application/vnd.ms-visio.template.macroenabled.12",
  "application/vnd.ms-word.document.macroenabled.12",
  "application/vnd.ms-word.template.macroenabled.12",
  "application/vnd.oasis.opendocument.graphics",
  "application/vnd.oasis.opendocument.graphics-template",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.presentation-template",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.spreadsheet-template",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.text-template",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
  "application/vnd.openxmlformats-officedocument.presentationml.template",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  "application/x-xpinstall",
  "model/3mf",
]);

function isZipContainerMime(mime: string): boolean {
  return mime.endsWith("+zip") || ZIP_CONTAINER_MIMES.has(mime);
}

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
    const { fileTypeFromBuffer } = await import("file-type");
    const type = await fileTypeFromBuffer(sliceMimeSniffBuffer(buffer));
    if (type?.mime) {
      return normalizeMimeType(type.mime);
    }
  } catch {
    // fall through to manual magic-byte sniffs
  }
  // Preserve iMessage CAF voice memos; file-type v22 does not detect them.
  return buffer.toString("ascii", 0, 4) === "caff" ? "audio/x-caf" : undefined;
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
  const ext = extnameFromAnyPath(filePath).toLowerCase();
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
export async function detectMime(opts: {
  buffer?: Buffer;
  headerMime?: string | null;
  additionalMimeHints?: readonly (string | null | undefined)[];
  filePath?: string;
}): Promise<string | undefined> {
  const extMime = MIME_BY_EXT[getFileExtension(opts.filePath) ?? ""];
  const mimeHints = [opts.headerMime, ...(opts.additionalMimeHints ?? [])]
    .map((mime) => normalizeMimeType(mime))
    .filter((mime): mime is string => Boolean(mime));
  const headerMime = mimeHints[0];
  const sniffed = await sniffMime(opts.buffer);
  const sniffedGenericContainer =
    sniffed === "application/octet-stream" || sniffed === "application/zip";

  // Prefer sniffed types, but don't let generic container types override a more
  // specific extension or known container metadata (e.g. XLSX vs ZIP).
  const specificExtMime =
    extMime && extMime !== sniffed && !extMime.startsWith("image/") ? extMime : undefined;
  const genericContainerMime =
    sniffed === "application/zip"
      ? [extMime, ...mimeHints].find((mime) => mime && isZipContainerMime(mime))
      : sniffed === "application/octet-stream"
        ? (specificExtMime ?? mimeHints.find((mime) => mime !== "application/octet-stream"))
        : undefined;
  const inferred = sniffedGenericContainer
    ? (genericContainerMime ?? sniffed)
    : (sniffed ?? extMime);
  // file-type defaults these containers to video without parsing their tracks.
  // Preserve a concrete audio hint only for those documented ambiguous results.
  const audioContainerHint = mimeHints.find(
    (mime) => AMBIGUOUS_VIDEO_MIME_BY_AUDIO_MIME[mime] === inferred,
  );
  if (audioContainerHint) {
    return audioContainerHint;
  }
  return inferred ?? headerMime;
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
