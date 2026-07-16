import { listQaScenariosForExecutionProfile, readQaScenarioPack } from "../../scenario-catalog.js";

type TelegramQaProfile = "all" | "release";

function resolveTelegramQaProfile(profile: string | undefined): TelegramQaProfile {
  const normalized = profile?.trim() || "release";
  if (normalized === "all" || normalized === "release") {
    return normalized;
  }
  throw new Error(
    `Unknown QA Lab Telegram profile "${normalized}". Expected one of: all, release.`,
  );
}

function listTelegramQaProfileScenarios(profile: string) {
  return listQaScenariosForExecutionProfile(`telegram:${profile}`);
}

export function resolveTelegramQaScenarioIds(params: {
  profile?: string;
  providerMode: string;
  scenarioIds?: readonly string[];
}): string[] {
  if (params.scenarioIds?.length) {
    const knownIds = new Set(readQaScenarioPack().scenarios.map((scenario) => scenario.id));
    const unknownIds = params.scenarioIds.filter((id) => !knownIds.has(id));
    if (unknownIds.length > 0) {
      throw new Error(`unknown Telegram QA scenario id(s): ${unknownIds.join(", ")}`);
    }
    return [...params.scenarioIds];
  }
  const profile = resolveTelegramQaProfile(params.profile);
  const executionProfile =
    profile === "release" && params.providerMode === "mock-openai" ? "mock-release" : profile;
  return listTelegramQaProfileScenarios(executionProfile).map((scenario) => scenario.id);
}

export function listTelegramQaScenarios(providerMode: string) {
  const defaultIds = new Set(resolveTelegramQaScenarioIds({ providerMode, profile: "release" }));
  return listTelegramQaProfileScenarios("all").map((scenario) => ({
    id: scenario.id,
    title: scenario.title,
    rationale: scenario.objective,
    regressionRefs: scenario.regressionRefs ?? [],
    defaultEnabled: defaultIds.has(scenario.id),
  }));
}
