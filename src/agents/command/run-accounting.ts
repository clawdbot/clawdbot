import { AsyncLocalStorage } from "node:async_hooks";
import { cloneCodeModeStats } from "../code-mode-stats.js";
import type { EmbeddedRunOpaqueWorkReason } from "../embedded-agent-runner/run/accounting-observers.js";
import type { AgentSubmissionHandle } from "../sessions/agent-session-accounting.js";
import {
  AGENT_COMMAND_USAGE_BUCKETS,
  boundAccountingIdentity,
  observeEmbeddedAttempt,
  observeModelUsage,
  type MutableCandidateRecord,
  type MutableRunAccounting,
} from "./run-accounting-observation.js";
import type {
  AgentCommandCandidateRuntime,
  AgentCommandModelCallAccounting,
  AgentCommandRunAccountingCoverage,
  AgentCommandRunAccountingCoverageReason,
  AgentCommandRunAccountingSnapshot,
  AgentCommandRunCandidateAccounting,
  RunAccountingAccumulator,
} from "./run-accounting.types.js";

const MAX_AGENT_COMMAND_ACCOUNTING_CANDIDATES = 32;
const COVERAGE_REASON_ORDER: readonly AgentCommandRunAccountingCoverageReason[] = [
  "candidate_failed",
  "candidate_details_truncated",
  "candidate_identity_truncated",
  "effective_model_details_truncated",
  "cli_runtime",
  "native_runtime",
  "cloud_runtime",
  "unknown_runtime",
  "missing_usage",
  "partial_usage",
  "partial_provider_billed_cost",
  "not_instrumented",
  "model_call_unsettled",
  "missing_pricing",
  "tiered_pricing_aggregate",
  "settled_finalization_failed",
  "session_core_compaction",
  "session_extension_compaction",
  "native_harness_compaction",
  "deferred_context_engine_maintenance",
  "post_turn_compaction",
  "tool_details_truncated",
  "agent_submission_unsettled",
  "attempt_extraction_only",
  "not_observed",
  "acp_runtime",
];
const COVERAGE_REASON_RANK = new Map(
  COVERAGE_REASON_ORDER.map((reason, index) => [reason, index] as const),
);

const snapshots = new WeakMap<object, AgentCommandRunAccountingSnapshot>();
const activeCommandRunAccounting = new AsyncLocalStorage<RunAccountingAccumulator>();

function cloneRunAccountingSnapshot(
  snapshot: AgentCommandRunAccountingSnapshot,
): AgentCommandRunAccountingSnapshot {
  return structuredClone(snapshot);
}

export function bindAgentCommandRunAccounting(
  target: unknown,
  snapshot: AgentCommandRunAccountingSnapshot,
): void {
  if ((typeof target === "object" && target !== null) || typeof target === "function") {
    snapshots.set(target, cloneRunAccountingSnapshot(snapshot));
  }
}

export function resolveAgentCommandRunAccounting(
  target: unknown,
): AgentCommandRunAccountingSnapshot | undefined {
  if ((typeof target === "object" && target !== null) || typeof target === "function") {
    const snapshot = snapshots.get(target);
    return snapshot ? cloneRunAccountingSnapshot(snapshot) : undefined;
  }
  return undefined;
}

export function markActiveAgentCommandOpaqueWork(reason: EmbeddedRunOpaqueWorkReason): void {
  activeCommandRunAccounting.getStore()?.markOpaqueWork(reason);
}

export function markActiveAgentCommandNoModelWork(): void {
  activeCommandRunAccounting.getStore()?.markNoModelWork();
}

export function beginActiveAgentCommandSubmission(): AgentSubmissionHandle | undefined {
  return activeCommandRunAccounting.getStore()?.beginAgentSubmission();
}

export function beginActiveAgentCommandModelCall(): AgentCommandModelCallAccounting | undefined {
  return activeCommandRunAccounting.getStore()?.beginModelCall();
}

