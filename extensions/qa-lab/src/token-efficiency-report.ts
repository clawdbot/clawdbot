// Qa Lab plugin module implements token efficiency report behavior.
import type { RuntimeParityCacheMiss } from "./runtime-parity-cache-diagnostics.js";
import type { RuntimeId, RuntimeParityCell, RuntimeParityResult } from "./runtime-parity.js";
import { resolveRuntimeParityUsagePolicy } from "./runtime-parity.js";

type ProcessedTokenEvidence = "measured" | "derived" | "unavailable";

type TokenEfficiencyRuntimeUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  processedTokens: number;
  processedTokenEvidence: ProcessedTokenEvidence;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheMisses: RuntimeParityCacheMiss[] | null;
  unmeasuredPostWarmTurns: number[] | null;
  toolCallCount: number;
};

type TokenEfficiencyAggregateRuntimeUsage = {
  totalTokens: number;
  processedTokens: number;
  processedTokenEvidence: ProcessedTokenEvidence;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheMissCount: number | null;
  cacheMissInputTokens: number | null;
  p50PerScenario: number | null;
  p90PerScenario: number | null;
};

type TokenEfficiencyRow = {
  scenarioId: string;
  usageSource: "live-usage" | "mock-estimate";
  openclaw: TokenEfficiencyRuntimeUsage;
  codex: TokenEfficiencyRuntimeUsage;
  deltaPercent: number;
  classification: "regression" | "savings" | "neutral";
  flagged: boolean;
  toolsUsed: string[];
};

type TokenEfficiencyReport = {
  status: "evaluated" | "estimated" | "skipped";
  runtimePair: [RuntimeId, RuntimeId];
  generatedAt: string;
  providerMode?: string;
  thresholdPercent: number;
  rows: TokenEfficiencyRow[];
  notApplicableScenarios: Array<{ scenarioId: string; reason: string }>;
  aggregate: {
    openclaw: TokenEfficiencyAggregateRuntimeUsage;
    codex: TokenEfficiencyAggregateRuntimeUsage;
    deltaPercent: number;
    flaggedScenarios: string[];
    savingsScenarios: string[];
  };
  pass: boolean;
  failures: string[];
  skipReason?: string;
  notes: string[];
};

export type TokenEfficiencySuiteSummary = {
  scenarios: Array<{
    name: string;
    status: "pass" | "fail" | "skip";
    runtimeParity?: RuntimeParityResult;
  }>;
  run?: {
    providerMode?: string;
    runtimePair?: [RuntimeId, RuntimeId] | null;
  };
};

type BuildTokenEfficiencyReportParams = {
  summary: TokenEfficiencySuiteSummary;
  generatedAt?: string;
  thresholdPercent?: number;
};

const DEFAULT_THRESHOLD_PERCENT = 15;
const ZERO_AGGREGATE_RUNTIME: TokenEfficiencyAggregateRuntimeUsage = {
  totalTokens: 0,
  processedTokens: 0,
  processedTokenEvidence: "unavailable",
  cacheReadTokens: null,
  cacheWriteTokens: null,
  cacheMissCount: null,
  cacheMissInputTokens: null,
  p50PerScenario: 0,
  p90PerScenario: 0,
};
const ZERO_AGGREGATE: TokenEfficiencyReport["aggregate"] = {
  openclaw: { ...ZERO_AGGREGATE_RUNTIME },
  codex: { ...ZERO_AGGREGATE_RUNTIME },
  deltaPercent: 0,
  flaggedScenarios: [],
  savingsScenarios: [],
};

function normalizeRuntimePair(
  pair: [RuntimeId, RuntimeId] | null | undefined,
): [RuntimeId, RuntimeId] {
  if (pair?.[0] && pair?.[1]) {
    return pair;
  }
  return ["openclaw", "codex"];
}

function normalizeTokenCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function deltaPercent(openclawTotalTokens: number, codexTotalTokens: number): number {
  if (openclawTotalTokens === 0) {
    return codexTotalTokens === 0 ? 0 : 100;
  }
  return ((codexTotalTokens - openclawTotalTokens) / openclawTotalTokens) * 100;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].toSorted((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function isLiveProviderMode(providerMode: string | undefined) {
  return providerMode?.startsWith("live-") === true;
}

function formatPercent(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

function formatOptionalCount(value: number | null): string {
  return value === null ? "N/A" : String(value);
}

function formatProcessedCount(
  usage: Pick<TokenEfficiencyRuntimeUsage, "processedTokens" | "processedTokenEvidence">,
): string {
  return usage.processedTokenEvidence === "unavailable" ? "N/A" : String(usage.processedTokens);
}

function formatProcessedDelta(params: {
  deltaPercent: number;
  openclaw: Pick<TokenEfficiencyRuntimeUsage, "processedTokenEvidence">;
  codex: Pick<TokenEfficiencyRuntimeUsage, "processedTokenEvidence">;
}): string {
  return params.openclaw.processedTokenEvidence === "unavailable" ||
    params.codex.processedTokenEvidence === "unavailable"
    ? "N/A"
    : formatPercent(params.deltaPercent);
}

function formatCacheMisses(
  misses: readonly RuntimeParityCacheMiss[] | null,
  unmeasuredPostWarmTurns: readonly number[] | null,
): string {
  if (misses === null) {
    return unmeasuredPostWarmTurns?.length
      ? `N/A (unmeasured turns ${unmeasuredPostWarmTurns.join(", ")})`
      : "N/A";
  }
  const measuredMisses =
    misses.length === 0
      ? "none"
      : misses.map((miss) => `turn ${miss.turn} (${miss.inputTokens} input)`).join(", ");
  if (!unmeasuredPostWarmTurns?.length) {
    return measuredMisses;
  }
  const unknownTurns = `unmeasured turns ${unmeasuredPostWarmTurns.join(", ")}`;
  return measuredMisses === "none" ? `N/A (${unknownTurns})` : `${measuredMisses}; ${unknownTurns}`;
}

function runtimeUsage(cell: RuntimeParityCell): TokenEfficiencyRuntimeUsage {
  const inputTokens = normalizeTokenCount(cell.usage.inputTokens);
  const outputTokens = normalizeTokenCount(cell.usage.outputTokens);
  const totalTokens = normalizeTokenCount(cell.usage.totalTokens);
  const cacheReadTokens =
    cell.usage.cacheRead === undefined ? null : normalizeTokenCount(cell.usage.cacheRead);
  const cacheWriteTokens =
    cell.usage.cacheWrite === undefined ? null : normalizeTokenCount(cell.usage.cacheWrite);
  const cacheDiagnostics = cell.cacheDiagnostics;
  const baseProcessedTokens = inputTokens + outputTokens;
  const completeCacheTelemetry =
    cacheDiagnostics === undefined ||
    cacheDiagnostics.cacheTelemetryTurns === cacheDiagnostics.assistantTurns;
  const unaccountedCacheTokens =
    totalTokens - baseProcessedTokens - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0);
  let processedTokens = baseProcessedTokens;
  let processedTokenEvidence: ProcessedTokenEvidence = "unavailable";
  // Aggregate counters can omit an unmeasured turn. Only exact accounting
  // proves that omitted nonnegative cache reads and writes were both zero.
  if (
    cacheWriteTokens !== null &&
    unaccountedCacheTokens >= 0 &&
    (cacheReadTokens === null || unaccountedCacheTokens === 0) &&
    (completeCacheTelemetry || unaccountedCacheTokens === 0)
  ) {
    processedTokens += cacheWriteTokens;
    processedTokenEvidence = "measured";
  } else if (cacheReadTokens !== null && cacheWriteTokens === null && completeCacheTelemetry) {
    const derivedCacheWriteTokens = totalTokens - baseProcessedTokens - cacheReadTokens;
    if (derivedCacheWriteTokens >= 0) {
      processedTokens += derivedCacheWriteTokens;
      processedTokenEvidence = "derived";
    }
  } else if (totalTokens === baseProcessedTokens) {
    // Nonnegative usage components prove both missing cache counters are zero.
    processedTokenEvidence = "derived";
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    processedTokens,
    processedTokenEvidence,
    cacheReadTokens,
    cacheWriteTokens,
    cacheMisses:
      cacheDiagnostics && cacheDiagnostics.cacheTelemetryTurns > 0
        ? cacheDiagnostics.cacheMisses
        : null,
    unmeasuredPostWarmTurns: cacheDiagnostics?.unmeasuredPostWarmTurns ?? null,
    toolCallCount: cell.toolCalls.length,
  };
}

function toolNamesForCells(openclaw: RuntimeParityCell, codex: RuntimeParityCell): string[] {
  return [
    ...new Set([...openclaw.toolCalls, ...codex.toolCalls].map((call) => call.tool)),
  ].toSorted((left, right) => left.localeCompare(right));
}

function buildRow(params: {
  result: RuntimeParityResult;
  thresholdPercent: number;
  usageSource: TokenEfficiencyRow["usageSource"];
}): TokenEfficiencyRow {
  const openclaw = runtimeUsage(params.result.cells.openclaw);
  const codex = runtimeUsage(params.result.cells.codex);
  const comparable =
    openclaw.processedTokenEvidence !== "unavailable" &&
    codex.processedTokenEvidence !== "unavailable";
  const delta = comparable ? deltaPercent(openclaw.processedTokens, codex.processedTokens) : 0;
  const flagged = params.usageSource === "live-usage" && delta > params.thresholdPercent;
  const classification =
    delta > params.thresholdPercent
      ? "regression"
      : delta < -params.thresholdPercent
        ? "savings"
        : "neutral";
  return {
    scenarioId: params.result.scenarioId,
    usageSource: params.usageSource,
    openclaw,
    codex,
    deltaPercent: delta,
    classification,
    flagged,
    toolsUsed: toolNamesForCells(params.result.cells.openclaw, params.result.cells.codex),
  };
}

function sumKnownCounts(values: readonly (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) {
      return null;
    }
    total += value;
  }
  return total;
}

function buildAggregateRuntime(
  rows: readonly TokenEfficiencyRow[],
  runtime: RuntimeId,
): TokenEfficiencyAggregateRuntimeUsage {
  const usages = rows.map((row) => row[runtime]);
  const processedTotals = usages.map((usage) => usage.processedTokens);
  const processedTokenEvidence: ProcessedTokenEvidence = usages.some(
    (usage) => usage.processedTokenEvidence === "unavailable",
  )
    ? "unavailable"
    : usages.some((usage) => usage.processedTokenEvidence === "derived")
      ? "derived"
      : "measured";
  return {
    totalTokens: usages.reduce((sum, usage) => sum + usage.totalTokens, 0),
    processedTokens: processedTotals.reduce((sum, value) => sum + value, 0),
    processedTokenEvidence,
    cacheReadTokens: sumKnownCounts(usages.map((usage) => usage.cacheReadTokens)),
    cacheWriteTokens: sumKnownCounts(usages.map((usage) => usage.cacheWriteTokens)),
    cacheMissCount: sumKnownCounts(
      usages.map((usage) =>
        usage.unmeasuredPostWarmTurns?.length ? null : (usage.cacheMisses?.length ?? null),
      ),
    ),
    cacheMissInputTokens: sumKnownCounts(
      usages.map((usage) =>
        usage.unmeasuredPostWarmTurns?.length
          ? null
          : (usage.cacheMisses?.reduce((sum, cacheMiss) => sum + cacheMiss.inputTokens, 0) ?? null),
      ),
    ),
    p50PerScenario:
      processedTokenEvidence === "unavailable" ? null : percentile(processedTotals, 50),
    p90PerScenario:
      processedTokenEvidence === "unavailable" ? null : percentile(processedTotals, 90),
  };
}

function buildAggregate(rows: readonly TokenEfficiencyRow[]): TokenEfficiencyReport["aggregate"] {
  const openclaw = buildAggregateRuntime(rows, "openclaw");
  const codex = buildAggregateRuntime(rows, "codex");
  const comparable =
    openclaw.processedTokenEvidence !== "unavailable" &&
    codex.processedTokenEvidence !== "unavailable";
  return {
    openclaw,
    codex,
    deltaPercent: comparable ? deltaPercent(openclaw.processedTokens, codex.processedTokens) : 0,
    flaggedScenarios: rows.filter((row) => row.flagged).map((row) => row.scenarioId),
    savingsScenarios: rows
      .filter((row) => row.classification === "savings")
      .map((row) => row.scenarioId),
  };
}

function liveEvidenceFailures(row: TokenEfficiencyRow): string[] {
  const failures: string[] = [];
  if (row.openclaw.totalTokens <= 0) {
    failures.push(`${row.scenarioId} openclaw live usage totalTokens=${row.openclaw.totalTokens}`);
  }
  if (row.codex.totalTokens <= 0) {
    failures.push(`${row.scenarioId} codex live usage totalTokens=${row.codex.totalTokens}`);
  }
  for (const runtime of ["openclaw", "codex"] as const) {
    if (row[runtime].processedTokenEvidence === "unavailable") {
      failures.push(
        `${row.scenarioId} ${runtime} live processed-token usage cannot be verified from cache-write telemetry or coherent cache-read totals`,
      );
    }
  }
  return failures;
}

function liveUsageShapeFailures(
  scenarioId: string,
  runtime: RuntimeId,
  usage: RuntimeParityCell["usage"],
): string[] {
  const failures: string[] = [];
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    const value: unknown = usage[key];
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      !Number.isInteger(value) ||
      value < 0
    ) {
      failures.push(`${scenarioId} ${runtime} live usage ${key} must be a non-negative integer`);
    }
  }
  return failures;
}

