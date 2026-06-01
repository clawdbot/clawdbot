export const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // 6MB
export const MAX_AUDIO_BYTES = 16 * 1024 * 1024; // 16MB
export const MAX_VIDEO_BYTES = 16 * 1024 * 1024; // 16MB
export const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024; // 100MB

export type MediaKind = "image" | "audio" | "video" | "document";

export function mediaKindFromMime(mime?: string | null): MediaKind | undefined {
  if (!mime) {
    return undefined;
  }
  if (mime.startsWith("image/")) {
    return "image";
  }
  if (mime.startsWith("audio/")) {
    return "audio";
  }
  if (mime.startsWith("video/")) {
    return "video";
  }
  if (mime === "application/pdf") {
    return "document";
  }
  if (mime.startsWith("text/")) {
    return "document";
  }
  if (mime.startsWith("application/")) {
    return "document";
  }
  return undefined;
}

export function maxBytesForKind(kind: MediaKind): number {
  switch (kind) {
    case "image":
      return MAX_IMAGE_BYTES;
    case "audio":
      return MAX_AUDIO_BYTES;
    case "video":
      return MAX_VIDEO_BYTES;
    case "document":
      return MAX_DOCUMENT_BYTES;
    default:
      return MAX_DOCUMENT_BYTES;
  }
}
