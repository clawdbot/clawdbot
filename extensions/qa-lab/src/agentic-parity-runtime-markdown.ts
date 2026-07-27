import {
  formatRuntimeCacheCount,
  formatRuntimeCacheHitPercent,
} from "./agentic-parity-cache-usage.js";
import type { QaRuntimeParityReport } from "./agentic-parity-runtime-report-contract.js";
import { formatRuntimeSpeedComparison, formatRuntimeWallClockMs } from "./runtime-parity-timing.js";

export function renderQaRuntimeParityMarkdownReport(report: QaRuntimeParityReport): string {
  const lines = [
    `# OpenClaw Runtime Parity Report — ${report.runtimePair[0]} vs ${report.runtimePair[1]}`,
    "",
    `- Compared at: ${report.comparedAt}`,
    `- Provider mode: ${report.providerMode ?? "unknown"}`,
    `- Primary model: ${report.primaryModel ?? "unknown"}`,
    `- Verdict: ${report.pass ? "pass" : "fail"}`,
    "",
    "## Aggregate Metrics",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Total scenarios | ${report.totalScenarios} |`,
    `| Passed scenarios | ${report.passedScenarios} |`,
    `| Failed scenarios | ${report.failedScenarios} |`,
    `| No drift | ${report.driftCounts.none} |`,
    `| Text-only drift | ${report.driftCounts["text-only"]} |`,
    `| Tool-call-shape drift | ${report.driftCounts["tool-call-shape"]} |`,
    `| Tool-result-shape drift | ${report.driftCounts["tool-result-shape"]} |`,
    `| Structural drift | ${report.driftCounts.structural} |`,
    `| Failure-mode drift | ${report.driftCounts["failure-mode"]} |`,
    "",
    "## Prompt Cache",
    "",
    "| Runtime | Gross input | Uncached input | Cached input | Cache writes | Output | Total tokens | Cache hit |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| openclaw | ${formatRuntimeCacheCount(report.usage.openclaw?.grossInputTokens)} | ${formatRuntimeCacheCount(report.usage.openclaw?.uncachedInputTokens)} | ${formatRuntimeCacheCount(report.usage.openclaw?.cachedInputTokens)} | ${formatRuntimeCacheCount(report.usage.openclaw?.cacheWriteTokens)} | ${formatRuntimeCacheCount(report.usage.openclaw?.outputTokens)} | ${formatRuntimeCacheCount(report.usage.openclaw?.totalTokens)} | ${formatRuntimeCacheHitPercent(report.usage.openclaw?.cacheHitPercent)} |`,
    `| codex | ${formatRuntimeCacheCount(report.usage.codex?.grossInputTokens)} | ${formatRuntimeCacheCount(report.usage.codex?.uncachedInputTokens)} | ${formatRuntimeCacheCount(report.usage.codex?.cachedInputTokens)} | ${formatRuntimeCacheCount(report.usage.codex?.cacheWriteTokens)} | ${formatRuntimeCacheCount(report.usage.codex?.outputTokens)} | ${formatRuntimeCacheCount(report.usage.codex?.totalTokens)} | ${formatRuntimeCacheHitPercent(report.usage.codex?.cacheHitPercent)} |`,
    "",
    "## Runtime Timing",
    "",
    "| Runtime | Total wall time | p50 per scenario | p90 per scenario |",
    "| --- | ---: | ---: | ---: |",
    `| openclaw | ${formatRuntimeWallClockMs(report.timing.openclaw.totalWallClockMs)} | ${formatRuntimeWallClockMs(report.timing.openclaw.p50WallClockMs)} | ${formatRuntimeWallClockMs(report.timing.openclaw.p90WallClockMs)} |`,
    `| codex | ${formatRuntimeWallClockMs(report.timing.codex.totalWallClockMs)} | ${formatRuntimeWallClockMs(report.timing.codex.p50WallClockMs)} | ${formatRuntimeWallClockMs(report.timing.codex.p90WallClockMs)} |`,
    "",
    `- Faster runtime: ${formatRuntimeSpeedComparison(report.timing)}`,
    "",
  ];
  if (report.timing.bootstrap) {
    lines.push(
      "## Gateway Bootstrap (Excluded From Runtime Timing)",
      "",
      "| Runtime | Total bootstrap | p50 per scenario | p90 per scenario |",
      "| --- | ---: | ---: | ---: |",
      `| openclaw | ${formatRuntimeWallClockMs(report.timing.bootstrap.openclaw.totalWallClockMs)} | ${formatRuntimeWallClockMs(report.timing.bootstrap.openclaw.p50WallClockMs)} | ${formatRuntimeWallClockMs(report.timing.bootstrap.openclaw.p90WallClockMs)} |`,
      `| codex | ${formatRuntimeWallClockMs(report.timing.bootstrap.codex.totalWallClockMs)} | ${formatRuntimeWallClockMs(report.timing.bootstrap.codex.p50WallClockMs)} | ${formatRuntimeWallClockMs(report.timing.bootstrap.codex.p90WallClockMs)} |`,
      "",
    );
  }
  if (report.failures.length > 0) {
    lines.push("## Gate Failures", "");
    for (const failure of report.failures) {
      lines.push(`- ${failure}`);
    }
    lines.push("");
  }
  lines.push("## Scenario Comparison", "");
  for (const scenario of report.scenarios) {
    const usageNotApplicable = scenario.runtimeParityUsage.expectation === "not-applicable";
    const openclawTokens = usageNotApplicable ? "N/A" : String(scenario.openclawTokens);
    const codexTokens = usageNotApplicable ? "N/A" : String(scenario.codexTokens);
    lines.push(`### ${scenario.name}`, "");
    lines.push(`- status: ${scenario.status}`);
    lines.push(`- drift: ${scenario.drift}`);
    lines.push(
      `- openclaw: ${scenario.openclawStatus} (${scenario.openclawToolCalls} tool calls, ${openclawTokens} tokens)`,
    );
    lines.push(
      `- codex: ${scenario.codexStatus} (${scenario.codexToolCalls} tool calls, ${codexTokens} tokens)`,
    );
    lines.push(
      `- wall time: openclaw ${formatRuntimeWallClockMs(scenario.openclawWallClockMs)}; codex ${formatRuntimeWallClockMs(scenario.codexWallClockMs)}; ${formatRuntimeSpeedComparison(scenario)}`,
    );
    if (
      scenario.openclawBootstrapWallClockMs !== undefined ||
      scenario.codexBootstrapWallClockMs !== undefined
    ) {
      lines.push(
        `- gateway bootstrap (excluded): openclaw ${formatRuntimeWallClockMs(scenario.openclawBootstrapWallClockMs ?? null)}; codex ${formatRuntimeWallClockMs(scenario.codexBootstrapWallClockMs ?? null)}`,
      );
    }
    lines.push(
      `- prompt cache: openclaw ${formatRuntimeCacheHitPercent(scenario.openclawUsage?.cacheHitPercent)} (${formatRuntimeCacheCount(scenario.openclawUsage?.cachedInputTokens)} cached, ${formatRuntimeCacheCount(scenario.openclawUsage?.uncachedInputTokens)} uncached input); codex ${formatRuntimeCacheHitPercent(scenario.codexUsage?.cacheHitPercent)} (${formatRuntimeCacheCount(scenario.codexUsage?.cachedInputTokens)} cached, ${formatRuntimeCacheCount(scenario.codexUsage?.uncachedInputTokens)} uncached input)`,
    );
    if (scenario.runtimeParityUsage.expectation === "not-applicable") {
      lines.push(`- assistant-message usage: N/A (${scenario.runtimeParityUsage.reason})`);
    }
    if (scenario.driftDetails) {
      lines.push(`- details: ${scenario.driftDetails}`);
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
