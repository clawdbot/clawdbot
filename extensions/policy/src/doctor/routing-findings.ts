import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { policyRoutingRules } from "../policy-routing.js";
import type { PolicyEvidence } from "../policy-state.js";
import { CHECK_IDS } from "./check-ids.js";
import { routingPolicyShapeFinding } from "./routing-shapes.js";
import { ocPathSegment } from "./utils.js";

export function routingFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const rules = policyRoutingRules(policy);
  if (
    rules === undefined ||
    evidence.routing === undefined ||
    routingPolicyShapeFinding(rules, { policyPath, policyDocName }) !== undefined
  ) {
    return [];
  }
  const findings: HealthFinding[] = [];
  if (rules.requireBindings === true && evidence.routing.bindings.length === 0) {
    findings.push({
      checkId: CHECK_IDS.policyRoutingBindingsRequired,
      severity: "error",
      message:
        "Routing policy requires at least one channel route binding, but none are configured.",
      source: "policy",
      path: policyPath,
      target: "oc://openclaw.config/bindings",
      requirement: `oc://${policyDocName}/routing/requireBindings`,
      fixHint: "Add an intentional route binding or update the policy after review.",
    });
  }
  if (rules.requireConfiguredChannels === true) {
    const configured = new Set(evidence.channels.map((channel) => channel.id.toLowerCase()));
    for (const binding of evidence.routing.bindings) {
      if (configured.has(binding.channel.toLowerCase())) {
        continue;
      }
      findings.push({
        checkId: CHECK_IDS.policyRoutingBindingChannelUnconfigured,
        severity: "error",
        message: `Route binding ${binding.index} names unconfigured channel ${binding.channel}.`,
        source: "policy",
        path: policyPath,
        target: `oc://openclaw.config/bindings/#${binding.index}`,
        requirement: `oc://${policyDocName}/routing/requireConfiguredChannels`,
        fixHint: `Configure channels.${binding.channel}, correct the binding channel, or update the policy after review.`,
      });
    }
  }
  for (const probe of rules.probes ?? []) {
    const result = evidence.routing.probes.find((entry) => entry.id === probe.id);
    if (result === undefined) {
      continue;
    }
    const resultTarget = `oc://policy/routing/probes/${ocPathSegment(probe.id)}/result`;
    const requirement = `oc://${policyDocName}/routing/probes/${ocPathSegment(probe.id)}/expect`;
    if (normalizeAgentId(result.agentId) !== normalizeAgentId(probe.expect.agentId)) {
      findings.push({
        checkId: CHECK_IDS.policyRoutingAgentMismatch,
        severity: "error",
        message: `Routing probe ${probe.id} resolved to agent ${result.agentId}, not ${probe.expect.agentId}.`,
        source: "policy",
        path: policyPath,
        target: resultTarget,
        requirement,
        fixHint: "Review the route bindings and expected destination before changing either one.",
      });
    }
    if (
      probe.expect.matchedBy !== undefined &&
      !probe.expect.matchedBy.includes(result.matchedBy)
    ) {
      findings.push({
        checkId: CHECK_IDS.policyRoutingMatchKindMismatch,
        severity: "error",
        message: `Routing probe ${probe.id} matched by ${result.matchedBy}, which is not an expected match kind.`,
        source: "policy",
        path: policyPath,
        target: resultTarget,
        requirement,
        fixHint:
          "Restore the intended binding specificity or update the accepted match kinds after review.",
      });
    }
  }
  return findings;
}
