// Model override provenance detects fallback-generated selections that resets should drop.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "./types.js";

/** Detects model overrides created by automatic fallback provenance. */
export function hasSessionAutoModelFallbackProvenance(
  entry:
    | Pick<
        SessionEntry,
        | "providerOverride"
        | "modelOverride"
        | "modelOverrideFallbackOriginProvider"
        | "modelOverrideFallbackOriginModel"
      >
    | undefined,
): boolean {
  const hasActiveOverride = Boolean(
    normalizeOptionalString(entry?.providerOverride) ||
    normalizeOptionalString(entry?.modelOverride),
  );
  return Boolean(
    hasActiveOverride &&
    normalizeOptionalString(entry?.modelOverrideFallbackOriginProvider) &&
    normalizeOptionalString(entry?.modelOverrideFallbackOriginModel),
  );
}
