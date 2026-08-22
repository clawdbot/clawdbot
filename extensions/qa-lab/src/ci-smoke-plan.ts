// Qa Lab plugin module plans the bounded CI smoke pack parts.
import { defaultQaModelForMode, normalizeQaProviderMode } from "./model-selection.js";
import { resolveQaProfileScenarios } from "./profile-planning.js";
import { readQaScenarioPack } from "./scenario-catalog.js";
import { describeQaProviderLaneMismatches } from "./scenario-lane.js";
import { readQaScorecardTaxonomyReport } from "./scorecard-taxonomy.js";

const QA_SMOKE_PROFILE = "smoke-ci";
// Four parts keep each smoke job near the fixed setup cost (~1min) instead of
// serializing ~4min of scenarios into one job that owns the PR wall clock. The
// hosted fallback may use six parts because its 4-core runners execute the
// scenario phase more slowly.
const QA_SMOKE_CI_DEFAULT_PART_COUNT = 4;
const QA_SMOKE_CI_PART_COUNTS = new Set([QA_SMOKE_CI_DEFAULT_PART_COUNT, 6]);
const QA_SMOKE_CI_CHANNELS = ["telegram", "matrix"] as const;
// Hosted timings show the separate Matrix run adds about two minutes, so
// reserve three flow-cost points for its fixed part during primary packing.
const QA_SMOKE_CI_MATRIX_RUN_COST = 3;

type QaSmokeCiPartId = `profile-${number}`;
type QaSmokeCiScenario = ReturnType<typeof readQaScenarioPack>["scenarios"][number];

// CI consumes only the run slug and ids. `qa run` resolves the taxonomy-owned
// channel driver so this planner does not encode driver-specific channel policy.
type QaSmokeCiRun = {
  slug: string;
  scenario_ids: string[];
};

type QaSmokeCiPart = {
  id: QaSmokeCiPartId;
  runs: QaSmokeCiRun[];
};

function resolveQaSmokeCiPartIndex(partId: string, partCount: number): number {
  if (!QA_SMOKE_CI_PART_COUNTS.has(partCount)) {
    throw new Error(`unsupported QA smoke CI profile part count: ${partCount}`);
  }
  const match = /^profile-([1-9][0-9]*)$/u.exec(partId);
  const partIndex = Number(match?.[1]) - 1;
  if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex >= partCount) {
    throw new Error(`unknown QA smoke CI profile part: ${partId}`);
  }
  return partIndex;
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

export function selectQaSmokeCiEligibilityChannel(scenario: QaSmokeCiScenario): string | undefined {
  return QA_SMOKE_CI_CHANNELS.find(
    (channel) => scenario.execution.channels?.includes(channel) === true,
  );
}

