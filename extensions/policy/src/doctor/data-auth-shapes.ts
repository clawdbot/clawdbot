import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { PolicyDataHandlingEvidence, PolicyEvidence } from "../policy-state.js";
import { getPolicyPath } from "../policy-value.js";
import { POLICY_CHECK_IDS } from "./check-ids.js";
import { SUPPORTED_AUTH_PROFILE_MODES } from "./policy-constants.js";
import { policyShapeFinding, unsupportedPolicyKey } from "./shape-helpers.js";
import { ocPathSegment } from "./utils.js";

export function dataHandlingPolicyShapeFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): readonly HealthFinding[] {
  if (!isRecord(policy)) {
    return [];
  }
  if (!isRecord(policy.dataHandling)) {
    return [];
  }
  return [
    policySectionUnsupportedKeyFinding(policy.dataHandling, {
      policyPath,
      policyDocName,
      propertyPath: "dataHandling",
      targetPath: "dataHandling",
      sectionName: "data-handling",
      allowedKeys: ["memory", "retention", "sensitiveLogging", "telemetry"],
    }),
    dataHandlingSectionShapeFinding(policy.dataHandling, {
      policyPath,
      policyDocName,
      propertyPath: "dataHandling.sensitiveLogging",
      targetPath: "dataHandling/sensitiveLogging",
      section: "sensitiveLogging",
    }),
    dataHandlingSectionShapeFinding(policy.dataHandling, {
      policyPath,
      policyDocName,
      propertyPath: "dataHandling.telemetry",
      targetPath: "dataHandling/telemetry",
      section: "telemetry",
    }),
    dataHandlingSectionShapeFinding(policy.dataHandling, {
      policyPath,
      policyDocName,
      propertyPath: "dataHandling.retention",
      targetPath: "dataHandling/retention",
      section: "retention",
    }),
    dataHandlingSectionShapeFinding(policy.dataHandling, {
      policyPath,
      policyDocName,
      propertyPath: "dataHandling.memory",
      targetPath: "dataHandling/memory",
      section: "memory",
    }),
    dataHandlingBooleanShapeFinding(policy.dataHandling, {
      policyPath,
      policyDocName,
      propertyPath: "dataHandling.sensitiveLogging.requireRedaction",
      targetPath: "dataHandling/sensitiveLogging/requireRedaction",
      path: ["sensitiveLogging", "requireRedaction"],
    }),
    dataHandlingBooleanShapeFinding(policy.dataHandling, {
      policyPath,
      policyDocName,
      propertyPath: "dataHandling.telemetry.denyContentCapture",
      targetPath: "dataHandling/telemetry/denyContentCapture",
      path: ["telemetry", "denyContentCapture"],
    }),
    dataHandlingBooleanShapeFinding(policy.dataHandling, {
      policyPath,
      policyDocName,
      propertyPath: "dataHandling.retention.requireSessionMaintenance",
      targetPath: "dataHandling/retention/requireSessionMaintenance",
      path: ["retention", "requireSessionMaintenance"],
    }),
    dataHandlingBooleanShapeFinding(policy.dataHandling, {
      policyPath,
      policyDocName,
      propertyPath: "dataHandling.memory.denySessionTranscriptIndexing",
      targetPath: "dataHandling/memory/denySessionTranscriptIndexing",
      path: ["memory", "denySessionTranscriptIndexing"],
    }),
  ].filter((finding): finding is HealthFinding => finding !== undefined);
}

function policySectionUnsupportedKeyFinding(
  value: Record<string, unknown>,
  params: {
    readonly policyPath: string;
    readonly policyDocName: string;
    readonly propertyPath: string;
    readonly targetPath: string;
    readonly sectionName: string;
    readonly allowedKeys: readonly string[];
  },
): HealthFinding | undefined {
  const unsupportedKey = unsupportedPolicyKey(value, params.allowedKeys);
  if (unsupportedKey === undefined) {
    return undefined;
  }
  return policyShapeFinding(
    params.policyPath,
    `oc://${params.policyDocName}/${params.targetPath}/${ocPathSegment(unsupportedKey)}`,
    `${params.policyPath} ${params.propertyPath}.${unsupportedKey} is not supported in ${params.sectionName} policy.`,
    `Remove ${params.propertyPath}.${unsupportedKey} or use a supported ${params.sectionName} policy rule.`,
  );
}

function dataHandlingSectionShapeFinding(
  dataHandling: Record<string, unknown>,
  params: {
    readonly policyPath: string;
    readonly policyDocName: string;
    readonly propertyPath: string;
    readonly targetPath: string;
    readonly section: string;
  },
): HealthFinding | undefined {
  const value = dataHandling[params.section];
  if (value === undefined || isRecord(value)) {
    return undefined;
  }
  return policyShapeFinding(
    params.policyPath,
    `oc://${params.policyDocName}/${params.targetPath}`,
    `${params.policyPath} ${params.propertyPath} must be an object.`,
    `Fix ${params.propertyPath} so it contains boolean policy rules.`,
  );
}

