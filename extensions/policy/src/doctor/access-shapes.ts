import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  agentWorkspacePolicyShapeFinding,
  toolPosturePolicyShapeFinding,
} from "./agent-tool-shapes.js";
import { execApprovalAllowlistExpectedShapeFinding } from "./exec-approval-rules.js";
import {
  SUPPORTED_DM_POLICIES,
  SUPPORTED_DM_SCOPES,
  SUPPORTED_EXEC_APPROVAL_SECURITY,
} from "./policy-constants.js";
import {
  policyShapeFinding,
  policyStringArrayPropertyShapeFinding,
  unsupportedPolicyKey,
} from "./shape-helpers.js";
import { ocPathSegment } from "./utils.js";

export function ingressPolicyShapeFinding(
  value: unknown,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly targetPrefix?: string;
    readonly propertyPrefix?: string;
    readonly allowSession?: boolean;
  },
): HealthFinding | undefined {
  const targetPrefix = params.targetPrefix ?? "ingress";
  const propertyPrefix = params.propertyPrefix ?? "ingress";
  const allowSession = params.allowSession ?? true;
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}`,
      `${params.policyPath} ${propertyPrefix} must be an object.`,
      `Fix ${params.policyPath} so ${propertyPrefix} is an object.`,
    );
  }
  if (!allowSession && value.session !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/session`,
      `${params.policyPath} ${propertyPrefix}.session is not supported by the channelIds selector.`,
      `Move session ingress rules to top-level ingress; scoped ingress currently supports ingress.channels.*.`,
    );
  }
  const unsupportedIngressKey = unsupportedPolicyKey(value, ["channels", "session"]);
  if (unsupportedIngressKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/${ocPathSegment(unsupportedIngressKey)}`,
      `${params.policyPath} ${propertyPrefix}.${unsupportedIngressKey} is not supported in ingress policy.`,
      `Remove ${propertyPrefix}.${unsupportedIngressKey} or use ingress.session or ingress.channels.`,
    );
  }
  for (const section of ["session", "channels"] as const) {
    if (value[section] !== undefined && !isRecord(value[section])) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/${section}`,
        `${params.policyPath} ${propertyPrefix}.${section} must be an object.`,
        `Fix ${params.policyPath} so ${propertyPrefix}.${section} is an object.`,
      );
    }
  }
  const session = isRecord(value.session) ? value.session : {};
  const unsupportedSessionKey = unsupportedPolicyKey(session, ["requireDmScope"]);
  if (unsupportedSessionKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/session/${ocPathSegment(unsupportedSessionKey)}`,
      `${params.policyPath} ${propertyPrefix}.session.${unsupportedSessionKey} is not supported in ingress policy.`,
      `Remove ${propertyPrefix}.session.${unsupportedSessionKey} or use ${propertyPrefix}.session.requireDmScope.`,
    );
  }
  if (
    session.requireDmScope !== undefined &&
    !SUPPORTED_DM_SCOPES.includes(session.requireDmScope as (typeof SUPPORTED_DM_SCOPES)[number])
  ) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/session/requireDmScope`,
      `${params.policyPath} ${propertyPrefix}.session.requireDmScope must be a supported DM scope.`,
      `Use supported DM scopes: ${SUPPORTED_DM_SCOPES.join(", ")}.`,
    );
  }
  const channels = isRecord(value.channels) ? value.channels : {};
  const unsupportedChannelsKey = unsupportedPolicyKey(channels, [
    "allowDmPolicies",
    "denyOpenGroups",
    "requireMentionInGroups",
  ]);
  if (unsupportedChannelsKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/channels/${ocPathSegment(unsupportedChannelsKey)}`,
      `${params.policyPath} ${propertyPrefix}.channels.${unsupportedChannelsKey} is not supported in ingress policy.`,
      `Remove ${propertyPrefix}.channels.${unsupportedChannelsKey} or use a supported ingress channel policy rule.`,
    );
  }
  const allowDmPoliciesFinding = policyStringArrayPropertyShapeFinding(channels.allowDmPolicies, {
    allowed: SUPPORTED_DM_POLICIES,
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    property: `${propertyPrefix}.channels.allowDmPolicies`,
    target: `${targetPrefix}/channels/allowDmPolicies`,
    valueName: "DM policy",
  });
  if (allowDmPoliciesFinding !== undefined) {
    return allowDmPoliciesFinding;
  }
  for (const key of ["denyOpenGroups", "requireMentionInGroups"] as const) {
    if (channels[key] !== undefined && typeof channels[key] !== "boolean") {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/channels/${key}`,
        `${params.policyPath} ${propertyPrefix}.channels.${key} must be a boolean.`,
        `Set ${propertyPrefix}.channels.${key} to true or false.`,
      );
    }
  }
  return undefined;
}

