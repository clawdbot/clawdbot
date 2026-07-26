import { readQaScenarioPack } from "../../scenario-catalog.js";

const TELEGRAM_QA_RELEASE_SCENARIO_IDS = [
  "channel-canary",
  "channel-mention-gating",
  "telegram-help-command",
  "telegram-commands-command",
  "telegram-tools-compact-command",
  "telegram-whoami-command",
  "telegram-status-command",
  "telegram-repeated-command-authorization",
  "telegram-context-command",
  "telegram-other-bot-command-gating",
] as const;

const TELEGRAM_QA_MOCK_RELEASE_SCENARIO_IDS = [
  ...TELEGRAM_QA_RELEASE_SCENARIO_IDS,
  "telegram-long-final-reuses-preview",
] as const;

const TELEGRAM_QA_ALL_SCENARIO_IDS = [
  ...TELEGRAM_QA_RELEASE_SCENARIO_IDS,
  "telegram-current-session-status-tool",
  "telegram-tool-only-usage-footer",
  "telegram-reply-chain-exact-marker",
  "telegram-stream-final-single-message",
  "telegram-long-final-reuses-preview",
  "telegram-long-final-three-chunks",
] as const;

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
  if (profile === "all") {
    return [...TELEGRAM_QA_ALL_SCENARIO_IDS];
  }
  return params.providerMode === "mock-openai"
    ? [...TELEGRAM_QA_MOCK_RELEASE_SCENARIO_IDS]
    : [...TELEGRAM_QA_RELEASE_SCENARIO_IDS];
}

export function listTelegramQaScenarios(providerMode: string) {
  const defaultIds = new Set(resolveTelegramQaScenarioIds({ providerMode, profile: "release" }));
  const scenarioById = new Map(
    readQaScenarioPack().scenarios.map((scenario) => [scenario.id, scenario] as const),
  );
  return TELEGRAM_QA_ALL_SCENARIO_IDS.map((id) => {
    const scenario = scenarioById.get(id);
    if (!scenario) {
      throw new Error(`Telegram QA profile references unknown scenario: ${id}`);
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
