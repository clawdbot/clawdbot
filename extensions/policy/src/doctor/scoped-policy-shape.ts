import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  execApprovalsPolicyShapeFinding,
  ingressPolicyShapeFinding,
  scopedDataHandlingPolicyShapeFinding,
  scopedToolsPolicyShapeFinding,
} from "./access-shapes.js";
import { agentWorkspacePolicyShapeFinding } from "./agent-tool-shapes.js";
import { normalizePolicyChannelId } from "./policy-runtime.js";
import { duplicateScopedPolicyFieldFinding } from "./policy-scope.js";
import { sandboxPolicyShapeFinding } from "./sandbox-gateway-shapes.js";
import { policyShapeFinding, policyStringArrayPropertyShapeFinding } from "./shape-helpers.js";
import { ocPathSegment } from "./utils.js";

export function scopedPolicyShapeFinding(
  value: unknown,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly policy: Record<string, unknown>;
  },
): HealthFinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/scopes`,
      `${params.policyPath} scopes must be an object.`,
      `Fix ${params.policyPath} so scopes maps scope names to policy overlays with selectors such as agentIds.`,
    );
  }
  for (const [scopeName, overlay] of Object.entries(value)) {
    const targetPrefix = `scopes/${ocPathSegment(scopeName)}`;
    if (!isRecord(overlay)) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}`,
        `${params.policyPath} scopes.${scopeName} must be an object.`,
        `Fix ${params.policyPath} so the named policy scope is an object.`,
      );
    }
    const hasAgentIds = overlay.agentIds !== undefined;
    const hasChannelIds = overlay.channelIds !== undefined;
    if (!hasAgentIds && !hasChannelIds) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}`,
        `${params.policyPath} scopes.${scopeName} must define at least one selector.`,
        `List agentIds for agent-scoped policy or channelIds for channel-scoped ingress policy.`,
      );
    }
    const agentIdsFinding = scopedSelectorShapeFinding(overlay.agentIds, {
      policyDocName: params.policyDocName,
      policyPath: params.policyPath,
      property: `scopes.${scopeName}.agentIds`,
      target: `${targetPrefix}/agentIds`,
      valueName: "agent id",
      normalize: normalizeAgentId,
    });
    if (agentIdsFinding !== undefined) {
      return agentIdsFinding;
    }
    const channelIdsFinding = scopedSelectorShapeFinding(overlay.channelIds, {
      policyDocName: params.policyDocName,
      policyPath: params.policyPath,
      property: `scopes.${scopeName}.channelIds`,
      target: `${targetPrefix}/channelIds`,
      valueName: "channel id",
      normalize: normalizePolicyChannelId,
    });
    if (channelIdsFinding !== undefined) {
      return channelIdsFinding;
    }
    if (overlay.ingress !== undefined && !hasChannelIds) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/ingress`,
        `${params.policyPath} scopes.${scopeName}.ingress requires the channelIds selector.`,
        `Move global ingress rules to top-level ingress, or list channelIds for channel-scoped ingress policy.`,
      );
    }
    if (
      (overlay.agents !== undefined ||
        overlay.dataHandling !== undefined ||
        overlay.execApprovals !== undefined ||
        overlay.tools !== undefined ||
        overlay.sandbox !== undefined) &&
      !hasAgentIds
    ) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}`,
        `${params.policyPath} scopes.${scopeName} uses agent-scoped sections without agentIds.`,
        `List agentIds for agents.workspace, dataHandling.memory, tools, or sandbox policy sections.`,
      );
    }
    const unsupportedKey = Object.keys(overlay).find(
      (key) =>
        key !== "agentIds" &&
        key !== "channelIds" &&
        key !== "agents" &&
        key !== "dataHandling" &&
        key !== "execApprovals" &&
        key !== "tools" &&
        key !== "sandbox" &&
        key !== "ingress",
    );
    if (unsupportedKey !== undefined) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/${ocPathSegment(unsupportedKey)}`,
        `${params.policyPath} scopes.${scopeName}.${unsupportedKey} is not a supported scoped policy section.`,
        `Use agentIds with agents.workspace, dataHandling.memory, execApprovals, tools, or sandbox, and channelIds with ingress.channels.`,
      );
    }
    if (overlay.dataHandling !== undefined && !isRecord(overlay.dataHandling)) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/dataHandling`,
        `${params.policyPath} scopes.${scopeName}.dataHandling must be an object.`,
        `Fix ${params.policyPath} so the scoped dataHandling policy section is an object.`,
      );
    }
    if (isRecord(overlay.dataHandling)) {
      const scopedDataHandlingFinding = scopedDataHandlingPolicyShapeFinding(overlay.dataHandling, {
        policyPath: params.policyPath,
        policyDocName: params.policyDocName,
        targetPrefix,
        scopeName,
      });
      if (scopedDataHandlingFinding !== undefined) {
        return scopedDataHandlingFinding;
      }
    }
    if (overlay.agents !== undefined && !isRecord(overlay.agents)) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/agents`,
        `${params.policyPath} scopes.${scopeName}.agents must be an object.`,
        `Fix ${params.policyPath} so the scoped agents policy section is an object.`,
      );
    }
    const scopedAgents = isRecord(overlay.agents) ? overlay.agents : {};
    const unsupportedAgentKey = Object.keys(scopedAgents).find((key) => key !== "workspace");
    if (unsupportedAgentKey !== undefined) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/agents/${ocPathSegment(unsupportedAgentKey)}`,
        `${params.policyPath} scopes.${scopeName}.agents.${unsupportedAgentKey} is not supported by the agentIds selector.`,
        `Move the rule under agents.workspace or a supported scoped top-level section.`,
      );
    }
    const workspaceFinding = agentWorkspacePolicyShapeFinding(scopedAgents.workspace, {
      policyDocName: params.policyDocName,
      policyPath: params.policyPath,
      targetPrefix: `${targetPrefix}/agents/workspace`,
      propertyPrefix: `scopes.${scopeName}.agents.workspace`,
    });
    if (workspaceFinding !== undefined) {
      return workspaceFinding;
    }

    const scopedExecApprovalsFinding = execApprovalsPolicyShapeFinding(overlay.execApprovals, {
      policyDocName: params.policyDocName,
      policyPath: params.policyPath,
      targetPrefix: `${targetPrefix}/execApprovals`,
      propertyPrefix: `scopes.${scopeName}.execApprovals`,
      allowDefaults: false,
    });
    if (scopedExecApprovalsFinding !== undefined) {
      return scopedExecApprovalsFinding;
    }
    if (overlay.tools !== undefined && !isRecord(overlay.tools)) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/tools`,
        `${params.policyPath} scopes.${scopeName}.tools must be an object.`,
        `Fix ${params.policyPath} so the scoped tools policy overlay is an object.`,
      );
    }
    if (isRecord(overlay.tools)) {
      const toolsFinding = scopedToolsPolicyShapeFinding(overlay.tools, {
        policyDocName: params.policyDocName,
        policyPath: params.policyPath,
        targetPrefix: `${targetPrefix}/tools`,
        propertyPrefix: `scopes.${scopeName}.tools`,
      });
      if (toolsFinding !== undefined) {
        return toolsFinding;
      }
    }
    const sandboxFinding = sandboxPolicyShapeFinding(overlay.sandbox, {
      policyDocName: params.policyDocName,
      policyPath: params.policyPath,
      targetPrefix: `${targetPrefix}/sandbox`,
      propertyPrefix: `scopes.${scopeName}.sandbox`,
    });
    if (sandboxFinding !== undefined) {
      return sandboxFinding;
    }
    const ingressFindingLocal = ingressPolicyShapeFinding(overlay.ingress, {
      policyDocName: params.policyDocName,
      policyPath: params.policyPath,
      targetPrefix: `${targetPrefix}/ingress`,
      propertyPrefix: `scopes.${scopeName}.ingress`,
      allowSession: false,
    });
    if (ingressFindingLocal !== undefined) {
      return ingressFindingLocal;
    }
  }
  return duplicateScopedPolicyFieldFinding(value, {
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    policy: params.policy,
  });
}