export function buildTokenEfficiencyReport(
  params: BuildTokenEfficiencyReportParams,
): TokenEfficiencyReport {
  const providerMode = params.summary.run?.providerMode;
  const runtimePair = normalizeRuntimePair(params.summary.run?.runtimePair);
  const thresholdPercent = params.thresholdPercent ?? DEFAULT_THRESHOLD_PERCENT;
  const liveUsage = isLiveProviderMode(providerMode);
  const usageSource: TokenEfficiencyRow["usageSource"] = liveUsage ? "live-usage" : "mock-estimate";
  const parityResults = params.summary.scenarios
    .map((scenario) => scenario.runtimeParity)
    .filter((result): result is RuntimeParityResult => Boolean(result));

  if (parityResults.length === 0) {
    const noCapturesReason = "No runtime parity captures were present in the suite summary.";
    return {
      status: liveUsage ? "evaluated" : "skipped",
      runtimePair,
      generatedAt: params.generatedAt ?? new Date().toISOString(),
      ...(providerMode ? { providerMode } : {}),
      thresholdPercent,
      rows: [],
      notApplicableScenarios: [],
      aggregate: ZERO_AGGREGATE,
      pass: !liveUsage,
      failures: liveUsage ? [noCapturesReason] : [],
      ...(liveUsage ? {} : { skipReason: noCapturesReason }),
      notes: ["Token efficiency requires runtime-pair summaries with RuntimeParityResult cells."],
    };
  }

  const notApplicableScenarios = parityResults.flatMap((result) => {
    const usage = resolveRuntimeParityUsagePolicy(result.runtimeParityUsage);
    return usage.expectation === "not-applicable"
      ? [{ scenarioId: result.scenarioId, reason: usage.reason }]
      : [];
  });
  const usageApplicableResults = parityResults.filter(
    (result) =>
      resolveRuntimeParityUsagePolicy(result.runtimeParityUsage).expectation ===
      "assistant-message-required",
  );
  if (usageApplicableResults.length === 0) {
    const noApplicableReason =
      "No usage-applicable runtime parity captures were present in the suite summary.";
    return {
      status: liveUsage ? "evaluated" : "skipped",
      runtimePair,
      generatedAt: params.generatedAt ?? new Date().toISOString(),
      ...(providerMode ? { providerMode } : {}),
      thresholdPercent,
      rows: [],
      notApplicableScenarios,
      aggregate: ZERO_AGGREGATE,
      pass: !liveUsage,
      failures: liveUsage ? [noApplicableReason] : [],
      ...(liveUsage ? {} : { skipReason: noApplicableReason }),
      notes: ["Token efficiency requires at least one assistant-message usage capture."],
    };
  }

  const rows = usageApplicableResults.map((result) =>
    buildRow({
      result,
      thresholdPercent,
      usageSource,
    }),
  );
  const aggregate = buildAggregate(rows);
  const failures = rows.flatMap((row, index) => {
    const result = usageApplicableResults[index];
    const rowFailures =
      liveUsage && result
        ? [
            ...liveUsageShapeFailures(row.scenarioId, "openclaw", result.cells.openclaw.usage),
            ...liveUsageShapeFailures(row.scenarioId, "codex", result.cells.codex.usage),
            ...liveEvidenceFailures(row),
          ]
        : [];
    if (row.flagged) {
      rowFailures.push(
        `${row.scenarioId} token delta=${formatPercent(row.deltaPercent)} exceeds ${thresholdPercent.toFixed(1)}% Codex increase threshold`,
      );
    }
    return rowFailures;
  });

  return {
    status: liveUsage ? "evaluated" : "estimated",
    runtimePair,
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    ...(providerMode ? { providerMode } : {}),
    thresholdPercent,
    rows,
    notApplicableScenarios,
    aggregate,
    pass: failures.length === 0,
    failures,
    notes: [
      "Token totals are read from RuntimeParityCell.usage, which is captured from normalized AssistantMessage.usage.",
      "Efficiency deltas and percentiles compare newly processed uncached input, cache-write input, and output; reused cached input remains separately reported and never masks a regression.",
      "Missing cache-write counts are derived only when measured cache reads and coherent usage totals prove the exact processed input; otherwise live efficiency proof fails.",
      "Post-warm cache misses require measured zero cache reads and newly processed input after the same conversation has already established a cache; cache rewrites are included and unavailable telemetry is N/A.",
      "Codex savings are reported as savings and do not fail the gate; only positive Codex-over-OpenClaw live deltas exceed the threshold.",
      usageSource === "mock-estimate"
        ? "Mock-provider token totals are labeled as estimates and do not block the token-efficiency gate."
        : "The report does not inspect provider transport payload token counters.",
    ],
  };
}

