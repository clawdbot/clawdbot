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

/** Detects an active automatic fallback rather than a self-origin configured selection. */
export function hasSessionActiveAutoModelFallback(
  entry:
    | Pick<
        SessionEntry,
        | "providerOverride"
        | "modelOverride"
        | "modelOverrideSource"
        | "modelOverrideFallbackOriginProvider"
        | "modelOverrideFallbackOriginModel"
      >
    | undefined,
): boolean {
  if (!entry) {
    return false;
  }
  if (
    !hasSessionAutoModelFallbackProvenance(entry) ||
    (entry.modelOverrideSource !== undefined && entry.modelOverrideSource !== "auto")
  ) {
    return false;
  }
  const originProvider = normalizeOptionalString(entry.modelOverrideFallbackOriginProvider);
  const originModel = normalizeOptionalString(entry.modelOverrideFallbackOriginModel);
  const overrideProvider = normalizeOptionalString(entry.providerOverride) ?? originProvider;
  const overrideModel = normalizeOptionalString(entry.modelOverride) ?? originModel;
  // Configured subagent selections deliberately carry self-origin metadata so cleanup preserves
  // them. Only a different effective selection represents provider failover to users.
  return overrideProvider !== originProvider || overrideModel !== originModel;
}