function scopedSelectorShapeFinding(
  value: unknown,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly property: string;
    readonly target: string;
    readonly valueName: string;
    readonly normalize: (value: string) => string;
  },
): HealthFinding | undefined {
  const selectorFinding = policyStringArrayPropertyShapeFinding(value, {
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    property: params.property,
    target: params.target,
    valueName: params.valueName,
  });
  if (selectorFinding !== undefined) {
    return selectorFinding;
  }
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value) && value.length === 0) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.target}`,
      `${params.policyPath} ${params.property} must include at least one ${params.valueName}.`,
      `Add one or more ${params.valueName}s to ${params.policyPath} ${params.property}.`,
    );
  }
  if (Array.isArray(value)) {
    const seen = new Map<string, number>();
    for (const [index, rawValue] of value.entries()) {
      if (typeof rawValue !== "string") {
        continue;
      }
      const normalized = params.normalize(rawValue);
      const previous = seen.get(normalized);
      if (previous !== undefined) {
        return policyShapeFinding(
          params.policyPath,
          `oc://${params.policyDocName}/${params.target}/#${index}`,
          `${params.policyPath} ${params.property}[${index}] duplicates ${params.property}[${previous}] after normalization.`,
          `List each ${params.valueName} only once per named policy scope.`,
        );
      }
      seen.set(normalized, index);
    }
  }
  return undefined;
}

export function hasValidScopedPolicy(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): boolean {
  return (
    isRecord(policy) &&
    scopedPolicyShapeFinding(policy.scopes, { policyDocName, policyPath, policy }) === undefined
  );
}
