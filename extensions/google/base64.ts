// Google provider module implements strict base64 decoding helpers.
import { canonicalizeBase64, estimateBase64DecodedBytes } from "openclaw/plugin-sdk/media-runtime";

function normalizeGoogleProviderBase64Alphabet(value: string): string | undefined {
  const hasStandardOnlyChars = value.includes("+") || value.includes("/");
  const hasUrlSafeOnlyChars = value.includes("-") || value.includes("_");
  if (hasStandardOnlyChars && hasUrlSafeOnlyChars) {
    return undefined;
  }
  if (!hasUrlSafeOnlyChars) {
    return value;
  }
  return value.replaceAll("-", "+").replaceAll("_", "/");
}

export function decodeGoogleProviderBase64(
  value: string,
  params: {
    malformedMessage: string;
    maxBytes?: number;
    overflowMessage?: (maxBytes: number) => string;
  },
): Buffer {
  if (params.maxBytes !== undefined && estimateBase64DecodedBytes(value) > params.maxBytes) {
    throw new Error(params.overflowMessage?.(params.maxBytes) ?? "Google base64 payload too large");
  }
  const normalized = normalizeGoogleProviderBase64Alphabet(value);
  const canonical = normalized ? canonicalizeBase64(normalized) : undefined;
  if (!canonical) {
    throw new Error(params.malformedMessage);
  }
  const buffer = Buffer.from(canonical, "base64");
  if (params.maxBytes !== undefined && buffer.length > params.maxBytes) {
    throw new Error(params.overflowMessage?.(params.maxBytes) ?? "Google base64 payload too large");
  }
  return buffer;
}
