import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { PolicyEvidence, PolicyIngressEvidence } from "../policy-state.js";
import { ingressPolicyShapeFinding } from "./access-shapes.js";
import { CHECK_IDS, POLICY_CHECK_IDS } from "./check-ids.js";
import { normalizePolicyChannelId } from "./policy-runtime.js";
import { channelScopedPolicyTargets } from "./policy-scope.js";
import { hasValidScopedPolicy } from "./scoped-policy-shape.js";
import { ocPathSegment, readPolicyBoolean, readString, readStringList } from "./utils.js";

export function ingressFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (!isRecord(policy)) {
    return [];
  }
  const findings: HealthFinding[] = [];
  const ingressPolicy = policy.ingress;
  if (
    ingressPolicyShapeFinding(ingressPolicy, { policyDocName, policyPath }) === undefined &&
    isRecord(ingressPolicy)
  ) {
    findings.push(
      ...ingressFindingsForRule(ingressPolicy, policyDocName, "ingress", evidence, () => true),
    );
  }
  if (hasValidScopedPolicy(policy, policyPath, policyDocName)) {
    for (const target of channelScopedPolicyTargets(policy)) {
      if (
        ingressPolicyShapeFinding(target.overlay.ingress, {
          policyDocName,
          policyPath,
          targetPrefix: `scopes/${ocPathSegment(target.scopeName)}/ingress`,
          propertyPrefix: `scopes.${target.scopeName}.ingress`,
          allowSession: false,
        }) !== undefined ||
        !isRecord(target.overlay.ingress)
      ) {
        continue;
      }
      findings.push(
        ...ingressFindingsForRule(
          target.overlay.ingress,
          policyDocName,
          `scopes/${ocPathSegment(target.scopeName)}/ingress`,
          evidence,
          (entry) => scopedIngressChannelMatches(entry, target.channelId),
        ),
      );
    }
  }
  return findings;
}

function ingressFindingsForRule(
  ingressPolicy: Record<string, unknown> | undefined,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyIngressEvidence) => boolean,
): readonly HealthFinding[] {
  if (!isRecord(ingressPolicy)) {
    return [];
  }
  return [
    ...ingressDmScopeFindings(
      ingressPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...ingressDmPolicyFindings(
      ingressPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...ingressOpenGroupFindings(
      ingressPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...ingressRequireMentionFindings(
      ingressPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
  ];
}

function ingressDmScopeFindings(
  ingressPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyIngressEvidence) => boolean,
): readonly HealthFinding[] {
  const required = readString(ingressPolicy, ["session", "requireDmScope"]);
  if (required === undefined) {
    return [];
  }
  return ingressEntries(evidence, "sessionDmScope")
    .filter(evidenceFilter)
    .filter((entry) => entry.value !== required)
    .map((entry) =>
      ingressFinding(entry, {
        checkId: CHECK_IDS.policyIngressDmScopeUnapproved,
        message: `session.dmScope '${entry.value ?? ""}' does not match policy.`,
        requirement: `oc://${policyDocName}/${requirementBase}/session/requireDmScope`,
        fixHint:
          "Set session.dmScope to the required isolation scope or update policy after review.",
      }),
    );
}

function ingressDmPolicyFindings(
  ingressPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyIngressEvidence) => boolean,
): readonly HealthFinding[] {
  const allowed = new Set(readStringList(ingressPolicy, ["channels", "allowDmPolicies"]));
  if (allowed.size === 0) {
    return [];
  }
  return ingressEntries(evidence, "channelDmPolicy")
    .filter(evidenceFilter)
    .filter((entry) => typeof entry.value === "string" && !allowed.has(entry.value.toLowerCase()))
    .map((entry) =>
      ingressFinding(entry, {
        checkId: CHECK_IDS.policyIngressDmPolicyUnapproved,
        message: `${ingressLabel(entry)} uses unapproved DM policy '${entry.value ?? ""}'.`,
        requirement: `oc://${policyDocName}/${requirementBase}/channels/allowDmPolicies`,
        fixHint: "Set the channel DM policy to an allowed value or update policy after review.",
      }),
    );
}

function ingressOpenGroupFindings(
  ingressPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyIngressEvidence) => boolean,
): readonly HealthFinding[] {
  if (readPolicyBoolean(ingressPolicy, ["channels", "denyOpenGroups"]) !== true) {
    return [];
  }
  return ingressEntries(evidence, "channelGroupPolicy")
    .filter(evidenceFilter)
    .filter((entry) => entry.value !== "allowlist" && entry.value !== "disabled")
    .map((entry) =>
      ingressFinding(entry, {
        checkId: CHECK_IDS.policyIngressOpenGroupsDenied,
        message: `${ingressLabel(entry)} allows open group ingress.`,
        requirement: `oc://${policyDocName}/${requirementBase}/channels/denyOpenGroups`,
        fixHint: "Set groupPolicy to allowlist or disabled, or update policy after review.",
      }),
    );
}

function ingressRequireMentionFindings(
  ingressPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyIngressEvidence) => boolean,
): readonly HealthFinding[] {
  if (readPolicyBoolean(ingressPolicy, ["channels", "requireMentionInGroups"]) !== true) {
    return [];
  }
  const groupPolicies = ingressEntries(evidence, "channelGroupPolicy").filter(evidenceFilter);
  return ingressEntries(evidence, "channelRequireMention")
    .filter(evidenceFilter)
    .filter((entry) => !isGroupIngressDisabled(entry, groupPolicies))
    .filter((entry) => entry.value !== true)
    .map((entry) =>
      ingressFinding(entry, {
        checkId: CHECK_IDS.policyIngressGroupMentionRequired,
        message: `${ingressLabel(entry)} does not require group mentions.`,
        requirement: `oc://${policyDocName}/${requirementBase}/channels/requireMentionInGroups`,
        fixHint:
          "Set requireMention=true for the channel/group entry or update policy after review.",
      }),
    );
}

