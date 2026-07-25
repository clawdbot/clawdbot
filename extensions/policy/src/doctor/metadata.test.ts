// Policy doctor metadata tests cover rule metadata.
import { describe, expect, it } from "vitest";
import { CHECK_IDS, POLICY_CHECK_IDS } from "./check-ids.js";
import { POLICY_FIX_METADATA_BY_CHECK_ID } from "./fix-metadata.js";
import { POLICY_RULE_METADATA, type PolicyRuleMetadata } from "./metadata.js";

const POLICY_FIX_METADATA = [...POLICY_FIX_METADATA_BY_CHECK_ID.values()];
type PolicyFixMetadata = (typeof POLICY_FIX_METADATA)[number];

describe("policy doctor metadata", () => {
  it("describes strictness for agent-scoped policy fields", () => {
    expect(
      (POLICY_RULE_METADATA as readonly PolicyRuleMetadata[])
        .filter(
          (rule) =>
            rule.scopeSelectors?.includes("agentIds") ||
            rule.scopeSelectors?.includes("channelIds"),
        )
        .map((rule) => {
          const description: {
            path: string;
            strictness: PolicyRuleMetadata["strictness"];
            selectors: PolicyRuleMetadata["scopeSelectors"];
            emptyList?: PolicyRuleMetadata["emptyList"];
          } = {
            path: rule.policyPath.join("."),
            strictness: rule.strictness,
            selectors: rule.scopeSelectors,
          };
          if (rule.emptyList !== undefined) {
            description.emptyList = rule.emptyList;
          }
          return description;
        }),
    ).toEqual([
      {
        path: "agents.workspace.allowedAccess",
        strictness: "allowlist-subset",
        emptyList: "disabled",
        selectors: ["agentIds"],
      },
      {
        path: "agents.workspace.denyTools",
        strictness: "denylist-superset",
        selectors: ["agentIds"],
      },
      {
        path: "tools.profiles.allow",
        strictness: "allowlist-subset",
        emptyList: "disabled",
        selectors: ["agentIds"],
      },
      {
        path: "tools.fs.requireWorkspaceOnly",
        strictness: "requires-true",
        selectors: ["agentIds"],
      },
      {
        path: "tools.exec.allowSecurity",
        strictness: "allowlist-subset",
        emptyList: "disabled",
        selectors: ["agentIds"],
      },
      {
        path: "tools.exec.requireAsk",
        strictness: "allowlist-subset",
        emptyList: "disabled",
        selectors: ["agentIds"],
      },
      {
        path: "tools.exec.allowHosts",
        strictness: "allowlist-subset",
        emptyList: "disabled",
        selectors: ["agentIds"],
      },
      { path: "tools.elevated.allow", strictness: "requires-false", selectors: ["agentIds"] },
      {
        path: "tools.alsoAllow.expected",
        strictness: "exact-list",
        emptyList: "meaningful",
        selectors: ["agentIds"],
      },
      { path: "tools.denyTools", strictness: "denylist-superset", selectors: ["agentIds"] },
      {
        path: "sandbox.requireMode",
        strictness: "allowlist-subset",
        emptyList: "disabled",
        selectors: ["agentIds"],
      },
      {
        path: "sandbox.allowBackends",
        strictness: "allowlist-subset",
        emptyList: "disabled",
        selectors: ["agentIds"],
      },
      {
        path: "sandbox.containers.denyHostNetwork",
        strictness: "requires-true",
        selectors: ["agentIds"],
      },
      {
        path: "sandbox.containers.denyContainerNamespaceJoin",
        strictness: "requires-true",
        selectors: ["agentIds"],
      },
      {
        path: "sandbox.containers.requireReadOnlyMounts",
        strictness: "requires-true",
        selectors: ["agentIds"],
      },
      {
        path: "sandbox.containers.denyContainerRuntimeSocketMounts",
        strictness: "requires-true",
        selectors: ["agentIds"],
      },
      {
        path: "sandbox.containers.denyUnconfinedProfiles",
        strictness: "requires-true",
        selectors: ["agentIds"],
      },
      {
        path: "sandbox.browser.requireCdpSourceRange",
        strictness: "requires-true",
        selectors: ["agentIds"],
      },
      {
        path: "ingress.channels.allowDmPolicies",
        strictness: "allowlist-subset",
        emptyList: "disabled",
        selectors: ["channelIds"],
      },
      {
        path: "ingress.channels.denyOpenGroups",
        strictness: "requires-true",
        selectors: ["channelIds"],
      },
      {
        path: "ingress.channels.requireMentionInGroups",
        strictness: "requires-true",
        selectors: ["channelIds"],
      },
      {
        path: "dataHandling.memory.denySessionTranscriptIndexing",
        strictness: "requires-true",
        selectors: ["agentIds"],
      },
      {
        path: "execApprovals.agents.allowSecurity",
        strictness: "allowlist-subset",
        emptyList: "disabled",
        selectors: ["agentIds"],
      },
      {
        path: "execApprovals.agents.allowAutoAllowSkills",
        strictness: "requires-false",
        selectors: ["agentIds"],
      },
      {
        path: "execApprovals.agents.allowlist.expected",
        strictness: "exact-list",
        emptyList: "meaningful",
        selectors: ["agentIds"],
      },
    ]);
  });

  it("classifies every policy finding for fix recommendation coverage", () => {
    expect(POLICY_FIX_METADATA.map((rule) => rule.checkId)).toHaveLength(
      new Set(POLICY_FIX_METADATA.map((rule) => rule.checkId)).size,
    );
    expect([...POLICY_FIX_METADATA_BY_CHECK_ID.keys()].toSorted()).toEqual(
      [...POLICY_CHECK_IDS].toSorted(),
    );
  });

  it("points required-deny repair metadata at OpenClaw deny config paths", () => {
    expect(
      POLICY_FIX_METADATA_BY_CHECK_ID.get(CHECK_IDS.policyToolsRequiredDenyMissing)?.configTargets,
    ).toEqual(["tools.deny", "agents.list[].tools.deny"]);
  });

  it("keeps policy fix class assignments explicit", () => {
    const grouped = new Map<PolicyFixMetadata["fixClass"], PolicyFixMetadata[]>();
    for (const rule of POLICY_FIX_METADATA) {
      const rules = grouped.get(rule.fixClass);
      if (rules) {
        rules.push(rule);
      } else {
        grouped.set(rule.fixClass, [rule]);
      }
    }

    expect({
      automatic: grouped
        .get("automatic")
        ?.map((rule) => rule.checkId)
        .toSorted(),
      manual: grouped
        .get("manual")
        ?.map((rule) => rule.checkId)
        .toSorted(),
      reviewRequired: grouped
        .get("reviewRequired")
        ?.map((rule) => rule.checkId)
        .toSorted(),
      unsupported: grouped
        .get("unsupported")
        ?.map((rule) => rule.checkId)
        .toSorted(),
      validateOnly:
        grouped
          .get("validateOnly")
          ?.map((rule) => rule.checkId)
          .toSorted() ?? [],
    }).toEqual({
      automatic: [
        "policy/agents-tool-not-denied",
        "policy/channels-denied-provider",
        "policy/data-handling-redaction-disabled",
        "policy/data-handling-telemetry-content-capture",
        "policy/gateway-control-ui-insecure",
        "policy/gateway-http-endpoint-enabled",
        "policy/gateway-remote-enabled",
        "policy/ingress-group-mention-required",
        "policy/ingress-open-groups-denied",
        "policy/tools-elevated-enabled",
        "policy/tools-required-deny-missing",
      ],
      manual: [
        "policy/attestation-hash-mismatch",
        "policy/auth-profile-invalid-metadata",
        "policy/auth-profile-unapproved-mode",
        "policy/exec-approvals-agent-security-unapproved",
        "policy/exec-approvals-allowlist-missing",
        "policy/exec-approvals-allowlist-unexpected",
        "policy/exec-approvals-default-security-unapproved",
        "policy/exec-approvals-invalid",
        "policy/exec-approvals-missing",
        "policy/gateway-auth-disabled",
        "policy/gateway-http-url-fetch-unrestricted",
        "policy/policy-hash-mismatch",
        "policy/policy-jsonc-invalid",
        "policy/policy-jsonc-missing",
        "policy/sandbox-browser-cdp-source-range-missing",
        "policy/secrets-unmanaged-provider",
        "policy/tools-missing-owner",
        "policy/tools-missing-risk-level",
        "policy/tools-missing-sensitivity-token",
        "policy/tools-unknown-risk-level",
        "policy/tools-unknown-sensitivity-token",
      ],
      reviewRequired: [
        "policy/agents-workspace-access-denied",
        "policy/data-handling-session-retention-not-enforced",
        "policy/data-handling-session-transcript-memory-enabled",
        "policy/exec-approvals-auto-allow-skills-enabled",
        "policy/gateway-node-command-denied",
        "policy/gateway-non-loopback-bind",
        "policy/gateway-rate-limit-missing",
        "policy/gateway-tailscale-funnel",
        "policy/ingress-dm-policy-unapproved",
        "policy/ingress-dm-scope-unapproved",
        "policy/mcp-denied-server",
        "policy/mcp-unapproved-server",
        "policy/models-denied-provider",
        "policy/models-unapproved-provider",
        "policy/network-private-access-enabled",
        "policy/routing-agent-mismatch",
        "policy/routing-binding-channel-unconfigured",
        "policy/routing-bindings-required",
        "policy/routing-match-kind-mismatch",
        "policy/sandbox-backend-unapproved",
        "policy/sandbox-container-host-network-denied",
        "policy/sandbox-container-mount-mode-required",
        "policy/sandbox-container-namespace-join-denied",
        "policy/sandbox-container-runtime-socket-mount",
        "policy/sandbox-container-unconfined-profile",
        "policy/sandbox-mode-unapproved",
        "policy/secrets-denied-provider-source",
        "policy/secrets-insecure-provider",
        "policy/tools-also-allow-missing",
        "policy/tools-also-allow-unexpected",
        "policy/tools-exec-ask-unapproved",
        "policy/tools-exec-host-unapproved",
        "policy/tools-exec-security-unapproved",
        "policy/tools-fs-workspace-only-required",
        "policy/tools-profile-unapproved",
      ],
      unsupported: ["policy/sandbox-container-posture-unobservable"],
      validateOnly: [],
    });
  });
});
