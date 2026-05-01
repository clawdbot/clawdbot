/**
 * Media type detection — pure functions for classifying files by MIME or extension.
 *
 * These replace the inline `isImageFile` and `isVideoFile` helpers scattered
 * across `outbound.ts`. Centralizing them here keeps detection consistent.
 */

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv"]);

/**
 * Extract a lowercase file extension from a path or URL, ignoring query and hash.
 */
export function getCleanExtension(filePath: string): string {
  const cleanPath = filePath.split("?")[0].split("#")[0];
  const lastDot = cleanPath.lastIndexOf(".");
  if (lastDot < 0) {
    return "";
  }
  return cleanPath.slice(lastDot).toLowerCase();
}

/** Check whether a file is an image using MIME first and extension as fallback. */
export function isImageFile(filePath: string, mimeType?: string): boolean {
  if (mimeType?.startsWith("image/")) {
    return true;
  }
  return IMAGE_EXTENSIONS.has(getCleanExtension(filePath));
}

/** Check whether a file is a video using MIME first and extension as fallback. */
export function isVideoFile(filePath: string, mimeType?: string): boolean {
  if (mimeType?.startsWith("video/")) {
    return true;
  }
  return VIDEO_EXTENSIONS.has(getCleanExtension(filePath));
}
