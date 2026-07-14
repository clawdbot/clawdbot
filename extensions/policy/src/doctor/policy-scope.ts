import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { PolicyAgentWorkspaceEvidence, PolicyToolPostureEvidence } from "../policy-state.js";
import {
  SANDBOX_CONTAINER_POLICY_RULES,
  type PolicyRuleMetadata,
  type PolicyScopeSelectorKind,
} from "./metadata.js";
import { POLICY_RULES } from "./policy-constants.js";
import { normalizePolicyChannelId } from "./policy-runtime.js";
import { policyShapeFinding } from "./shape-helpers.js";
import { isPolicyValueAtLeastAsStrict } from "./strictness.js";
import { ocPathSegment } from "./utils.js";

export function scopedWorkspaceAgentMatches(
  entry: PolicyAgentWorkspaceEvidence,
  policyAgentId: string,
  entries: readonly PolicyAgentWorkspaceEvidence[],
): boolean {
  if (scopedAgentIdMatches(entry.agentId, policyAgentId)) {
    return true;
  }
  return entry.scope === "defaults" && !hasScopedAgentEvidence(entries, entry.kind, policyAgentId);
}

export function scopedToolAgentMatches(
  entry: PolicyToolPostureEvidence,
  policyAgentId: string,
  entries: readonly PolicyToolPostureEvidence[],
): boolean {
  if (scopedAgentIdMatches(entry.agentId, policyAgentId)) {
    return true;
  }
  return entry.scope === "global" && !hasScopedToolEvidence(entries, entry.kind, policyAgentId);
}

function hasScopedAgentEvidence(
  entries: readonly PolicyAgentWorkspaceEvidence[],
  kind: PolicyAgentWorkspaceEvidence["kind"],
  policyAgentId: string,
): boolean {
  return entries.some(
    (candidate) =>
      candidate.scope === "agent" &&
      candidate.kind === kind &&
      scopedAgentIdMatches(candidate.agentId, policyAgentId),
  );
}

function hasScopedToolEvidence(
  entries: readonly PolicyToolPostureEvidence[],
  kind: PolicyToolPostureEvidence["kind"],
  policyAgentId: string,
): boolean {
  return entries.some(
    (candidate) =>
      candidate.scope === "agent" &&
      candidate.kind === kind &&
      scopedAgentIdMatches(candidate.agentId, policyAgentId),
  );
}

export function scopedAgentIdMatches(
  evidenceAgentId: string | undefined,
  policyAgentId: string,
): boolean {
  return (
    evidenceAgentId !== undefined &&
    normalizeAgentId(evidenceAgentId) === normalizeAgentId(policyAgentId)
  );
}

export function policyHasExecApprovalsRules(policy: unknown): boolean {
  if (!isRecord(policy)) {
    return false;
  }
  if (execApprovalsPolicyHasRules(policy.execApprovals)) {
    return true;
  }
  return agentScopedPolicyOverlays(policy).some(([, overlay]) =>
    execApprovalsPolicyHasRules(overlay.execApprovals),
  );
}

function execApprovalsPolicyHasRules(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.requireFile !== undefined || isRecord(value.defaults) || isRecord(value.agents))
  );
}

export function policyHasSecretRules(policy: unknown): boolean {
  if (!isRecord(policy) || !isRecord(policy.secrets)) {
    return false;
  }
  return (
    policy.secrets.requireManagedProviders !== undefined ||
    policy.secrets.denySources !== undefined ||
    policy.secrets.allowInsecureProviders !== undefined
  );
}

export function policyHasAuthProfileRules(policy: unknown): boolean {
  return (
    isRecord(policy) &&
    isRecord(policy.auth) &&
    isRecord(policy.auth.profiles) &&
    (policy.auth.profiles.requireMetadata !== undefined ||
      policy.auth.profiles.allowModes !== undefined)
  );
}

