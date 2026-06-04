// Default model and alias resolution for directive handling.
import {
  buildModelAliasIndex,
  type ModelAliasIndex,
  resolveDefaultModelForAgent,
} from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** Resolve default provider/model plus alias index for directive parsing. */
export function resolveDefaultModel(params: { cfg: OpenClawConfig; agentId?: string }): {
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
} {
  const mainModel = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    // Default-model lookup is on every reply; plugin runtime normalization can
    // cold-load plugins, so keep this to static/configured model aliases here.
    allowPluginNormalization: false,
  });
  const defaultProvider = mainModel.provider;
  const defaultModel = mainModel.model;
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider,
    allowPluginNormalization: false,
  });
  return { defaultProvider, defaultModel, aliasIndex };
}
