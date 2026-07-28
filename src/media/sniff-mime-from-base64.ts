// Base64 mime sniffing helpers infer media types from encoded payload bytes.
import { canonicalizeBase64 } from "@openclaw/media-core/base64";
import { detectMime } from "@openclaw/media-core/mime";

const BASE64_SNIFF_PREFIX_CHARS = 256;

/** Sniffs a MIME type from a small base64 prefix after validating the full payload. */
export async function sniffMimeFromBase64(base64: string): Promise<string | undefined> {
  const canonical = canonicalizeBase64(base64);
  if (!canonical) {
    return undefined;
  }

  const take = Math.min(BASE64_SNIFF_PREFIX_CHARS, canonical.length);
  const sliceLength = take - (take % 4);
  // Keep the existing minimum so short magic-byte prefixes are not treated as complete media.
  if (sliceLength < 8) {
    return undefined;
  }

  try {
    const canonicalPrefix = canonical.slice(0, sliceLength);
    const head = Buffer.from(canonicalPrefix, "base64");
    return await detectMime({ buffer: head });
  } catch {
    return undefined;
  }
}
