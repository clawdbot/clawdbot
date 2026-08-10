import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";
import type { CodeModeRunFinalQuiescence } from "../code-mode-activity.js";
import { cloneCodeModeStats, createCodeModeStats, mergeCodeModeStats } from "../code-mode-stats.js";
import type {
  EmbeddedRunAccountingObservation,
  EmbeddedRunOpaqueWorkReason,
} from "../embedded-agent-runner/run/accounting-observers.js";
import type { ToolSummaryTrace } from "../embedded-agent-runner/types.js";
import type { createProviderTransportAccountingCollector } from "../provider-transport-accounting.js";
import {
  NORMALIZED_USAGE_BUCKET_ORDER,
  resolveNormalizedUsageObservedBuckets,
  type NormalizedUsage,
} from "../usage.js";
import type {
  AgentCommandRunAccountingCoverageReason,
  AgentCommandRunAccountingSnapshot,
  AgentCommandRunUsageBucket,
} from "./run-accounting.types.js";

const MAX_AGENT_COMMAND_ACCOUNTING_EFFECTIVE_MODELS = 8;
const MAX_AGENT_COMMAND_ACCOUNTING_IDENTITY_CHARS = 256;
const MAX_AGENT_COMMAND_ACCOUNTING_TOOL_NAMES = 64;
export const AGENT_COMMAND_USAGE_BUCKETS: readonly AgentCommandRunUsageBucket[] =
  NORMALIZED_USAGE_BUCKET_ORDER;
const PRICEABLE_USAGE_BUCKETS: readonly AgentCommandRunUsageBucket[] = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
];

export type MutableCandidateRecord = Omit<
  AgentCommandRunAccountingSnapshot["candidates"]["entries"][number],
  "outcome"
> & {
  outcome?: "returned" | "threw";
};

export type MutableRunAccounting = {
  startedAtMs: number;
  candidates: Omit<AgentCommandRunAccountingSnapshot["candidates"], "entries"> & {
    entries: MutableCandidateRecord[];
  };
  candidateIdentityTruncated: boolean;
  agentSubmissions: NonNullable<AgentCommandRunAccountingSnapshot["agentSubmissions"]>;
  modelCalls: NonNullable<AgentCommandRunAccountingSnapshot["modelCalls"]>;
  modelCallInstrumentedCandidates: number;
  embeddedCandidatesObserved: number;
  assistantTurns: number;
  assistantTurnsObserved: number;
  usage: Record<AgentCommandRunUsageBucket, { value: number; observed: number }>;
  usageCoverageExpected: number;
  usageObserved: number;
  usageMissing: number;
  usagePartial: number;
  toolSummary: ToolSummaryTrace;
  toolNamesTruncated: boolean;
  toolsObserved: number;
  attemptsObserved: number;
  agentDurationMs: number;
  agentDurationObservations: number;
  agentDurationInvalidObservations: number;
  costCoverageExpected: number;
  providerBilledCostUsd: number;
  providerBilledCostReports: number;
  providerBilledCostObserved: number;
  providerBilledCostPartial: number;
  estimatedCostUsd: number;
  estimatedCostObserved: number;
  costMissingPricing: number;
  costPartialUsage: number;
  costTieredAggregate: number;
  opaqueWorkReasons: Map<EmbeddedRunOpaqueWorkReason, number>;
  modelWorkRuledOut: boolean;
  codeModeEngaged: boolean;
  codeModeStats?: ReturnType<typeof createCodeModeStats>;
  codeModeAttempts: number;
  codeModeLifecycleObserved: number;
  codeModeLifecycleMissing: number;
  maxUnresolvedAtExtraction: number;
  attemptsWithUnresolved: number;
  codeModeFinalQuiescence?: CodeModeRunFinalQuiescence;
  providerTransport: ReturnType<typeof createProviderTransportAccountingCollector>;
};

type ModelUsageObservation = Pick<
  EmbeddedRunAccountingObservation,
  "provider" | "model" | "config" | "agentDir"
> & {
  usage?: NormalizedUsage;
};

