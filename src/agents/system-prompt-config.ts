import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildTtsSystemPromptHint } from "../tts/tts.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { buildModelAliasLines } from "./model-alias-lines.js";
import { resolveOwnerDisplaySetting } from "./owner-display.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

type AgentSystemPromptRenderParams = Parameters<typeof buildAgentSystemPrompt>[0];

export type ResolvedAgentSystemPromptConfig = Pick<
  AgentSystemPromptRenderParams,
  | "ownerDisplay"
  | "ownerDisplaySecret"
  | "subagentDelegationMode"
  | "ttsHint"
  | "modelAliasLines"
  | "memoryCitationsMode"
>;

export type ConfiguredAgentSystemPromptParams = AgentSystemPromptRenderParams & {
  config?: OpenClawConfig;
  agentId?: string;
};

export function resolveAgentSystemPromptConfig(params: {
  config?: OpenClawConfig;
  agentId?: string;
}): ResolvedAgentSystemPromptConfig {
  const { config, agentId } = params;
  const ownerDisplay = resolveOwnerDisplaySetting(config);
  const agentSubagents =
    config && agentId ? resolveAgentConfig(config, agentId)?.subagents : undefined;
  return {
    ownerDisplay: ownerDisplay.ownerDisplay,
    ownerDisplaySecret: ownerDisplay.ownerDisplaySecret,
    subagentDelegationMode:
      agentSubagents?.delegationMode ??
      config?.agents?.defaults?.subagents?.delegationMode ??
      "suggest",
    ttsHint: config ? buildTtsSystemPromptHint(config, agentId) : undefined,
    modelAliasLines: buildModelAliasLines(config),
    memoryCitationsMode: config?.memory?.citations,
  };
}

export function buildConfiguredAgentSystemPrompt(params: ConfiguredAgentSystemPromptParams) {
  const { config, agentId, ...renderParams } = params;
  const configParams = config ? resolveAgentSystemPromptConfig({ config, agentId }) : {};
  return buildAgentSystemPrompt({
    ...renderParams,
    ...configParams,
  });
}
