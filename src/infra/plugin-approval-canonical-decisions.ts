// Canonical plugin approval decisions used by approval runtimes and typed surfaces.
import type { ExecApprovalDecision } from "./exec-approvals.js";
import { resolvePluginApprovalRequestAllowedDecisions } from "./plugin-approvals.js";

/** Add the fail-closed deny verdict to the normalized plugin decision set. */
export function resolveCanonicalPluginApprovalRequestAllowedDecisions(params?: {
  allowedDecisions?: readonly ExecApprovalDecision[] | readonly string[] | null;
}): readonly ExecApprovalDecision[] {
  const allowedDecisions = resolvePluginApprovalRequestAllowedDecisions(params);
  return allowedDecisions.includes("deny") ? allowedDecisions : [...allowedDecisions, "deny"];
}
