// Policy doctor health-check factories for one policy scope.
import type { HealthCheck } from "openclaw/plugin-sdk/health";
import { repairPolicyAutomaticNarrower } from "../automatic-repairs.js";
import { createPolicyScopedChecks } from "../check-factory.js";
import { CHECK_IDS } from "../check-ids.js";
import type { PolicyDoctorCheckDeps } from "../types.js";

export function createPolicyChannelProviderChecks(
  deps: PolicyDoctorCheckDeps,
): readonly HealthCheck[] {
  const {
    channelIdsFromFindings,
    disableChannels,
    workspaceRepairsDisabledResult,
    workspaceRepairsEnabled,
  } = deps;

  return createPolicyScopedChecks(deps, [
    [
      CHECK_IDS.policyDeniedChannelProvider,
      "Configured channels satisfy policy deny rules.",
      async (ctx, findings) => {
        if (!workspaceRepairsEnabled(ctx)) {
          return workspaceRepairsDisabledResult("channel config");
        }
        const channelIds = channelIdsFromFindings(findings);
        if (channelIds.length === 0) {
          return {
            status: "skipped",
            reason: "no channel findings matched a configurable channel",
            changes: [],
          };
        }
        const next = disableChannels(ctx.cfg, channelIds);
        if (next.changed.length === 0) {
          return {
            status: "skipped",
            reason: "matching channels were already disabled or missing",
            changes: [],
          };
        }
        return {
          config: next.config,
          changes: next.changed.map(
            (id) => `Disabled channels.${id}.enabled for policy conformance.`,
          ),
        };
      },
    ],
  ]);
}

export function createPolicyIngressChecks(deps: PolicyDoctorCheckDeps): readonly HealthCheck[] {
  return createPolicyScopedChecks(deps, [
    [
      CHECK_IDS.policyIngressDmPolicyUnapproved,
      "Channel direct-message access policy matches ingress requirements.",
    ],
    [
      CHECK_IDS.policyIngressDmScopeUnapproved,
      "Direct-message sessions use the policy-required isolation scope.",
    ],
    [
      CHECK_IDS.policyIngressOpenGroupsDenied,
      "Channel group access does not use open group policy when denied.",
      async (ctx, findings) =>
        repairPolicyAutomaticNarrower(ctx, findings, CHECK_IDS.policyIngressOpenGroupsDenied),
    ],
    [
      CHECK_IDS.policyIngressGroupMentionRequired,
      "Channel group access keeps mention gates enabled when required.",
      async (ctx, findings) =>
        repairPolicyAutomaticNarrower(ctx, findings, CHECK_IDS.policyIngressGroupMentionRequired),
    ],
  ]);
}
