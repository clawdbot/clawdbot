import type {
  ProviderTransportAccountingCoverage,
  ProviderTransportAccountingCoverageReason,
} from "../provider-transport-accounting.types.js";
import { runtimeCoverageReasons, type MutableRunAccounting } from "./run-accounting-observation.js";
import type {
  AgentCommandRunAccountingCoverage,
  AgentCommandRunAccountingCoverageReason,
} from "./run-accounting.types.js";

const COVERAGE_REASON_ORDER: readonly AgentCommandRunAccountingCoverageReason[] = [
  "candidate_failed",
  "candidate_details_truncated",
  "candidate_identity_truncated",
  "effective_model_details_truncated",
  "not_observed",
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
  "acp_runtime",
];
const COVERAGE_REASON_RANK = new Map(
  COVERAGE_REASON_ORDER.map((reason, index) => [reason, index] as const),
);

export function createRunAccountingCoverage(
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

export function extendProviderTransportCoverage(
  coverage: ProviderTransportAccountingCoverage,
  hasUninstrumentedWork: boolean,
): ProviderTransportAccountingCoverage {
  if (!hasUninstrumentedWork) {
    return coverage;
  }
  const reasons = [
    ...("reasons" in coverage ? coverage.reasons : []),
    "not_instrumented",
  ] satisfies ProviderTransportAccountingCoverageReason[];
  return {
    state: coverage.state === "unavailable" ? "unavailable" : "partial",
    reasons: [...new Set(reasons)],
  };
}

export function projectObservedRunAccountingCoverage(params: {
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
    return createRunAccountingCoverage(
      "unavailable",
      reasons.length > 0 ? reasons : ["not_observed"],
    );
  }
  if (reasons.length === 0) {
    return { state: "complete" };
  }
  return createRunAccountingCoverage("partial", reasons);
}

export function projectAgentTimeCoverage(
  state: MutableRunAccounting,
  runtimeReasons: AgentCommandRunAccountingCoverageReason[],
): AgentCommandRunAccountingCoverage {
  const complete =
    state.candidates.total === 1 &&
    state.candidates.runtimes.embedded === 1 &&
    state.agentDurationObservations === 1 &&
    state.agentDurationInvalidObservations === 0;
  const reasons = [...runtimeReasons];
  if (!complete && state.candidates.threw > 0) {
    reasons.push("candidate_failed");
  }
  if (!complete) {
    reasons.push("not_observed");
  }
  return complete
    ? { state: "complete" }
    : createRunAccountingCoverage(
        state.agentDurationObservations > 0 ? "partial" : "unavailable",
        reasons.length > 0 ? reasons : ["not_observed"],
      );
}
