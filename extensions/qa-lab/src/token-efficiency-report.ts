// Qa Lab plugin module implements token efficiency report behavior.
import type { RuntimeId, RuntimeParityCell, RuntimeParityResult } from "./runtime-parity.js";
import { resolveRuntimeParityUsagePolicy } from "./runtime-parity.js";

export type TokenEfficiencyRuntimeUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCallCount: number;
};

export type TokenEfficiencyRow = {
  scenarioId: string;
  usageSource: "live-usage" | "mock-estimate";
  openclaw: TokenEfficiencyRuntimeUsage;
  codex: TokenEfficiencyRuntimeUsage;
  deltaPercent: number;
  classification: "regression" | "savings" | "neutral";
  flagged: boolean;
  toolsUsed: string[];
};

export type TokenEfficiencyReport = {
  status: "evaluated" | "estimated" | "skipped";
  runtimePair: [RuntimeId, RuntimeId];
  generatedAt: string;
  providerMode?: string;
  thresholdPercent: number;
  rows: TokenEfficiencyRow[];
  notApplicableScenarios: Array<{ scenarioId: string; reason: string }>;
  aggregate: {
    openclaw: { totalTokens: number; p50PerScenario: number; p90PerScenario: number };
    codex: { totalTokens: number; p50PerScenario: number; p90PerScenario: number };
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

export type BuildTokenEfficiencyReportParams = {
  summary: TokenEfficiencySuiteSummary;
  generatedAt?: string;
  thresholdPercent?: number;
};

const DEFAULT_THRESHOLD_PERCENT = 15;
const ZERO_AGGREGATE: TokenEfficiencyReport["aggregate"] = {
  openclaw: { totalTokens: 0, p50PerScenario: 0, p90PerScenario: 0 },
  codex: { totalTokens: 0, p50PerScenario: 0, p90PerScenario: 0 },
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

function runtimeUsage(cell: RuntimeParityCell): TokenEfficiencyRuntimeUsage {
  return {
    inputTokens: normalizeTokenCount(cell.usage.inputTokens),
    outputTokens: normalizeTokenCount(cell.usage.outputTokens),
    totalTokens: normalizeTokenCount(cell.usage.totalTokens),
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
  const delta = deltaPercent(openclaw.totalTokens, codex.totalTokens);
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

function buildAggregate(rows: readonly TokenEfficiencyRow[]): TokenEfficiencyReport["aggregate"] {
  const openclawTotals = rows.map((row) => row.openclaw.totalTokens);
  const codexTotals = rows.map((row) => row.codex.totalTokens);
  const openclawTotalTokens = openclawTotals.reduce((sum, value) => sum + value, 0);
  const codexTotalTokens = codexTotals.reduce((sum, value) => sum + value, 0);
  return {
    openclaw: {
      totalTokens: openclawTotalTokens,
      p50PerScenario: percentile(openclawTotals, 50),
      p90PerScenario: percentile(openclawTotals, 90),
    },
    codex: {
      totalTokens: codexTotalTokens,
      p50PerScenario: percentile(codexTotals, 50),
      p90PerScenario: percentile(codexTotals, 90),
    },
    deltaPercent: deltaPercent(openclawTotalTokens, codexTotalTokens),
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
    `- Threshold: Codex token increase > ${report.thresholdPercent.toFixed(1)}%`,
    "",
  ];

  if (report.skipReason) {
    lines.push(`- Skip reason: ${report.skipReason}`, "");
  }

  lines.push(
    "## Aggregate Metrics",
    "",
    "| Runtime | Total tokens | p50 per scenario | p90 per scenario |",
    "| --- | ---: | ---: | ---: |",
    `| openclaw | ${report.aggregate.openclaw.totalTokens} | ${report.aggregate.openclaw.p50PerScenario} | ${report.aggregate.openclaw.p90PerScenario} |`,
    `| codex | ${report.aggregate.codex.totalTokens} | ${report.aggregate.codex.p50PerScenario} | ${report.aggregate.codex.p90PerScenario} |`,
    `| delta | ${formatPercent(report.aggregate.deltaPercent)} |  |  |`,
    "",
  );

  if (report.rows.length > 0) {
    lines.push(
      "## Scenario Efficiency",
      "",
      "| Scenario | Source | OpenClaw in/out/total/tools | Codex in/out/total/tools | Token delta | Classification | Flagged | Tools used |",
      "| --- | --- | ---: | ---: | ---: | --- | --- | --- |",
    );
    for (const row of report.rows) {
      lines.push(
        `| ${row.scenarioId} | ${row.usageSource} | ${row.openclaw.inputTokens}/${row.openclaw.outputTokens}/${row.openclaw.totalTokens}/${row.openclaw.toolCallCount} | ${row.codex.inputTokens}/${row.codex.outputTokens}/${row.codex.totalTokens}/${row.codex.toolCallCount} | ${formatPercent(row.deltaPercent)} | ${row.classification} | ${row.flagged ? "yes" : "no"} | ${row.toolsUsed.join(", ")} |`,
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
