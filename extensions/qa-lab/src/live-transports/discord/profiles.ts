const DISCORD_QA_ALL_SCENARIO_IDS = [
  "discord-canary",
  "discord-mention-gating",
  "discord-native-help-command-registration",
  "discord-voice-autojoin",
  "discord-status-reactions-tool-only",
  "discord-thread-reply-filepath-attachment",
] as const;

export const DISCORD_QA_DEFAULT_SCENARIO_IDS = DISCORD_QA_ALL_SCENARIO_IDS.filter(
  (scenarioId) =>
    scenarioId !== "discord-voice-autojoin" &&
    scenarioId !== "discord-status-reactions-tool-only" &&
    scenarioId !== "discord-thread-reply-filepath-attachment",
);

export function resolveDiscordQaScenarioIds(scenarioIds?: readonly string[]) {
  return scenarioIds?.length ? [...scenarioIds] : [...DISCORD_QA_DEFAULT_SCENARIO_IDS];
}