export function policyHasIngressRules(policy: unknown): boolean {
  if (!isRecord(policy)) {
    return false;
  }
  if (ingressPolicyHasRules(policy.ingress)) {
    return true;
  }
  return agentScopedPolicyOverlays(policy).some(([, overlay]) =>
    ingressPolicyHasRules(overlay.ingress),
  );
}

function ingressPolicyHasRules(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const ingress = value;
  return (
    (isRecord(ingress.session) && ingress.session.requireDmScope !== undefined) ||
    (isRecord(ingress.channels) &&
      (ingress.channels.allowDmPolicies !== undefined ||
        ingress.channels.denyOpenGroups !== undefined ||
        ingress.channels.requireMentionInGroups !== undefined))
  );
}

export function policyHasGatewayRules(policy: unknown): boolean {
  if (!isRecord(policy) || !isRecord(policy.gateway)) {
    return false;
  }
  const gateway = policy.gateway;
  return (
    (isRecord(gateway.exposure) &&
      (gateway.exposure.allowNonLoopbackBind !== undefined ||
        gateway.exposure.allowTailscaleFunnel !== undefined)) ||
    (isRecord(gateway.auth) &&
      (gateway.auth.requireAuth !== undefined ||
        gateway.auth.requireExplicitRateLimit !== undefined)) ||
    (isRecord(gateway.controlUi) && gateway.controlUi.allowInsecure !== undefined) ||
    (isRecord(gateway.remote) && gateway.remote.allow !== undefined) ||
    (isRecord(gateway.http) &&
      (gateway.http.denyEndpoints !== undefined ||
        gateway.http.requireUrlAllowlists !== undefined)) ||
    (isRecord(gateway.nodes) && gateway.nodes.denyCommands !== undefined)
  );
}

export function policyHasAgentWorkspaceRules(policy: unknown): boolean {
  if (!isRecord(policy)) {
    return false;
  }
  if (isRecord(policy.agents) && workspacePolicyHasRules(policy.agents.workspace)) {
    return true;
  }
  return agentScopedPolicyOverlays(policy).some(([, overlay]) => {
    const scopedAgents = isRecord(overlay.agents) ? overlay.agents : {};
    return workspacePolicyHasRules(scopedAgents.workspace);
  });
}

export function policyHasSandboxPostureRules(policy: unknown): boolean {
  if (!isRecord(policy)) {
    return false;
  }
  if (sandboxPosturePolicyHasRules(policy.sandbox)) {
    return true;
  }
  return agentScopedPolicyOverlays(policy).some(([, overlay]) =>
    sandboxPosturePolicyHasRules(overlay.sandbox),
  );
}

function sandboxPosturePolicyHasRules(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const sandbox = value;
  const containers = isRecord(sandbox.containers) ? sandbox.containers : undefined;
  const browser = isRecord(sandbox.browser) ? sandbox.browser : undefined;
  return (
    sandbox.requireMode !== undefined ||
    sandbox.allowBackends !== undefined ||
    (containers !== undefined &&
      SANDBOX_CONTAINER_POLICY_RULES.some((rule) => containers[rule.key] !== undefined)) ||
    browser?.requireCdpSourceRange !== undefined
  );
}

export function policyHasDataHandlingRules(policy: unknown): boolean {
  if (!isRecord(policy)) {
    return false;
  }
  if (dataHandlingPolicyHasRules(policy.dataHandling)) {
    return true;
  }
  return agentScopedPolicyOverlays(policy).some(([, overlay]) =>
    dataHandlingPolicyHasRules(overlay.dataHandling),
  );
}

export function dataHandlingPolicyHasRules(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const dataHandling = value;
  return (
    (isRecord(dataHandling.sensitiveLogging) &&
      dataHandling.sensitiveLogging.requireRedaction !== undefined) ||
    (isRecord(dataHandling.telemetry) && dataHandling.telemetry.denyContentCapture !== undefined) ||
    (isRecord(dataHandling.retention) &&
      dataHandling.retention.requireSessionMaintenance !== undefined) ||
    (isRecord(dataHandling.memory) &&
      dataHandling.memory.denySessionTranscriptIndexing !== undefined)
  );
}

