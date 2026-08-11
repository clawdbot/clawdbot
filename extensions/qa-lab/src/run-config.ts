// Qa Lab helper module supports run config behavior.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  QaLabExecutionKind,
  QaLabResolvedRunPlan,
  QaLabRunnerSnapshot,
  QaLabRunSelection,
} from "../runner-contract.js";
import { defaultQaModelForMode as defaultStaticQaModelForMode } from "./model-selection.js";
import {
  defaultQaRuntimeModelForMode,
  resolveQaRuntimeModelPair,
} from "./model-selection.runtime.js";
import {
  resolveQaRunProfileExecutionSelection,
  resolveQaRunProfileMembership,
} from "./profile-planning.js";
import {
  DEFAULT_QA_LIVE_PROVIDER_MODE,
  getQaProvider,
  isQaProviderModeInput,
  normalizeQaProviderMode as normalizeQaProviderModeInput,
  type QaProviderMode,
} from "./providers/index.js";
import {
  resolveQaRuntimePairLaneScenarioIds,
  resolveQaRuntimePairScenarioSupport,
} from "./runtime-pair-lane-selection.js";
import {
  qaRuntimePairLaneSchema,
  type QaSeedScenario,
  type QaSeedScenarioWithSource,
} from "./scenario-catalog.js";
import {
  qaScorecardChannelDriverSchema,
  qaScorecardEvidenceModeSchema,
  type QaScorecardTaxonomyReport,
} from "./scorecard-taxonomy.js";
import { resolveQaSuiteScenarioChannels } from "./suite-planning.js";

export type { QaProviderMode } from "./model-selection.js";
export type { QaProviderModeInput } from "./providers/index.js";

type QaLabRunProfileOption = QaScorecardTaxonomyReport["profiles"][number];

export function defaultQaModelForMode(mode: QaProviderMode, alternate = false) {
  return defaultQaRuntimeModelForMode(mode, alternate ? { alternate: true } : undefined);
}

type QaDefaultModelResolver = (mode: QaProviderMode, alternate?: boolean) => string;

function defaultStaticModelForMode(mode: QaProviderMode, alternate = false) {
  return defaultStaticQaModelForMode(mode, alternate ? { alternate: true } : undefined);
}

function requireQaRunProfile(profiles: readonly QaLabRunProfileOption[], profileId: string) {
  const profile = profiles.find((entry) => entry.id === profileId);
  if (!profile) {
    throw new Error(`QA runner profile table does not define required profile: ${profileId}`);
  }
  return profile;
}

function createDefaultQaRunSelection(
  profiles: readonly QaLabRunProfileOption[],
  options?: { resolveDefaultModel?: QaDefaultModelResolver },
): QaLabRunSelection {
  const profile = requireQaRunProfile(profiles, "smoke-ci");
  const providerMode: QaProviderMode = "mock-openai";
  const resolveDefaultModel = options?.resolveDefaultModel ?? defaultQaModelForMode;
  return {
    profile: profile.id,
    channel: null,
    channelDriver: profile.channelDriver,
    evidenceMode: profile.evidenceMode,
    providerMode,
    ...resolveQaRuntimeModelPair({ providerMode, resolveDefaultModel }),
    fastMode: getQaProvider(providerMode).kind === "live",
    runtimePair: null,
    runtimePairLane: null,
    scenarioIds: null,
  };
}

export function normalizeQaProviderMode(input: unknown): QaProviderMode {
  if (input === undefined || input === null || input === "") {
    return DEFAULT_QA_LIVE_PROVIDER_MODE;
  }
  if (isQaProviderModeInput(input)) {
    return normalizeQaProviderModeInput(input);
  }
  const details = typeof input === "string" ? `: ${input}` : "";
  throw new Error(`unknown QA provider mode${details}`);
}

function normalizeScenarioIds(input: unknown, scenarios: QaSeedScenario[]): string[] | null {
  if (input === undefined || input === null) {
    return null;
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("QA runner scenarioIds must be a non-empty array");
  }
  const requestedIds = input.map((value) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("QA runner scenarioIds must contain non-empty strings");
    }
    return value.trim();
  });
  const selectedIds = uniqueStrings(requestedIds);
  const availableIds = new Set(scenarios.map((scenario) => scenario.id));
  const unknownIds = selectedIds.filter((id) => !availableIds.has(id));
  if (unknownIds.length > 0) {
    throw new Error(`unknown QA scenario id(s): ${unknownIds.join(", ")}`);
  }
  return selectedIds;
}

