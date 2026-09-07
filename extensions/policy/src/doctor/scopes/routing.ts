import type { HealthCheck } from "openclaw/plugin-sdk/health";
import { createPolicyScopedChecks } from "../check-factory.js";
import { CHECK_IDS } from "../check-ids.js";
import type { PolicyDoctorCheckDeps } from "../types.js";

export function createPolicyRoutingChecks(deps: PolicyDoctorCheckDeps): readonly HealthCheck[] {
  return createPolicyScopedChecks(deps, [
    [
      CHECK_IDS.policyRoutingBindingsRequired,
      "Routing policy has at least one channel route binding when required.",
    ],
    [
      CHECK_IDS.policyRoutingBindingChannelUnconfigured,
      "Route bindings name channels present in configuration.",
    ],
    [
      CHECK_IDS.policyRoutingAgentMismatch,
      "Authored routing probes resolve to their expected agents.",
    ],
    [
      CHECK_IDS.policyRoutingMatchKindMismatch,
      "Authored routing probes match at their expected specificity.",
    ],
  ]);
}
