import type { HealthCheck } from "openclaw/plugin-sdk/health";
import { CHECK_IDS } from "../check-ids.js";
import type { PolicyDoctorCheckDeps } from "../types.js";

export function createPolicyRoutingChecks(deps: PolicyDoctorCheckDeps): readonly HealthCheck[] {
  const { evaluatePolicy, findingsForCheck } = deps;
  return [
    {
      id: CHECK_IDS.policyRoutingBindingsRequired,
      kind: "plugin",
      description: "Routing policy has at least one channel route binding when required.",
      source: "policy",
      async detect(ctx) {
        return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyRoutingBindingsRequired);
      },
    },
    {
      id: CHECK_IDS.policyRoutingBindingChannelUnconfigured,
      kind: "plugin",
      description: "Route bindings name channels present in configuration.",
      source: "policy",
      async detect(ctx) {
        return findingsForCheck(
          await evaluatePolicy(ctx),
          CHECK_IDS.policyRoutingBindingChannelUnconfigured,
        );
      },
    },
    {
      id: CHECK_IDS.policyRoutingAgentMismatch,
      kind: "plugin",
      description: "Authored routing probes resolve to their expected agents.",
      source: "policy",
      async detect(ctx) {
        return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyRoutingAgentMismatch);
      },
    },
    {
      id: CHECK_IDS.policyRoutingMatchKindMismatch,
      kind: "plugin",
      description: "Authored routing probes match at their expected specificity.",
      source: "policy",
      async detect(ctx) {
        return findingsForCheck(
          await evaluatePolicy(ctx),
          CHECK_IDS.policyRoutingMatchKindMismatch,
        );
      },
    },
  ];
}
