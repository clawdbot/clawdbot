import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { isRecord, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { PolicyEvidence, PolicyToolPostureEvidence } from "../policy-state.js";
import { toolPosturePolicyShapeFinding } from "./agent-tool-shapes.js";
import { CHECK_IDS, POLICY_CHECK_IDS } from "./check-ids.js";
import { KNOWN_RISK_LEVELS, KNOWN_SENSITIVITY_LEVELS } from "./policy-constants.js";
import { expandPolicyToolRequirement, toolListCoversTool } from "./policy-runtime.js";
import { agentScopedPolicyTargets, scopedToolAgentMatches } from "./policy-scope.js";
import { hasValidScopedPolicy } from "./scoped-policy-shape.js";
import { ocPathSegment, readPolicyBoolean, readStringList } from "./utils.js";

export function toolPostureFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const findings: HealthFinding[] = [];
  if (
    isRecord(policy) &&
    isRecord(policy.tools) &&
    toolPosturePolicyShapeFinding(policy.tools, { policyDocName, policyPath }) === undefined
  ) {
    findings.push(
      ...toolPostureFindingsForRule(policy.tools, policyDocName, "tools", evidence, () => true),
    );
  }
  if (!hasValidScopedPolicy(policy, policyPath, policyDocName)) {
    return findings;
  }
  for (const target of agentScopedPolicyTargets(policy)) {
    if (!isRecord(target.overlay.tools)) {
      continue;
    }
    const requirementBase = `scopes/${ocPathSegment(target.scopeName)}/tools`;
    if (
      toolPosturePolicyShapeFinding(target.overlay.tools, {
        policyDocName,
        policyPath,
        targetPrefix: requirementBase,
        propertyPrefix: `scopes.${target.scopeName}.tools`,
      }) !== undefined
    ) {
      continue;
    }
    findings.push(
      ...toolPostureFindingsForRule(
        target.overlay.tools,
        policyDocName,
        requirementBase,
        evidence,
        (entry) => scopedToolAgentMatches(entry, target.agentId, evidence.toolPosture ?? []),
      ),
    );
  }
  return findings;
}

function toolPostureFindingsForRule(
  toolsPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyToolPostureEvidence) => boolean,
): readonly HealthFinding[] {
  return [
    ...toolProfileFindings(toolsPolicy, policyDocName, requirementBase, evidence, evidenceFilter),
    ...toolFsWorkspaceOnlyFindings(
      toolsPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...toolExecPostureFindings(
      toolsPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...toolElevatedFindings(toolsPolicy, policyDocName, requirementBase, evidence, evidenceFilter),
    ...toolAlsoAllowExpectedFindings(
      toolsPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...toolRequiredDenyFindings(
      toolsPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
  ];
}

function toolProfileFindings(
  toolsPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyToolPostureEvidence) => boolean,
): readonly HealthFinding[] {
  const allowed = new Set(readStringList(toolsPolicy, ["profiles", "allow"]));
  if (allowed.size === 0) {
    return [];
  }
  return toolPostureEntries(evidence, "profile")
    .filter(evidenceFilter)
    .filter((entry) => typeof entry.value === "string" && !allowed.has(entry.value.toLowerCase()))
    .map((entry): HealthFinding => {
      return toolPostureFinding(entry, {
        checkId: CHECK_IDS.policyToolsProfileUnapproved,
        message: `${toolPostureLabel(entry)} uses unapproved tool profile '${entry.value ?? ""}'.`,
        requirement: `oc://${policyDocName}/${requirementBase}/profiles/allow`,
        fixHint: "Use an approved tools.profile value or update policy after review.",
      });
    });
}

function toolFsWorkspaceOnlyFindings(
  toolsPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyToolPostureEvidence) => boolean,
): readonly HealthFinding[] {
  if (readPolicyBoolean(toolsPolicy, ["fs", "requireWorkspaceOnly"]) !== true) {
    return [];
  }
  return toolPostureEntries(evidence, "fsWorkspaceOnly")
    .filter(evidenceFilter)
    .filter((entry) => entry.value !== true)
    .map((entry): HealthFinding => {
      return toolPostureFinding(entry, {
        checkId: CHECK_IDS.policyToolsFsWorkspaceOnlyRequired,
        message: `${toolPostureLabel(entry)} does not require workspace-only filesystem tools.`,
        requirement: `oc://${policyDocName}/${requirementBase}/fs/requireWorkspaceOnly`,
        fixHint: "Set tools.fs.workspaceOnly=true or update policy after review.",
      });
    });
}

function toolExecPostureFindings(
  toolsPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyToolPostureEvidence) => boolean,
): readonly HealthFinding[] {
  return [
    ...toolStringPostureAllowFindings(toolsPolicy, policyDocName, requirementBase, evidence, {
      checkId: CHECK_IDS.policyToolsExecSecurityUnapproved,
      kind: "execSecurity",
      policyPath: ["exec", "allowSecurity"],
      requirementPath: "exec/allowSecurity",
      settingLabel: "exec security",
      evidenceFilter,
    }),
    ...toolStringPostureAllowFindings(toolsPolicy, policyDocName, requirementBase, evidence, {
      checkId: CHECK_IDS.policyToolsExecAskUnapproved,
      kind: "execAsk",
      policyPath: ["exec", "requireAsk"],
      requirementPath: "exec/requireAsk",
      settingLabel: "exec ask",
      evidenceFilter,
    }),
    ...toolStringPostureAllowFindings(toolsPolicy, policyDocName, requirementBase, evidence, {
      checkId: CHECK_IDS.policyToolsExecHostUnapproved,
      kind: "execHost",
      policyPath: ["exec", "allowHosts"],
      requirementPath: "exec/allowHosts",
      settingLabel: "exec host",
      evidenceFilter,
    }),
  ];
}

function toolStringPostureAllowFindings(
  toolsPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  params: {
    readonly checkId: (typeof POLICY_CHECK_IDS)[number];
    readonly kind: PolicyToolPostureEvidence["kind"];
    readonly policyPath: readonly string[];
    readonly requirementPath: string;
    readonly settingLabel: string;
    readonly evidenceFilter: (entry: PolicyToolPostureEvidence) => boolean;
  },
): readonly HealthFinding[] {
  const allowed = new Set(readStringList(toolsPolicy, params.policyPath));
  if (allowed.size === 0) {
    return [];
  }
  return toolPostureEntries(evidence, params.kind)
    .filter(params.evidenceFilter)
    .filter((entry) => typeof entry.value === "string" && !allowed.has(entry.value.toLowerCase()))
    .map((entry): HealthFinding => {
      return toolPostureFinding(entry, {
        checkId: params.checkId,
        message: `${toolPostureLabel(entry)} uses unapproved ${params.settingLabel} '${entry.value ?? ""}'.`,
        requirement: `oc://${policyDocName}/${requirementBase}/${params.requirementPath}`,
        fixHint: "Adjust the configured tool posture or update policy after review.",
      });
    });
}

function toolElevatedFindings(
  toolsPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyToolPostureEvidence) => boolean,
): readonly HealthFinding[] {
  if (readPolicyBoolean(toolsPolicy, ["elevated", "allow"]) !== false) {
    return [];
  }
  return toolPostureEntries(evidence, "elevatedEnabled")
    .filter(evidenceFilter)
    .filter((entry) => entry.value !== false)
    .map((entry): HealthFinding => {
      return toolPostureFinding(entry, {
        checkId: CHECK_IDS.policyToolsElevatedEnabled,
        message: `${toolPostureLabel(entry)} permits elevated tool mode.`,
        requirement: `oc://${policyDocName}/${requirementBase}/elevated/allow`,
        fixHint: "Set tools.elevated.enabled=false or update policy after review.",
      });
    });
}

