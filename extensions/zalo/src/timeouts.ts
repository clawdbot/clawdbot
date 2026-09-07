export const ZALO_DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const ZALO_OUTBOUND_MEDIA_TTL_MS = 2 * 60_000;

// Zalo resolves photo URLs server-side. Wait through the hosted URL lifetime,
// then retain one ordinary request budget for provider response processing.
export const ZALO_SEND_PHOTO_REQUEST_TIMEOUT_MS =
  ZALO_OUTBOUND_MEDIA_TTL_MS + ZALO_DEFAULT_REQUEST_TIMEOUT_MS;