export async function runWithAgentCommandAccounting<T>(
  run: (accounting: RunAccountingAccumulator) => Promise<T>,
): Promise<T> {
  const accounting = createRunAccountingAccumulator();
  return await activeCommandRunAccounting.run(accounting, async () => {
    try {
      return await run(accounting);
    } catch (error) {
      if ((typeof error === "object" && error !== null) || typeof error === "function") {
        bindAgentCommandRunAccounting(error, accounting.project());
      }
      throw error;
    }
  });
}

export async function runOutsideAgentCommandAccounting<T>(run: () => Promise<T>): Promise<T> {
  return await activeCommandRunAccounting.exit(run);
}

function createCoverage(
  state: "partial" | "unavailable",
  reasons: Iterable<AgentCommandRunAccountingCoverageReason>,
): AgentCommandRunAccountingCoverage {
  return {
    state,
    reasons: [...new Set(reasons)].toSorted(
      (left, right) =>
        (COVERAGE_REASON_RANK.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (COVERAGE_REASON_RANK.get(right) ?? Number.MAX_SAFE_INTEGER),
    ),
  };
}

function runtimeCoverageReasons(
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

function projectObservedCoverage(params: {
  state: MutableRunAccounting;
  observed?: number;
  extraReasons?: AgentCommandRunAccountingCoverageReason[];
}): AgentCommandRunAccountingCoverage {
  const reasons = [
    ...runtimeCoverageReasons(params.state.candidates.runtimes),
    ...(params.state.candidates.threw > 0 ? (["candidate_failed"] as const) : []),
    ...(params.extraReasons ?? []),
  ];
  const observed = params.observed ?? params.state.attemptsObserved;
  if (observed === 0) {
    return createCoverage("unavailable", reasons.length > 0 ? reasons : ["not_observed"]);
  }
  if (reasons.length === 0) {
    return { state: "complete" };
  }
  return createCoverage("partial", reasons);
}

export function createRunAccountingAccumulator(startedAtMs = Date.now()): RunAccountingAccumulator {
  const state: MutableRunAccounting = {
    startedAtMs,
    candidates: {
      total: 0,
      returned: 0,
      threw: 0,
      runtimes: {
        embedded: 0,
        cli: 0,
        native: 0,
        cloud: 0,
        unknown: 0,
      },
      entries: [],
      truncated: 0,
    },
    candidateIdentityTruncated: false,
    agentSubmissions: { total: 0, completed: 0, failed: 0 },
    modelCalls: { total: 0, completed: 0, failed: 0 },
    modelCallInstrumentedCandidates: 0,
    embeddedCandidatesObserved: 0,
    assistantTurns: 0,
    assistantTurnsObserved: 0,
    usage: {
      input: { value: 0, observed: 0 },
      output: { value: 0, observed: 0 },
      cacheRead: { value: 0, observed: 0 },
      cacheWrite: { value: 0, observed: 0 },
      reasoningTokens: { value: 0, observed: 0 },
      total: { value: 0, observed: 0 },
    },
    usageCoverageExpected: 0,
    usageObserved: 0,
    usageMissing: 0,
    usagePartial: 0,
    toolSummary: { calls: 0, tools: [] },
    toolNamesTruncated: false,
    toolsObserved: 0,
    attemptsObserved: 0,
    costCoverageExpected: 0,
    providerBilledCostUsd: 0,
    providerBilledCostReports: 0,
    providerBilledCostObserved: 0,
    providerBilledCostPartial: 0,
    estimatedCostUsd: 0,
    estimatedCostObserved: 0,
    costMissingPricing: 0,
    costPartialUsage: 0,
    costTieredAggregate: 0,
    opaqueWorkReasons: new Map(),
    modelWorkRuledOut: false,
    codeModeEngaged: false,
    codeModeAttempts: 0,
    codeModeLifecycleObserved: 0,
    codeModeLifecycleMissing: 0,
    maxUnresolvedAtExtraction: 0,
    attemptsWithUnresolved: 0,
  };

  const beginAgentSubmission = (): AgentSubmissionHandle => {
    state.agentSubmissions.total += 1;
    let settled = false;
    return {
      settle(outcome) {
        if (settled) {
          return;
        }
        settled = true;
        state.agentSubmissions[outcome] += 1;
      },
    };
  };
  const recordOpaqueWork = (reason: EmbeddedRunOpaqueWorkReason) => {
    state.modelWorkRuledOut = false;
    state.opaqueWorkReasons.set(reason, (state.opaqueWorkReasons.get(reason) ?? 0) + 1);
  };

  return {
    beginAgentSubmission,
    beginModelCall() {
      state.modelWorkRuledOut = false;
      state.modelCalls.total += 1;
      let settled = false;
      return {
        settle(settlement) {
          if (settled) {
            return;
          }
          settled = true;
          state.modelCalls[settlement.outcome] += 1;
          state.usageCoverageExpected += 1;
          if (settlement.usage) {
            state.usageObserved += 1;
          } else {
            state.usageMissing += 1;
          }
          observeModelUsage(state, settlement);
        },
      };
    },
    beginCandidate(identity): AgentCommandRunCandidateAccounting {
      state.modelWorkRuledOut = false;
      state.candidates.total += 1;
      let runtime: AgentCommandCandidateRuntime = "unknown";
      let settled = false;
      let modelCallInstrumentationInstalled = false;
      let embeddedAttemptObserved = false;
      const provider = boundAccountingIdentity(identity.provider);
      const model = boundAccountingIdentity(identity.model);
      state.candidateIdentityTruncated ||= provider.truncated || model.truncated;
      const entry: MutableCandidateRecord | undefined =
        state.candidates.entries.length < MAX_AGENT_COMMAND_ACCOUNTING_CANDIDATES
          ? {
              provider: provider.value,
              model: model.value,
              runtime,
              effectiveModels: { entries: [], truncated: 0 },
            }
          : undefined;
      if (entry) {
        state.candidates.entries.push(entry);
      } else {
        state.candidates.truncated += 1;
      }
      return {
        selectRuntime(nextRuntime) {
          if (runtime === nextRuntime) {
            return;
          }
          if (runtime !== "unknown") {
            throw new Error(
              `agent command candidate runtime changed from ${runtime} to ${nextRuntime}`,
            );
          }
          runtime = nextRuntime;
          if (entry) {
            entry.runtime = nextRuntime;
          }
        },
        beginAgentSubmission() {
          return beginAgentSubmission();
        },
        beginModelCall() {
          state.modelCalls.total += 1;
          let modelCallSettled = false;
          return {
            settle(outcome) {
              if (modelCallSettled) {
                return;
              }
              modelCallSettled = true;
              state.modelCalls[outcome] += 1;
            },
          };
        },
        markModelCallInstrumentationInstalled() {
          if (modelCallInstrumentationInstalled) {
            return;
          }
          modelCallInstrumentationInstalled = true;
          state.modelCallInstrumentedCandidates += 1;
        },
        observeEmbeddedAttempt(observation) {
          if (!embeddedAttemptObserved) {
            embeddedAttemptObserved = true;
            state.embeddedCandidatesObserved += 1;
          }
          observeEmbeddedAttempt(state, observation, entry);
        },
        markOpaqueWork(reason) {
          recordOpaqueWork(reason);
        },
        settle(outcome) {
          if (settled) {
            return;
          }
          settled = true;
          state.candidates.runtimes[runtime] += 1;
          state.candidates[outcome] += 1;
          if (entry) {
            entry.outcome = outcome;
          }
        },
      };
    },
    markNoModelWork() {
      if (
        state.candidates.total === 0 &&
        state.modelCalls.total === 0 &&
        state.opaqueWorkReasons.size === 0
      ) {
        state.modelWorkRuledOut = true;
      }
    },
    markOpaqueWork(reason) {
      recordOpaqueWork(reason);
    },
    project(): AgentCommandRunAccountingSnapshot {
      const runtimeReasons = runtimeCoverageReasons(state.candidates.runtimes);
      const opaqueWorkReasons = [...state.opaqueWorkReasons.keys()];
      const opaqueWorkTotal = [...state.opaqueWorkReasons.values()].reduce(
        (total, count) => total + count,
        0,
      );
      const settledFinalizationReasons = opaqueWorkReasons.filter(
        (reason) => reason === "settled_finalization_failed",
      );
      const auxiliaryHiddenWorkReasons = opaqueWorkReasons.filter(
        (reason) => reason !== "settled_finalization_failed",
      );
      const candidateCoverageReasons = [
        ...(state.candidates.truncated > 0 ? (["candidate_details_truncated"] as const) : []),
        ...(state.candidateIdentityTruncated ? (["candidate_identity_truncated"] as const) : []),
        ...(state.candidates.entries.some((entry) => entry.effectiveModels.truncated > 0)
          ? (["effective_model_details_truncated"] as const)
          : []),
      ];
      const candidatesCoverage =
        state.candidates.total > 0
          ? candidateCoverageReasons.length > 0
            ? createCoverage("partial", candidateCoverageReasons)
            : ({ state: "complete" } as const)
          : createCoverage("unavailable", ["not_observed"]);
      const agentSubmissionCoverageReasons = [
        ...runtimeReasons,
        ...(state.agentSubmissions.completed + state.agentSubmissions.failed <
        state.agentSubmissions.total
          ? (["agent_submission_unsettled"] as const)
          : []),
      ];
      const agentSubmissionsCoverage = state.modelWorkRuledOut
        ? ({ state: "complete" } as const)
        : state.agentSubmissions.total > 0
          ? agentSubmissionCoverageReasons.length === 0
            ? ({ state: "complete" } as const)
            : createCoverage("partial", agentSubmissionCoverageReasons)
          : state.candidates.total === 0
            ? createCoverage("unavailable", ["not_observed", ...agentSubmissionCoverageReasons])
            : agentSubmissionCoverageReasons.length === 0
              ? ({ state: "complete" } as const)
              : createCoverage(
                  state.agentSubmissions.total > 0 ? "partial" : "unavailable",
                  agentSubmissionCoverageReasons,
                );
      const modelCallInstrumentationMissing =
        state.modelCallInstrumentedCandidates < state.candidates.runtimes.embedded;
      const embeddedAttemptObservationMissing =
        state.embeddedCandidatesObserved < state.candidates.runtimes.embedded;
      const modelCallCoverageReasons = [
        ...runtimeReasons,
        ...(modelCallInstrumentationMissing ? (["not_instrumented"] as const) : []),
        ...(state.modelCalls.completed + state.modelCalls.failed < state.modelCalls.total
          ? (["model_call_unsettled"] as const)
          : []),
        ...auxiliaryHiddenWorkReasons,
      ];
      const modelCallsCoverage = state.modelWorkRuledOut
        ? ({ state: "complete" } as const)
        : state.candidates.total === 0 && state.modelCalls.total === 0
          ? createCoverage("unavailable", ["not_observed", ...modelCallCoverageReasons])
          : state.modelCallInstrumentedCandidates === 0 && state.modelCalls.total === 0
            ? createCoverage(
                "unavailable",
                modelCallCoverageReasons.length > 0 ? modelCallCoverageReasons : ["not_observed"],
              )
            : modelCallCoverageReasons.length === 0
              ? ({ state: "complete" } as const)
              : createCoverage("partial", modelCallCoverageReasons);
      const modelCallUnsettled =
        state.modelCalls.completed + state.modelCalls.failed < state.modelCalls.total;
      const usageCoverageExpected =
        state.modelCallInstrumentedCandidates > 0
          ? Math.max(state.usageCoverageExpected, state.modelCalls.total)
          : state.usageCoverageExpected;
      const usageMissing = Math.max(
        state.usageMissing,
        usageCoverageExpected - state.usageObserved,
        0,
      );
      const wholeRunUsageReasons = [
        ...runtimeReasons,
        ...(state.candidates.threw > 0 ? (["candidate_failed"] as const) : []),
        ...(modelCallInstrumentationMissing ? (["not_instrumented"] as const) : []),
        ...(modelCallUnsettled ? (["model_call_unsettled"] as const) : []),
      ];
      const exactZeroModelWork =
        (state.modelWorkRuledOut || modelCallsCoverage.state === "complete") &&
        state.modelCalls.total === 0 &&
        wholeRunUsageReasons.length === 0 &&
        opaqueWorkReasons.length === 0;
      const usageBuckets = Object.fromEntries(
        AGENT_COMMAND_USAGE_BUCKETS.map((bucket) => {
          const observed = state.usage[bucket].observed;
          const reasons = [
            ...wholeRunUsageReasons,
            ...(usageMissing > 0 ? (["missing_usage"] as const) : []),
            ...(observed < usageCoverageExpected ? (["partial_usage"] as const) : []),
            ...opaqueWorkReasons,
          ];
          return [
            bucket,
            exactZeroModelWork
              ? ({ state: "complete" } as const)
              : observed === 0
                ? createCoverage("unavailable", reasons.length > 0 ? reasons : ["not_observed"])
                : reasons.length === 0
                  ? ({ state: "complete" } as const)
                  : createCoverage("partial", reasons),
          ];
        }),
      ) as AgentCommandRunAccountingSnapshot["coverage"]["usageBuckets"];
      const usageCoverage = projectObservedCoverage({
        state,
        observed: state.usageObserved,
        extraReasons: [
          ...(usageMissing > 0 ? (["missing_usage"] as const) : []),
          ...(state.usagePartial > 0 ? (["partial_usage"] as const) : []),
          ...(modelCallInstrumentationMissing ? (["not_instrumented"] as const) : []),
          ...(modelCallUnsettled ? (["model_call_unsettled"] as const) : []),
          ...opaqueWorkReasons,
        ],
      });
      const hasProviderBilledCost = state.providerBilledCostReports > 0;
      const costObserved = hasProviderBilledCost
        ? state.providerBilledCostObserved
        : state.estimatedCostObserved;
      const costCoverageExpected = Math.max(state.costCoverageExpected, state.modelCalls.total);
      const costMissing = Math.max(costCoverageExpected - costObserved, 0);
      const costCoverage = projectObservedCoverage({
        state,
        observed: costObserved,
        extraReasons: [
          ...(costMissing > 0 && usageMissing > 0 ? (["missing_usage"] as const) : []),
          ...(modelCallInstrumentationMissing ? (["not_instrumented"] as const) : []),
          ...(modelCallUnsettled ? (["model_call_unsettled"] as const) : []),
          ...(hasProviderBilledCost && (costMissing > 0 || state.providerBilledCostPartial > 0)
            ? (["partial_provider_billed_cost"] as const)
            : []),
          ...(!hasProviderBilledCost && state.costPartialUsage > 0
            ? (["partial_usage"] as const)
            : []),
          ...(!hasProviderBilledCost && state.costMissingPricing > 0
            ? (["missing_pricing"] as const)
            : []),
          ...(!hasProviderBilledCost && state.costTieredAggregate > 0
            ? (["tiered_pricing_aggregate"] as const)
            : []),
          ...opaqueWorkReasons,
        ],
      });
      const projectedUsage = Object.fromEntries(
        AGENT_COMMAND_USAGE_BUCKETS.flatMap((bucket) =>
          exactZeroModelWork || state.usage[bucket].observed > 0
            ? [[bucket, state.usage[bucket].value]]
            : [],
        ),
      ) as NonNullable<AgentCommandRunAccountingSnapshot["usage"]>;
      const effectiveUsageCoverage = exactZeroModelWork
        ? ({ state: "complete" } as const)
        : usageCoverage;
      const effectiveCostCoverage = exactZeroModelWork
        ? ({ state: "complete" } as const)
        : costCoverage;
      const codeMode =
        state.codeModeEngaged || state.codeModeStats
          ? {
              engaged: state.codeModeEngaged,
              ...(state.codeModeStats ? { stats: cloneCodeModeStats(state.codeModeStats) } : {}),
              lifecycle: {
                ...(state.codeModeAttempts > 0 &&
                state.codeModeLifecycleObserved === state.codeModeAttempts
                  ? {
                      maxUnresolvedAtExtraction: state.maxUnresolvedAtExtraction,
                      attemptsWithUnresolved: state.attemptsWithUnresolved,
                    }
                  : {}),
                finalQuiescence:
                  state.codeModeLifecycleObserved === 0
                    ? createCoverage("unavailable", ["not_observed"])
                    : state.codeModeLifecycleMissing > 0
                      ? createCoverage("partial", ["attempt_extraction_only", "not_observed"])
                      : createCoverage("partial", ["attempt_extraction_only"]),
              },
            }
          : undefined;
      return {
        candidates: {
          ...state.candidates,
          runtimes: { ...state.candidates.runtimes },
          entries: state.candidates.entries.flatMap((entry) =>
            entry.outcome
              ? [
                  {
                    ...entry,
                    outcome: entry.outcome,
                    effectiveModels: {
                      entries: entry.effectiveModels.entries.map((identity) => ({ ...identity })),
                      truncated: entry.effectiveModels.truncated,
                    },
                  },
                ]
              : [],
          ),
        },
        ...(agentSubmissionsCoverage.state !== "unavailable"
          ? { agentSubmissions: { ...state.agentSubmissions } }
          : {}),
        ...(modelCallsCoverage.state !== "unavailable"
          ? { modelCalls: { ...state.modelCalls } }
          : {}),
        ...(exactZeroModelWork
          ? { assistantTurns: 0 }
          : state.assistantTurnsObserved > 0
            ? { assistantTurns: state.assistantTurns }
            : {}),
        ...(exactZeroModelWork || state.usageObserved > 0 ? { usage: projectedUsage } : {}),
        ...(exactZeroModelWork
          ? { toolSummary: { calls: 0, tools: [] } }
          : state.toolsObserved > 0
            ? {
                toolSummary: {
                  ...state.toolSummary,
                  tools: [...state.toolSummary.tools],
                },
              }
            : {}),
        ...(state.toolNamesTruncated ? { toolNamesTruncated: true as const } : {}),
        ...(opaqueWorkTotal > 0
          ? {
              opaqueWork: {
                total: opaqueWorkTotal,
                byReason: Object.fromEntries(state.opaqueWorkReasons),
              },
            }
          : {}),
        ...(exactZeroModelWork || costObserved > 0
          ? {
              costUsd: hasProviderBilledCost ? state.providerBilledCostUsd : state.estimatedCostUsd,
            }
          : {}),
        commandExecutionDurationMs: Math.max(0, Date.now() - state.startedAtMs),
        coverage: {
          candidates: candidatesCoverage,
          agentSubmissions: agentSubmissionsCoverage,
          modelCalls: modelCallsCoverage,
          assistantTurns: exactZeroModelWork
            ? { state: "complete" }
            : projectObservedCoverage({
                state,
                observed: state.assistantTurnsObserved,
                extraReasons: [
                  ...(embeddedAttemptObservationMissing ||
                  state.attemptsObserved > state.assistantTurnsObserved
                    ? (["not_observed"] as const)
                    : []),
                  ...settledFinalizationReasons,
                ],
              }),
          usage: effectiveUsageCoverage,
          usageBuckets,
          tools: exactZeroModelWork
            ? { state: "complete" }
            : projectObservedCoverage({
                state,
                observed: state.toolsObserved,
                extraReasons: [
                  ...(state.attemptsObserved > state.toolsObserved
                    ? (["not_observed"] as const)
                    : []),
                  ...(embeddedAttemptObservationMissing ? (["not_observed"] as const) : []),
                  ...(state.toolNamesTruncated ? (["tool_details_truncated"] as const) : []),
                  ...settledFinalizationReasons,
                ],
              }),
          cost: effectiveCostCoverage,
          agentTime: createCoverage("unavailable", ["not_instrumented"]),
          commandExecutionDuration: { state: "complete" },
          wallLatency: createCoverage("unavailable", ["not_instrumented"]),
          providerTransport: createCoverage("unavailable", [
            "not_instrumented",
            ...auxiliaryHiddenWorkReasons,
          ]),
        },
        ...(codeMode ? { codeMode } : {}),
      };
    },
  };
}