function toolAlsoAllowExpectedFindings(
  toolsPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyToolPostureEvidence) => boolean,
): readonly HealthFinding[] {
  const alsoAllowPolicy = isRecord(toolsPolicy.alsoAllow) ? toolsPolicy.alsoAllow : {};
  if (alsoAllowPolicy.expected === undefined) {
    return [];
  }
  const expected = normalizedStringSet(readStringList(toolsPolicy, ["alsoAllow", "expected"]));
  const findings: HealthFinding[] = [];
  for (const entry of toolPostureEntries(evidence, "alsoAllow").filter(evidenceFilter)) {
    const actual = normalizedStringSet(entry.entries ?? []);
    for (const expectedTool of expected) {
      if (actual.has(expectedTool)) {
        continue;
      }
      findings.push(
        toolPostureFinding(entry, {
          checkId: CHECK_IDS.policyToolsAlsoAllowMissing,
          message: `${toolPostureLabel(entry)} is missing expected tools.alsoAllow entry '${expectedTool}'.`,
          requirement: `oc://${policyDocName}/${requirementBase}/alsoAllow/expected`,
          fixHint: "Add the expected tools.alsoAllow entry or update policy after review.",
        }),
      );
    }
    for (const actualTool of actual) {
      if (expected.has(actualTool)) {
        continue;
      }
      findings.push(
        toolPostureFinding(entry, {
          checkId: CHECK_IDS.policyToolsAlsoAllowUnexpected,
          message: `${toolPostureLabel(entry)} has unexpected tools.alsoAllow entry '${actualTool}'.`,
          requirement: `oc://${policyDocName}/${requirementBase}/alsoAllow/expected`,
          fixHint: "Remove the unexpected tools.alsoAllow entry or update policy after review.",
        }),
      );
    }
  }
  return findings;
}

function normalizedStringSet(entries: readonly string[]): ReadonlySet<string> {
  return new Set(
    entries
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
      .toSorted(),
  );
}

