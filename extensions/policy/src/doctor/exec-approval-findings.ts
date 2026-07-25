import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { PolicyEvidence, PolicyExecApprovalEvidence } from "../policy-state.js";
import { execApprovalsPolicyShapeFinding } from "./access-shapes.js";
import { CHECK_IDS, POLICY_CHECK_IDS } from "./check-ids.js";
import {
  effectiveExecApprovalAgentAutoAllowSkillsEntry,
  effectiveExecApprovalAgentSecurityEntry,
  execApprovalAllowlistMissingTarget,
  execApprovalAllowlistRequirementKey,
  formatExecApprovalAllowlistEntry,
  formatExecApprovalAllowlistRequirement,
  readExecApprovalAllowlistRequirements,
  syntheticExecApprovalAgentEntry,
} from "./exec-approval-rules.js";
import { parseExecApprovalsFile } from "./policy-runtime.js";
import { agentScopedPolicyTargets } from "./policy-scope.js";
import { hasValidScopedPolicy } from "./scoped-policy-shape.js";
import { ocPathSegment, readPolicyBoolean, readStringList } from "./utils.js";

export function execApprovalsFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
  file:
    | { readonly raw: string; readonly displayName: string; readonly ocDocName: string }
    | null
    | undefined,
  displayName: string,
): readonly HealthFinding[] {
  if (!isRecord(policy)) {
    return [];
  }
  const findings: HealthFinding[] = [];
  const entries = evidence.execApprovals ?? [];
  const defaults = entries.find((entry) => entry.kind === "defaults");
  const defaultSecurity = defaults?.security ?? "full";

  if (isRecord(policy.execApprovals)) {
    const shapeFinding = execApprovalsPolicyShapeFinding(policy.execApprovals, {
      policyDocName,
      policyPath,
    });
    if (shapeFinding !== undefined) {
      return [shapeFinding];
    }
    const fileFindings = execApprovalsFileFindings(policy.execApprovals, {
      policyDocName,
      file,
      displayName,
      requirementBase: "execApprovals",
    });
    findings.push(...fileFindings);
    if (fileFindings.length > 0) {
      return findings;
    }
    findings.push(
      ...execApprovalsRuleFindings(policy.execApprovals, {
        entries,
        defaultSecurity,
        defaults,
        displayName,
        fileDisplayName: file?.displayName,
        policyDocName,
        requirementBase: "execApprovals",
      }),
    );
  }

  if (!hasValidScopedPolicy(policy, policyPath, policyDocName)) {
    return findings;
  }
  const scopedFileFindingScopes = new Set<string>();
  for (const target of agentScopedPolicyTargets(policy)) {
    if (!isRecord(target.overlay.execApprovals)) {
      continue;
    }
    const requirementBase = `scopes/${ocPathSegment(target.scopeName)}/execApprovals`;
    const shapeFinding = execApprovalsPolicyShapeFinding(target.overlay.execApprovals, {
      policyDocName,
      policyPath,
      targetPrefix: requirementBase,
      propertyPrefix: `scopes.${target.scopeName}.execApprovals`,
      allowDefaults: false,
    });
    if (shapeFinding !== undefined) {
      findings.push(shapeFinding);
      continue;
    }
    const fileFindings = execApprovalsFileFindings(target.overlay.execApprovals, {
      policyDocName,
      file,
      displayName,
      requirementBase,
    });
    if (fileFindings.length > 0) {
      if (!scopedFileFindingScopes.has(target.scopeName)) {
        findings.push(...fileFindings);
        scopedFileFindingScopes.add(target.scopeName);
      }
      continue;
    }
    findings.push(
      ...execApprovalsRuleFindings(target.overlay.execApprovals, {
        entries,
        defaultSecurity,
        defaults,
        displayName,
        fileDisplayName: file?.displayName,
        policyDocName,
        requirementBase,
        targetAgentId: target.agentId,
      }),
    );
  }
  return findings;
}

