export type TelegramMediaContextPayload = {
  MediaPath?: string;
  MediaUrl?: string;
  MediaType?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
};

export function pruneStickerMediaFromContext(
  ctxPayload: TelegramMediaContextPayload,
  opts?: { stickerMediaIncluded?: boolean },
) {
  if (opts?.stickerMediaIncluded === false) {
    return;
  }
  const nextMediaPaths = Array.isArray(ctxPayload.MediaPaths)
    ? ctxPayload.MediaPaths.slice(1)
    : undefined;
  const nextMediaUrls = Array.isArray(ctxPayload.MediaUrls)
    ? ctxPayload.MediaUrls.slice(1)
    : undefined;
  const nextMediaTypes = Array.isArray(ctxPayload.MediaTypes)
    ? ctxPayload.MediaTypes.slice(1)
    : undefined;
  ctxPayload.MediaPaths = nextMediaPaths && nextMediaPaths.length > 0 ? nextMediaPaths : undefined;
  ctxPayload.MediaUrls = nextMediaUrls && nextMediaUrls.length > 0 ? nextMediaUrls : undefined;
  ctxPayload.MediaTypes = nextMediaTypes && nextMediaTypes.length > 0 ? nextMediaTypes : undefined;
  ctxPayload.MediaPath = ctxPayload.MediaPaths?.[0];
  ctxPayload.MediaUrl = ctxPayload.MediaUrls?.[0] ?? ctxPayload.MediaPath;
  ctxPayload.MediaType = ctxPayload.MediaTypes?.[0];
}
