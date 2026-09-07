import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export { sha256Hex, sha256HexPrefixCore } from "@openclaw/normalization-core/node-crypto";

type DigestInput = string | Uint8Array;

export function sha256Base64(input: DigestInput): string {
  return createHash("sha256").update(input).digest("base64");
}

export function sha256Base64Url(input: DigestInput): string {
  return createHash("sha256").update(input).digest("base64url");
}

export function sha256Base64UrlPrefix(input: DigestInput, length: number): string {
  return sha256Base64Url(input).slice(0, length);
}

/** Streams a file, optionally stopping at an inclusive byte offset. */
export async function sha256File(filePath: string, end?: number): Promise<string> {
  const digest = createHash("sha256");
  try {
    for await (const chunk of createReadStream(filePath, { end })) {
      digest.update(chunk);
    }
  } catch (err) {
    throw new Error(
      `Failed to hash file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return digest.digest("hex");
}
