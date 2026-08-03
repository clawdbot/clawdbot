// TLS fingerprint normalization accepts common SHA-256 display formats and
// stores lowercase hex for config comparisons.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

// Gateway TLS fingerprints are stored as lowercase hex without labels or
// separators so config comparisons stay format-insensitive.
export function normalizeFingerprint(input: string): string {
  const trimmed = input.trim();
  const withoutPrefix = trimmed.replace(/^sha-?256\s*:?\s*/i, "");
  return normalizeLowercaseStringOrEmpty(withoutPrefix.replace(/[^a-fA-F0-9]/g, ""));
}