function dataHandlingBooleanShapeFinding(
  dataHandling: unknown,
  params: {
    readonly policyPath: string;
    readonly policyDocName: string;
    readonly propertyPath: string;
    readonly targetPath: string;
    readonly path: readonly string[];
  },
): HealthFinding | undefined {
  const value = getPolicyPath(dataHandling, params.path);
  if (isRecord(dataHandling) && typeof params.path[0] === "string") {
    const section = dataHandling[params.path[0]];
    if (isRecord(section) && typeof params.path[1] === "string") {
      const sectionPath = params.path.slice(0, -1).join(".");
      const unsupportedKey = unsupportedPolicyKey(section, [params.path[1]]);
      if (unsupportedKey !== undefined) {
        return policyShapeFinding(
          params.policyPath,
          `oc://${params.policyDocName}/${params.targetPath
            .split("/")
            .slice(0, -1)
            .join("/")}/${ocPathSegment(unsupportedKey)}`,
          `${params.policyPath} dataHandling.${sectionPath}.${unsupportedKey} is not supported in data-handling policy.`,
          `Remove dataHandling.${sectionPath}.${unsupportedKey} or use ${params.propertyPath}.`,
        );
      }
    }
  }
  if (value === undefined || typeof value === "boolean") {
    return undefined;
  }
  return policyShapeFinding(
    params.policyPath,
    `oc://${params.policyDocName}/${params.targetPath}`,
    `${params.policyPath} ${params.propertyPath} must be a boolean.`,
    `Set ${params.propertyPath} to true or false.`,
  );
}

export function dataHandlingEntries(
  evidence: PolicyEvidence,
  kind: PolicyDataHandlingEvidence["kind"],
): readonly PolicyDataHandlingEvidence[] {
  return (evidence.dataHandling ?? []).filter((entry) => entry.kind === kind);
}

export function dataHandlingFinding(
  entry: PolicyDataHandlingEvidence,
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

export function dataHandlingLabel(entry: PolicyDataHandlingEvidence): string {
  return entry.agentId === undefined ? "Global data handling config" : `agent '${entry.agentId}'`;
}

export function secretPolicyShapeFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): readonly HealthFinding[] {
  if (!isRecord(policy) || !isRecord(policy.secrets)) {
    return [];
  }
  const findings: HealthFinding[] = [];
  for (const key of ["requireManagedProviders", "allowInsecureProviders"] as const) {
    if (policy.secrets[key] !== undefined && typeof policy.secrets[key] !== "boolean") {
      findings.push(
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/secrets/${key}`,
          `${policyPath} secrets.${key} must be a boolean.`,
          `Set secrets.${key} to true or false.`,
        ),
      );
    }
  }
  if (policy.secrets.denySources !== undefined && !Array.isArray(policy.secrets.denySources)) {
    findings.push(
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/secrets/denySources`,
        `${policyPath} secrets.denySources must be an array of source names.`,
        'Use an array such as ["exec"] or remove secrets.denySources.',
      ),
    );
  } else if (Array.isArray(policy.secrets.denySources)) {
    const invalidIndex = policy.secrets.denySources.findIndex(
      (entry) => typeof entry !== "string" || entry.trim() === "",
    );
    if (invalidIndex >= 0) {
      findings.push(
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/secrets/denySources/#${invalidIndex}`,
          `${policyPath} secrets.denySources[${invalidIndex}] must be a non-empty source name.`,
          "Use non-empty source names such as env, file, exec, or openclaw.",
        ),
      );
    }
  }
  return findings;
}

export function authProfileAllowModesShapeFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): readonly HealthFinding[] {
  if (
    !isRecord(policy) ||
    !isRecord(policy.auth) ||
    !isRecord(policy.auth.profiles) ||
    policy.auth.profiles.allowModes === undefined
  ) {
    return [];
  }
  if (!Array.isArray(policy.auth.profiles.allowModes)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/auth/profiles/allowModes`,
        `${policyPath} auth.profiles.allowModes must be an array of auth modes.`,
        `Use supported auth modes: ${SUPPORTED_AUTH_PROFILE_MODES.join(", ")}.`,
      ),
    ];
  }
  const invalidIndex = policy.auth.profiles.allowModes.findIndex(
    (entry) =>
      typeof entry !== "string" ||
      !SUPPORTED_AUTH_PROFILE_MODES.includes(
        entry.trim().toLowerCase() as (typeof SUPPORTED_AUTH_PROFILE_MODES)[number],
      ),
  );
  if (invalidIndex < 0) {
    return [];
  }
  return [
    policyShapeFinding(
      policyPath,
      `oc://${policyDocName}/auth/profiles/allowModes/#${invalidIndex}`,
      `${policyPath} auth.profiles.allowModes[${invalidIndex}] must be a supported auth mode.`,
      `Use supported auth modes: ${SUPPORTED_AUTH_PROFILE_MODES.join(", ")}.`,
    ),
  ];
}