export function renderTokenEfficiencyMarkdownReport(report: TokenEfficiencyReport): string {
  const lines = [
    `# OpenClaw Runtime Token Efficiency - ${report.runtimePair[0]} vs ${report.runtimePair[1]}`,
    "",
    `- Generated at: ${report.generatedAt}`,
    ...(report.providerMode ? [`- Provider mode: ${report.providerMode}`] : []),
    `- Verdict: ${report.status === "skipped" ? "skipped" : report.pass ? "pass" : "fail"}`,
    `- Usage source: ${report.rows[0]?.usageSource ?? "none"}`,
    `- Threshold: Codex processed-token increase > ${report.thresholdPercent.toFixed(1)}%`,
    "",
  ];

  if (report.skipReason) {
    lines.push(`- Skip reason: ${report.skipReason}`, "");
  }

  lines.push(
    "## Aggregate Metrics",
    "",
    "| Runtime | Processed tokens | Total tokens | Cached input | Cache writes | Post-warm cache misses | p50 per scenario | p90 per scenario |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| openclaw | ${formatProcessedCount(report.aggregate.openclaw)} | ${report.aggregate.openclaw.totalTokens} | ${formatOptionalCount(report.aggregate.openclaw.cacheReadTokens)} | ${formatOptionalCount(report.aggregate.openclaw.cacheWriteTokens)} | ${formatOptionalCount(report.aggregate.openclaw.cacheMissCount)} | ${formatOptionalCount(report.aggregate.openclaw.p50PerScenario)} | ${formatOptionalCount(report.aggregate.openclaw.p90PerScenario)} |`,
    `| codex | ${formatProcessedCount(report.aggregate.codex)} | ${report.aggregate.codex.totalTokens} | ${formatOptionalCount(report.aggregate.codex.cacheReadTokens)} | ${formatOptionalCount(report.aggregate.codex.cacheWriteTokens)} | ${formatOptionalCount(report.aggregate.codex.cacheMissCount)} | ${formatOptionalCount(report.aggregate.codex.p50PerScenario)} | ${formatOptionalCount(report.aggregate.codex.p90PerScenario)} |`,
    `| delta | ${formatProcessedDelta({ deltaPercent: report.aggregate.deltaPercent, openclaw: report.aggregate.openclaw, codex: report.aggregate.codex })} |  |  |  |  |  |  |`,
    "",
  );

  if (report.rows.length > 0) {
    lines.push(
      "## Scenario Efficiency",
      "",
      "| Scenario | Source | OpenClaw processed/in/out/cached/written/total/tools | Codex processed/in/out/cached/written/total/tools | Processed-token delta | Classification | Flagged | OpenClaw cache misses | Codex cache misses | Tools used |",
      "| --- | --- | ---: | ---: | ---: | --- | --- | --- | --- | --- |",
    );
    for (const row of report.rows) {
      lines.push(
        `| ${row.scenarioId} | ${row.usageSource} | ${formatProcessedCount(row.openclaw)}/${row.openclaw.inputTokens}/${row.openclaw.outputTokens}/${formatOptionalCount(row.openclaw.cacheReadTokens)}/${formatOptionalCount(row.openclaw.cacheWriteTokens)}/${row.openclaw.totalTokens}/${row.openclaw.toolCallCount} | ${formatProcessedCount(row.codex)}/${row.codex.inputTokens}/${row.codex.outputTokens}/${formatOptionalCount(row.codex.cacheReadTokens)}/${formatOptionalCount(row.codex.cacheWriteTokens)}/${row.codex.totalTokens}/${row.codex.toolCallCount} | ${formatProcessedDelta({ deltaPercent: row.deltaPercent, openclaw: row.openclaw, codex: row.codex })} | ${row.classification} | ${row.flagged ? "yes" : "no"} | ${formatCacheMisses(row.openclaw.cacheMisses, row.openclaw.unmeasuredPostWarmTurns)} | ${formatCacheMisses(row.codex.cacheMisses, row.codex.unmeasuredPostWarmTurns)} | ${row.toolsUsed.join(", ")} |`,
      );
    }
    lines.push("");
  }

  if (report.notApplicableScenarios.length > 0) {
    lines.push("## Usage Not Applicable", "");
    for (const scenario of report.notApplicableScenarios) {
      lines.push(`- ${scenario.scenarioId}: ${scenario.reason}`);
    }
    lines.push("");
  }

  if (report.failures.length > 0) {
    lines.push("## Gate Failures", "");
    for (const failure of report.failures) {
      lines.push(`- ${failure}`);
    }
    lines.push("");
  }

  lines.push("## Notes", "");
  for (const note of report.notes) {
    lines.push(`- ${note}`);
  }
  lines.push("");

  return lines.join("\n");
}
