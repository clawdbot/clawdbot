import { canonicalizeBase64 } from "openclaw/plugin-sdk/media-runtime";

export function canonicalizeVoiceCallMediaBase64(payloadBase64: string): string | undefined {
  // Preserve the provider adapter's base64url contract; canonicalizeBase64 restores padding.
  return canonicalizeBase64(payloadBase64.replaceAll("-", "+").replaceAll("_", "/"));
}
