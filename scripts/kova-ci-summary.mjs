#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
if (!args.report) {
  usage("missing --report");
}

const keyMetricIds = [
  "timeToHealthReadyMs",
  "timeToListeningMs",
  "healthP95Ms",
  "peakRssMb",
  "resourcePeakGatewayRssMb",
  "cpuPercentMax",
  "openclawEventLoopMaxMs",
  "agentTurnP95Ms",
  "coldAgentTurnMs",
  "warmAgentTurnMs",
  "agentPreProviderP95Ms",
  "agentProviderFinalP95Ms",
  "agentCleanupP95Ms",
  "runtimeDepsStagingMs",
];

const reportPath = path.resolve(args.report);
const report = JSON.parse(await readFile(reportPath, "utf8"));
const markdown = renderSummary(report, {
  lane: args.lane || "kova",
  reportUrl: args.reportUrl || "",
  artifactUrl: args.artifactUrl || "",
});

if (args.output) {
  await writeFile(path.resolve(args.output), markdown, "utf8");
} else {
  process.stdout.write(markdown);
}

function renderSummary(report, options) {
  const lines = [];
  const statuses = report.summary?.statuses || {};
  const statusText =
    Object.entries(statuses)
      .map(([status, count]) => `${status}: ${value(count)}`)
      .join(", ") || "unknown";

  lines.push(`# OpenClaw Performance Report`);
  lines.push("");
  lines.push(`- Lane: ${options.lane}`);
  lines.push(`- Run: ${value(report.runId)}`);
  lines.push(`- Generated: ${value(report.generatedAt)}`);
  lines.push(`- Target: ${value(report.target)}`);
  lines.push(`- Statuses: ${statusText}`);
  lines.push(`- Repeat: ${value(report.performance?.repeat)}`);
  if (options.reportUrl) {
    lines.push(`- Published report: ${options.reportUrl}`);
  }
  if (options.artifactUrl) {
    lines.push(`- GitHub artifact: ${options.artifactUrl}`);
  }
  lines.push("");

  const groups = Array.isArray(report.performance?.groups) ? report.performance.groups : [];
  if (groups.length > 0) {
    lines.push("## Key metrics");
    lines.push("");
    lines.push("| Scenario | State | Metric | Median | p95 | Max |");
    lines.push("| --- | --- | --- | ---: | ---: | ---: |");
    for (const group of groups) {
      for (const metricId of keyMetricIds) {
        const metric = group.metrics?.[metricId];
        if (!metric || metric.count === 0) {
          continue;
        }
        lines.push(
          [
            value(group.scenario),
            value(group.state),
            value(metric.title || metricId),
            formatMetric(metric.median, metric.unit),
            formatMetric(metric.p95, metric.unit),
            formatMetric(metric.max, metric.unit),
          ]
            .join(" | ")
            .replace(/^/, "| ")
            .replace(/$/, " |"),
        );
      }
    }
    lines.push("");
  }

  const violations = collectViolations(report.records);
  if (violations.length > 0) {
    lines.push("## Threshold violations");
    lines.push("");
    lines.push("| Scenario | State | Metric | Actual | Threshold |");
    lines.push("| --- | --- | --- | ---: | ---: |");
    for (const item of violations.slice(0, 20)) {
      lines.push(
        [
          item.scenario,
          item.state,
          item.metric,
          formatMetric(item.actual, item.unit),
          formatMetric(item.threshold, item.unit),
        ]
          .join(" | ")
          .replace(/^/, "| ")
          .replace(/$/, " |"),
      );
    }
    if (violations.length > 20) {
      lines.push("");
      lines.push(`_Only first 20 of ${violations.length} violations shown._`);
    }
    lines.push("");
  }

  const records = Array.isArray(report.records) ? report.records : [];
  if (records.length > 0) {
    lines.push("## Records");
    lines.push("");
    lines.push("| Scenario | State | Status | Failure |");
    lines.push("| --- | --- | --- | --- |");
    for (const record of records.slice(0, 30)) {
      lines.push(
        [
          value(record.scenario),
          value(record.state?.id ?? record.state),
          value(record.status),
          value(record.failureReason || record.error?.message || ""),
        ]
          .join(" | ")
          .replace(/^/, "| ")
          .replace(/$/, " |"),
      );
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function collectViolations(records) {
  if (!Array.isArray(records)) {
    return [];
  }
  return records.flatMap((record) => {
    if (!Array.isArray(record.violations)) {
      return [];
    }
    return record.violations.map((violation) => ({
      scenario: value(record.scenario),
      state: value(record.state?.id ?? record.state),
      metric: value(violation.metric || violation.id || violation.name),
      actual: violation.actual ?? violation.value,
      threshold: violation.threshold ?? violation.max ?? violation.expected,
      unit: violation.unit,
    }));
  });
}

function formatMetric(valueToFormat, unit) {
  if (valueToFormat === null || valueToFormat === undefined || Number.isNaN(valueToFormat)) {
    return "";
  }
  const numeric = Number(valueToFormat);
  const rendered = Number.isFinite(numeric)
    ? numeric.toLocaleString("en-US", { maximumFractionDigits: numeric >= 100 ? 0 : 1 })
    : String(valueToFormat);
  return unit ? `${rendered} ${unit}` : rendered;
}

function value(input) {
  if (input === null || input === undefined) {
    return "";
  }
  return String(input).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      usage(`unexpected argument: ${arg}`);
    }
    const key = arg.slice(2).replaceAll("-", "");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      usage(`${arg} requires a value`);
    }
    parsed[key] = value;
    index += 1;
  }
  return {
    report: parsed.report,
    output: parsed.output,
    lane: parsed.lane,
    reportUrl: parsed.reporturl,
    artifactUrl: parsed.artifacturl,
  };
}

function usage(message) {
  if (message) {
    console.error(`error: ${message}`);
  }
  console.error(
    "usage: node scripts/kova-ci-summary.mjs --report <report.json> [--output <summary.md>] [--lane <name>]",
  );
  process.exit(2);
}