function execApprovalsFileFindings(
  execApprovalsPolicy: Record<string, unknown>,
  params: {
    readonly policyDocName: string;
    readonly file:
      | { readonly raw: string; readonly displayName: string; readonly ocDocName: string }
      | null
      | undefined;
    readonly displayName: string;
    readonly requirementBase: string;
  },
): readonly HealthFinding[] {
  const requireFile = readPolicyBoolean(execApprovalsPolicy, ["requireFile"]) === true;
  const needsArtifactEvidence =
    requireFile || execApprovalsPolicyNeedsArtifactEvidence(execApprovalsPolicy);
  if (needsArtifactEvidence && params.file === null) {
    return [
      {
        checkId: CHECK_IDS.policyExecApprovalsMissing,
        severity: "error",
        message: "exec-approvals.json evidence is required by policy but was not found.",
        source: "policy",
        path: params.displayName,
        target: "oc://exec-approvals.json",
        requirement: `oc://${params.policyDocName}/${
          requireFile ? `${params.requirementBase}/requireFile` : params.requirementBase
        }`,
        fixHint: "Restore the approved exec approvals artifact or update policy after review.",
      },
    ];
  }
  if (params.file === null || params.file === undefined) {
    return [];
  }
  const parsed = parseExecApprovalsFile(params.file.raw);
  if (parsed.ok || !needsArtifactEvidence) {
    return [];
  }
  return [
    {
      checkId: CHECK_IDS.policyExecApprovalsInvalid,
      severity: "error",
      message: `${params.file.displayName} could not be parsed: ${parsed.message}`,
      source: "policy",
      path: params.file.displayName,
      target: `oc://${params.file.ocDocName}`,
      requirement: `oc://${params.policyDocName}/${params.requirementBase}`,
      fixHint: "Fix exec-approvals.json so it is valid JSON.",
    },
  ];
}

function execApprovalsPolicyNeedsArtifactEvidence(
  execApprovalsPolicy: Record<string, unknown>,
): boolean {
  return isRecord(execApprovalsPolicy.defaults) || isRecord(execApprovalsPolicy.agents);
}

function execApprovalsRuleFindings(
  execApprovalsPolicy: Record<string, unknown>,
  params: {
    readonly entries: readonly PolicyExecApprovalEvidence[];
    readonly defaultSecurity: string;
    readonly defaults?: PolicyExecApprovalEvidence;
    readonly displayName: string;
    readonly fileDisplayName?: string;
    readonly policyDocName: string;
    readonly requirementBase: string;
    readonly targetAgentId?: string;
  },
): readonly HealthFinding[] {
  const findings: HealthFinding[] = [];
  const allowedDefaults = new Set(
    readStringList(execApprovalsPolicy, ["defaults", "allowSecurity"]),
  );
  if (
    params.targetAgentId === undefined &&
    allowedDefaults.size > 0 &&
    !allowedDefaults.has(params.defaultSecurity.toLowerCase())
  ) {
    findings.push(
      execApprovalFinding(params.defaults, {
        checkId: CHECK_IDS.policyExecApprovalsDefaultSecurityUnapproved,
        message: `exec approvals defaults use unapproved security mode '${params.defaultSecurity}'.`,
        requirement: `oc://${params.policyDocName}/${params.requirementBase}/defaults/allowSecurity`,
        fixHint: "Set defaults.security to an approved mode or update policy after review.",
      }),
    );
  }

  const allowedAgents = new Set(readStringList(execApprovalsPolicy, ["agents", "allowSecurity"]));
  if (allowedAgents.size > 0) {
    const agentEntries =
      params.targetAgentId === undefined
        ? globalExecApprovalAgentSecurityEntries(params.entries, params.defaults)
        : [
            effectiveExecApprovalAgentSecurityEntry(params.entries, params.targetAgentId) ??
              params.defaults ??
              syntheticExecApprovalAgentEntry(params.targetAgentId),
          ];
    for (const entry of agentEntries) {
      const security = entry.security ?? params.defaultSecurity;
      if (allowedAgents.has(security.toLowerCase())) {
        continue;
      }
      findings.push(
        execApprovalFinding(entry, {
          checkId: CHECK_IDS.policyExecApprovalsAgentSecurityUnapproved,
          message: `exec approvals agent '${entry.agentId ?? params.targetAgentId ?? "inherited defaults"}' uses unapproved security mode '${security}'.`,
          requirement: `oc://${params.policyDocName}/${params.requirementBase}/agents/allowSecurity`,
          fixHint:
            "Set the agent approval security mode to an approved value or update policy after review.",
        }),
      );
    }
  }

  const allowAutoAllowSkills = readPolicyBoolean(execApprovalsPolicy, [
    "agents",
    "allowAutoAllowSkills",
  ]);
  if (allowAutoAllowSkills === false) {
    const autoAllowEntries =
      params.targetAgentId === undefined
        ? globalExecApprovalAgentAutoAllowSkillsEntries(params.entries, params.defaults)
        : [
            effectiveExecApprovalAgentAutoAllowSkillsEntry(params.entries, params.targetAgentId) ??
              params.defaults ??
              syntheticExecApprovalAgentEntry(params.targetAgentId),
          ];
    for (const entry of autoAllowEntries) {
      if (entry.autoAllowSkills !== true) {
        continue;
      }
      findings.push(
        execApprovalFinding(entry, {
          checkId: CHECK_IDS.policyExecApprovalsAutoAllowSkillsEnabled,
          message: `exec approvals agent '${entry.agentId ?? params.targetAgentId ?? "inherited defaults"}' enables autoAllowSkills outside policy.`,
          requirement: `oc://${params.policyDocName}/${params.requirementBase}/agents/allowAutoAllowSkills`,
          fixHint:
            "Set autoAllowSkills to false or update policy after reviewing implicit skill CLI trust.",
        }),
      );
    }
  }

  const expected = readExecApprovalAllowlistRequirements(execApprovalsPolicy, [
    "agents",
    "allowlist",
    "expected",
  ]);
  if (expected !== undefined) {
    const expectedSet = new Set(expected.map((entry) => entry.key));
    const actualEntries = execApprovalAllowlistEntries(params.entries, params.targetAgentId).filter(
      (entry) => entry.pattern !== undefined,
    );
    const actual = actualEntries
      .map((entry) =>
        execApprovalAllowlistRequirementKey(entry.pattern as string, entry.argPattern),
      )
      .toSorted();
    const actualSet = new Set(actual);
    for (const entry of expected.toSorted((a, b) => a.key.localeCompare(b.key))) {
      if (!actualSet.has(entry.key)) {
        const requirement = `oc://${params.policyDocName}/${params.requirementBase}/agents/allowlist/expected`;
        const target = execApprovalAllowlistMissingTarget(params.targetAgentId);
        findings.push({
          checkId: CHECK_IDS.policyExecApprovalsAllowlistMissing,
          severity: "error",
          message: `exec approvals allowlist is missing expected pattern '${formatExecApprovalAllowlistRequirement(entry)}'.`,
          source: "policy",
          path: params.fileDisplayName ?? params.displayName,
          target,
          requirement,
          fixHint: "Add the expected approval pattern or update policy after review.",
        });
      }
    }
    for (const key of actualSet) {
      if (expectedSet.has(key)) {
        continue;
      }
      const entry = actualEntries.find(
        (candidate) =>
          candidate.pattern !== undefined &&
          execApprovalAllowlistRequirementKey(candidate.pattern, candidate.argPattern) === key,
      );
      findings.push(
        execApprovalFinding(entry, {
          checkId: CHECK_IDS.policyExecApprovalsAllowlistUnexpected,
          message: `exec approvals allowlist has unexpected pattern '${formatExecApprovalAllowlistEntry(entry)}'.`,
          requirement: `oc://${params.policyDocName}/${params.requirementBase}/agents/allowlist/expected`,
          fixHint: "Remove the unexpected approval pattern or update policy after review.",
        }),
      );
    }
  }
  return findings;
}

