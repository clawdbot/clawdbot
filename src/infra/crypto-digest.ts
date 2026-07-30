import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

type DigestInput = string | Uint8Array;

export function sha256Hex(input: DigestInput): string {
  return createHash("sha256").update(input).digest("hex");
}

export function sha256Base64(input: DigestInput): string {
  return createHash("sha256").update(input).digest("base64");
}

export function sha256Base64Url(input: DigestInput): string {
  return createHash("sha256").update(input).digest("base64url");
}

export function sha256Base64UrlPrefix(input: DigestInput, length: number): string {
  return sha256Base64Url(input).slice(0, length);
}

export function sha256HexPrefix(input: DigestInput, length: number): string {
  return sha256Hex(input).slice(0, length);
}

export async function sha256File(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  try {
    for await (const chunk of createReadStream(filePath)) {
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
