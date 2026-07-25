// Qa Lab plugin module plans the bounded CI smoke profile parts.
import { OPENCLAW_CRABLINE_DEFAULT_CHANNEL } from "@openclaw/crabline";
import { defaultQaModelForMode, normalizeQaProviderMode } from "./model-selection.js";
import { readQaScenarioPack } from "./scenario-catalog.js";
import { scenarioMatchesQaProviderLane } from "./scenario-lane.js";
import { readQaScorecardTaxonomyReport } from "./scorecard-taxonomy.js";

const QA_SMOKE_PROFILE = "smoke-ci";
// Four parts keep each smoke job near the fixed setup cost (~1min) instead of
// serializing ~4min of scenarios into one job that owns the PR wall clock.
const QA_SMOKE_CI_PARTS = ["profile-1", "profile-2", "profile-3", "profile-4"] as const;
const QA_SMOKE_CI_CHANNELS = ["matrix", OPENCLAW_CRABLINE_DEFAULT_CHANNEL] as const;
const QA_SMOKE_CI_SCENARIO_IDS = new Set([
  "control-ui-chat-flow-playwright",
  "system-agent-ring-zero-setup",
  "dreaming-shadow-trial-report",
  "gateway-smoke",
  "model-switch-follow-up",
  "group-visible-reply-tool",
  "long-running-release-audit",
  "matrix-restart-resume",
  "personal-task-followthrough-status",
  "plugin-lifecycle-hot-reload",
  "subagent-completion-direct-fallback",
  "telegram-commands-command",
]);

type QaSmokeCiPartId = (typeof QA_SMOKE_CI_PARTS)[number];

type QaSmokeCiRun = {
  channel: string;
  slug: string;
  scenario_ids: string[];
};

type QaSmokeCiPart = {
  id: QaSmokeCiPartId;
  runs: QaSmokeCiRun[];
};

function isQaSmokeCiPartId(value: string): value is QaSmokeCiPartId {
  return QA_SMOKE_CI_PARTS.includes(value as QaSmokeCiPartId);
}

function estimateScenarioCost(
  scenario: ReturnType<typeof readQaScenarioPack>["scenarios"][number],
) {
  if (scenario.execution.kind === "script") {
    return 8;
  }
  if (scenario.execution.kind === "playwright") {
    return 6;
  }
  return scenario.execution.kind === "flow" && scenario.execution.isolationReason ? 4 : 1;
}

export function createQaSmokeCiPart(partId: string): QaSmokeCiPart {
  if (!isQaSmokeCiPartId(partId)) {
    throw new Error(`unknown QA smoke CI profile part: ${partId}`);
  }

  const scenarioPack = readQaScenarioPack();
  const scorecardReport = readQaScorecardTaxonomyReport(scenarioPack.scenarios);
  const profile = scorecardReport.profiles.find((entry) => entry.id === QA_SMOKE_PROFILE);
  if (!profile) {
    throw new Error(`taxonomy.yaml does not define QA run profile ${QA_SMOKE_PROFILE}.`);
  }
  const providerMode = normalizeQaProviderMode("mock-openai");
  const primaryModel = defaultQaModelForMode(providerMode);
  const scenarios = scenarioPack.scenarios.filter(
    (scenario) =>
      QA_SMOKE_CI_SCENARIO_IDS.has(scenario.id) &&
      scenarioMatchesQaProviderLane({
        scenario,
        providerMode,
        primaryModel,
        channelDriver: profile.channelDriver,
        channel: scenario.execution.channel ?? OPENCLAW_CRABLINE_DEFAULT_CHANNEL,
      }),
  );
  if (scenarios.length === 0) {
    throw new Error(`${QA_SMOKE_PROFILE} did not resolve any executable QA scenarios.`);
  }

  const supportedChannels = new Set<string>(QA_SMOKE_CI_CHANNELS);
  const unsupportedChannels = new Set(
    scenarios
      .map((scenario) => scenario.execution.channel ?? OPENCLAW_CRABLINE_DEFAULT_CHANNEL)
      .filter((channel) => !supportedChannels.has(channel)),
  );
  if (unsupportedChannels.size > 0) {
    throw new Error(
      `${QA_SMOKE_PROFILE} resolved unsupported CI channels: ${[...unsupportedChannels].toSorted().join(", ")}.`,
    );
  }

  const matrixScenarios = scenarios.filter((scenario) => scenario.execution.channel === "matrix");
  const defaultChannelScenarios = scenarios
    .filter(
      (scenario) =>
        (scenario.execution.channel ?? OPENCLAW_CRABLINE_DEFAULT_CHANNEL) ===
        OPENCLAW_CRABLINE_DEFAULT_CHANNEL,
    )
    .toSorted(
      (left, right) =>
        estimateScenarioCost(right) - estimateScenarioCost(left) || left.id.localeCompare(right.id),
    );
  const partitions = QA_SMOKE_CI_PARTS.map(() => ({
    cost: 0,
    scenarios: [] as typeof scenarios,
  }));
  const firstPartition = partitions[0];
  if (!firstPartition) {
    throw new Error(`${QA_SMOKE_PROFILE} declares no CI profile parts.`);
  }
  for (const scenario of defaultChannelScenarios) {
    const partition = partitions.reduce(
      (lightest, candidate) => (candidate.cost < lightest.cost ? candidate : lightest),
      firstPartition,
    );
    partition.scenarios.push(scenario);
    partition.cost += estimateScenarioCost(scenario);
  }

  // The matrix channel run rides on the last part so the greedy cost balance
  // above stays undisturbed for the shared default-channel scenarios.
  const matrixPartIndex = QA_SMOKE_CI_PARTS.length - 1;
  const partIndex = QA_SMOKE_CI_PARTS.indexOf(partId);
  const selectedPartition = partitions[partIndex];
  if (!selectedPartition) {
    throw new Error(`unknown QA smoke CI profile part: ${partId}`);
  }
  const runs: QaSmokeCiRun[] = [
    {
      channel: OPENCLAW_CRABLINE_DEFAULT_CHANNEL,
      slug: "primary",
      scenario_ids: selectedPartition.scenarios.map((scenario) => scenario.id).toSorted(),
    },
  ];
  if (partIndex === matrixPartIndex) {
    runs.push({
      channel: "matrix",
      slug: "matrix",
      scenario_ids: matrixScenarios.map((scenario) => scenario.id).toSorted(),
    });
  }
  if (runs.some((run) => run.scenario_ids.length === 0)) {
    throw new Error(`${QA_SMOKE_PROFILE} CI profile part ${partId} did not resolve any scenarios.`);
  }

  return { id: partId, runs };
}