export function policyHasToolPostureRules(policy: unknown): boolean {
  if (!isRecord(policy)) {
    return false;
  }
  if (toolPosturePolicyHasRules(policy.tools)) {
    return true;
  }
  return agentScopedPolicyOverlays(policy).some(([, overlay]) =>
    toolPosturePolicyHasRules(overlay.tools),
  );
}

function workspacePolicyHasRules(value: unknown): boolean {
  return isRecord(value) && (value.allowedAccess !== undefined || value.denyTools !== undefined);
}

function toolPosturePolicyHasRules(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const tools = value;
  return (
    (isRecord(tools.profiles) && tools.profiles.allow !== undefined) ||
    (isRecord(tools.fs) && tools.fs.requireWorkspaceOnly !== undefined) ||
    (isRecord(tools.exec) &&
      (tools.exec.allowSecurity !== undefined ||
        tools.exec.requireAsk !== undefined ||
        tools.exec.allowHosts !== undefined)) ||
    (isRecord(tools.elevated) && tools.elevated.allow !== undefined) ||
    (isRecord(tools.alsoAllow) && tools.alsoAllow.expected !== undefined) ||
    tools.denyTools !== undefined
  );
}

type AgentScopedPolicyTarget = {
  readonly scopeName: string;
  readonly agentId: string;
  readonly overlay: Record<string, unknown>;
};

type ChannelScopedPolicyTarget = {
  readonly scopeName: string;
  readonly channelId: string;
  readonly overlay: Record<string, unknown>;
};

function agentScopedPolicyOverlays(
  policy: unknown,
): readonly (readonly [string, Record<string, unknown>])[] {
  if (!isRecord(policy) || !isRecord(policy.scopes)) {
    return [];
  }
  return Object.entries(policy.scopes).filter((entry): entry is [string, Record<string, unknown>] =>
    isRecord(entry[1]),
  );
}

export function agentScopedPolicyTargets(policy: unknown): readonly AgentScopedPolicyTarget[] {
  const targets: AgentScopedPolicyTarget[] = [];
  for (const [scopeName, overlay] of agentScopedPolicyOverlays(policy)) {
    if (!Array.isArray(overlay.agentIds)) {
      continue;
    }
    for (const rawAgentId of overlay.agentIds) {
      if (typeof rawAgentId !== "string" || rawAgentId.trim() === "") {
        continue;
      }
      targets.push({ scopeName, agentId: normalizeAgentId(rawAgentId), overlay });
    }
  }
  return targets;
}

export function channelScopedPolicyTargets(policy: unknown): readonly ChannelScopedPolicyTarget[] {
  const targets: ChannelScopedPolicyTarget[] = [];
  for (const [scopeName, overlay] of agentScopedPolicyOverlays(policy)) {
    if (!Array.isArray(overlay.channelIds)) {
      continue;
    }
    for (const rawChannelId of overlay.channelIds) {
      if (typeof rawChannelId !== "string" || rawChannelId.trim() === "") {
        continue;
      }
      targets.push({ scopeName, channelId: normalizePolicyChannelId(rawChannelId), overlay });
    }
  }
  return targets;
}

type ScopedPolicyField = {
  readonly fieldPath: string;
  readonly propertyPath: string;
  readonly targetPath: string;
  readonly metadata: PolicyRuleMetadata;
  readonly value: unknown;
};

export function duplicateScopedPolicyFieldFinding(
  scopes: Record<string, unknown>,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly policy: Record<string, unknown>;
  },
): HealthFinding | undefined {
  return (
    duplicateScopedFieldFinding(scopes, {
      ...params,
      selector: "agentIds",
      selectorLabel: "agent",
      normalize: normalizeAgentId,
    }) ??
    duplicateScopedFieldFinding(scopes, {
      ...params,
      selector: "channelIds",
      selectorLabel: "channel",
      normalize: normalizePolicyChannelId,
    })
  );
}

