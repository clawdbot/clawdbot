import { canonicalizeBase64 } from "./base64.js";
import { detectMime } from "./mime.js";

export async function sniffMimeFromBase64(base64: string): Promise<string | undefined> {
  const trimmed = base64.trim();
  const canonicalBase64 = trimmed ? canonicalizeBase64(trimmed) : undefined;
  if (!canonicalBase64) {
    return undefined;
  }

  const take = Math.min(256, canonicalBase64.length);
  const sliceLen = take - (take % 4);
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
