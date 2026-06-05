// Base64 mime sniffing helpers infer media types from encoded payload bytes.
import { canonicalizeBase64 } from "@openclaw/media-core/base64";
import { detectMime } from "@openclaw/media-core/mime";

/** Sniffs a MIME type from canonical base64 without decoding the full payload. */
export async function sniffMimeFromBase64(base64: string): Promise<string | undefined> {
  const trimmed = base64.trim();
  const canonicalBase64 = trimmed ? canonicalizeBase64(trimmed) : undefined;
  if (!canonicalBase64) {
    return undefined;
  }

  const take = Math.min(256, canonicalBase64.length);
  const sliceLen = take - (take % 4);
  // Need at least two base64 quads so magic-byte sniffers see more than a trivial prefix.
  if (sliceLen < 8) {
    return undefined;
  }

  try {
    const head = Buffer.from(canonicalBase64.slice(0, sliceLen), "base64");
    return await detectMime({ buffer: head });
  } catch {
    return undefined;
  }
}
