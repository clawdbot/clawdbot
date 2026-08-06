// Device metadata normalization for auth payloads and policy matching.
function normalizeTrimmedMetadata(value?: string | null): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : "";
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
