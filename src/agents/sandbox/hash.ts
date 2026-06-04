import crypto from "node:crypto";

/** Returns a stable SHA-256 hex digest for sandbox config/cache keys. */
export function hashTextSha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
