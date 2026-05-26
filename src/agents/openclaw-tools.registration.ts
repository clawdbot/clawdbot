import type { OpenClawConfig } from "../config/types.openclaw.js";
import { uniqueStrings } from "../shared/string-normalization.js";
import { isStrictAgenticExecutionContractActive } from "./execution-contract.js";
import { isToolAllowedByPolicyName } from "./tool-policy-match.js";
import type { AnyAgentTool } from "./tools/common.js";

export function collectPresentOpenClawTools(
  candidates: readonly (AnyAgentTool | null | undefined)[],
): AnyAgentTool[] {
  return candidates.filter((tool): tool is AnyAgentTool => tool !== null && tool !== undefined);
}

export function isUpdatePlanToolEnabledForOpenClawTools(params: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
  agentId?: string | null;
  modelProvider?: string;
  modelId?: string;
}): boolean {
  const configured = params.config?.tools?.experimental?.planTool;
  if (configured !== undefined) {
    return configured;
  }
  return isStrictAgenticExecutionContractActive({
    config: params.config,
    sessionKey: params.agentSessionKey,
    agentId: params.agentId,
    provider: params.modelProvider,
    modelId: params.modelId,
  });
}

function mergeOpenClawToolPolicyList(...lists: Array<string[] | undefined>): string[] | undefined {
  const merged = lists.flatMap((list) => (Array.isArray(list) ? list : []));
  return merged.length > 0 ? uniqueStrings(merged) : undefined;
}

function isToolExplicitlyAllowedByOpenClawToolPolicy(params: {
  toolName: string;
  allowlist?: string[];
  denylist?: string[];
}): boolean {
  if (!params.allowlist?.some((entry) => typeof entry === "string" && entry.trim().length > 0)) {
    return false;
  }
  return isToolAllowedByPolicyName(params.toolName, {
    allow: params.allowlist,
    deny: params.denylist,
  });
}

export function shouldIncludeUpdatePlanToolForOpenClawTools(params: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
  agentId?: string | null;
  modelProvider?: string;
  modelId?: string;
  pluginToolAllowlist?: string[];
  pluginToolDenylist?: string[];
}): boolean {
  const allowlist = mergeOpenClawToolPolicyList(
    params.config?.tools?.allow,
    params.config?.tools?.alsoAllow,
    params.pluginToolAllowlist,
  );
  const denylist = mergeOpenClawToolPolicyList(
    params.config?.tools?.deny,
    params.pluginToolDenylist,
  );
  return (
    isToolExplicitlyAllowedByOpenClawToolPolicy({
      toolName: "update_plan",
      allowlist,
      denylist,
    }) ||
    isUpdatePlanToolEnabledForOpenClawTools({
      config: params.config,
      agentSessionKey: params.agentSessionKey,
      agentId: params.agentId,
      modelProvider: params.modelProvider,
      modelId: params.modelId,
    })
  );
}
