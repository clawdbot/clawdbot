import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { PolicyExecApprovalEvidence } from "../policy-state.js";
import { policyShapeFinding, unsupportedPolicyKey } from "./shape-helpers.js";
import { ocPathSegment } from "./utils.js";

export function execApprovalAllowlistExpectedShapeFinding(
  value: unknown,
  params: {
    readonly property: string;
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly target: string;
  },
): HealthFinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.target}`,
      `${params.policyPath} ${params.property} must be an array.`,
      `Fix ${params.policyPath} so ${params.property} is an array of exec approval allowlist entries.`,
    );
  }
  const invalidIndex = value.findIndex(
    (entry) => execApprovalAllowlistRequirement(entry) === undefined,
  );
  if (invalidIndex < 0) {
    return undefined;
  }
  return policyShapeFinding(
    params.policyPath,
    `oc://${params.policyDocName}/${params.target}/#${invalidIndex}`,
    `${params.policyPath} ${params.property}[${invalidIndex}] must be a non-empty string or an object with pattern and optional argPattern strings.`,
    `Use entries such as "deploy" or { "pattern": "deploy", "argPattern": "^--prod$" }.`,
  );
}

type ExecApprovalAllowlistRequirement = {
  readonly key: string;
  readonly pattern: string;
  readonly argPattern?: string;
};

export function readExecApprovalAllowlistRequirements(
  policy: unknown,
  path: readonly string[],
): readonly ExecApprovalAllowlistRequirement[] | undefined {
  let current: unknown = policy;
  for (const part of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  if (!Array.isArray(current)) {
    return undefined;
  }
  const entries = current.map(execApprovalAllowlistRequirement);
  return entries.every((entry): entry is ExecApprovalAllowlistRequirement => entry !== undefined)
    ? entries
    : undefined;
}

function execApprovalAllowlistRequirement(
  value: unknown,
): ExecApprovalAllowlistRequirement | undefined {
  if (typeof value === "string") {
    const pattern = value.trim();
    return pattern === "" ? undefined : execApprovalAllowlistRequirementFromParts(pattern);
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (unsupportedPolicyKey(value, ["argPattern", "pattern"]) !== undefined) {
    return undefined;
  }
  const pattern = typeof value.pattern === "string" ? value.pattern.trim() : "";
  if (pattern === "") {
    return undefined;
  }
  const argPattern = typeof value.argPattern === "string" ? value.argPattern.trim() : undefined;
  if (value.argPattern !== undefined && argPattern === undefined) {
    return undefined;
  }
  return execApprovalAllowlistRequirementFromParts(
    pattern,
    argPattern === "" ? undefined : argPattern,
  );
}

function execApprovalAllowlistRequirementFromParts(
  pattern: string,
  argPattern?: string,
): ExecApprovalAllowlistRequirement {
  return {
    key: execApprovalAllowlistRequirementKey(pattern, argPattern),
    pattern,
    ...(argPattern === undefined ? {} : { argPattern }),
  };
}

export function execApprovalAllowlistRequirementKey(
  pattern: string,
  argPattern: string | undefined,
): string {
  return `${pattern}\0${argPattern ?? ""}`;
}

export function execApprovalAllowlistMissingTarget(agentId: string | undefined): string {
  return agentId === undefined
    ? "oc://exec-approvals.json"
    : `oc://exec-approvals.json/agents/${ocPathSegment(agentId)}/allowlist`;
}

export function formatExecApprovalAllowlistRequirement(
  entry: ExecApprovalAllowlistRequirement,
): string {
  return formatExecApprovalAllowlistParts(entry.pattern, entry.argPattern);
}

export function formatExecApprovalAllowlistEntry(
  entry: PolicyExecApprovalEvidence | undefined,
): string {
  return formatExecApprovalAllowlistParts(entry?.pattern ?? "", entry?.argPattern);
}

function formatExecApprovalAllowlistParts(pattern: string, argPattern: string | undefined): string {
  return argPattern === undefined ? pattern : `${pattern} argPattern=${argPattern}`;
}

export function effectiveExecApprovalAgentSecurityEntry(
  entries: readonly PolicyExecApprovalEvidence[],
  agentId: string,
): PolicyExecApprovalEvidence | undefined {
  const exact = entries.find(
    (entry) =>
      entry.kind === "agent" &&
      entry.agentId !== undefined &&
      normalizeAgentId(entry.agentId) === normalizeAgentId(agentId),
  );
  const wildcard = entries.find((entry) => entry.kind === "agent" && entry.agentId === "*");
  if (exact?.security !== undefined || exact?.securityConfigured === true) {
    return exact;
  }
  return wildcard?.security === undefined ? (exact ?? wildcard) : wildcard;
}

export function effectiveExecApprovalAgentAutoAllowSkillsEntry(
  entries: readonly PolicyExecApprovalEvidence[],
  agentId: string,
): PolicyExecApprovalEvidence | undefined {
  const exact = entries.find(
    (entry) =>
      entry.kind === "agent" &&
      entry.agentId !== undefined &&
      normalizeAgentId(entry.agentId) === normalizeAgentId(agentId),
  );
  if (exact?.autoAllowSkills !== undefined) {
    return exact;
  }
  const wildcard = entries.find((entry) => entry.kind === "agent" && entry.agentId === "*");
  return wildcard?.autoAllowSkills === undefined ? undefined : wildcard;
}

export function syntheticExecApprovalAgentEntry(agentId: string): PolicyExecApprovalEvidence {
  return {
    id: `agent:${agentId}:runtime-defaults`,
    kind: "agent",
    source: "oc://exec-approvals.json",
    agentId,
  };
}
