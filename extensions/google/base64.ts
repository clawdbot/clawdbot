// Google provider inbound-media boundary implements ProtoJSON base64 decoding.
// Every Google response path that receives inline media (Live, TTS, video,
// music) normalizes the URL-safe alphabet here before the shared strict
// validator, so ProtoJSON bytes fields are accepted without weakening the
// malformed-base64 guard for any surface.
import { canonicalizeBase64 } from "openclaw/plugin-sdk/media-runtime";

/**
 * Convert a ProtoJSON URL-safe Base64 payload to the standard alphabet without
 * validating the payload. Returns undefined when the input mixes alphabets, so
 * callers can reject it before the shared strict validator runs once.
 */
export function toStandardGoogleProviderBase64(value: string): string | undefined {
  const usesStandardAlphabet = value.includes("+") || value.includes("/");
  const usesUrlSafeAlphabet = value.includes("-") || value.includes("_");
  if (usesStandardAlphabet && usesUrlSafeAlphabet) {
    return undefined;
  }
  return usesUrlSafeAlphabet
    ? value.replace(/[-_]/g, (symbol) => (symbol === "-" ? "+" : "/"))
    : value;
}

export function canonicalizeGoogleProviderBase64(value: string): string | undefined {
  const standard = toStandardGoogleProviderBase64(value);
  return standard === undefined ? undefined : canonicalizeBase64(standard);
}
