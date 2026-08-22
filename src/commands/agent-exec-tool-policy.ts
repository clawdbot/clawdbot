import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ToolAllowDenyPolicyConfig, ToolPolicyConfig } from "../config/types.tools.js";

type RequestedToolPolicy = Pick<ToolAllowDenyPolicyConfig, "allow" | "alsoAllow"> & {
  byProvider?: Record<string, Pick<ToolPolicyConfig, "allow" | "alsoAllow">>;
};

function appendRequestedTools(params: {
  policy: ToolAllowDenyPolicyConfig | undefined;
  requestedTools: string[];
  allowImplicitAlsoAllow: boolean;
}): RequestedToolPolicy | undefined {
  if (params.requestedTools.length === 0 || (!params.policy && !params.allowImplicitAlsoAllow)) {
    return undefined;
  }
  const allow = params.policy?.allow ?? [];
  if (allow.length > 0) {
    return { allow: [...new Set([...allow, ...params.requestedTools])] };
  }
  if (params.policy?.alsoAllow === undefined && !params.allowImplicitAlsoAllow) {
    return undefined;
  }
  return {
    alsoAllow: [...new Set([...(params.policy?.alsoAllow ?? []), ...params.requestedTools])],
  };
}

function appendRequestedToolsByProvider(params: {
  byProvider: Record<string, ToolPolicyConfig> | undefined;
  requestedTools: string[];
}): RequestedToolPolicy["byProvider"] {
  if (!params.byProvider || params.requestedTools.length === 0) {
    return undefined;
  }
  const result: NonNullable<RequestedToolPolicy["byProvider"]> = {};
  for (const [provider, policy] of Object.entries(params.byProvider)) {
    const requestedPolicy = appendRequestedTools({
      policy,
      requestedTools: params.requestedTools,
      allowImplicitAlsoAllow: true,
    });
    if (requestedPolicy) {
      result[provider] = requestedPolicy;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function resolveRequestedToolPolicy(params: {
  policy:
    | (ToolAllowDenyPolicyConfig & { byProvider?: Record<string, ToolPolicyConfig> })
    | undefined;
  requestedTools: string[];
  allowImplicitAlsoAllow: boolean;
}): RequestedToolPolicy | undefined {
  const direct = appendRequestedTools(params);
  const byProvider = appendRequestedToolsByProvider({
    byProvider: params.policy?.byProvider,
    requestedTools: params.requestedTools,
  });
  if (!direct && !byProvider) {
    return undefined;
  }
  return { ...direct, ...(byProvider ? { byProvider } : {}) };
}

export function resolveAgentExecRequestedToolPolicies(params: {
  base: OpenClawConfig;
  agentId?: string;
  requestedToolNames?: string[];
}): {
  requestedToolPolicy?: RequestedToolPolicy;
  selectedAgentRequestedToolPolicy?: RequestedToolPolicy;
} {
  const requestedTools = params.requestedToolNames?.map((value) => value.trim()) ?? [];
  if (requestedTools.some((value) => !value)) {
    throw new Error("--also-allow-tool requires a non-empty tool name.");
  }
  const selectedAgentTools = params.agentId
    ? params.base.agents?.entries?.[params.agentId]?.tools
    : undefined;
  return {
    requestedToolPolicy: resolveRequestedToolPolicy({
      policy: params.base.tools,
      requestedTools,
      allowImplicitAlsoAllow: true,
    }),
    selectedAgentRequestedToolPolicy: resolveRequestedToolPolicy({
      policy: selectedAgentTools,
      requestedTools,
      allowImplicitAlsoAllow: false,
    }),
  };
}
