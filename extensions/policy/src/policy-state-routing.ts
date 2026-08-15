import {
  listPolicyRouteBindings,
  resolvePolicyRoutingProbe,
  type PolicyRoutingRules,
} from "./policy-routing.js";
import type { PolicyRoutingEvidence } from "./policy-state-types.js";

export function scanPolicyRouting(
  cfg: Record<string, unknown>,
  rules: PolicyRoutingRules,
): PolicyRoutingEvidence {
  return {
    bindings: listPolicyRouteBindings(cfg).map((binding) => ({
      index: binding.index,
      source: `oc://openclaw.config/bindings/#${binding.index}`,
      channel: binding.channel,
    })),
    probes: (rules.probes ?? []).map((probe, index) => {
      const result = resolvePolicyRoutingProbe(cfg, probe);
      return {
        id: probe.id,
        source: `oc://policy/routing/probes/#${index}`,
        agentId: result.agentId,
        matchedBy: result.matchedBy,
      };
    }),
  };
}
