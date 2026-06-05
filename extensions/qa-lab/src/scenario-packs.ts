// Qa Lab plugin module implements scenario packs behavior.
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";

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
  "personal-approval-denial-stop",
  "personal-task-followthrough-status",
  "personal-share-safe-diagnostics-artifact",
  "personal-no-fake-progress",
  "personal-failure-recovery",
] as const;

export const QA_OBSERVABILITY_SCENARIO_IDS = [
  "otel-trace-smoke",
  "docker-prometheus-smoke",
] as const;

export const QA_SCENARIO_PACKS = [
  {
    id: "personal-agent",
    title: "Personal Agent Benchmark Pack",
    description:
      "Local-only personal assistant workflow scenarios for reminders, channel replies, memory recall, redaction, safe tool followthrough, approval denial, task status honesty, share-safe diagnostics, proof-backed completion claims, and failure recovery.",
    scenarioIds: QA_PERSONAL_AGENT_SCENARIO_IDS,
  },
  {
    id: "observability",
    title: "Observability Smoke Pack",
    description:
      "Source-checkout diagnostics smoke scenarios for OpenTelemetry signal export and protected Prometheus scraping.",
    scenarioIds: QA_OBSERVABILITY_SCENARIO_IDS,
  },
] as const satisfies readonly QaScenarioPackDefinition[];

export function resolveQaScenarioPackScenarioIds(params: {
  pack?: string;
  scenarioIds?: string[];
}): string[] {
  const normalizedPack = params.pack?.trim().toLowerCase();
  const explicitScenarioIds = uniqueStrings(params.scenarioIds ?? []);
  if (!normalizedPack) {
    return explicitScenarioIds;
  }
  const pack = QA_SCENARIO_PACKS.find((candidate) => candidate.id === normalizedPack);
  if (!pack) {
    throw new Error(
      `--pack must be one of ${QA_SCENARIO_PACKS.map((candidate) => candidate.id).join(", ")}, got "${params.pack}"`,
    );
  }
  return uniqueStrings([...explicitScenarioIds, ...pack.scenarioIds]);
}
