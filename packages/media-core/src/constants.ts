/** Default outbound image payload cap shared by media loaders and adapters. */
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // 6MB
/** Default outbound audio payload cap shared by media loaders and adapters. */
export const MAX_AUDIO_BYTES = 16 * 1024 * 1024; // 16MB
/** Default outbound video payload cap shared by media loaders and adapters. */
export const MAX_VIDEO_BYTES = 16 * 1024 * 1024; // 16MB
/** Default outbound document payload cap shared by media loaders and adapters. */
export const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024; // 100MB

/** Media families that share size-policy and MIME-classification behavior. */
export type MediaKind = "image" | "audio" | "video" | "document";

/** Maps a MIME type to the media family used for size limits and routing. */
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

/** Returns the default byte cap for a classified media family. */
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