function toolRequiredDenyFindings(
  toolsPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyToolPostureEvidence) => boolean,
): readonly HealthFinding[] {
  const required = readStringList(toolsPolicy, ["denyTools"]);
  if (required.length === 0) {
    return [];
  }
  const requiredTools = uniqueStrings(required.flatMap(expandPolicyToolRequirement));
  const findings: HealthFinding[] = [];
  for (const entry of toolPostureEntries(evidence, "deny").filter(evidenceFilter)) {
    for (const tool of requiredTools) {
      if (toolListCoversTool(entry.entries ?? [], tool)) {
        continue;
      }
      findings.push(
        toolPostureFinding(entry, {
          checkId: CHECK_IDS.policyToolsRequiredDenyMissing,
          message: `${toolPostureLabel(entry)} does not deny required tool '${tool}'.`,
          requirement: `oc://${policyDocName}/${requirementBase}/denyTools`,
          fixHint:
            "Add the tool or group to tools.deny/agents.list[].tools.deny, or update policy after review.",
        }),
      );
    }
  }
  return findings;
}

function toolPostureEntries(
  evidence: PolicyEvidence,
  kind: PolicyToolPostureEvidence["kind"],
): readonly PolicyToolPostureEvidence[] {
  return (evidence.toolPosture ?? []).filter((entry) => entry.kind === kind);
}

function toolPostureFinding(
  entry: PolicyToolPostureEvidence,
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

function toolPostureLabel(entry: PolicyToolPostureEvidence): string {
  return entry.agentId === undefined ? "global tools config" : `agent '${entry.agentId}'`;
}

export function toolRiskFindings(
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  return (evidence.tools ?? [])
    .filter((tool) => tool.risk === undefined)
    .map((tool): HealthFinding => {
      return {
        checkId: CHECK_IDS.policyMissingToolRisk,
        severity: "error",
        message: `TOOLS.md tool '${tool.id}' has no explicit risk classification.`,
        source: "policy",
        path: "TOOLS.md",
        line: tool.line,
        ocPath: tool.source,
        target: tool.source,
        requirement: `oc://${policyDocName}/tools/requireMetadata`,
        fixHint:
          "Declare risk:low, risk:medium, risk:high, risk:critical, or an R0-R5 review alias.",
      };
    });
}

export function toolUnknownRiskFindings(
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  return (evidence.tools ?? [])
    .filter(
      (tool) =>
        tool.risk !== undefined &&
        !KNOWN_RISK_LEVELS.includes(tool.risk as (typeof KNOWN_RISK_LEVELS)[number]),
    )
    .map((tool): HealthFinding => {
      return {
        checkId: CHECK_IDS.policyUnknownToolRisk,
        severity: "error",
        message: `TOOLS.md tool '${tool.id}' declares unknown risk '${tool.risk}'.`,
        source: "policy",
        path: "TOOLS.md",
        line: tool.line,
        ocPath: tool.source,
        target: tool.source,
        requirement: `oc://${policyDocName}/tools/requireMetadata`,
        fixHint: `Use one of: ${KNOWN_RISK_LEVELS.join(", ")}.`,
      };
    });
}

export function toolSensitivityFindings(
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  return (evidence.tools ?? []).flatMap((tool): HealthFinding[] => {
    if (tool.sensitivity === undefined) {
      return [
        {
          checkId: CHECK_IDS.policyMissingToolSensitivity,
          severity: "error",
          message: `TOOLS.md tool '${tool.id}' has no declared artifact sensitivity.`,
          source: "policy",
          path: "TOOLS.md",
          line: tool.line,
          ocPath: tool.source,
          target: tool.source,
          requirement: `oc://${policyDocName}/tools/requireMetadata`,
          fixHint: `Declare sensitivity as one of: ${KNOWN_SENSITIVITY_LEVELS.join(", ")}.`,
        },
      ];
    }
    if (
      KNOWN_SENSITIVITY_LEVELS.includes(
        tool.sensitivity as (typeof KNOWN_SENSITIVITY_LEVELS)[number],
      )
    ) {
      return [];
    }
    return [
      {
        checkId: CHECK_IDS.policyUnknownToolSensitivity,
        severity: "error",
        message: `TOOLS.md tool '${tool.id}' declares unknown sensitivity '${tool.sensitivity}'.`,
        source: "policy",
        path: "TOOLS.md",
        line: tool.line,
        ocPath: tool.source,
        target: tool.source,
        requirement: `oc://${policyDocName}/tools/requireMetadata`,
        fixHint: `Use one of: ${KNOWN_SENSITIVITY_LEVELS.join(", ")}.`,
      },
    ];
  });
}

export function toolOwnerFindings(
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  return (evidence.tools ?? [])
    .filter((tool) => tool.owner === undefined)
    .map((tool): HealthFinding => {
      return {
        checkId: CHECK_IDS.policyMissingToolOwner,
        severity: "error",
        message: `TOOLS.md tool '${tool.id}' has no declared owner.`,
        source: "policy",
        path: "TOOLS.md",
        line: tool.line,
        ocPath: tool.source,
        target: tool.source,
        requirement: `oc://${policyDocName}/tools/requireMetadata`,
        fixHint: "Declare owner:<team-or-person> for this tool.",
      };
    });
}
