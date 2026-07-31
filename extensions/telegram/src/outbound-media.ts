import { extensionForMime, type MediaKind } from "openclaw/plugin-sdk/media-mime";

export function resolveTelegramOutboundMediaFilename(params: {
  fileName?: string;
  contentType?: string;
  kind?: MediaKind;
  isGif: boolean;
}): string {
  if (params.fileName) {
    return params.fileName;
  }
  if (params.isGif) {
    return "animation.gif";
  }

  // Telegram receives only the multipart filename, so preserve the detected
  // MIME extension instead of labeling every anonymous upload as another format.
  const basename =
    params.kind === "image" || params.kind === "video" || params.kind === "audio"
      ? params.kind
      : "file";
  const defaultExtension =
    params.kind === "image"
      ? ".jpg"
      : params.kind === "video"
        ? ".mp4"
        : params.kind === "audio"
          ? ".ogg"
          : ".bin";
  return `${basename}${extensionForMime(params.contentType) ?? defaultExtension}`;
}