function globalExecApprovalAgentSecurityEntries(
  entries: readonly PolicyExecApprovalEvidence[],
  defaults: PolicyExecApprovalEvidence | undefined,
): readonly PolicyExecApprovalEvidence[] {
  const agentEntries = entries.filter((candidate) => candidate.kind === "agent");
  const wildcard = agentEntries.find((entry) => entry.agentId === "*");
  const securityEntries = agentEntries.filter(
    (entry) =>
      entry.agentId === "*" || entry.security !== undefined || entry.securityConfigured === true,
  );
  return wildcard === undefined
    ? [...securityEntries, defaults ?? syntheticExecApprovalAgentEntry("*")]
    : securityEntries;
}

function globalExecApprovalAgentAutoAllowSkillsEntries(
  entries: readonly PolicyExecApprovalEvidence[],
  defaults: PolicyExecApprovalEvidence | undefined,
): readonly PolicyExecApprovalEvidence[] {
  const agentEntries = entries.filter((candidate) => candidate.kind === "agent");
  const wildcard = agentEntries.find((entry) => entry.agentId === "*");
  const explicitEntries = agentEntries.filter((entry) => entry.autoAllowSkills !== undefined);
  return wildcard?.autoAllowSkills === undefined
    ? [...explicitEntries, defaults ?? syntheticExecApprovalAgentEntry("*")]
    : explicitEntries;
}

function execApprovalAllowlistEntries(
  entries: readonly PolicyExecApprovalEvidence[],
  agentId: string | undefined,
): readonly PolicyExecApprovalEvidence[] {
  if (agentId === undefined) {
    return entries.filter((entry) => entry.kind === "allowlist");
  }
  return entries.filter(
    (entry) =>
      entry.kind === "allowlist" &&
      entry.agentId !== undefined &&
      (normalizeAgentId(entry.agentId) === normalizeAgentId(agentId) || entry.agentId === "*"),
  );
}

function execApprovalFinding(
  entry: PolicyExecApprovalEvidence | undefined,
  params: {
    readonly checkId: (typeof POLICY_CHECK_IDS)[number];
    readonly message: string;
    readonly requirement: string;
    readonly fixHint: string;
  },
): HealthFinding {
  const target = entry?.source ?? "oc://exec-approvals.json";
  return {
    checkId: params.checkId,
    severity: "error",
    message: params.message,
    source: "policy",
    path: "exec-approvals.json",
    ocPath: target,
    target,
    requirement: params.requirement,
    fixHint: params.fixHint,
  };
}
