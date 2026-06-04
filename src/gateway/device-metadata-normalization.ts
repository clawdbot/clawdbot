// Device metadata normalization for auth payloads and policy matching.
function normalizeTrimmedMetadata(value?: string | null): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : "";
}

function toLowerAscii(input: string): string {
  return input.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}

/** Normalize device metadata for cross-runtime auth comparisons. */
export function normalizeDeviceMetadataForAuth(value?: string | null): string {
  const trimmed = normalizeTrimmedMetadata(value);
  if (!trimmed) {
    return "";
  }
  // Keep cross-runtime normalization deterministic (TS/Swift/Kotlin) by only
  // lowercasing ASCII metadata fields used in auth payloads.
  return toLowerAscii(trimmed);
}

/** Normalize device metadata for policy classification. */
export function normalizeDeviceMetadataForPolicy(value?: string | null): string {
  const trimmed = normalizeTrimmedMetadata(value);
  if (!trimmed) {
    return "";
  }
  // Policy classification should collapse Unicode confusables to stable ASCII-ish
  // tokens where possible before matching platform/family rules.
  return normalizeLowercaseStringOrEmpty(trimmed.normalize("NFKD").replace(/\p{M}/gu, ""));
}
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
