import type { ClawdbotConfig } from "../config/config.js";
import { resolveAgentConfig, resolveAgentIdFromSessionKey } from "./agent-scope.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import type { SandboxToolPolicy } from "./sandbox.js";
import { expandToolGroups, normalizeToolName } from "./tool-policy.js";

const DEFAULT_SUBAGENT_TOOL_DENY = [
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
];

export function resolveSubagentToolPolicy(cfg?: ClawdbotConfig): SandboxToolPolicy {
  const configured = cfg?.tools?.subagents?.tools;
  const deny = [
    ...DEFAULT_SUBAGENT_TOOL_DENY,
    ...(Array.isArray(configured?.deny) ? configured.deny : []),
  ];
  const allow = Array.isArray(configured?.allow) ? configured.allow : undefined;
  return { allow, deny };
}

export function isToolAllowedByPolicyName(name: string, policy?: SandboxToolPolicy): boolean {
  if (!policy) return true;
  const deny = new Set(expandToolGroups(policy.deny));
  const allowRaw = expandToolGroups(policy.allow);
  const allow = allowRaw.length > 0 ? new Set(allowRaw) : null;
  const normalized = normalizeToolName(name);
  if (deny.has(normalized)) return false;
  if (allow) {
    if (allow.has(normalized)) return true;
    if (normalized === "apply_patch" && allow.has("exec")) return true;
    return false;
  }
  return true;
}

export function filterToolsByPolicy(tools: AnyAgentTool[], policy?: SandboxToolPolicy) {
  if (!policy) return tools;
  return tools.filter((tool) => isToolAllowedByPolicyName(tool.name, policy));
}

type ToolPolicyConfig = {
  allow?: string[];
  deny?: string[];
  profile?: string;
};

function pickToolPolicy(config?: ToolPolicyConfig): SandboxToolPolicy | undefined {
  if (!config) return undefined;
  const allow = Array.isArray(config.allow) ? config.allow : undefined;
  const deny = Array.isArray(config.deny) ? config.deny : undefined;
  if (!allow && !deny) return undefined;
  return { allow, deny };
}

function normalizeProviderKey(value: string): string {
  return value.trim().toLowerCase();
}

function resolveProviderToolPolicy(params: {
  byProvider?: Record<string, ToolPolicyConfig>;
  modelProvider?: string;
  modelId?: string;
}): ToolPolicyConfig | undefined {
  const provider = params.modelProvider?.trim();
  if (!provider || !params.byProvider) return undefined;

  const entries = Object.entries(params.byProvider);
  if (entries.length === 0) return undefined;

  const lookup = new Map<string, ToolPolicyConfig>();
  for (const [key, value] of entries) {
    const normalized = normalizeProviderKey(key);
    if (!normalized) continue;
    lookup.set(normalized, value);
  }

  const normalizedProvider = normalizeProviderKey(provider);
  const rawModelId = params.modelId?.trim().toLowerCase();
  const fullModelId =
    rawModelId && !rawModelId.includes("/") ? `${normalizedProvider}/${rawModelId}` : rawModelId;

  const candidates = [...(fullModelId ? [fullModelId] : []), normalizedProvider];

  for (const key of candidates) {
    const match = lookup.get(key);
    if (match) return match;
  }
  return undefined;
}

export function resolveEffectiveToolPolicy(params: {
  config?: ClawdbotConfig;
  sessionKey?: string;
  modelProvider?: string;
  modelId?: string;
}) {
  const agentId = params.sessionKey ? resolveAgentIdFromSessionKey(params.sessionKey) : undefined;
  const agentConfig =
    params.config && agentId ? resolveAgentConfig(params.config, agentId) : undefined;
  const agentTools = agentConfig?.tools;
  const globalTools = params.config?.tools;

  const profile = agentTools?.profile ?? globalTools?.profile;
  const providerPolicy = resolveProviderToolPolicy({
    byProvider: globalTools?.byProvider,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  const agentProviderPolicy = resolveProviderToolPolicy({
    byProvider: agentTools?.byProvider,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  return {
    agentId,
    globalPolicy: pickToolPolicy(globalTools),
    globalProviderPolicy: pickToolPolicy(providerPolicy),
    agentPolicy: pickToolPolicy(agentTools),
    agentProviderPolicy: pickToolPolicy(agentProviderPolicy),
    profile,
    providerProfile: agentProviderPolicy?.profile ?? providerPolicy?.profile,
  };
}

export function isToolAllowedByPolicies(
  name: string,
  policies: Array<SandboxToolPolicy | undefined>,
) {
  return policies.every((policy) => isToolAllowedByPolicyName(name, policy));
}
