// File Transfer plugin module implements mime behavior.
import { mimeTypeFromFilePath } from "openclaw/plugin-sdk/media-mime";

// MIME types we treat as inline-displayable images for vision-capable models.
// Note: heic/heif are detectable but not all providers can render them, so we
// leave them out of the inline-image set and let them flow as text+saved-path.
export const IMAGE_MIME_INLINE_SET = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export const TEXT_INLINE_MAX_BYTES = 8 * 1024;

export function mimeFromExtension(filePath: string): string {
  return mimeTypeFromFilePath(filePath) ?? "application/octet-stream";
}
