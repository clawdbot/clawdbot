// Qa Lab plugin module owns canonical taxonomy profile membership planning.
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { QaCliBackendAuthMode } from "./gateway-child.js";
import {
  defaultQaModelForMode,
  normalizeQaProviderMode,
  type QaProviderMode,
  type QaProviderModeInput,
} from "./model-selection.js";
import { readQaScenarioPack, type QaSeedScenarioWithSource } from "./scenario-catalog.js";
import { describeQaProviderLaneMismatches, resolveQaScenarioLaneChannel } from "./scenario-lane.js";
import {
  readQaScorecardTaxonomyReport,
  type QaScorecardCategoryCoverageReport,
  type QaScorecardTaxonomyReport,
  type QaScorecardChannelDriver,
} from "./scorecard-taxonomy.js";

type QaRunProfileMembership = {
  categories: QaScorecardCategoryCoverageReport[];
  excludedScenarioIds: string[];
  profile: QaScorecardTaxonomyReport["profiles"][number];
  profileScenarios: QaSeedScenarioWithSource[];
  selectedScenarios: QaSeedScenarioWithSource[];
};

type QaRunProfileExecutionSelection = {
  excludedScenarios: Array<{ scenario: QaSeedScenarioWithSource; reasons: string[] }>;
  selectedScenarios: QaSeedScenarioWithSource[];
};

function categoryMatchesRunProfile(
  category: QaScorecardCategoryCoverageReport,
  opts: { profile: string; surface?: string; category?: string },
): boolean {
  if (!category.profiles.includes(opts.profile)) {
    return false;
  }
  if (opts.surface?.trim()) {
    const surface = opts.surface.trim();
    if (category.taxonomySurfaceId !== surface && !category.id.startsWith(`${surface}.`)) {
      return false;
    }
  }
  return !opts.category?.trim() || category.id === opts.category.trim();
}

export function resolveQaRunProfileMembership(
  opts: {
    profile: string;
    surface?: string;
    category?: string;
    scenarioIds?: readonly string[];
  },
  source?: {
    scenarios?: QaSeedScenarioWithSource[];
    scorecardReport?: QaScorecardTaxonomyReport;
  },
): QaRunProfileMembership {
  const scenarios = source?.scenarios ?? readQaScenarioPack().scenarios;
  const scorecardReport = source?.scorecardReport ?? readQaScorecardTaxonomyReport(scenarios);
  const profileId = opts.profile.trim();
  const profile = scorecardReport.profiles.find((entry) => entry.id === profileId);
  if (!profile) {
    const profileIds = scorecardReport.profiles.map((entry) => entry.id);
    if (profileIds.length === 0) {
      throw new Error("taxonomy.yaml does not define QA run profiles.");
    }
    throw new Error(
      `QA run profile must be one of ${profileIds.join(", ")}, got "${opts.profile}".`,
    );
  }
  const categories = scorecardReport.categories.filter((category) =>
    categoryMatchesRunProfile(category, {
      profile: profileId,
      surface: opts.surface,
      category: opts.category,
    }),
  );
  const scenarioBySourcePath = new Map(
    scenarios.map((scenario) => [scenario.sourcePath, scenario] as const),
  );
  const categoryScenarioRefs = new Set(categories.flatMap((category) => category.scenarioRefs));
  const profileScenarios = profile.scenarioRefs
    .filter((scenarioRef) => categoryScenarioRefs.has(scenarioRef))
    .map((scenarioRef) => scenarioBySourcePath.get(scenarioRef))
    .filter((scenario): scenario is QaSeedScenarioWithSource => scenario !== undefined);
  const requestedScenarioIds = uniqueStrings(
    (opts.scenarioIds ?? []).map((scenarioId) => scenarioId.trim()).filter(Boolean),
  );
  if (requestedScenarioIds.length === 0) {
    return {
      categories,
      excludedScenarioIds: [],
      profile,
      profileScenarios,
      selectedScenarios: profileScenarios,
    };
  }
  const requestedScenarioIdSet = new Set(requestedScenarioIds);
  const selectedScenarios = profileScenarios.filter((scenario) =>
    requestedScenarioIdSet.has(scenario.id),
  );
  const selectedScenarioIdSet = new Set(selectedScenarios.map((scenario) => scenario.id));
  return {
    categories,
    excludedScenarioIds: requestedScenarioIds.filter(
      (scenarioId) => !selectedScenarioIdSet.has(scenarioId),
    ),
    profile,
    profileScenarios,
    selectedScenarios,
  };
}

