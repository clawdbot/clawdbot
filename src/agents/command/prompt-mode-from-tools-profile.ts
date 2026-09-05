import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveEffectiveToolPolicy } from "../agent-tools.policy.js";
import type { PromptMode } from "../system-prompt.types.js";

function resolvePromptModeFromToolsProfile(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  modelProvider?: string;
  modelId?: string;
}): "minimal" | undefined {
  const policy = resolveEffectiveToolPolicy({
    config: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  const profile = policy.providerProfile ?? policy.profile;
  return profile === "minimal" ? "minimal" : undefined;
}

export function resolveCandidatePromptMode(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  modelProvider?: string;
  modelId?: string;
  promptMode?: PromptMode;
  promptModeFromToolsProfile?: boolean;
}): PromptMode | undefined {
  if (params.promptMode) {
    return params.promptMode;
  }
  if (!params.promptModeFromToolsProfile) {
    return undefined;
  }
  return resolvePromptModeFromToolsProfile(params);
}
