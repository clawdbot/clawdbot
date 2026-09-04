import type { FastMode } from "../../api/types.ts";

export type ModelBehaviorConfig = {
  thinkingLevel: string | undefined;
  thinkingOverridden: boolean;
  fastMode: FastMode | undefined;
  fastModeOverridden: boolean;
};

export function readModelBehaviorConfig(
  agentsDefaults: Record<string, unknown> | null,
): ModelBehaviorConfig {
  const thinkingValue = agentsDefaults?.thinkingDefault;
  const fastValue = agentsDefaults?.fastModeDefault;
  return {
    thinkingLevel: typeof thinkingValue === "string" ? thinkingValue : undefined,
    thinkingOverridden: agentsDefaults !== null && Object.hasOwn(agentsDefaults, "thinkingDefault"),
    fastMode: fastValue === "auto" || typeof fastValue === "boolean" ? fastValue : undefined,
    fastModeOverridden: agentsDefaults !== null && Object.hasOwn(agentsDefaults, "fastModeDefault"),
  };
}