function duplicateScopedFieldFinding(
  scopes: Record<string, unknown>,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly policy: Record<string, unknown>;
    readonly selector: PolicyScopeSelectorKind;
    readonly selectorLabel: string;
    readonly normalize: (value: string) => string;
  },
): HealthFinding | undefined {
  const seen = new Map<
    string,
    {
      readonly scopeName: string;
      readonly propertyPath: string;
      readonly field: ScopedPolicyField;
    }
  >();
  for (const [scopeName, overlay] of Object.entries(scopes)) {
    if (!isRecord(overlay)) {
      continue;
    }
    const selectorValues = overlay[params.selector];
    if (!Array.isArray(selectorValues)) {
      continue;
    }
    const fields = scopedPolicyFields(scopeName, overlay, params.selector);
    for (const rawSelectorValue of selectorValues) {
      if (typeof rawSelectorValue !== "string" || rawSelectorValue.trim() === "") {
        continue;
      }
      const selectorValue = params.normalize(rawSelectorValue);
      for (const field of fields) {
        const topLevelValue = getPolicyPath(params.policy, field.metadata.policyPath);
        if (
          topLevelValue !== undefined &&
          !isPolicyValueAtLeastAsStrict(field.metadata, field.value, topLevelValue)
        ) {
          return policyShapeFinding(
            params.policyPath,
            `oc://${params.policyDocName}/${field.targetPath}`,
            `${params.policyPath} scopes.${scopeName}.${field.propertyPath} is weaker than the top-level ${field.propertyPath} policy.`,
            `Use an equally or more restrictive scoped value, or remove the scoped override.`,
          );
        }
        const key = `${selectorValue}\0${field.fieldPath}`;
        const previous = seen.get(key);
        if (previous !== undefined) {
          if (isPolicyValueAtLeastAsStrict(field.metadata, field.value, previous.field.value)) {
            seen.set(key, {
              scopeName,
              propertyPath: `scopes.${scopeName}.${field.propertyPath}`,
              field,
            });
            continue;
          }
          return policyShapeFinding(
            params.policyPath,
            `oc://${params.policyDocName}/${field.targetPath}`,
            `${params.policyPath} scopes.${scopeName}.${field.propertyPath} is not an equally or more restrictive override of ${previous.propertyPath} for ${params.selectorLabel} '${selectorValue}'.`,
            `Use one effective scoped value per ${params.selectorLabel}, or make later scoped values stricter according to policy metadata.`,
          );
        }
        seen.set(key, {
          scopeName,
          propertyPath: `scopes.${scopeName}.${field.propertyPath}`,
          field,
        });
      }
    }
  }
  return undefined;
}

function scopedPolicyFields(
  scopeName: string,
  overlay: Record<string, unknown>,
  selector: PolicyScopeSelectorKind,
): readonly ScopedPolicyField[] {
  const prefix = `scopes/${ocPathSegment(scopeName)}`;
  return POLICY_RULES.filter((rule) => rule.scopeSelectors?.includes(selector) === true)
    .map((rule) => ({ rule, value: scopedPolicyValue(overlay, rule.policyPath) }))
    .filter((entry) => entry.value !== undefined)
    .map(({ rule, value }) => ({
      fieldPath: rule.policyPath.join("."),
      propertyPath: rule.policyPath.join("."),
      targetPath: `${prefix}/${rule.policyPath.map(ocPathSegment).join("/")}`,
      metadata: rule,
      value,
    }));
}

function scopedPolicyValue(overlay: Record<string, unknown>, path: readonly string[]): unknown {
  const [root, ...remainingPath] = path;
  if (!root) {
    return undefined;
  }
  const scopedRoot = root === "agents" ? overlay.agents : overlay[root];
  return getPolicyPath(scopedRoot, remainingPath);
}

export function getPolicyPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}
