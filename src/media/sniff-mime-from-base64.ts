// Base64 mime sniffing helpers infer media types from encoded payload bytes.
import { canonicalizeBase64 } from "@openclaw/media-core/base64";
import { detectMime } from "@openclaw/media-core/mime";

const BASE64_SNIFF_PREFIX_CHARS = 256;

/** Detects MIME from a bounded base64 prefix and optional caller metadata. */
export async function sniffMimeFromBase64(
  base64: string,
  hints: Pick<
    Parameters<typeof detectMime>[0],
    "headerMime" | "filePath" | "additionalMimeHints"
  > = {},
): Promise<string | undefined> {
  const canonical = canonicalizeBase64(base64);
  if (!canonical) {
    return undefined;
  }

  const take = Math.min(BASE64_SNIFF_PREFIX_CHARS, canonical.length);
  const sliceLength = take - (take % 4);
  // Keep the existing minimum so short magic-byte prefixes are not treated as complete media.
  const head = sliceLength < 8 ? undefined : Buffer.from(canonical.slice(0, sliceLength), "base64");
  return await detectMime({ ...hints, buffer: head });
}
