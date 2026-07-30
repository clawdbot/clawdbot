// Google provider module implements ProtoJSON base64 decoding.
import { canonicalizeBase64 } from "openclaw/plugin-sdk/media-runtime";

export function canonicalizeGoogleProviderBase64(value: string): string | undefined {
  const usesStandardAlphabet = value.includes("+") || value.includes("/");
  const usesUrlSafeAlphabet = value.includes("-") || value.includes("_");
  if (usesStandardAlphabet && usesUrlSafeAlphabet) {
    return undefined;
  }
  return canonicalizeBase64(
    usesUrlSafeAlphabet ? value.replaceAll("-", "+").replaceAll("_", "/") : value,
  );
}
