/** Fast-test model-selection state factory, split out to keep model-selection.ts under budget. */
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { ModelFallbackRouteResolution } from "../../agents/model-fallback.types.js";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ThinkLevel } from "../thinking.shared.js";

type ModelCatalog = ModelCatalogEntry[];

export type ThinkingDefaultSelection = {
  provider: string;
  model: string;
  agentRuntime?: string | null;
};

export type ModelSelectionState = {
  provider: string;
  model: string;
  requestedRouteResolution: ModelFallbackRouteResolution;
  allowedModelKeys: Set<string>;
  allowedModelCatalog: ModelCatalog;
  policyAliasIndex: ModelAliasIndex;
  resetModelOverride: boolean;
  resetModelOverrideRef?: string;
  resetModelOverrideReason?: "disallowed" | "stale" | "temporarily-unavailable";
  modelPolicyConfigPath?: string;
  modelPolicyRepairConfigPath?: string;
  resolveThinkingCatalog: () => Promise<ModelCatalog | undefined>;
  resolveDefaultThinkingLevel: (selection?: ThinkingDefaultSelection) => Promise<ThinkLevel>;
  hasConfiguredThinkingDefault?: boolean;
  /** Default reasoning level from model capability: "on" if model has reasoning, else "off". */
  resolveDefaultReasoningLevel: () => Promise<"on" | "off">;
  needsModelCatalog: boolean;
  modelContextWindow?: number;
  modelContextTokens?: number;
};

/** Creates minimal model-selection state for fast test mode. */
export function createFastTestModelSelectionState(params: {
  agentCfg: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> | undefined;
  provider: string;
  model: string;
}): ModelSelectionState {
  return {
    provider: params.provider,
    model: params.model,
    requestedRouteResolution: "resolved",
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
