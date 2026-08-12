/** Pure configured-model selection helpers safe for config validation. */
import { toAgentModelListLike } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig, resolveAgentEffectiveModelPrimary } from "./agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import type { ModelManifestNormalizationContext, ModelRef } from "./model-ref-shared.js";
import { normalizeModelSelection, resolveConfiguredModelRef } from "./model-selection-shared.js";

export function resolveDefaultModelForAgent(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelRef {
  const agentModelOverride = params.agentId
    ? resolveAgentEffectiveModelPrimary(params.cfg, params.agentId)
    : undefined;
  const cfg =
    agentModelOverride && agentModelOverride.length > 0
      ? {
          ...params.cfg,
          agents: {
            ...params.cfg.agents,
            defaults: {
              ...params.cfg.agents?.defaults,
              model: {
                ...toAgentModelListLike(params.cfg.agents?.defaults?.model),
                primary: agentModelOverride,
              },
            },
          },
        }
      : params.cfg;
  return resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
    allowPluginNormalization: params.allowPluginNormalization,
    manifestPlugins: params.manifestPlugins,
  });
}

export function resolveSubagentConfiguredModelSelection(params: {
  cfg: OpenClawConfig;
  agentId: string;
  includeAgentPrimary?: boolean;
  /**
   * Spawn runtime discriminator. When "acp", consult per-agent and default
   * `subagents.acpModel` ahead of `subagents.model` so a harness-correct vendor
   * ref (e.g. openai/* for Codex ACP) can be set independently. Undefined or
   * "subagent" preserves the prior chain.
   */
  runtime?: "acp" | "subagent";
}): string | undefined {
  const agentConfig = resolveAgentConfig(params.cfg, params.agentId);
  const acpPreferred = params.runtime === "acp";
  return (
    (acpPreferred ? normalizeModelSelection(agentConfig?.subagents?.acpModel) : undefined) ??
    (acpPreferred
      ? normalizeModelSelection(params.cfg.agents?.defaults?.subagents?.acpModel)
      : undefined) ??
    normalizeModelSelection(agentConfig?.subagents?.model) ??
    normalizeModelSelection(params.cfg.agents?.defaults?.subagents?.model) ??
    (params.includeAgentPrimary === false ? undefined : normalizeModelSelection(agentConfig?.model))
  );
}