function isGroupIngressDisabled(
  entry: PolicyIngressEvidence,
  groupPolicies: readonly PolicyIngressEvidence[],
): boolean {
  const entryParent = ocPathParent(entry.source);
  const channelDefaultsParent = "oc://openclaw.config/channels/defaults";
  const matches = groupPolicies
    .filter((candidate) => {
      const candidateParent = ocPathParent(candidate.source);
      return (
        candidate.channel === entry.channel &&
        (candidate.accountId ?? "") === (entry.accountId ?? "") &&
        (candidateParent === channelDefaultsParent ||
          entryParent === candidateParent ||
          entryParent.startsWith(`${candidateParent}/`))
      );
    })
    .toSorted(
      (left, right) => ocPathParent(right.source).length - ocPathParent(left.source).length,
    );
  return matches[0]?.value === "disabled";
}

function ocPathParent(source: string): string {
  return source.slice(0, Math.max(0, source.lastIndexOf("/")));
}

function ingressEntries(
  evidence: PolicyEvidence,
  kind: PolicyIngressEvidence["kind"],
): readonly PolicyIngressEvidence[] {
  return (evidence.ingress ?? []).filter((entry) => entry.kind === kind);
}

function scopedIngressChannelMatches(
  entry: PolicyIngressEvidence,
  policyChannelId: string,
): boolean {
  return normalizePolicyChannelId(entry.channel ?? "") === policyChannelId;
}

function ingressFinding(
  entry: PolicyIngressEvidence,
  params: {
    readonly checkId: (typeof POLICY_CHECK_IDS)[number];
    readonly message: string;
    readonly requirement: string;
    readonly fixHint: string;
  },
): HealthFinding {
  return {
    checkId: params.checkId,
    severity: "error",
    message: params.message,
    source: "policy",
    path: "openclaw config",
    ocPath: entry.source,
    target: entry.source,
    requirement: params.requirement,
    fixHint: params.fixHint,
  };
}

function ingressLabel(entry: PolicyIngressEvidence): string {
  const account = entry.accountId === undefined ? "" : ` account '${entry.accountId}'`;
  const group = entry.groupId === undefined ? "" : ` group '${entry.groupId}'`;
  return `channel '${entry.channel ?? "unknown"}'${account}${group}`;
}
