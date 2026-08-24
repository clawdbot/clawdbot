import type { ClawPackage, ClawPackagePreflightResult } from "./types.js";

/**
 * Coerces a plugin_version_conflict preflight into an install action for
 * update plans whose consented actions change the exact plugin version.
 * Owns the coerced result shape so callers never re-derive preflight fields
 * by hand; the shouldCoerce predicate keeps the plan-dependent decision in
 * the caller.
 */
export function coercePluginVersionConflictForUpdate(
  preflight: ClawPackagePreflightResult,
  pkg: ClawPackage,
  shouldCoerce: (pkg: ClawPackage) => boolean,
): ClawPackagePreflightResult {
  if (preflight.ok || pkg.kind !== "plugin" || preflight.code !== "plugin_version_conflict") {
    return preflight;
  }
  if (!shouldCoerce(pkg)) {
    return preflight;
  }
  return {
    ok: true,
    action: "install",
    ...(preflight.integrity ? { integrity: preflight.integrity } : {}),
    ...(preflight.installId ? { installId: preflight.installId } : {}),
    ...(preflight.warning ? { warning: preflight.warning } : {}),
    ...(preflight.requirements ? { requirements: preflight.requirements } : {}),
    ...(preflight.detectedFormat ? { detectedFormat: preflight.detectedFormat } : {}),
    ...(preflight.mapped ? { mapped: preflight.mapped } : {}),
    ...(preflight.unavailable ? { unavailable: preflight.unavailable } : {}),
    ...(preflight.adapterIdentity ? { adapterIdentity: preflight.adapterIdentity } : {}),
  };
}