export function boundAccountingIdentity(value: string): { value: string; truncated: boolean } {
  const characters = Array.from(value);
  return characters.length > MAX_AGENT_COMMAND_ACCOUNTING_IDENTITY_CHARS
    ? {
        value: characters.slice(0, MAX_AGENT_COMMAND_ACCOUNTING_IDENTITY_CHARS).join(""),
        truncated: true,
      }
    : { value, truncated: false };
}

function hasPositiveCodeModeStats(stats: MutableRunAccounting["codeModeStats"]): boolean {
  if (!stats) {
    return false;
  }
  const hasPositiveCounter = (values: Array<number | undefined>) =>
    values.some((value) => (value ?? 0) > 0);
  return (
    hasPositiveCounter(Object.values(stats.controlCalls)) ||
    hasPositiveCounter(Object.values(stats.bridgeCalls)) ||
    hasPositiveCounter(Object.values(stats.bridgeLifecycle)) ||
    hasPositiveCounter(Object.values(stats.outcomes)) ||
    Object.values(stats.workerRuns).some(
      (run) => run !== undefined && (run.count > 0 || run.elapsedMs > 0),
    ) ||
    (stats.snapshots !== undefined &&
      (stats.snapshots.attempted > 0 ||
        stats.snapshots.produced > 0 ||
        stats.snapshots.accepted > 0 ||
        stats.snapshots.rejected > 0 ||
        stats.snapshots.incomplete > 0 ||
        stats.snapshots.totalBytes > 0 ||
        stats.snapshots.maxBytes > 0 ||
        stats.snapshots.serializationMs > 0 ||
        hasPositiveCounter(Object.values(stats.snapshots.rejectedByReason ?? {}))))
  );
}

export function hasCommandModelEvidence(state: MutableRunAccounting): boolean {
  return (
    state.assistantTurns > 0 ||
    state.usageObserved > 0 ||
    state.toolSummary.calls > 0 ||
    state.toolSummary.tools.length > 0 ||
    (state.toolSummary.failures ?? 0) > 0 ||
    (state.toolSummary.totalToolTimeMs ?? 0) > 0 ||
    state.providerBilledCostReports > 0 ||
    state.estimatedCostObserved > 0 ||
    state.maxUnresolvedAtExtraction > 0 ||
    state.attemptsWithUnresolved > 0 ||
    hasPositiveCodeModeStats(state.codeModeStats)
  );
}

export function runtimeCoverageReasons(
  runtimes: AgentCommandRunAccountingSnapshot["candidates"]["runtimes"],
): AgentCommandRunAccountingCoverageReason[] {
  const reasons: AgentCommandRunAccountingCoverageReason[] = [];
  if (runtimes.cli > 0) {
    reasons.push("cli_runtime");
  }
  if (runtimes.native > 0) {
    reasons.push("native_runtime");
  }
  if (runtimes.cloud > 0) {
    reasons.push("cloud_runtime");
  }
  if (runtimes.unknown > 0) {
    reasons.push("unknown_runtime");
  }
  return reasons;
}

function hasKnownPricing(cost: ReturnType<typeof resolveModelCostConfig>): boolean {
  if (!cost) {
    return false;
  }
  if (cost.tieredPricing && cost.tieredPricing.length > 0) {
    return cost.tieredPricing.some(
      (tier) => tier.input > 0 || tier.output > 0 || tier.cacheRead > 0 || tier.cacheWrite > 0,
    );
  }
  return cost.input > 0 || cost.output > 0 || cost.cacheRead > 0 || cost.cacheWrite > 0;
}

