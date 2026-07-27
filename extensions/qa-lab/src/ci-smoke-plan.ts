// Qa Lab plugin module plans bounded CI smoke shards after taxonomy selection.
import { defaultQaModelForMode, normalizeQaProviderMode } from "./model-selection.js";
import { readQaScenarioPack } from "./scenario-catalog.js";
import { scenarioMatchesQaProviderLane } from "./scenario-lane.js";
import {
  readQaScorecardTaxonomyReport,
  selectQaScorecardProfileScenarios,
} from "./scorecard-taxonomy.js";

const QA_SMOKE_PROFILE = "smoke-ci";
// Four shards keep each smoke job near the fixed setup cost (~1min) instead of
// serializing ~4min of scenarios into one job that owns the PR wall clock.
const QA_SMOKE_CI_SHARDS = ["shard-1", "shard-2", "shard-3", "shard-4"] as const;
const QA_SMOKE_CI_CHANNELS = ["telegram", "matrix"] as const;

type QaSmokeCiShardId = (typeof QA_SMOKE_CI_SHARDS)[number];
type QaSmokeCiScenario = ReturnType<typeof readQaScenarioPack>["scenarios"][number];

// CI consumes only the run slug and ids. `qa run` resolves the taxonomy-owned
// channel driver so this planner does not encode driver-specific channel policy.
type QaSmokeCiRun = {
  slug: string;
  scenario_ids: string[];
};

type QaSmokeCiShard = {
  id: QaSmokeCiShardId;
  runs: QaSmokeCiRun[];
};

function isQaSmokeCiShardId(value: string): value is QaSmokeCiShardId {
  return QA_SMOKE_CI_SHARDS.includes(value as QaSmokeCiShardId);
}

function estimateScenarioCost(scenario: QaSmokeCiScenario) {
  if (scenario.execution.kind === "script") {
    return 8;
  }
  if (scenario.execution.kind === "playwright") {
    return 6;
  }
  return scenario.execution.kind === "flow" && scenario.execution.isolationReason ? 4 : 1;
}

function listQaSmokeCiDeclaredChannels(scenario: QaSmokeCiScenario): readonly string[] {
  if (scenario.execution.channel) {
    return [scenario.execution.channel];
  }
  return scenario.execution.kind === "flow" ? (scenario.execution.channels ?? []) : [];
}

export function selectQaSmokeCiEligibilityChannel(scenario: QaSmokeCiScenario): string | undefined {
  const declaredChannels = listQaSmokeCiDeclaredChannels(scenario);
  return QA_SMOKE_CI_CHANNELS.find((channel) => declaredChannels.includes(channel));
}

export function selectQaSmokeCiScenarios(): QaSmokeCiScenario[] {
  const scenarioPack = readQaScenarioPack();
  const scorecardReport = readQaScorecardTaxonomyReport(scenarioPack.scenarios);
  const profile = scorecardReport.profiles.find((entry) => entry.id === QA_SMOKE_PROFILE);
  if (!profile) {
    throw new Error(`taxonomy.yaml does not define QA run profile ${QA_SMOKE_PROFILE}.`);
  }

  const providerMode = normalizeQaProviderMode("mock-openai");
  const primaryModel = defaultQaModelForMode(providerMode);
  const smokeCategories = scorecardReport.categories.filter((category) =>
    category.profiles.includes(QA_SMOKE_PROFILE),
  );
  const smokeScenarioRefs = new Set(smokeCategories.flatMap((category) => category.scenarioRefs));
  const eligibleScenarios = scenarioPack.scenarios.filter((scenario) => {
    const declaredChannels = listQaSmokeCiDeclaredChannels(scenario);
    if (declaredChannels.length > 0 && !selectQaSmokeCiEligibilityChannel(scenario)) {
      return false;
    }
    return (
      smokeScenarioRefs.has(scenario.sourcePath) &&
      scenarioMatchesQaProviderLane({
        scenario,
        providerMode,
        primaryModel,
        channelDriver: profile.channelDriver,
        channel: selectQaSmokeCiEligibilityChannel(scenario),
      })
    );
  });
  const scenarios = selectQaScorecardProfileScenarios({
    coverageIds: profile.coverageIds,
    profileId: QA_SMOKE_PROFILE,
    scenarios: eligibleScenarios,
  });
  if (scenarios.length !== profile.coverageIds.length) {
    throw new Error(
      `${QA_SMOKE_PROFILE} profile must resolve one CI scenario per coverage anchor; got ${scenarios.length} scenarios for ${profile.coverageIds.length} anchors.`,
    );
  }
  return scenarios;
}

export function createQaSmokeCiShard(shardId: string): QaSmokeCiShard {
  if (!isQaSmokeCiShardId(shardId)) {
    throw new Error(`unknown QA smoke CI shard: ${shardId}`);
  }
  const scenarios = selectQaSmokeCiScenarios();

  const matrixScenarios = scenarios.filter(
    (scenario) => selectQaSmokeCiEligibilityChannel(scenario) === "matrix",
  );
  const primaryScenarios = scenarios
    .filter((scenario) => selectQaSmokeCiEligibilityChannel(scenario) !== "matrix")
    .toSorted(
      (left, right) =>
        estimateScenarioCost(right) - estimateScenarioCost(left) || left.id.localeCompare(right.id),
    );
  const partitions = QA_SMOKE_CI_SHARDS.map(() => ({
    cost: 0,
    scenarios: [] as typeof scenarios,
  }));
  const firstPartition = partitions[0];
  if (!firstPartition) {
    throw new Error(`${QA_SMOKE_PROFILE} declares no CI shards.`);
  }
  for (const scenario of primaryScenarios) {
    const partition = partitions.reduce(
      (lightest, candidate) => (candidate.cost < lightest.cost ? candidate : lightest),
      firstPartition,
    );
    partition.scenarios.push(scenario);
    partition.cost += estimateScenarioCost(scenario);
  }

  // The Matrix run rides on the last shard so the greedy cost balance above
  // stays undisturbed for scenarios that use the run-level channel driver.
  const matrixShardIndex = QA_SMOKE_CI_SHARDS.length - 1;
  const shardIndex = QA_SMOKE_CI_SHARDS.indexOf(shardId);
  const selectedPartition = partitions[shardIndex];
  if (!selectedPartition) {
    throw new Error(`unknown QA smoke CI shard: ${shardId}`);
  }
  const runs: QaSmokeCiRun[] = [
    {
      slug: "primary",
      scenario_ids: selectedPartition.scenarios.map((scenario) => scenario.id).toSorted(),
    },
  ];
  if (shardIndex === matrixShardIndex) {
    runs.push({
      slug: "matrix",
      scenario_ids: matrixScenarios.map((scenario) => scenario.id).toSorted(),
    });
  }
  if (runs.some((run) => run.scenario_ids.length === 0)) {
    throw new Error(`${QA_SMOKE_PROFILE} CI shard ${shardId} did not resolve any scenarios.`);
  }

  return { id: shardId, runs };
}
