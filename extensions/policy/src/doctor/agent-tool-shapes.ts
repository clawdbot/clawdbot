import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  SUPPORTED_AGENT_WORKSPACE_DENY_TOOLS,
  SUPPORTED_TOOL_EXEC_ASK,
  SUPPORTED_TOOL_EXEC_HOST,
  SUPPORTED_TOOL_EXEC_SECURITY,
} from "./policy-constants.js";
import {
  policyShapeFinding,
  policyStringArrayPropertyShapeFinding,
  unsupportedPolicyKey,
} from "./shape-helpers.js";
import { ocPathSegment } from "./utils.js";

export function agentWorkspacePolicyShapeFinding(
  value: unknown,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly targetPrefix: string;
    readonly propertyPrefix: string;
  },
): HealthFinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.targetPrefix}`,
      `${params.policyPath} ${params.propertyPrefix} must be an object.`,
      `Fix ${params.policyPath} so ${params.propertyPrefix} is an object.`,
    );
  }
  const unsupportedWorkspaceKey = unsupportedPolicyKey(value, ["allowedAccess", "denyTools"]);
  if (unsupportedWorkspaceKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.targetPrefix}/${ocPathSegment(unsupportedWorkspaceKey)}`,
      `${params.policyPath} ${params.propertyPrefix}.${unsupportedWorkspaceKey} is not supported in agent workspace policy.`,
      `Remove ${params.propertyPrefix}.${unsupportedWorkspaceKey} or use a supported agent workspace policy rule.`,
    );
  }
  const allowedAccess = value.allowedAccess;
  if (allowedAccess !== undefined && !Array.isArray(allowedAccess)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.targetPrefix}/allowedAccess`,
      `${params.policyPath} ${params.propertyPrefix}.allowedAccess must be an array.`,
      'Use workspace access values such as ["none", "ro"].',
    );
  }
  if (Array.isArray(allowedAccess)) {
    const invalidIndex = allowedAccess.findIndex(
      (entry) => entry !== "none" && entry !== "ro" && entry !== "rw",
    );
    if (invalidIndex >= 0) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${params.targetPrefix}/allowedAccess/#${invalidIndex}`,
        `${params.policyPath} ${params.propertyPrefix}.allowedAccess[${invalidIndex}] must be none, ro, or rw.`,
        'Use workspace access values such as ["none", "ro"].',
      );
    }
  }
  const denyTools = value.denyTools;
  if (denyTools !== undefined && !Array.isArray(denyTools)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.targetPrefix}/denyTools`,
      `${params.policyPath} ${params.propertyPrefix}.denyTools must be an array.`,
      'Use tool ids such as ["exec", "process", "write", "edit", "apply_patch"].',
    );
  }
  if (Array.isArray(denyTools)) {
    const invalidIndex = denyTools.findIndex(
      (entry) =>
        typeof entry !== "string" ||
        !SUPPORTED_AGENT_WORKSPACE_DENY_TOOLS.includes(
          entry.trim() as (typeof SUPPORTED_AGENT_WORKSPACE_DENY_TOOLS)[number],
        ),
    );
    if (invalidIndex >= 0) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${params.targetPrefix}/denyTools/#${invalidIndex}`,
        `${params.policyPath} ${params.propertyPrefix}.denyTools[${invalidIndex}] must be a supported agent workspace tool id.`,
        `Use supported tool ids: ${SUPPORTED_AGENT_WORKSPACE_DENY_TOOLS.join(", ")}.`,
      );
    }
  }
  return undefined;
}

