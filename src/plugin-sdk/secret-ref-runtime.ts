// Narrow shared secret-ref helpers for plugin config and secret-contract paths.

import { resolveSecretPlanTargetByPath as resolveSecretPlanTargetByPathInternal } from "../secrets/target-registry-query.js";

export { coerceSecretRef } from "../config/types.secrets.js";
export type { SecretInput, SecretRef } from "../config/types.secrets.js";
export { resolveSecretRefValues } from "../secrets/resolve.js";
export { applyResolvedAssignments, createResolverContext } from "../secrets/runtime-shared.js";

export type ResolvedSecretPlanTarget = {
  targetType: string;
  providerId?: string;
  accountId?: string;
};

export function resolveSecretPlanTargetByPath(params: {
  configFile: "openclaw.json" | "auth-profiles.json";
  pathSegments: string[];
}): ResolvedSecretPlanTarget | null {
  const resolved = resolveSecretPlanTargetByPathInternal(params);
  if (!resolved) {
    return null;
  }
  return {
    targetType: resolved.entry.targetType,
    ...(resolved.providerId ? { providerId: resolved.providerId } : {}),
    ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
  };
}
