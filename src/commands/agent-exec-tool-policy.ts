import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ToolAllowDenyPolicyConfig } from "../config/types.tools.js";

type RequestedToolPolicy = Pick<ToolAllowDenyPolicyConfig, "allow" | "alsoAllow">;

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
    requestedToolPolicy: appendRequestedTools({
      policy: params.base.tools,
      requestedTools,
      allowImplicitAlsoAllow: true,
    }),
    selectedAgentRequestedToolPolicy: appendRequestedTools({
      policy: selectedAgentTools,
      requestedTools,
      allowImplicitAlsoAllow: false,
    }),
  };
}
