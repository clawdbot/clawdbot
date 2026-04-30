import path from "node:path";

// Single source of truth for extension→MIME mapping. Used by all four
// handlers/tools so adding a new extension lands everywhere at once.
export const EXTENSION_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".html": "text/html",
  ".xml": "application/xml",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
};

// MIME types we treat as inline-displayable images for vision-capable models.
// Note: heic/heif are detectable but not all providers can render them, so we
// leave them out of the inline-image set and let them flow as text+saved-path.
export const IMAGE_MIME_INLINE_SET = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

// Plain-text MIME types where inlining the content into a text block is more
// useful than a "saved at <path>" stub for small files (under TEXT_INLINE_MAX).
export const TEXT_INLINE_MIME_SET = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "application/json",
  "application/xml",
]);

export const TEXT_INLINE_MAX_BYTES = 8 * 1024;

export function mimeFromExtension(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_MIME[ext] ?? "application/octet-stream";
}
