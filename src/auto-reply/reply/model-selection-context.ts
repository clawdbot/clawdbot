import { resolveContextTokensForModel } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** Resolves the context window token count for the selected provider/model. */
export function resolveContextTokens(params: {
  cfg: OpenClawConfig;
  agentCfg: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> | undefined;
  provider: string;
  model: string;
  modelContextWindow?: number;
  modelContextTokens?: number;
}): number {
  const modelContextTokens = resolveContextTokensForModel({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    modelContextWindow: params.modelContextWindow,
    modelContextTokens: params.modelContextTokens,
    allowAsyncLoad: false,
  });
  const agentContextTokens =
    typeof params.agentCfg?.contextTokens === "number" && params.agentCfg.contextTokens > 0
      ? Math.floor(params.agentCfg.contextTokens)
      : undefined;

  if (agentContextTokens !== undefined) {
    return modelContextTokens !== undefined
      ? Math.min(agentContextTokens, modelContextTokens)
      : agentContextTokens;
  }

  return modelContextTokens ?? DEFAULT_CONTEXT_TOKENS;
}
