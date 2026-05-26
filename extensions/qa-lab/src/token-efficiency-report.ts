import { sortUniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { RuntimeId, RuntimeParityCell, RuntimeParityResult } from "./runtime-parity.js";

export type TokenEfficiencyRuntimeUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCallCount: number;
};

export type TokenEfficiencyRow = {
  scenarioId: string;
  usageSource: "live-usage" | "mock-estimate";
  pi: TokenEfficiencyRuntimeUsage;
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
  aggregate: {
    pi: { totalTokens: number; p50PerScenario: number; p90PerScenario: number };
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
  pi: { totalTokens: 0, p50PerScenario: 0, p90PerScenario: 0 },
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
  return ["pi", "codex"];
}

function normalizeTokenCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function deltaPercent(piTotalTokens: number, codexTotalTokens: number): number {
  if (piTotalTokens === 0) {
    return codexTotalTokens === 0 ? 0 : 100;
  }
  return ((codexTotalTokens - piTotalTokens) / piTotalTokens) * 100;
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

function toolNamesForCells(pi: RuntimeParityCell, codex: RuntimeParityCell): string[] {
  return sortUniqueStrings([...pi.toolCalls, ...codex.toolCalls].map((call) => call.tool));
}

function buildRow(params: {
  result: RuntimeParityResult;
  thresholdPercent: number;
  usageSource: TokenEfficiencyRow["usageSource"];
}): TokenEfficiencyRow {
  const pi = runtimeUsage(params.result.cells.pi);
  const codex = runtimeUsage(params.result.cells.codex);
  const delta = deltaPercent(pi.totalTokens, codex.totalTokens);
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
    pi,
    codex,
    deltaPercent: delta,
    classification,
    flagged,
    toolsUsed: toolNamesForCells(params.result.cells.pi, params.result.cells.codex),
  };
}

function buildAggregate(rows: readonly TokenEfficiencyRow[]): TokenEfficiencyReport["aggregate"] {
  const piTotals = rows.map((row) => row.pi.totalTokens);
  const codexTotals = rows.map((row) => row.codex.totalTokens);
  const piTotalTokens = piTotals.reduce((sum, value) => sum + value, 0);
  const codexTotalTokens = codexTotals.reduce((sum, value) => sum + value, 0);
  return {
    pi: {
      totalTokens: piTotalTokens,
      p50PerScenario: percentile(piTotals, 50),
      p90PerScenario: percentile(piTotals, 90),
    },
    codex: {
      totalTokens: codexTotalTokens,
      p50PerScenario: percentile(codexTotals, 50),
      p90PerScenario: percentile(codexTotals, 90),
    },
    deltaPercent: deltaPercent(piTotalTokens, codexTotalTokens),
    flaggedScenarios: rows.filter((row) => row.flagged).map((row) => row.scenarioId),
    savingsScenarios: rows
      .filter((row) => row.classification === "savings")
      .map((row) => row.scenarioId),
  };
}

function liveEvidenceFailures(row: TokenEfficiencyRow): string[] {
  const failures: string[] = [];
  if (row.pi.totalTokens <= 0) {
    failures.push(`${row.scenarioId} pi live usage totalTokens=${row.pi.totalTokens}`);
  }
  if (row.codex.totalTokens <= 0) {
    failures.push(`${row.scenarioId} codex live usage totalTokens=${row.codex.totalTokens}`);
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
    .filter((result): result is RuntimeParityResult => !!result);

  if (parityResults.length === 0) {
    return {
      status: "skipped",
      runtimePair,
      generatedAt: params.generatedAt ?? new Date().toISOString(),
      ...(providerMode ? { providerMode } : {}),
      thresholdPercent,
      rows: [],
      aggregate: ZERO_AGGREGATE,
      pass: true,
      failures: [],
      skipReason: "No runtime parity captures were present in the suite summary.",
      notes: ["Token efficiency requires runtime-pair summaries with RuntimeParityResult cells."],
    };
  }

  const rows = parityResults.map((result) =>
    buildRow({
      result,
      thresholdPercent,
      usageSource,
    }),
  );
  const aggregate = buildAggregate(rows);
  const failures = rows.flatMap((row) => {
    const rowFailures = liveUsage ? liveEvidenceFailures(row) : [];
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
    aggregate,
    pass: failures.length === 0,
    failures,
    notes: [
      "Token totals are read from RuntimeParityCell.usage, which is captured from normalized AssistantMessage.usage.",
      "Codex savings are reported as savings and do not fail the gate; only positive Codex-over-Pi live deltas exceed the threshold.",
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
    `| pi | ${report.aggregate.pi.totalTokens} | ${report.aggregate.pi.p50PerScenario} | ${report.aggregate.pi.p90PerScenario} |`,
    `| codex | ${report.aggregate.codex.totalTokens} | ${report.aggregate.codex.p50PerScenario} | ${report.aggregate.codex.p90PerScenario} |`,
    `| delta | ${formatPercent(report.aggregate.deltaPercent)} |  |  |`,
    "",
  );

  if (report.rows.length > 0) {
    lines.push(
      "## Scenario Efficiency",
      "",
      "| Scenario | Source | Pi in/out/total/tools | Codex in/out/total/tools | Token delta | Classification | Flagged | Tools used |",
      "| --- | --- | ---: | ---: | ---: | --- | --- | --- |",
    );
    for (const row of report.rows) {
      lines.push(
        `| ${row.scenarioId} | ${row.usageSource} | ${row.pi.inputTokens}/${row.pi.outputTokens}/${row.pi.totalTokens}/${row.pi.toolCallCount} | ${row.codex.inputTokens}/${row.codex.outputTokens}/${row.codex.totalTokens}/${row.codex.toolCallCount} | ${formatPercent(row.deltaPercent)} | ${row.classification} | ${row.flagged ? "yes" : "no"} | ${row.toolsUsed.join(", ")} |`,
      );
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
