import { isRecord as hasRecord } from "@openclaw/normalization-core/record-coerce";
import { listAgentEntries, resolveAgentConfig } from "../../../agents/agent-scope-config.js";
import { resolveProviderToolPolicy } from "../../../agents/provider-tool-policy.js";
import { pickSandboxToolPolicy } from "../../../agents/sandbox-tool-policy.js";
import { isToolAllowedByPolicies } from "../../../agents/tool-policy-match.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "../../../agents/tool-policy.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { AgentToolsConfig, ToolsConfig } from "../../../config/types.tools.js";
import { resolveDoctorPrimaryModelRef } from "./primary-model-ref.js";

export function resolveMessageToolAvailability(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  globalTools?: ToolsConfig;
  agentTools?: AgentToolsConfig;
  runtimeAlsoAllow?: string[];
}): boolean {
  const agentConfig = params.agentId ? resolveAgentConfig(params.cfg, params.agentId) : undefined;
  const modelRef = resolveDoctorPrimaryModelRef(params.cfg, agentConfig?.model);
  const providerPolicy = resolveProviderToolPolicy({
    byProvider: params.globalTools?.byProvider,
    modelProvider: modelRef.provider,
    modelId: modelRef.model,
  });
  const agentProviderPolicy = resolveProviderToolPolicy({
    byProvider: params.agentTools?.byProvider,
    modelProvider: modelRef.provider,
    modelId: modelRef.model,
  });
  const profile = params.agentTools?.profile ?? params.globalTools?.profile;
  const configuredAlsoAllow = Array.isArray(params.agentTools?.alsoAllow)
    ? params.agentTools.alsoAllow
    : Array.isArray(params.globalTools?.alsoAllow)
      ? params.globalTools.alsoAllow
      : [];
  const providerAlsoAllow = Array.isArray(agentProviderPolicy?.alsoAllow)
    ? agentProviderPolicy.alsoAllow
    : Array.isArray(providerPolicy?.alsoAllow)
      ? providerPolicy.alsoAllow
      : [];
  const profileAlsoAllow = [...configuredAlsoAllow, ...(params.runtimeAlsoAllow ?? [])];
  const providerProfileAlsoAllow = [...providerAlsoAllow, ...(params.runtimeAlsoAllow ?? [])];
  const profilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(profile), profileAlsoAllow);
  const providerProfilePolicy = mergeAlsoAllowPolicy(
    resolveToolProfilePolicy(agentProviderPolicy?.profile ?? providerPolicy?.profile),
    providerProfileAlsoAllow,
  );
  return isToolAllowedByPolicies("message", [
    profilePolicy,
    providerProfilePolicy,
    pickSandboxToolPolicy(providerPolicy),
    pickSandboxToolPolicy(agentProviderPolicy),
    pickSandboxToolPolicy(params.globalTools),
    pickSandboxToolPolicy(params.agentTools),
  ]);
}

export const SOURCE_REPLY_RUNTIME_MESSAGE_ALLOW = ["message"];

export function collectUnavailableSourceReplyTargets(cfg: OpenClawConfig): string[] {
  const agents = listAgentEntries(cfg).filter(hasRecord);
  if (agents.length === 0) {
    const available = resolveMessageToolAvailability({
      cfg,
      globalTools: cfg.tools,
      runtimeAlsoAllow: SOURCE_REPLY_RUNTIME_MESSAGE_ALLOW,
    });
    return available ? [] : ["default tool policy"];
  }
  return agents.flatMap((agent) => {
    const agentId = typeof agent.id === "string" ? agent.id : "unknown";
    const available = resolveMessageToolAvailability({
      cfg,
      agentId,
      globalTools: cfg.tools,
      agentTools: agent.tools,
      runtimeAlsoAllow: SOURCE_REPLY_RUNTIME_MESSAGE_ALLOW,
    });
    return available ? [] : [`agent "${agentId}"`];
  });
}
