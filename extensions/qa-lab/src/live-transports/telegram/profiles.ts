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

export const TELEGRAM_QA_ALL_SCENARIO_IDS = [
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
  const knownIds = new Set<string>(TELEGRAM_QA_ALL_SCENARIO_IDS);
  if (params.scenarioIds && params.scenarioIds.length > 0) {
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
  const allIds = new Set<string>(TELEGRAM_QA_ALL_SCENARIO_IDS);
  return readQaScenarioPack()
    .scenarios.filter((scenario) => allIds.has(scenario.id))
    .map((scenario) => ({
      id: scenario.id,
      title: scenario.title,
      rationale: scenario.objective,
      regressionRefs: scenario.regressionRefs ?? [],
      defaultEnabled: defaultIds.has(scenario.id),
    }));
}