function normalizeQaChannelDriver(
  input: unknown,
  fallback: QaLabRunSelection["channelDriver"],
): QaLabRunSelection["channelDriver"] {
  if (input === undefined || input === null || input === "") {
    return fallback;
  }
  const parsed = qaScorecardChannelDriverSchema.safeParse(input);
  if (!parsed.success) {
    const details = typeof input === "string" ? `: ${input}` : "";
    throw new Error(`unknown QA channel driver${details}`);
  }
  return parsed.data;
}

function normalizeQaProfile(
  input: unknown,
  profiles: readonly QaLabRunProfileOption[],
  fallbackProfile?: string,
) {
  const fallback = fallbackProfile ?? requireQaRunProfile(profiles, "smoke-ci").id;
  // Match the other optional runner controls: null means no override, while any
  // concrete profile value must be a non-empty string or the request fails closed.
  if (input !== undefined && input !== null && (typeof input !== "string" || !input.trim())) {
    throw new Error("QA runner profile must be a non-empty string");
  }
  const profile = typeof input === "string" ? input.trim() : fallback;
  if (!profiles.some((entry) => entry.id === profile)) {
    throw new Error(
      `unknown QA run profile: ${profile}; expected one of ${profiles.map((entry) => entry.id).join(", ")}`,
    );
  }
  return profile;
}

function normalizeQaChannel(input: unknown): string | null {
  if (input === undefined || input === null || input === "") {
    return null;
  }
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("QA runner channel must be a non-empty string");
  }
  return input.trim().toLowerCase();
}

function normalizeQaEvidenceMode(
  input: unknown,
  fallback: QaLabRunSelection["evidenceMode"],
): QaLabRunSelection["evidenceMode"] {
  if (input === undefined || input === null || input === "") {
    return fallback;
  }
  const parsed = qaScorecardEvidenceModeSchema.safeParse(input);
  if (!parsed.success) {
    const details = typeof input === "string" ? `: ${input}` : "";
    throw new Error(`unknown QA evidence mode${details}`);
  }
  return parsed.data;
}

function normalizeQaRuntimePair(input: unknown): QaLabRunSelection["runtimePair"] {
  if (input === undefined || input === null) {
    return null;
  }
  if (
    !Array.isArray(input) ||
    input.length !== 2 ||
    !input.every((runtime) => runtime === "openclaw" || runtime === "codex")
  ) {
    throw new Error('QA runner runtimePair must be ["openclaw", "codex"]');
  }
  if (input[0] === input[1]) {
    throw new Error("QA runner runtimePair must compare two different runtimes");
  }
  if (input[0] !== "openclaw" || input[1] !== "codex") {
    throw new Error('QA runner runtimePair must be ["openclaw", "codex"]');
  }
  return ["openclaw", "codex"];
}

function normalizeQaRuntimePairLane(input: unknown): QaLabRunSelection["runtimePairLane"] {
  if (input === undefined || input === null || input === "") {
    return null;
  }
  const parsed = qaRuntimePairLaneSchema.safeParse(input);
  if (!parsed.success) {
    const details = typeof input === "string" ? `: ${input}` : "";
    throw new Error(`unknown QA runtime-pair lane${details}`);
  }
  return parsed.data;
}

export function normalizeQaRunSelection(
  input: unknown,
  scenarios: QaSeedScenario[],
  profiles: readonly QaLabRunProfileOption[],
): QaLabRunSelection {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("QA runner request must be a JSON object");
  }
  const payload = input as Record<string, unknown>;
  const profile = normalizeQaProfile(
    payload.profile,
    profiles,
    Array.isArray(payload.scenarioIds) ? "all" : undefined,
  );
  const profileDefaults = requireQaRunProfile(profiles, profile);
  const providerMode = normalizeQaProviderMode(
    payload.providerMode ?? (profile === "smoke-ci" ? "mock-openai" : undefined),
  );
  const models = resolveQaRuntimeModelPair({
    providerMode,
    primaryModel: typeof payload.primaryModel === "string" ? payload.primaryModel : undefined,
    alternateModel: typeof payload.alternateModel === "string" ? payload.alternateModel : undefined,
  });
  return {
    profile,
    channel: normalizeQaChannel(payload.channel),
    channelDriver: normalizeQaChannelDriver(payload.channelDriver, profileDefaults.channelDriver),
    evidenceMode: normalizeQaEvidenceMode(payload.evidenceMode, profileDefaults.evidenceMode),
    providerMode,
    ...models,
    fastMode: getQaProvider(providerMode).kind === "live" || payload.fastMode === true,
    runtimePair: normalizeQaRuntimePair(payload.runtimePair),
    runtimePairLane: normalizeQaRuntimePairLane(payload.runtimePairLane),
    scenarioIds: normalizeScenarioIds(payload.scenarioIds, scenarios),
  };
}