function mergeToolSummary(state: MutableRunAccounting, source: ToolSummaryTrace | undefined): void {
  if (!source) {
    return;
  }
  const target = state.toolSummary;
  target.calls += source.calls;
  const tools = new Set(target.tools);
  for (const tool of source.tools) {
    const boundedTool = boundAccountingIdentity(tool);
    state.toolNamesTruncated ||= boundedTool.truncated;
    if (!tools.has(boundedTool.value)) {
      if (target.tools.length >= MAX_AGENT_COMMAND_ACCOUNTING_TOOL_NAMES) {
        state.toolNamesTruncated = true;
        continue;
      }
      tools.add(boundedTool.value);
      target.tools.push(boundedTool.value);
    }
  }
  if (source.failures !== undefined) {
    target.failures = (target.failures ?? 0) + source.failures;
  }
  if (source.totalToolTimeMs !== undefined) {
    target.totalToolTimeMs = (target.totalToolTimeMs ?? 0) + source.totalToolTimeMs;
  }
}

export function observeEmbeddedAttempt(
  state: MutableRunAccounting,
  observation: EmbeddedRunAccountingObservation,
  candidate: MutableCandidateRecord | undefined,
): void {
  if (candidate) {
    const provider = boundAccountingIdentity(observation.provider);
    const model = boundAccountingIdentity(observation.model);
    state.candidateIdentityTruncated ||= provider.truncated || model.truncated;
    const alreadyRecorded = candidate.effectiveModels.entries.some(
      (entry) => entry.provider === provider.value && entry.model === model.value,
    );
    if (!alreadyRecorded) {
      if (
        candidate.effectiveModels.entries.length < MAX_AGENT_COMMAND_ACCOUNTING_EFFECTIVE_MODELS
      ) {
        candidate.effectiveModels.entries.push({
          provider: provider.value,
          model: model.value,
        });
      } else {
        candidate.effectiveModels.truncated += 1;
      }
    }
  }
  state.attemptsObserved += 1;
  if (observation.assistantTurnsObserved) {
    state.assistantTurnsObserved += 1;
    state.assistantTurns += observation.assistantTurns ?? 0;
  }
  if (observation.toolsObserved) {
    state.toolsObserved += 1;
    mergeToolSummary(state, observation.toolSummary ?? { calls: 0, tools: [] });
  }

  const assistantTurns =
    observation.assistantTurnsObserved &&
    typeof observation.assistantTurns === "number" &&
    Number.isFinite(observation.assistantTurns)
      ? Math.max(0, Math.floor(observation.assistantTurns))
      : undefined;
  const explicitAssistantTurnsWithUsage =
    assistantTurns !== undefined &&
    typeof observation.assistantTurnsWithUsage === "number" &&
    Number.isFinite(observation.assistantTurnsWithUsage)
      ? Math.min(assistantTurns, Math.max(0, Math.floor(observation.assistantTurnsWithUsage)))
      : undefined;
  // A zero/one-turn aggregate is unambiguous even for older harnesses. Multi-turn
  // aggregates need the explicit count or their usage coverage stays partial.
  const assistantTurnsWithUsage =
    explicitAssistantTurnsWithUsage ??
    (assistantTurns === 1
      ? observation.usage
        ? 1
        : 0
      : assistantTurns === 0 && !observation.usage
        ? 0
        : undefined);
  const usageCoverageExpected = Math.max(assistantTurns ?? 1, observation.usage ? 1 : 0);
  const usageCoverageObserved =
    assistantTurnsWithUsage === undefined ? (observation.usage ? 1 : 0) : assistantTurnsWithUsage;
  state.usageCoverageExpected += usageCoverageExpected;
  state.usageObserved += observation.usage ? Math.max(1, usageCoverageObserved) : 0;
  if (assistantTurnsWithUsage === undefined) {
    state.usagePartial += 1;
    if (!observation.usage) {
      state.usageMissing += usageCoverageExpected;
    }
  } else if (assistantTurns !== undefined && assistantTurnsWithUsage < assistantTurns) {
    state.usageMissing += assistantTurns - assistantTurnsWithUsage;
  }

  observeModelUsage(state, observation, {
    expected: usageCoverageExpected,
    observed: usageCoverageObserved,
  });

  state.codeModeEngaged ||= observation.codeModeEngaged === true;
  const codeModeRelevant =
    observation.codeModeEngaged === true || observation.codeModeStats !== undefined;
  if (!codeModeRelevant) {
    return;
  }
  state.codeModeAttempts += 1;
  if (!observation.codeModeStats) {
    state.codeModeLifecycleMissing += 1;
    return;
  }
  const attemptStats = cloneCodeModeStats(observation.codeModeStats);
  const unresolved = attemptStats.bridgeLifecycle.unresolvedAtExtraction;
  if (observation.codeModeLifecycleObserved && unresolved !== undefined) {
    state.codeModeLifecycleObserved += 1;
    state.maxUnresolvedAtExtraction = Math.max(state.maxUnresolvedAtExtraction, unresolved);
    if (unresolved > 0) {
      state.attemptsWithUnresolved += 1;
    }
  } else {
    state.codeModeLifecycleMissing += 1;
  }
  delete attemptStats.bridgeLifecycle.unresolvedAtExtraction;
  state.codeModeStats ??= createCodeModeStats();
  mergeCodeModeStats(state.codeModeStats, attemptStats);
}

