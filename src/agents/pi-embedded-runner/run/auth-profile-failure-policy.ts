import type { AuthProfileFailureReason } from "../../auth-profiles/types.js";
import type { FailoverReason } from "../../pi-embedded-helpers/types.js";
import type { AuthProfileFailurePolicy } from "./auth-profile-failure-policy.types.js";

export function resolveAuthProfileFailureReason(params: {
  failoverReason: FailoverReason | null;
  policy?: AuthProfileFailurePolicy;
}): AuthProfileFailureReason | null {
  // Helper-local runs and transport timeouts should not poison shared provider auth health.
  if (params.policy === "local" || !params.failoverReason || params.failoverReason === "timeout") {
    return null;
  }
  return params.failoverReason;
}
