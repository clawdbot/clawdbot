import type { AgentCommandRunAccountingSnapshot } from "../agents/command/run-accounting.types.js";

export type AgentExecTraceMetric =
  | { state: "exact" | "lower_bound"; value: number; reasons?: string[] }
  | { state: "unavailable"; reasons: string[] };

export type AgentExecTraceCacheObservation =
  | { state: "exact"; value: number }
  | { state: "unknown"; reasons: string[] };

type TraceCoverage =
  | { state: "complete" }
  | { state: "partial" | "unavailable"; reasons: readonly string[] };

export function normalizeTraceReasons(reasons: Iterable<string>): string[] {
  return [...new Set(reasons)].toSorted();
}

export function coverageReasons(coverage: TraceCoverage): string[] {
  return "reasons" in coverage ? normalizeTraceReasons(coverage.reasons) : [];
}

export function unavailableMetric(reasons: Iterable<string>): AgentExecTraceMetric {
  const normalized = normalizeTraceReasons(reasons);
  return {
    state: "unavailable",
    reasons: normalized.length > 0 ? normalized : ["not_observed"],
  };
}

export function observedMetric(params: {
  value: number | undefined;
  coverage: TraceCoverage;
  reasons?: Iterable<string>;
}): AgentExecTraceMetric {
  const reasons = normalizeTraceReasons([
    ...coverageReasons(params.coverage),
    ...(params.reasons ?? []),
  ]);
  if (params.value === undefined || !Number.isSafeInteger(params.value) || params.value < 0) {
    return unavailableMetric(reasons);
  }
  if (params.coverage.state !== "complete" || reasons.length > 0) {
    return {
      state: "lower_bound",
      value: params.value,
      ...(reasons.length > 0 ? { reasons } : {}),
    };
  }
  return { state: "exact", value: params.value };
}

export function sumExactMetrics(
  metrics: readonly AgentExecTraceMetric[],
  reason: string,
): AgentExecTraceMetric {
  if (metrics.some((metric) => metric.state === "unavailable")) {
    return unavailableMetric([
      reason,
      ...metrics.flatMap((metric) => ("reasons" in metric ? (metric.reasons ?? []) : [])),
    ]);
  }
  const observed = metrics as Array<Extract<AgentExecTraceMetric, { value: number }>>;
  const reasons = normalizeTraceReasons(
    observed.flatMap((metric) => ("reasons" in metric ? (metric.reasons ?? []) : [])),
  );
  return {
    state: observed.every((metric) => metric.state === "exact") ? "exact" : "lower_bound",
    value: observed.reduce((total, metric) => total + metric.value, 0),
    ...(reasons.length > 0 ? { reasons } : {}),
  };
}

export function agentDurationMetric(
  snapshot: AgentCommandRunAccountingSnapshot,
  durationMs: number | undefined,
): AgentExecTraceMetric {
  const reasons = [
    ...coverageReasons(snapshot.coverage.candidates),
    ...(snapshot.candidates.total === 1 &&
    snapshot.candidates.returned === 1 &&
    snapshot.candidates.threw === 0
      ? []
      : ["candidate_scope_incomplete"]),
  ];
  return observedMetric({
    value: durationMs,
    coverage: reasons.length === 0 ? { state: "complete" } : { state: "partial", reasons },
  });
}
