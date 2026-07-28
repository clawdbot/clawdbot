#!/usr/bin/env node
// Summarizes Kova CI run metadata for diagnostics.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const knownArgKeys = new Set(["report", "output", "lane", "reporturl", "artifacturl"]);
const rawArgs = process.argv.slice(2);
if (shouldPrintHelp(rawArgs)) {
  usage("", 0);
}

const args = parseArgs(rawArgs);
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
const rssMetricIds = ["peakRssMb", "resourcePeakGatewayRssMb"];
const cpuMetricIds = ["cpuPercentMax"];
const reportPath = path.resolve(args.report);
const report = JSON.parse(await readFile(reportPath, "utf8"));
const invalidReport = validateKovaSummaryReport(report);
if (invalidReport) {
  console.error(`error: invalid Kova report: ${invalidReport}`);
  process.exit(1);
}
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

function renderSummary(reportLocal, options) {
  const lines = [];
  const statuses = reportLocal.summary?.statuses || {};
  const statusText =
    Object.entries(statuses)
      .map(([status, count]) => `${status}: ${value(count)}`)
      .join(", ") || "unknown";

  lines.push(`# OpenClaw Performance Report`);
  lines.push("");
  lines.push(`- Lane: ${options.lane}`);
  lines.push(`- Run: ${value(reportLocal.runId)}`);
  lines.push(`- Generated: ${value(reportLocal.generatedAt)}`);
  lines.push(`- Target: ${value(reportLocal.target)}`);
  lines.push(`- Statuses: ${statusText}`);
  lines.push(`- Repeat: ${value(reportLocal.performance?.repeat)}`);
  if (options.reportUrl) {
    lines.push(`- Published report: ${options.reportUrl}`);
  }
  if (options.artifactUrl) {
    lines.push(`- GitHub artifact: ${options.artifactUrl}`);
  }
  lines.push("");

  const groups = Array.isArray(reportLocal.performance?.groups)
    ? reportLocal.performance.groups
    : [];
  const metricRows = [];
  for (const group of groups) {
    for (const metricId of keyMetricIds) {
      const metric = group.metrics?.[metricId];
      if (!hasPositiveSampleCount(metric)) {
        continue;
      }
      metricRows.push(
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
  if (metricRows.length > 0) {
    lines.push("## Key metrics");
    lines.push("");
    lines.push("| Scenario | State | Metric | Median | p95 | Max |");
    lines.push("| --- | --- | --- | ---: | ---: | ---: |");
    lines.push(...metricRows);
    lines.push("");
  } else if (groups.length > 0) {
    lines.push("## Key metrics");
    lines.push("");
    lines.push("- No sampled key metrics were available; inspect the blocking records below.");
    lines.push("");
  }

  const violations = collectViolations(reportLocal.records);
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

  const records = Array.isArray(reportLocal.records) ? reportLocal.records : [];
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

function validateKovaSummaryReport(reportLocal) {
  if (!reportLocal || typeof reportLocal !== "object" || Array.isArray(reportLocal)) {
    return "report must be an object";
  }
  const statuses = reportLocal.summary?.statuses;
  if (
    !statuses ||
    typeof statuses !== "object" ||
    Array.isArray(statuses) ||
    Object.keys(statuses).length === 0
  ) {
    return "missing summary.statuses";
  }
  const records = Array.isArray(reportLocal.records) ? reportLocal.records : [];
  const groups = Array.isArray(reportLocal.performance?.groups)
    ? reportLocal.performance.groups
    : [];
  if (records.length === 0 && groups.length === 0) {
    return "missing records or performance groups";
  }
  if (
    groups.length > 0 &&
    reportHasOnlyPassingStatuses(statuses) &&
    !hasExplicitResourceCollectionSkip(reportLocal)
  ) {
    if (!groups.some((group) => hasSampledMetric(group, rssMetricIds))) {
      return "missing sampled RSS metric in performance groups";
    }
    if (!groups.some((group) => hasSampledMetric(group, cpuMetricIds))) {
      return "missing sampled CPU metric in performance groups";
    }
  }
  return null;
}

function reportHasOnlyPassingStatuses(statuses) {
  const populated = Object.entries(statuses).filter(([, count]) => Number(count) > 0);
  return (
    populated.length > 0 && populated.every(([status]) => status.trim().toUpperCase() === "PASS")
  );
}

function hasExplicitResourceCollectionSkip(reportLocal) {
  const reason = reportLocal.performance?.resourceCollectionSkippedReason;
  return typeof reason === "string" && reason.trim().length > 0;
}

function hasSampledMetric(group, metricIds) {
  return metricIds.some((metricId) => hasPositiveSampleCount(group?.metrics?.[metricId]));
}

function hasPositiveSampleCount(metric) {
  return Number.isSafeInteger(metric?.count) && metric.count > 0;
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
    if (!knownArgKeys.has(key)) {
      usage(`unknown argument: ${arg}`);
    }
    const valueLocal = argv[index + 1];
    if (!valueLocal || valueLocal.startsWith("-")) {
      usage(`${arg} requires a value`);
    }
    parsed[key] = valueLocal;
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

function shouldPrintHelp(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return true;
    }
    if (!arg.startsWith("--")) {
      return false;
    }
    const key = arg.slice(2).replaceAll("-", "");
    if (!knownArgKeys.has(key)) {
      return false;
    }
    const optionValue = argv[index + 1];
    if (!optionValue || optionValue.startsWith("-")) {
      return false;
    }
    index += 1;
  }
  return false;
}

function usage(message, status = 2) {
  const text =
    "usage: node scripts/kova-ci-summary.mjs --report <report.json> [--output <summary.md>] [--lane <name>] [--report-url <url>] [--artifact-url <url>]\n";
  if (message) {
    console.error(`error: ${message}`);
  }
  if (status === 0 && !message) {
    process.stdout.write(text);
  } else {
    process.stderr.write(text);
  }
  process.exit(status);
}
