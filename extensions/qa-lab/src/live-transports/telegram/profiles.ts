import type { QaProviderModeInput } from "../../model-selection.js";
import { readQaScenarioPack } from "../../scenario-catalog.js";
import { resolveLiveTransportQaScenarioIds } from "../shared/scenario-selection.js";

export function resolveTelegramQaScenarioIds(params: {
  profile?: string;
  providerMode: QaProviderModeInput;
  scenarioIds?: readonly string[];
}): string[] {
  return resolveLiveTransportQaScenarioIds({ channelId: "telegram", ...params });
}

export function listTelegramQaScenarios(providerMode: QaProviderModeInput) {
  const defaultIds = new Set(resolveTelegramQaScenarioIds({ providerMode, profile: "release" }));
  const allIds = resolveTelegramQaScenarioIds({ providerMode, profile: "all" });
  const scenarioById = new Map(
    readQaScenarioPack().scenarios.map((scenario) => [scenario.id, scenario] as const),
  );
  return allIds.map((id) => {
    const scenario = scenarioById.get(id);
    if (!scenario) {
      throw new Error(`Telegram QA taxonomy profile references unknown scenario: ${id}`);
    }
    return {
      id: scenario.id,
      title: scenario.title,
      rationale: scenario.objective,
      regressionRefs: scenario.regressionRefs ?? [],
      defaultEnabled: defaultIds.has(scenario.id),
    };
  });
}
