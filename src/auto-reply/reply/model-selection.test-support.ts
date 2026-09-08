import { createModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ThinkLevel } from "../thinking.shared.js";
import type { createModelSelectionState } from "./model-selection.js";

/** Supplies selected-model facts to tests outside the model-selection owner. */
export function createModelSelectionStateFixture(params: {
  agentCfg: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> | undefined;
  provider: string;
  model: string;
}): Awaited<ReturnType<typeof createModelSelectionState>> {
  return {
    provider: params.provider,
    model: params.model,
    requestedRouteResolution: "resolved",
    modelPolicy: createModelVisibilityPolicy({
      cfg: { agents: { defaults: params.agentCfg } },
      catalog: [],
      defaultProvider: params.provider,
      defaultModel: params.model,
    }),
    allowedModelKeys: new Set<string>(),
    allowedModelCatalog: [],
    policyAliasIndex: { byAlias: new Map(), byKey: new Map() },
    resetModelOverride: false,
    resetModelOverrideRef: undefined,
    resetModelOverrideReason: undefined,
    modelPolicyConfigPath: undefined,
    modelPolicyRepairConfigPath: undefined,
    resolveThinkingCatalog: async () => [],
    resolveDefaultThinkingLevel: async () => params.agentCfg?.thinkingDefault as ThinkLevel,
    hasConfiguredThinkingDefault: params.agentCfg?.thinkingDefault !== undefined,
    resolveDefaultReasoningLevel: async () => "off",
    needsModelCatalog: false,
    modelContextWindow: undefined,
    modelContextTokens: undefined,
  };
}
