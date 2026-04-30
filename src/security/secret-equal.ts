import { timingSafeEqual } from "node:crypto";

function padSecretBytes(bytes: Buffer, length: number): Buffer {
  if (bytes.length === length) {
    return bytes;
  }
  const padded = Buffer.alloc(length);
  bytes.copy(padded);
  return padded;
}

export function safeEqualSecret(
  provided: string | undefined | null,
  expected: string | undefined | null,
): boolean {
  if (typeof provided !== "string" || typeof expected !== "string") {
    return false;
  }
  const providedBytes = Buffer.from(provided, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  const byteLength = Math.max(providedBytes.length, expectedBytes.length);
  if (byteLength === 0) {
    return true;
  }
  return (
    timingSafeEqual(
      padSecretBytes(providedBytes, byteLength),
      padSecretBytes(expectedBytes, byteLength),
    ) && providedBytes.length === expectedBytes.length
  );
}