function effectiveChannelForScenario(params: {
  scenario: QaSeedScenarioWithSource;
  selection: QaLabRunSelection;
  defaultChannel?: string;
}): string | null {
  // Catalog parsing defaults flow executions to kind="flow"; plans never consume raw YAML.
  if (params.scenario.execution.kind !== "flow") {
    return null;
  }
  const fallbackChannel =
    params.defaultChannel ?? params.selection.channel ?? params.scenario.execution.channel;
  if (!fallbackChannel) {
    return null;
  }
  return (
    resolveQaSuiteScenarioChannels({
      defaultChannel: fallbackChannel,
      explicitChannel:
        params.selection.channelDriver === "qa-channel" ? null : params.selection.channel,
      scenarios: [params.scenario],
    })[0] ?? null
  );
}

export function resolveQaLabRunPlan(params: {
  selection: QaLabRunSelection;
  scenarios: QaSeedScenarioWithSource[];
  scorecardReport: QaScorecardTaxonomyReport;
  defaultChannel?: string;
  supportsChannel?: (channel: string) => boolean;
  resolveModuleFlowSupport?: (channel?: string) => boolean;
}): QaLabResolvedRunPlan {
  const { selection } = params;
  const explicitScenarioSelection = selection.scenarioIds !== null;
  const membership = resolveQaRunProfileMembership(
    {
      profile: selection.profile,
      scenarioIds: selection.scenarioIds ?? undefined,
    },
    { scenarios: params.scenarios, scorecardReport: params.scorecardReport },
  );
  const scenarioById = new Map(params.scenarios.map((scenario) => [scenario.id, scenario]));
  const exclusions: QaLabResolvedRunPlan["exclusions"] = membership.excludedScenarioIds.map(
    (scenarioId) => {
      const scenario = scenarioById.get(scenarioId);
      return {
        scenarioId,
        executionKind: scenario ? scenario.execution.kind : "flow",
        reasons: [`not a member of profile ${selection.profile}`],
      };
    },
  );
  let laneSelection: ReturnType<typeof resolveQaRuntimePairLaneScenarioIds>;
  const errors: string[] = [];
  try {
    laneSelection = resolveQaRuntimePairLaneScenarioIds({
      channel: selection.channel,
      channelDriver: selection.channelDriver,
      defaultChannel: selection.channelDriver === "crabline" ? params.defaultChannel : undefined,
      primaryModel: selection.primaryModel,
      providerMode: selection.providerMode,
      scenarioIds: selection.runtimePairLane
        ? []
        : membership.selectedScenarios.map((scenario) => scenario.id),
      scenarios: membership.profileScenarios,
      runtimePairLanes: selection.runtimePairLane ? [selection.runtimePairLane] : [],
      runtimePair: selection.runtimePair !== null,
      resolveModuleFlowSupport: params.resolveModuleFlowSupport,
    });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    laneSelection = {
      scenarioIds: [],
      excludedLaneScenarios: [],
      excludedNonFlowScenarios: [],
    };
  }
  exclusions.push(
    ...laneSelection.excludedLaneScenarios.map((scenario) => ({
      scenarioId: scenario.id,
      executionKind: scenario.execution.kind,
      reasons: ["does not match the selected provider/model/channel lane"],
    })),
    ...laneSelection.excludedNonFlowScenarios.map((scenario) => ({
      scenarioId: scenario.id,
      executionKind: scenario.execution.kind,
      reasons: ["runtimePair requires execution.kind=flow"],
    })),
  );
  if (selection.runtimePairLane && explicitScenarioSelection) {
    const laneScenarioIds = new Set(laneSelection.scenarioIds);
    const alreadyExcludedIds = new Set(exclusions.map((exclusion) => exclusion.scenarioId));
    exclusions.push(
      ...membership.selectedScenarios
        .filter(
          (scenario) => !laneScenarioIds.has(scenario.id) && !alreadyExcludedIds.has(scenario.id),
        )
        .map((scenario) => ({
          scenarioId: scenario.id,
          executionKind: scenario.execution.kind,
          reasons: [`runtimePairLane=${selection.runtimePairLane}`],
        })),
    );
    laneSelection = {
      ...laneSelection,
      scenarioIds: membership.selectedScenarios
        .filter((scenario) => laneScenarioIds.has(scenario.id))
        .map((scenario) => scenario.id),
    };
  }
  const laneScenarios = laneSelection.scenarioIds.flatMap((scenarioId) => {
    const scenario = scenarioById.get(scenarioId);
    return scenario ? [scenario] : [];
  });
  const profileExecution = resolveQaRunProfileExecutionSelection({
    scenarios: laneScenarios,
    providerMode: selection.providerMode,
    primaryModel: selection.primaryModel,
    channelDriver: selection.channelDriver,
    channel: selection.channel,
    defaultChannel: selection.channelDriver === "crabline" ? params.defaultChannel : undefined,
    supportsChannel: params.supportsChannel,
    resolveModuleFlowSupport: params.resolveModuleFlowSupport,
  });
  exclusions.push(
    ...profileExecution.excludedScenarios.map(({ scenario, reasons }) => ({
      scenarioId: scenario.id,
      executionKind: scenario.execution.kind,
      reasons,
    })),
  );
  const runtimePairSupport = selection.runtimePair
    ? resolveQaRuntimePairScenarioSupport(profileExecution.selectedScenarios)
    : { selectedScenarios: profileExecution.selectedScenarios, excludedScenarios: [] };
  exclusions.push(
    ...runtimePairSupport.excludedScenarios.map((scenario) => ({
      scenarioId: scenario.id,
      executionKind: scenario.execution.kind,
      reasons: ["runtimePair requires execution.kind=flow"],
    })),
  );
  const selectedScenarios = runtimePairSupport.selectedScenarios;
  if (membership.categories.length === 0) {
    errors.push(`QA run profile ${selection.profile} did not resolve any taxonomy categories.`);
  }
  if (selection.channel && selection.channelDriver === "qa-channel") {
    errors.push("An execution channel requires channelDriver=crabline or channelDriver=live.");
  }
  const explicitScenarioIds = new Set(selection.scenarioIds ?? []);
  const explicitExclusions = exclusions.filter((exclusion) =>
    explicitScenarioIds.has(exclusion.scenarioId),
  );
  if (explicitScenarioSelection && explicitExclusions.length > 0) {
    errors.push(
      `Explicit QA scenario selection is not runnable: ${explicitExclusions
        .map((exclusion) => `${exclusion.scenarioId} (${exclusion.reasons.join(", ")})`)
        .join("; ")}.`,
    );
  }
  if (selectedScenarios.length === 0) {
    errors.push("QA run plan selected no runnable scenarios.");
  }
  const executionKinds = uniqueStrings(
    selectedScenarios.map((scenario) => scenario.execution.kind),
  ) as QaLabExecutionKind[];
  return {
    status: errors.length > 0 ? "invalid" : "ready",
    profile: selection.profile,
    explicitScenarioSelection,
    selectedScenarios: selectedScenarios.map((scenario) => ({
      id: scenario.id,
      title: scenario.title,
      executionKind: scenario.execution.kind,
      declaredChannel: scenario.execution.channel ?? null,
      effectiveChannel: effectiveChannelForScenario({
        scenario,
        selection,
        defaultChannel: params.defaultChannel,
      }),
    })),
    executionKinds,
    exclusions,
    errors: uniqueStrings(errors),
  };
}

export function createIdleQaRunnerSnapshot(
  profiles: readonly QaLabRunProfileOption[],
  plan: QaLabResolvedRunPlan | null = null,
): QaLabRunnerSnapshot {
  return {
    status: "idle",
    selection: createDefaultQaRunSelection(profiles, {
      resolveDefaultModel: defaultStaticModelForMode,
    }),
    plan,
    artifacts: null,
    error: null,
  };
}

export function createQaRunOutputDir(baseDir = process.cwd()) {
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "").replace("T", "-");
  return path.join(baseDir, ".artifacts", "qa-e2e", `lab-${stamp}-${randomUUID().slice(0, 8)}`);
}
