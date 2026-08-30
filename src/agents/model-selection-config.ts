/** Pure configured-model selection helpers safe for config validation. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope-config.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import type { ModelRef } from "./model-ref-shared.js";
import {
  normalizeModelSelection,
  resolveConfiguredModelProvider,
  resolveConfiguredModelRef,
  type ModelSelectionNormalizationContext,
} from "./model-selection-shared.js";

export function resolveDefaultModelForAgent(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelSelectionNormalizationContext,
): ModelRef {
  return resolveConfiguredModelRef({
    ...params,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
}

/** Resolve the agent's default provider while preserving runtime alias selection. */
export function resolveDefaultModelProviderForAgent(
  params: Parameters<typeof resolveDefaultModelForAgent>[0],
): string {
  return resolveConfiguredModelProvider({
    ...params,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
}

export function resolveSubagentConfiguredModelSelection(params: {
  cfg: OpenClawConfig;
  agentId: string;
  includeAgentPrimary?: boolean;
}): string | undefined {
  const agentConfig = resolveAgentConfig(params.cfg, params.agentId);
  return (
    normalizeModelSelection(agentConfig?.subagents?.model) ??
    normalizeModelSelection(params.cfg.agents?.defaults?.subagents?.model) ??
    (params.includeAgentPrimary === false ? undefined : normalizeModelSelection(agentConfig?.model))
  );
}