export function resolveQaRunProfileExecutionSelection(params: {
  scenarios: readonly QaSeedScenarioWithSource[];
  providerMode: QaProviderMode;
  primaryModel: string;
  channelDriver: QaScorecardChannelDriver;
  channel?: string | null;
  defaultChannel?: string;
  claudeCliAuthMode?: QaCliBackendAuthMode;
  supportsChannel?: (channel: string) => boolean;
}): QaRunProfileExecutionSelection {
  const selectedScenarios: QaSeedScenarioWithSource[] = [];
  const excludedScenarios: QaRunProfileExecutionSelection["excludedScenarios"] = [];
  for (const scenario of params.scenarios) {
    const reasons: string[] = [];
    // qa-channel is the built-in harness channel, so another driver cannot implement it.
    if (scenario.execution.channel === "qa-channel" && params.channelDriver !== "qa-channel") {
      reasons.push("channelDriver=qa-channel");
    }
    const effectiveChannel = resolveQaScenarioLaneChannel({
      scenario,
      channelDriver: params.channelDriver,
      channel: params.channel,
      defaultChannel: params.defaultChannel,
      supportsChannel: params.supportsChannel,
    });
    reasons.push(
      ...describeQaProviderLaneMismatches({
        scenario,
        providerMode: params.providerMode,
        primaryModel: params.primaryModel,
        channelDriver: params.channelDriver,
        channel: effectiveChannel,
        claudeCliAuthMode: params.claudeCliAuthMode,
      }),
    );
    if (
      reasons.length === 0 &&
      scenario.execution.kind === "flow" &&
      params.channelDriver !== "qa-channel" &&
      effectiveChannel &&
      params.supportsChannel &&
      !params.supportsChannel(effectiveChannel)
    ) {
      reasons.push(`unsupported ${params.channelDriver} channel=${effectiveChannel}`);
    }
    if (reasons.length > 0) {
      excludedScenarios.push({ scenario, reasons: uniqueStrings(reasons) });
    } else {
      selectedScenarios.push(scenario);
    }
  }
  return { excludedScenarios, selectedScenarios };
}

export function scenarioDeclaresQaChannel(scenario: QaSeedScenarioWithSource, channel: string) {
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
  const membership = resolveQaRunProfileMembership({
    profile: params.profile,
    scenarioIds: params.scenarioIds,
  });
  if (membership.excludedScenarioIds.length > 0) {
    throw new Error(`unknown QA scenario id(s): ${membership.excludedScenarioIds.join(", ")}`);
  }

  const providerMode = normalizeQaProviderMode(params.providerMode);
  const primaryModel = params.primaryModel?.trim() || defaultQaModelForMode(providerMode);
  const channelDriver = params.channelDriver ?? membership.profile.channelDriver;
  const channel = params.channel?.trim().toLowerCase();
  const eligibleChannels = new Set(
    params.eligibleChannels?.map((candidate) => candidate.trim().toLowerCase()),
  );
  const evaluatedCandidates = membership.selectedScenarios.map((scenario) => {
    const reasons: string[] = [];
    if (params.requireDeclaredChannel && channel && !scenarioDeclaresQaChannel(scenario, channel)) {
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
      ...resolveQaRunProfileExecutionSelection({
        scenarios: [scenario],
        providerMode,
        primaryModel,
        channelDriver,
        channel: channel ?? scenario.execution.channel,
      }).excludedScenarios.flatMap((entry) => entry.reasons),
    );
    return { scenario, reasons: uniqueStrings(reasons) };
  });
  const scenarios = evaluatedCandidates
    .filter(({ reasons }) => reasons.length === 0)
    .map(({ scenario }) => scenario);
  const excludedScenarios = evaluatedCandidates.filter(({ reasons }) => reasons.length > 0);

  if (params.scenarioIds?.length && excludedScenarios.length > 0) {
    const ineligible = excludedScenarios
      .map(({ scenario, reasons }) => `${scenario.id} (${reasons.join(", ")})`)
      .toSorted();
    throw new Error(
      `QA profile ${membership.profile.id} cannot run ineligible scenario(s) for the selected lane: ${ineligible.join("; ")}.`,
    );
  }
  if (scenarios.length === 0) {
    throw new Error(
      `QA taxonomy profile ${membership.profile.id} resolved no executable scenarios.`,
    );
  }
  return { profile: membership.profile, scenarios, excludedScenarios };
}
