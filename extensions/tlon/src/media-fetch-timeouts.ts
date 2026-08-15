// Header wait and body progress are separate failure modes. Keep both Tlon
// media directions on one policy so attachment and upload fallbacks stay aligned.
export const TLON_MEDIA_FETCH_TIMEOUTS = {
  responseHeaderTimeoutMs: 120_000,
  readIdleTimeoutMs: 30_000,
} as const;