export function createQaSmokeCiPart(
  partId: string,
  partCount = QA_SMOKE_CI_DEFAULT_PART_COUNT,
): QaSmokeCiPart {
  const partIndex = resolveQaSmokeCiPartIndex(partId, partCount);

  const scenarioPack = readQaScenarioPack();
  const scorecardReport = readQaScorecardTaxonomyReport(scenarioPack.scenarios);
  const profile = scorecardReport.profiles.find((entry) => entry.id === QA_SMOKE_PROFILE);
  if (!profile) {
    throw new Error(`taxonomy.yaml does not define QA run profile ${QA_SMOKE_PROFILE}.`);
  }

  let scenarios: QaSmokeCiScenario[];
  let excludedScenarios: ReturnType<typeof resolveQaProfileScenarios>["excludedScenarios"];
  try {
    const selection = resolveQaProfileScenarios({
      profile: QA_SMOKE_PROFILE,
      providerMode: "mock-openai",
      eligibleChannels: QA_SMOKE_CI_CHANNELS,
    });
    scenarios = selection.scenarios;
    excludedScenarios = selection.excludedScenarios;
  } catch (error) {
    throw new Error(`${QA_SMOKE_PROFILE} taxonomy profile did not resolve any CI scenarios.`, {
      cause: error,
    });
  }
  if (scenarios.length === 0) {
    throw new Error(`${QA_SMOKE_PROFILE} taxonomy profile did not resolve any CI scenarios.`);
  }

  const supportedChannels = new Set<string>(QA_SMOKE_CI_CHANNELS);
  const unsupportedChannels = new Set(
    scenarios.flatMap((scenario) => {
      const declaredChannels = scenario.execution.channels ?? [];
      return declaredChannels.length > 0 && !selectQaSmokeCiEligibilityChannel(scenario)
        ? declaredChannels.filter((channel) => !supportedChannels.has(channel))
        : [];
    }),
  );
  if (unsupportedChannels.size > 0) {
    throw new Error(
      `${QA_SMOKE_PROFILE} taxonomy profile resolved unsupported CI channels: ${[...unsupportedChannels].toSorted().join(", ")}.`,
    );
  }

  const providerMode = normalizeQaProviderMode("mock-openai");
  const primaryModel = defaultQaModelForMode(providerMode);
  const smokeScenarioRefs = new Set(profile.scenarioRefs);
  const ineligibleScenarios = scenarios.flatMap((scenario) => {
    const reasons = describeQaProviderLaneMismatches({
      scenario,
      providerMode,
      primaryModel,
      channelDriver: profile.channelDriver,
      channel: selectQaSmokeCiEligibilityChannel(scenario),
    });
    if (!smokeScenarioRefs.has(scenario.sourcePath)) {
      reasons.unshift(`not a primary owner selected by ${QA_SMOKE_PROFILE}`);
    }
    return reasons.length > 0 ? [`${scenario.id} (${reasons.join(", ")})`] : [];
  });
  if (ineligibleScenarios.length > 0) {
    throw new Error(
      `${QA_SMOKE_PROFILE} taxonomy profile resolved ineligible CI scenarios: ${ineligibleScenarios.toSorted().join("; ")}.`,
    );
  }

  const selectedCoverageIds = new Set(
    scenarios.flatMap((scenario) =>
      (scenario.coverage?.primary ?? []).filter((coverageId) =>
        profile.coverageIds.includes(coverageId),
      ),
    ),
  );
  const uncoveredCoverageIds = profile.coverageIds.filter(
    (coverageId) => !selectedCoverageIds.has(coverageId),
  );
  if (uncoveredCoverageIds.length > 0) {
    const excludedOwners = excludedScenarios
      .filter(({ scenario }) =>
        (scenario.coverage?.primary ?? []).some((coverageId) =>
          uncoveredCoverageIds.includes(coverageId),
        ),
      )
      .map(({ scenario, reasons }) => `${scenario.id} (${reasons.join(", ")})`)
      .toSorted();
    const exclusionDetails =
      excludedOwners.length > 0 ? ` Excluded owners: ${excludedOwners.join("; ")}.` : "";
    throw new Error(
      `${QA_SMOKE_PROFILE} taxonomy profile leaves coverage IDs without eligible CI scenarios: ${uncoveredCoverageIds.join(", ")}.${exclusionDetails}`,
    );
  }

  const matrixScenarios = scenarios.filter(
    (scenario) => selectQaSmokeCiEligibilityChannel(scenario) === "matrix",
  );
  const primaryScenarios = scenarios
    .filter((scenario) => selectQaSmokeCiEligibilityChannel(scenario) !== "matrix")
    .toSorted(
      (left, right) =>
        estimateScenarioCost(right) - estimateScenarioCost(left) || left.id.localeCompare(right.id),
    );
  const matrixPartIndex = partCount - 1;
  const partitions = Array.from({ length: partCount }, (_, index) => ({
    cost: index === matrixPartIndex ? QA_SMOKE_CI_MATRIX_RUN_COST : 0,
    scenarios: [] as typeof scenarios,
  }));
  const firstPartition = partitions[0];
  if (!firstPartition) {
    throw new Error(`${QA_SMOKE_PROFILE} declares no CI profile parts.`);
  }
  for (const scenario of primaryScenarios) {
    const partition = partitions.reduce(
      (lightest, candidate) => (candidate.cost < lightest.cost ? candidate : lightest),
      firstPartition,
    );
    partition.scenarios.push(scenario);
    partition.cost += estimateScenarioCost(scenario);
  }

  // The Matrix run stays on the last part, whose reserved cost above reduces
  // its primary share without mixing run-level channel drivers.
  const selectedPartition = partitions[partIndex];
  if (!selectedPartition) {
    throw new Error(`unknown QA smoke CI profile part: ${partId}`);
  }
  const runs: QaSmokeCiRun[] = [
    {
      slug: "primary",
      scenario_ids: selectedPartition.scenarios.map((scenario) => scenario.id).toSorted(),
    },
  ];
  if (partIndex === matrixPartIndex) {
    runs.push({
      slug: "matrix",
      scenario_ids: matrixScenarios.map((scenario) => scenario.id).toSorted(),
    });
  }
  if (runs.some((run) => run.scenario_ids.length === 0)) {
    throw new Error(`${QA_SMOKE_PROFILE} CI profile part ${partId} did not resolve any scenarios.`);
  }

  // Reconstruct from the validated index so the id carries the template type
  // without asserting on the caller-supplied string.
  return { id: `profile-${partIndex + 1}`, runs };
}
