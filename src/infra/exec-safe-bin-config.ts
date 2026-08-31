import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { normalizeTrustedSafeBinDirs } from "./exec-safe-bin-trust.js";

export function normalizeConfiguredSafeBins(entries: unknown): string[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  return Array.from(
    new Set(
      entries
        .map((entry) => normalizeOptionalLowercaseString(entry) ?? "")
        .filter((entry) => entry.length > 0),
    ),
  ).toSorted();
}

export function normalizeConfiguredTrustedSafeBinDirs(entries: unknown): string[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  return normalizeTrustedSafeBinDirs(
    entries.filter((entry): entry is string => typeof entry === "string"),
  );
}
