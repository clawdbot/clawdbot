// Google provider module implements strict base64 decoding helpers.
import { canonicalizeBase64, estimateBase64DecodedBytes } from "openclaw/plugin-sdk/media-runtime";

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
  const canonical = canonicalizeBase64(value);
  if (!canonical) {
    throw new Error(params.malformedMessage);
  }
  const buffer = Buffer.from(canonical, "base64");
  if (params.maxBytes !== undefined && buffer.length > params.maxBytes) {
    throw new Error(params.overflowMessage?.(params.maxBytes) ?? "Google base64 payload too large");
  }
  return buffer;
}
