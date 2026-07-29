// Elevenlabs plugin module implements shared behavior.
export const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";

export function isValidElevenLabsVoiceId(voiceId: string): boolean {
  return /^[a-zA-Z0-9]{10,40}$/.test(voiceId);
}

function normalizeElevenLabsBaseUrlWithProtocols(
  baseUrl: string | undefined,
  allowedProtocols: readonly string[],
): string {
  const trimmed = baseUrl?.trim();
  // Only an absent/blank value falls back to the default endpoint. An explicit
  // custom endpoint is operator intent, so never silently retarget it.
  if (!trimmed) {
    return DEFAULT_ELEVENLABS_BASE_URL;
  }
  const normalized = trimmed.replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    // Do not interpolate the raw value: an explicit baseUrl may embed userinfo
    // (https://user:token@host) or credential-bearing query params that would
    // otherwise leak into logs/diagnostics via this error.
    throw new Error("Invalid ElevenLabs baseUrl: value is not a valid URL");
  }
  if (!allowedProtocols.includes(parsed.protocol)) {
    // Only the scheme is safe to surface; the rest of the URL may carry secrets.
    throw new Error(
      `Invalid ElevenLabs baseUrl: unsupported scheme "${parsed.protocol}" (expected ${allowedProtocols.join(" or ")})`,
    );
  }
  return normalized;
}

export function normalizeElevenLabsBaseUrl(baseUrl?: string): string {
  return normalizeElevenLabsBaseUrlWithProtocols(baseUrl, ["http:", "https:"]);
}

export function normalizeElevenLabsRealtimeBaseUrl(baseUrl?: string): string {
  const url = new URL(
    normalizeElevenLabsBaseUrlWithProtocols(baseUrl, ["http:", "https:", "ws:", "wss:"]),
  );
  if (url.protocol === "http:" || url.protocol === "https:") {
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  }
  return url.toString().replace(/\/+$/, "");
}
