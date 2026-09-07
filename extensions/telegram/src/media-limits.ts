const DEFAULT_TELEGRAM_MEDIA_MAX_BYTES = 100 * 1024 * 1024;
const MIB = 1024 * 1024;

export function resolveTelegramMediaMaxBytes(params: {
  maxBytes?: number;
  mediaMaxMb?: number;
  fallbackMediaMaxMb?: number;
}): number {
  if (
    typeof params.maxBytes === "number" &&
    Number.isFinite(params.maxBytes) &&
    params.maxBytes >= 0
  ) {
    return Math.floor(params.maxBytes);
  }
  const mediaMaxMb = [params.mediaMaxMb, params.fallbackMediaMaxMb].find(
    (candidate): candidate is number =>
      typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0,
  );
  return mediaMaxMb === undefined ? DEFAULT_TELEGRAM_MEDIA_MAX_BYTES : Math.floor(mediaMaxMb * MIB);
}
