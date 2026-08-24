import { canonicalizeBase64 } from "@openclaw/media-core/base64";

export function decodeMeetingAudioBase64(base64: string, action: string): Buffer {
  const canonicalBase64 = canonicalizeBase64(base64);
  if (!canonicalBase64) {
    throw new Error(`${action} base64 must be a valid audio payload`);
  }
  return Buffer.from(canonicalBase64, "base64");
}

export function isMeetingAudioBase64(base64: string): boolean {
  return canonicalizeBase64(base64) !== undefined;
}
