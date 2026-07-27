// QA Lab plugin module resolves taxonomy profiles to executable catalog scenarios.
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  defaultQaModelForMode,
  normalizeQaProviderMode,
  type QaProviderModeInput,
} from "./model-selection.js";
import { readQaScenarioPack } from "./scenario-catalog.js";
import { describeQaProviderLaneMismatches } from "./scenario-lane.js";
import {
  readQaScorecardTaxonomyReport,
  type QaScorecardChannelDriver,
} from "./scorecard-taxonomy.js";

type QaScenario = ReturnType<typeof readQaScenarioPack>["scenarios"][number];

export function qaScenarioDeclaresChannel(scenario: QaScenario, channel: string) {
  const normalizedChannel = channel.trim().toLowerCase();
  if (scenario.execution.channel === normalizedChannel) {
    return true;
  }
  return (
    scenario.execution.kind === "flow" &&
    scenario.execution.channels?.includes(normalizedChannel) === true
  );
}

export function resolveQaProfileScenarios(params: {
  profile: string;
  providerMode: QaProviderModeInput;
  primaryModel?: string;
  channelDriver?: QaScorecardChannelDriver;
  channel?: string;
  eligibleChannels?: readonly string[];
  requireDeclaredChannel?: boolean;
  scenarioIds?: readonly string[];
}) {
  const scenarioPack = readQaScenarioPack();
  const report = readQaScorecardTaxonomyReport(scenarioPack.scenarios);
  const profileId = params.profile.trim();
  const profile = report.profiles.find((candidate) => candidate.id === profileId);
  if (!profile) {
    throw new Error(
      `QA taxonomy profile must be one of ${report.profiles.map((candidate) => candidate.id).join(", ")}, got "${params.profile}".`,
    );
  }

  const scenarioById = new Map(scenarioPack.scenarios.map((scenario) => [scenario.id, scenario]));
  const scenarioBySourcePath = new Map(
    scenarioPack.scenarios.map((scenario) => [scenario.sourcePath, scenario]),
  );
  const requestedScenarioIds = uniqueStrings(params.scenarioIds ?? []);
  const candidates =
    requestedScenarioIds.length > 0
      ? requestedScenarioIds.map((scenarioId) => {
          const scenario = scenarioById.get(scenarioId);
          if (!scenario) {
            throw new Error(`unknown QA scenario id: ${scenarioId}`);
          }
          return scenario;
        })
      : profile.scenarioRefs.flatMap((sourcePath) => {
          const scenario = scenarioBySourcePath.get(sourcePath);
          return scenario ? [scenario] : [];
        });

  const providerMode = normalizeQaProviderMode(params.providerMode);
  const primaryModel = params.primaryModel?.trim() || defaultQaModelForMode(providerMode);
  const channelDriver = params.channelDriver ?? profile.channelDriver;
  const channel = params.channel?.trim().toLowerCase();
  const eligibleChannels = new Set(
    params.eligibleChannels?.map((candidate) => candidate.trim().toLowerCase()),
  );
  const evaluatedCandidates = candidates.map((scenario) => {
    const reasons: string[] = [];
    if (params.requireDeclaredChannel && channel && !qaScenarioDeclaresChannel(scenario, channel)) {
      reasons.push(`does not declare channel ${channel}`);
    }
    if (eligibleChannels.size > 0) {
      const declaredChannels = scenario.execution.channel
        ? [scenario.execution.channel]
        : scenario.execution.kind === "flow"
          ? (scenario.execution.channels ?? [])
          : [];
      if (
        declaredChannels.length > 0 &&
        !declaredChannels.some((declaredChannel) => eligibleChannels.has(declaredChannel))
      ) {
        reasons.push(
          `declared channels ${declaredChannels.join(", ")} do not match eligible channels ${[...eligibleChannels].join(", ")}`,
        );
      }
    }
    reasons.push(
      ...describeQaProviderLaneMismatches({
        scenario,
        providerMode,
        primaryModel,
        channelDriver,
        channel: channel ?? scenario.execution.channel,
      }),
    );
    return { scenario, reasons };
  });
  const scenarios = evaluatedCandidates
    .filter(({ reasons }) => reasons.length === 0)
    .map(({ scenario }) => scenario);
  const excludedScenarios = evaluatedCandidates.filter(({ reasons }) => reasons.length > 0);

  if (requestedScenarioIds.length > 0 && excludedScenarios.length > 0) {
    const ineligible = excludedScenarios
      .map(({ scenario, reasons }) => `${scenario.id} (${reasons.join(", ")})`)
      .toSorted();
    throw new Error(
      `QA profile ${profileId} cannot run ineligible scenario(s) for the selected lane: ${ineligible.join("; ")}.`,
    );
  }
  if (scenarios.length === 0) {
    throw new Error(`QA taxonomy profile ${profileId} resolved no executable scenarios.`);
  }
  return { profile, scenarios, excludedScenarios };
}
