// Policy doctor health-check factories for one policy scope.
import type { HealthCheck } from "openclaw/plugin-sdk/health";
import { repairPolicyAutomaticNarrower } from "../automatic-repairs.js";
import { CHECK_IDS } from "../check-ids.js";
import type { PolicyDoctorCheckDeps } from "../types.js";

export function createPolicyChannelProviderChecks(
  deps: PolicyDoctorCheckDeps,
): readonly HealthCheck[] {
  const {
    channelIdsFromFindings,
    disableChannels,
    evaluatePolicy,
    findingsForCheck,
    workspaceRepairsDisabledResult,
    workspaceRepairsEnabled,
  } = deps;

  const policyChannelsDeniedProviderCheck: HealthCheck = {
    id: CHECK_IDS.policyDeniedChannelProvider,
    kind: "plugin",
    description: "Configured channels satisfy policy deny rules.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyDeniedChannelProvider);
    },
    async repair(ctx, findings) {
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
  };

  return [policyChannelsDeniedProviderCheck];
}

export function createPolicyIngressChecks(deps: PolicyDoctorCheckDeps): readonly HealthCheck[] {
  const { evaluatePolicy, findingsForCheck } = deps;

  const policyIngressDmPolicyUnapprovedCheck: HealthCheck = {
    id: CHECK_IDS.policyIngressDmPolicyUnapproved,
    kind: "plugin",
    description: "Channel direct-message access policy matches ingress requirements.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyIngressDmPolicyUnapproved);
    },
  };
  const policyIngressDmScopeUnapprovedCheck: HealthCheck = {
    id: CHECK_IDS.policyIngressDmScopeUnapproved,
    kind: "plugin",
    description: "Direct-message sessions use the policy-required isolation scope.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyIngressDmScopeUnapproved);
    },
  };
  const policyIngressOpenGroupsDeniedCheck: HealthCheck = {
    id: CHECK_IDS.policyIngressOpenGroupsDenied,
    kind: "plugin",
    description: "Channel group access does not use open group policy when denied.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyIngressOpenGroupsDenied);
    },
    async repair(ctx, findings) {
      return repairPolicyAutomaticNarrower(ctx, findings, CHECK_IDS.policyIngressOpenGroupsDenied);
    },
  };
  const policyIngressGroupMentionRequiredCheck: HealthCheck = {
    id: CHECK_IDS.policyIngressGroupMentionRequired,
    kind: "plugin",
    description: "Channel group access keeps mention gates enabled when required.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(
        await evaluatePolicy(ctx),
        CHECK_IDS.policyIngressGroupMentionRequired,
      );
    },
    async repair(ctx, findings) {
      return repairPolicyAutomaticNarrower(
        ctx,
        findings,
        CHECK_IDS.policyIngressGroupMentionRequired,
      );
    },
  };

  return [
    policyIngressDmPolicyUnapprovedCheck,
    policyIngressDmScopeUnapprovedCheck,
    policyIngressOpenGroupsDeniedCheck,
    policyIngressGroupMentionRequiredCheck,
  ];
}