export function observeModelUsage(
  state: MutableRunAccounting,
  observation: ModelUsageObservation,
  coverage: { expected: number; observed: number } = {
    expected: 1,
    observed: observation.usage ? 1 : 0,
  },
): void {
  const expected = Math.max(0, Math.floor(coverage.expected));
  const observed = Math.max(0, Math.floor(coverage.observed));
  state.costCoverageExpected += expected;
  if (!observation.usage) {
    return;
  }

  const observedUsageBuckets = resolveNormalizedUsageObservedBuckets(observation.usage);
  let observedBuckets = 0;
  for (const bucket of AGENT_COMMAND_USAGE_BUCKETS) {
    const value = observation.usage[bucket];
    if (!observedUsageBuckets.has(bucket) || typeof value !== "number" || !Number.isFinite(value)) {
      continue;
    }
    observedBuckets += 1;
    state.usage[bucket].value += value;
    state.usage[bucket].observed += Math.max(1, observed);
  }
  if (observedBuckets < AGENT_COMMAND_USAGE_BUCKETS.length) {
    state.usagePartial += 1;
  }

  if (observation.usage.providerBilledCost) {
    state.providerBilledCostUsd += observation.usage.providerBilledCost.totalUsd;
    state.providerBilledCostReports += 1;
    if (observation.usage.providerBilledCost.coverage === "complete") {
      state.providerBilledCostObserved += Math.max(1, observed);
    } else {
      state.providerBilledCostObserved += 1;
      state.providerBilledCostPartial += 1;
    }
    return;
  }

  const hasPriceableUsage = PRICEABLE_USAGE_BUCKETS.some((bucket) =>
    observedUsageBuckets.has(bucket),
  );
  const hasCompletePriceableUsage = PRICEABLE_USAGE_BUCKETS.every((bucket) =>
    observedUsageBuckets.has(bucket),
  );
  const hasZeroPriceableUsage =
    hasCompletePriceableUsage &&
    PRICEABLE_USAGE_BUCKETS.every((bucket) => observation.usage?.[bucket] === 0);
  if (!hasPriceableUsage) {
    state.costPartialUsage += 1;
  } else if (hasZeroPriceableUsage) {
    state.estimatedCostObserved += Math.max(1, observed);
  } else {
    if (!hasCompletePriceableUsage) {
      state.costPartialUsage += 1;
    }
    const cost = resolveModelCostConfig({
      provider: observation.provider,
      model: observation.model,
      config: observation.config,
      agentDir: observation.agentDir,
      allowPluginNormalization: false,
    });
    if (!hasKnownPricing(cost)) {
      state.costMissingPricing += 1;
    } else if ((cost?.tieredPricing?.length ?? 0) > 0) {
      state.costTieredAggregate += 1;
    } else {
      const costUsd = estimateUsageCost({ usage: observation.usage, cost });
      if (costUsd === undefined) {
        state.costMissingPricing += 1;
      } else {
        state.estimatedCostObserved += Math.max(1, observed);
        state.estimatedCostUsd += costUsd;
      }
    }
  }
}
