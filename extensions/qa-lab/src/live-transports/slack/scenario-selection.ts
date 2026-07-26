// These are the live Slack runner defaults. The retired `slack:adapter` YAML
// membership was test-only and never drove this selector.
const SLACK_QA_DEFAULT_SCENARIO_IDS = [
  "slack-canary",
  "slack-mention-gating",
  "slack-allowlist-block",
  "slack-top-level-reply-shape",
  "slack-chart-presentation-native",
  "slack-table-presentation-native",
  "slack-reaction-glyph-native",
  "slack-approval-exec-native",
  "slack-approval-plugin-native",
  "slack-codex-approval-exec-native",
  "slack-codex-approval-plugin-native",
] as const;

export function resolveSlackQaScenarioIds({ scenarioIds }: { scenarioIds?: readonly string[] }) {
  return scenarioIds?.length ? [...scenarioIds] : [...SLACK_QA_DEFAULT_SCENARIO_IDS];
}
