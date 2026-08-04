// Google provider inbound-media boundary implements ProtoJSON base64 decoding.
// Every Google response path that receives inline media (Live, TTS, video,
// music) normalizes the URL-safe alphabet here before the shared strict
// validator, so ProtoJSON bytes fields are accepted without weakening the
// malformed-base64 guard for any surface.
import { canonicalizeBase64 } from "openclaw/plugin-sdk/media-runtime";

export function canonicalizeGoogleProviderBase64(value: string): string | undefined {
  const usesStandardAlphabet = value.includes("+") || value.includes("/");
  const usesUrlSafeAlphabet = value.includes("-") || value.includes("_");
  if (usesStandardAlphabet && usesUrlSafeAlphabet) {
    return undefined;
  }
  if (!usesUrlSafeAlphabet) {
    return canonicalizeBase64(value);
  }
  return canonicalizeBase64(value.replace(/[-_]/g, (symbol) => (symbol === "-" ? "+" : "/")));
}