export function toolPosturePolicyShapeFinding(
  tools: Record<string, unknown>,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly targetPrefix?: string;
    readonly propertyPrefix?: string;
  },
): HealthFinding | undefined {
  const targetPrefix = params.targetPrefix ?? "tools";
  const propertyPrefix = params.propertyPrefix ?? "tools";
  const allowedTopLevel = [
    "alsoAllow",
    "denyTools",
    "elevated",
    "exec",
    "fs",
    "profiles",
    "requireMetadata",
  ];
  const unsupportedTopLevel = unsupportedPolicyKey(tools, allowedTopLevel);
  if (unsupportedTopLevel !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/${ocPathSegment(unsupportedTopLevel)}`,
      `${params.policyPath} ${propertyPrefix}.${unsupportedTopLevel} is not supported in tools policy.`,
      `Remove ${propertyPrefix}.${unsupportedTopLevel} or use a supported tools policy rule.`,
    );
  }
  for (const section of ["profiles", "fs", "exec", "elevated", "alsoAllow"] as const) {
    if (tools[section] !== undefined && !isRecord(tools[section])) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/${section}`,
        `${params.policyPath} ${propertyPrefix}.${section} must be an object.`,
        `Fix ${params.policyPath} so ${propertyPrefix}.${section} is an object.`,
      );
    }
  }

  const profiles = isRecord(tools.profiles) ? tools.profiles : {};
  const unsupportedProfileKey = unsupportedPolicyKey(profiles, ["allow"]);
  if (unsupportedProfileKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/profiles/${ocPathSegment(unsupportedProfileKey)}`,
      `${params.policyPath} ${propertyPrefix}.profiles.${unsupportedProfileKey} is not supported in tools policy.`,
      `Remove ${propertyPrefix}.profiles.${unsupportedProfileKey} or use ${propertyPrefix}.profiles.allow.`,
    );
  }
  const profileAllowFinding = policyStringArrayPropertyShapeFinding(profiles.allow, {
    isAllowed: (value) => /^[a-z][a-z0-9_-]{0,63}$/.test(value),
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    property: `${propertyPrefix}.profiles.allow`,
    target: `${targetPrefix}/profiles/allow`,
    valueName: "tool profile id",
  });
  if (profileAllowFinding !== undefined) {
    return profileAllowFinding;
  }

  const fs = isRecord(tools.fs) ? tools.fs : {};
  const unsupportedFsKey = unsupportedPolicyKey(fs, ["requireWorkspaceOnly"]);
  if (unsupportedFsKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/fs/${ocPathSegment(unsupportedFsKey)}`,
      `${params.policyPath} ${propertyPrefix}.fs.${unsupportedFsKey} is not supported in tools policy.`,
      `Remove ${propertyPrefix}.fs.${unsupportedFsKey} or use ${propertyPrefix}.fs.requireWorkspaceOnly.`,
    );
  }
  if (fs.requireWorkspaceOnly !== undefined && typeof fs.requireWorkspaceOnly !== "boolean") {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/fs/requireWorkspaceOnly`,
      `${params.policyPath} ${propertyPrefix}.fs.requireWorkspaceOnly must be a boolean.`,
      `Set ${propertyPrefix}.fs.requireWorkspaceOnly to true or false.`,
    );
  }

  const exec = isRecord(tools.exec) ? tools.exec : {};
  const unsupportedExecKey = unsupportedPolicyKey(exec, [
    "allowHosts",
    "allowSecurity",
    "requireAsk",
  ]);
  if (unsupportedExecKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/exec/${ocPathSegment(unsupportedExecKey)}`,
      `${params.policyPath} ${propertyPrefix}.exec.${unsupportedExecKey} is not supported in tools policy.`,
      `Remove ${propertyPrefix}.exec.${unsupportedExecKey} or use a supported tools exec policy rule.`,
    );
  }
  const execLists = [
    ["allowSecurity", SUPPORTED_TOOL_EXEC_SECURITY, "exec security mode"],
    ["requireAsk", SUPPORTED_TOOL_EXEC_ASK, "exec ask mode"],
    ["allowHosts", SUPPORTED_TOOL_EXEC_HOST, "exec host"],
  ] as const;
  for (const [key, supported, valueName] of execLists) {
    const finding = policyStringArrayPropertyShapeFinding(exec[key], {
      allowed: supported,
      policyDocName: params.policyDocName,
      policyPath: params.policyPath,
      property: `${propertyPrefix}.exec.${key}`,
      target: `${targetPrefix}/exec/${key}`,
      valueName,
    });
    if (finding !== undefined) {
      return finding;
    }
  }

  const elevated = isRecord(tools.elevated) ? tools.elevated : {};
  const unsupportedElevatedKey = unsupportedPolicyKey(elevated, ["allow"]);
  if (unsupportedElevatedKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/elevated/${ocPathSegment(unsupportedElevatedKey)}`,
      `${params.policyPath} ${propertyPrefix}.elevated.${unsupportedElevatedKey} is not supported in tools policy.`,
      `Remove ${propertyPrefix}.elevated.${unsupportedElevatedKey} or use ${propertyPrefix}.elevated.allow.`,
    );
  }
  if (elevated.allow !== undefined && typeof elevated.allow !== "boolean") {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/elevated/allow`,
      `${params.policyPath} ${propertyPrefix}.elevated.allow must be a boolean.`,
      `Set ${propertyPrefix}.elevated.allow to true or false.`,
    );
  }

  const alsoAllow = isRecord(tools.alsoAllow) ? tools.alsoAllow : {};
  const unsupportedAlsoAllowKey = unsupportedPolicyKey(alsoAllow, ["expected"]);
  if (unsupportedAlsoAllowKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/alsoAllow/${ocPathSegment(unsupportedAlsoAllowKey)}`,
      `${params.policyPath} ${propertyPrefix}.alsoAllow.${unsupportedAlsoAllowKey} is not supported in tools policy.`,
      `Remove ${propertyPrefix}.alsoAllow.${unsupportedAlsoAllowKey} or use ${propertyPrefix}.alsoAllow.expected.`,
    );
  }
  const alsoAllowExpectedFinding = policyStringArrayPropertyShapeFinding(alsoAllow.expected, {
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    property: `${propertyPrefix}.alsoAllow.expected`,
    target: `${targetPrefix}/alsoAllow/expected`,
    valueName: "tool id",
  });
  if (alsoAllowExpectedFinding !== undefined) {
    return alsoAllowExpectedFinding;
  }

  const denyToolsFinding = policyStringArrayPropertyShapeFinding(tools.denyTools, {
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    property: `${propertyPrefix}.denyTools`,
    target: `${targetPrefix}/denyTools`,
    valueName: "tool id or group",
  });
  return denyToolsFinding;
}
