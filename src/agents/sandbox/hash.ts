/**
 * Sandbox hashing helper.
 *
 * Produces stable SHA-256 digests for config hashes, labels, and cache keys.
 */
import crypto from "node:crypto";

/** Returns a stable SHA-256 hex digest for sandbox config/cache keys. */
export function hashTextSha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
