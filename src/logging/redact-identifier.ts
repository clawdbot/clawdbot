// Identifier redaction helpers replace sensitive identifiers with stable hashes.
import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** Returns a stable sha256 hex prefix for non-secret identifier correlation. */
export function sha256HexPrefix(value: string, len = 12): string {
  const safeLen = Number.isFinite(len) ? Math.max(1, Math.floor(len)) : 12;
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, safeLen);
}

/** Redacts an identifier to a stable hash label, or "-" for missing values. */
export function redactIdentifier(value: string | undefined, opts?: { len?: number }): string {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return "-";
  }
  return `sha256:${sha256HexPrefix(trimmed, opts?.len ?? 12)}`;
}