export function execApprovalsPolicyShapeFinding(
  value: unknown,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly targetPrefix?: string;
    readonly propertyPrefix?: string;
    readonly allowDefaults?: boolean;
  },
): HealthFinding | undefined {
  const targetPrefix = params.targetPrefix ?? "execApprovals";
  const propertyPrefix = params.propertyPrefix ?? "execApprovals";
  const allowDefaults = params.allowDefaults ?? true;
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}`,
      `${params.policyPath} ${propertyPrefix} must be an object.`,
      `Fix ${params.policyPath} so ${propertyPrefix} is an object.`,
    );
  }
  const unsupportedTopLevel = unsupportedPolicyKey(
    value,
    allowDefaults ? ["agents", "defaults", "requireFile"] : ["agents"],
  );
  if (unsupportedTopLevel !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/${ocPathSegment(unsupportedTopLevel)}`,
      `${params.policyPath} ${propertyPrefix}.${unsupportedTopLevel} is not supported in exec approvals policy.`,
      `Remove ${propertyPrefix}.${unsupportedTopLevel} or use a supported execApprovals rule.`,
    );
  }
  if (value.requireFile !== undefined && typeof value.requireFile !== "boolean") {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/requireFile`,
      `${params.policyPath} ${propertyPrefix}.requireFile must be a boolean.`,
      `Set execApprovals.requireFile to true or false.`,
    );
  }
  for (const section of (allowDefaults ? ["defaults", "agents"] : ["agents"]) as readonly (
    | "agents"
    | "defaults"
  )[]) {
    if (value[section] !== undefined && !isRecord(value[section])) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/${section}`,
        `${params.policyPath} ${propertyPrefix}.${section} must be an object.`,
        `Fix ${params.policyPath} so ${propertyPrefix}.${section} is an object.`,
      );
    }
  }
  const defaults = allowDefaults && isRecord(value.defaults) ? value.defaults : {};
  const unsupportedDefaultsKey = unsupportedPolicyKey(defaults, ["allowSecurity"]);
  if (unsupportedDefaultsKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/defaults/${ocPathSegment(unsupportedDefaultsKey)}`,
      `${params.policyPath} ${propertyPrefix}.defaults.${unsupportedDefaultsKey} is not supported in exec approvals policy.`,
      `Use execApprovals.defaults.allowSecurity or remove the unsupported rule.`,
    );
  }
  const defaultsSecurityFinding = policyStringArrayPropertyShapeFinding(defaults.allowSecurity, {
    allowed: SUPPORTED_EXEC_APPROVAL_SECURITY,
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    property: `${propertyPrefix}.defaults.allowSecurity`,
    target: `${targetPrefix}/defaults/allowSecurity`,
    valueName: "exec approval security mode",
  });
  if (defaultsSecurityFinding !== undefined) {
    return defaultsSecurityFinding;
  }
  const agents = isRecord(value.agents) ? value.agents : {};
  const unsupportedAgentsKey = unsupportedPolicyKey(agents, [
    "allowAutoAllowSkills",
    "allowSecurity",
    "allowlist",
  ]);
  if (unsupportedAgentsKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/agents/${ocPathSegment(unsupportedAgentsKey)}`,
      `${params.policyPath} ${propertyPrefix}.agents.${unsupportedAgentsKey} is not supported in exec approvals policy.`,
      `Use execApprovals.agents.allowSecurity, execApprovals.agents.allowAutoAllowSkills, or execApprovals.agents.allowlist.expected.`,
    );
  }
  const agentSecurityFinding = policyStringArrayPropertyShapeFinding(agents.allowSecurity, {
    allowed: SUPPORTED_EXEC_APPROVAL_SECURITY,
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    property: `${propertyPrefix}.agents.allowSecurity`,
    target: `${targetPrefix}/agents/allowSecurity`,
    valueName: "exec approval security mode",
  });
  if (agentSecurityFinding !== undefined) {
    return agentSecurityFinding;
  }
  if (
    agents.allowAutoAllowSkills !== undefined &&
    typeof agents.allowAutoAllowSkills !== "boolean"
  ) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/agents/allowAutoAllowSkills`,
      `${params.policyPath} ${propertyPrefix}.agents.allowAutoAllowSkills must be a boolean.`,
      `Set execApprovals.agents.allowAutoAllowSkills to true or false.`,
    );
  }
  if (agents.allowlist !== undefined && !isRecord(agents.allowlist)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/agents/allowlist`,
      `${params.policyPath} ${propertyPrefix}.agents.allowlist must be an object.`,
      `Fix ${params.policyPath} so ${propertyPrefix}.agents.allowlist is an object.`,
    );
  }
  const allowlist = isRecord(agents.allowlist) ? agents.allowlist : {};
  const unsupportedAllowlistKey = unsupportedPolicyKey(allowlist, ["expected"]);
  if (unsupportedAllowlistKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/agents/allowlist/${ocPathSegment(unsupportedAllowlistKey)}`,
      `${params.policyPath} ${propertyPrefix}.agents.allowlist.${unsupportedAllowlistKey} is not supported in exec approvals policy.`,
      `Use execApprovals.agents.allowlist.expected or remove the unsupported rule.`,
    );
  }
  return execApprovalAllowlistExpectedShapeFinding(allowlist.expected, {
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    property: `${propertyPrefix}.agents.allowlist.expected`,
    target: `${targetPrefix}/agents/allowlist/expected`,
  });
}

export function agentsPolicyShapeFinding(
  value: unknown,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
  },
): HealthFinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/agents`,
      `${params.policyPath} agents must be an object.`,
      `Fix ${params.policyPath} so agents is an object.`,
    );
  }
  const unsupportedAgentsKey = unsupportedPolicyKey(value, ["workspace"]);
  if (unsupportedAgentsKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/agents/${ocPathSegment(unsupportedAgentsKey)}`,
      `${params.policyPath} agents.${unsupportedAgentsKey} is not supported in agents policy.`,
      `Remove agents.${unsupportedAgentsKey} or use agents.workspace.`,
    );
  }
  const workspaceFinding = agentWorkspacePolicyShapeFinding(value.workspace, {
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    targetPrefix: "agents/workspace",
    propertyPrefix: "agents.workspace",
  });
  if (workspaceFinding !== undefined) {
    return workspaceFinding;
  }
  return undefined;
}

export function scopedDataHandlingPolicyShapeFinding(
  dataHandling: Record<string, unknown>,
  params: {
    readonly policyPath: string;
    readonly policyDocName: string;
    readonly targetPrefix: string;
    readonly scopeName: string;
  },
): HealthFinding | undefined {
  const unsupportedKey = Object.keys(dataHandling).find((key) => key !== "memory");
  if (unsupportedKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.targetPrefix}/dataHandling/${ocPathSegment(unsupportedKey)}`,
      `${params.policyPath} scopes.${params.scopeName}.dataHandling.${unsupportedKey} is not a supported scoped policy section.`,
      `Move global data-handling rules to top-level dataHandling, or use dataHandling.memory with agentIds.`,
    );
  }
  if (dataHandling.memory !== undefined && !isRecord(dataHandling.memory)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.targetPrefix}/dataHandling/memory`,
      `${params.policyPath} scopes.${params.scopeName}.dataHandling.memory must be an object.`,
      `Fix ${params.policyPath} so the scoped dataHandling.memory policy section is an object.`,
    );
  }
  if (!isRecord(dataHandling.memory)) {
    return undefined;
  }
  const unsupportedMemoryKey = Object.keys(dataHandling.memory).find(
    (key) => key !== "denySessionTranscriptIndexing",
  );
  if (unsupportedMemoryKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.targetPrefix}/dataHandling/memory/${ocPathSegment(unsupportedMemoryKey)}`,
      `${params.policyPath} scopes.${params.scopeName}.dataHandling.memory.${unsupportedMemoryKey} is not a supported scoped policy rule.`,
      `Use dataHandling.memory.denySessionTranscriptIndexing or remove the unsupported rule.`,
    );
  }
  if (
    dataHandling.memory.denySessionTranscriptIndexing !== undefined &&
    typeof dataHandling.memory.denySessionTranscriptIndexing !== "boolean"
  ) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.targetPrefix}/dataHandling/memory/denySessionTranscriptIndexing`,
      `${params.policyPath} scopes.${params.scopeName}.dataHandling.memory.denySessionTranscriptIndexing must be a boolean.`,
      `Set dataHandling.memory.denySessionTranscriptIndexing to true or false.`,
    );
  }
  return undefined;
}

export function scopedToolsPolicyShapeFinding(
  value: Record<string, unknown>,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly targetPrefix: string;
    readonly propertyPrefix: string;
  },
): HealthFinding | undefined {
  const allowedTopLevel = new Set(["profiles", "fs", "exec", "elevated", "alsoAllow", "denyTools"]);
  const unsupportedTopLevel = Object.keys(value).find((key) => !allowedTopLevel.has(key));
  if (unsupportedTopLevel !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.targetPrefix}/${ocPathSegment(unsupportedTopLevel)}`,
      `${params.policyPath} ${params.propertyPrefix}.${unsupportedTopLevel} is not supported in agent-scoped tools policy.`,
      `Move ${params.propertyPrefix}.${unsupportedTopLevel} to top-level tools or use a supported scoped tools posture rule.`,
    );
  }
  for (const [section, allowedKeys] of [
    ["profiles", ["allow"]],
    ["fs", ["requireWorkspaceOnly"]],
    ["exec", ["allowSecurity", "requireAsk", "allowHosts"]],
    ["elevated", ["allow"]],
    ["alsoAllow", ["expected"]],
  ] as const) {
    const sectionValue = value[section];
    if (!isRecord(sectionValue)) {
      continue;
    }
    const allowed = new Set<string>(allowedKeys);
    const unsupportedKey = Object.keys(sectionValue).find((key) => !allowed.has(key));
    if (unsupportedKey !== undefined) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${params.targetPrefix}/${section}/${ocPathSegment(unsupportedKey)}`,
        `${params.policyPath} ${params.propertyPrefix}.${section}.${unsupportedKey} is not supported in agent-scoped tools policy.`,
        `Move ${params.propertyPrefix}.${section}.${unsupportedKey} to top-level tools or use a supported scoped tools posture rule.`,
      );
    }
  }
  return toolPosturePolicyShapeFinding(value, params);
}
