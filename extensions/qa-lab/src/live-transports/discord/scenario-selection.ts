const DISCORD_QA_DEFAULT_SCENARIO_IDS = [
  "discord-canary",
  "discord-mention-gating",
  "discord-native-help-command-registration",
] as const;

export function resolveDiscordQaScenarioIds({ scenarioIds }: { scenarioIds?: readonly string[] }) {
  return scenarioIds?.length ? [...scenarioIds] : [...DISCORD_QA_DEFAULT_SCENARIO_IDS];
}
