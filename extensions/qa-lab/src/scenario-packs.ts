export type QaScenarioPackDefinition = {
  id: string;
  title: string;
  description: string;
  scenarioIds: readonly string[];
};

export const QA_PERSONAL_AGENT_SCENARIO_IDS = [
  "personal-reminder-roundtrip",
  "personal-channel-thread-reply",
  "personal-memory-preference-recall",
  "personal-redaction-no-secret-leak",
  "personal-tool-safety-followthrough",
] as const;

export const QA_SCENARIO_PACKS = [
  {
    id: "personal-agent",
    title: "Personal Agent Benchmark Pack",
    description:
      "Local-only personal assistant workflow scenarios for reminders, channel replies, memory recall, redaction, and safe tool followthrough.",
    scenarioIds: QA_PERSONAL_AGENT_SCENARIO_IDS,
  },
] as const satisfies readonly QaScenarioPackDefinition[];

export function resolveQaScenarioPackScenarioIds(params: {
  pack?: string;
  scenarioIds?: string[];
}): string[] {
  const normalizedPack = params.pack?.trim().toLowerCase();
  const explicitScenarioIds = [...new Set(params.scenarioIds ?? [])];
  if (!normalizedPack) {
    return explicitScenarioIds;
  }
  const pack = QA_SCENARIO_PACKS.find((candidate) => candidate.id === normalizedPack);
  if (!pack) {
    throw new Error(
      `--pack must be one of ${QA_SCENARIO_PACKS.map((candidate) => candidate.id).join(", ")}, got "${params.pack}"`,
    );
  }
  return [...new Set([...explicitScenarioIds, ...pack.scenarioIds])];
}
