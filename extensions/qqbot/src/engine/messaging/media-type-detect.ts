/**
 * Media type detection — pure functions for classifying files by MIME or extension.
 *
 * These replace the inline `isImageFile`, `isVideoFile`, `isAudioFile` helpers
 * scattered across `outbound.ts`. Centralizing them here ensures consistent
 * detection across both the built-in and standalone versions.
 */

/** Supported media kind for QQ Bot outbound routing. */
export type MediaKind = "image" | "voice" | "video" | "file";

/** Display labels for media kinds. */
export const MEDIA_KIND_LABELS: Record<MediaKind | "media", string> = {
  image: "Image",
  voice: "Voice",
  video: "Video",
  file: "File",
  media: "Media",
};

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv"]);
const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".ogg",
  ".flac",
  ".aac",
  ".m4a",
  ".wma",
  ".opus",
  ".amr",
  ".silk",
  ".slk",
  ".pcm",
]);

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

/** Check whether a file is audio using MIME first and extension as fallback. */
export function isAudioFile(filePath: string, mimeType?: string): boolean {
  if (mimeType) {
    if (
      mimeType.startsWith("audio/") ||
      mimeType === "voice" ||
      mimeType.includes("silk") ||
      mimeType.includes("amr")
    ) {
      return true;
    }
  }
  return AUDIO_EXTENSIONS.has(getCleanExtension(filePath));
}

/**
 * Auto-detect the media kind from a file path and optional MIME type.
 *
 * Priority: audio → video → image → file (default).
 */
export function detectMediaKind(filePath: string, mimeType?: string): MediaKind {
  if (isAudioFile(filePath, mimeType)) {
    return "voice";
  }
  if (isVideoFile(filePath, mimeType)) {
    return "video";
  }
  if (isImageFile(filePath, mimeType)) {
    return "image";
  }
  return "file";
}

/** Return true when the source is a remote HTTP(S) URL. */
export function isHttpSource(source: string): boolean {
  return source.startsWith("http://") || source.startsWith("https://");
}

/** Return true when the source is a Base64 data URL. */
export function isDataSource(source: string): boolean {
  return source.startsWith("data:");
}

/** Return true when the source is a remote URL or data URL. */
export function isRemoteOrDataSource(source: string): boolean {
  return isHttpSource(source) || isDataSource(source);
}

/** Common MIME type mapping for image extensions. */
export const IMAGE_MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};
