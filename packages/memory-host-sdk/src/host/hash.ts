// Memory Host SDK module implements hash behavior.
import crypto from "node:crypto";

/** SHA-256 hash helper for stable cache/content keys. */
export function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
