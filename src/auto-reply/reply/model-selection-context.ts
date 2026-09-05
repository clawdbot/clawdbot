import { resolveContextTokensForModel } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** Resolves the context window token count for the selected provider/model. */
export function resolveContextTokens(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  modelContextWindow?: number;
  modelContextTokens?: number;
}): number {
  return (
    resolveContextTokensForModel({
      cfg: params.cfg,
      provider: params.provider,
      model: params.model,
      modelContextWindow: params.modelContextWindow,
      modelContextTokens: params.modelContextTokens,
      allowAsyncLoad: false,
    }) ?? DEFAULT_CONTEXT_TOKENS
  );
}
