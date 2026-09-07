import { resolveDefaultModelForAgent } from "../../agents/model-selection-config.js";
import { buildModelAliasIndex, resolveModelRefFromString } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveSkillWorkshopConfig } from "./config.js";

const log = createSubsystemLogger("skills/workshop");

export type SkillWorkshopReviewModel = {
  provider: string;
  model: string;
  /** True when `skills.workshop.model` selected this ref instead of the fallback. */
  configured: boolean;
};

/**
 * Resolves the model for a background Workshop review. `skills.workshop.model`
 * wins when it resolves; otherwise the fallback (normally the reviewed run's
 * model) or the agent's default model is used.
 */
export function resolveSkillWorkshopReviewModel(params: {
  config: OpenClawConfig;
  agentId: string;
  fallback?: { provider: string; model: string };
}): SkillWorkshopReviewModel {
  const fallback = () => {
    const ref =
      params.fallback ??
      resolveDefaultModelForAgent({ cfg: params.config, agentId: params.agentId });
    return { provider: ref.provider, model: ref.model, configured: false };
  };
  const raw = resolveSkillWorkshopConfig(params.config).model;
  if (!raw) {
    return fallback();
  }
  const defaultProvider = resolveDefaultModelForAgent({
    cfg: params.config,
    agentId: params.agentId,
    allowPluginNormalization: false,
  }).provider;
  const resolved = resolveModelRefFromString({
    cfg: params.config,
    agentId: params.agentId,
    raw,
    defaultProvider,
    aliasIndex: buildModelAliasIndex({
      cfg: params.config,
      defaultProvider,
      agentId: params.agentId,
      allowPluginNormalization: false,
    }),
    allowPluginNormalization: false,
  });
  if (!resolved) {
    log.warn(
      `skills.workshop.model "${raw}" did not resolve to a provider/model; using the default review model`,
    );
    return fallback();
  }
  return { provider: resolved.ref.provider, model: resolved.ref.model, configured: true };
}
