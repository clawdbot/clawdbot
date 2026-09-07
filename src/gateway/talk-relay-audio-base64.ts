// Shared guard for browser-provided Talk relay audio frames.
import { canonicalizeBase64 } from "@openclaw/media-core/base64";

export function decodeTalkRelayAudioBase64(base64: string, label: string): Buffer {
  const canonicalBase64 = canonicalizeBase64(base64.replace(/-/gu, "+").replace(/_/gu, "/"));
  if (!canonicalBase64) {
    throw new Error(`${label} audio frame is invalid base64`);
  }
  const audio = Buffer.from(canonicalBase64, "base64");
  if (audio.toString("base64") !== canonicalBase64) {
    throw new Error(`${label} audio frame is invalid base64`);
  }
  return audio;
}
