import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

export function normalizeFingerprint(input: string): string {
  const trimmed = input.trim();
  const withoutPrefix = trimmed.replace(/^sha-?256\s*:?\s*/i, "");
  return normalizeLowercaseStringOrEmpty(withoutPrefix.replace(/[^a-fA-F0-9]/g, ""));
}
