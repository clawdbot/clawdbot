const SLACK_QA_ALL_SCENARIO_IDS = [
  "slack-canary",
  "slack-mention-gating",
  "slack-allowlist-block",
  "slack-channel-disabled-warning",
  "slack-top-level-reply-shape",
  "slack-progress-commentary-true",
  "slack-progress-commentary-false",
  "slack-progress-commentary-omitted",
  "slack-progress-commentary-verbose-dedupe",
  "slack-chart-presentation-native",
  "slack-table-presentation-native",
  "slack-table-invalid-blocks-fallback",
  "slack-reaction-glyph-native",
  "slack-approval-exec-native",
  "slack-approval-plugin-native",
  "slack-codex-approval-exec-native",
  "slack-codex-approval-plugin-native",
] as const;

const SLACK_QA_EXPLICIT_SCENARIO_IDS = new Set<string>([
  "slack-channel-disabled-warning",
  "slack-progress-commentary-true",
  "slack-progress-commentary-false",
  "slack-progress-commentary-omitted",
  "slack-progress-commentary-verbose-dedupe",
  "slack-table-invalid-blocks-fallback",
]);

export const SLACK_QA_DEFAULT_SCENARIO_IDS = SLACK_QA_ALL_SCENARIO_IDS.filter(
  (scenarioId) => !SLACK_QA_EXPLICIT_SCENARIO_IDS.has(scenarioId),
);

export function resolveSlackQaScenarioIds(scenarioIds?: readonly string[]) {
  return scenarioIds?.length ? [...scenarioIds] : [...SLACK_QA_DEFAULT_SCENARIO_IDS];
}
