#!/usr/bin/env node
// Summarizes Kova CI run metadata for diagnostics.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "./lib/record-shared.mjs";

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
type Metric = Partial<Record<"count" | "title" | "median" | "p95" | "max" | "unit", unknown>>;
type PerformanceGroup = Partial<Record<"scenario" | "state", unknown>> & {
  metrics?: Record<string, Metric | undefined>;
};
type KovaRecord = Partial<Record<"scenario" | "state" | "status" | "failureReason", unknown>> & {
  error?: { message?: unknown };
  violations?: Array<Record<string, unknown>>;
};
type KovaReport = Partial<Record<"runId" | "generatedAt" | "target", unknown>> & {
  summary?: { statuses?: Record<string, unknown> };
  performance?: {
    repeat?: unknown;
    groups?: PerformanceGroup[];
    resourceCollectionSkippedReason?: unknown;
  };
  records?: KovaRecord[];
};
type SummaryOptions = { lane: string; reportUrl: string; artifactUrl: string };

const report: KovaReport = JSON.parse(await readFile(reportPath, "utf8"));
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

function renderSummary(reportLocal: KovaReport, options: SummaryOptions) {
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
      if (!metric || !hasPositiveSampleCount(metric)) {
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
          value(stateValue(record.state)),
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

function validateKovaSummaryReport(reportLocal: KovaReport) {
  if (!isRecord(reportLocal)) {
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

function reportHasOnlyPassingStatuses(statuses: Record<string, unknown>) {
  const populated = Object.entries(statuses).filter(([, count]) => Number(count) > 0);
  return (
    populated.length > 0 && populated.every(([status]) => status.trim().toUpperCase() === "PASS")
  );
}

function hasExplicitResourceCollectionSkip(reportLocal: KovaReport) {
  const reason = reportLocal.performance?.resourceCollectionSkippedReason;
  return typeof reason === "string" && reason.trim().length > 0;
}

function hasSampledMetric(group: PerformanceGroup, metricIds: string[]) {
  return metricIds.some((metricId) => hasPositiveSampleCount(group?.metrics?.[metricId]));
}

function hasPositiveSampleCount(metric: Metric | undefined) {
  return (
    typeof metric?.count === "number" && Number.isSafeInteger(metric.count) && metric.count > 0
  );
}

function stateValue(state: unknown): unknown {
  return isRecord(state) ? state.id : state;
}

function collectViolations(records: KovaRecord[] | undefined) {
  if (!Array.isArray(records)) {
    return [];
  }
  return records.flatMap((record) => {
    if (!Array.isArray(record.violations)) {
      return [];
    }
    return record.violations.map((violation) => ({
      scenario: value(record.scenario),
      state: value(stateValue(record.state)),
      metric: value(violation.metric || violation.id || violation.name),
      actual: violation.actual ?? violation.value,
      threshold: violation.threshold ?? violation.max ?? violation.expected,
      unit: violation.unit,
    }));
  });
}

function formatMetric(valueToFormat: unknown, unit: unknown) {
  if (
    valueToFormat === null ||
    valueToFormat === undefined ||
    (typeof valueToFormat === "number" && Number.isNaN(valueToFormat))
  ) {
    return "";
  }
  const numeric = Number(valueToFormat);
  const rendered = Number.isFinite(numeric)
    ? numeric.toLocaleString("en-US", { maximumFractionDigits: numeric >= 100 ? 0 : 1 })
    : value(valueToFormat);
  const unitText = value(unit);
  return unitText ? `${rendered} ${unitText}` : rendered;
}

function value(input: unknown) {
  if (input === null || input === undefined) {
    return "";
  }
  const rendered =
    typeof input === "string" ||
    typeof input === "number" ||
    typeof input === "boolean" ||
    typeof input === "bigint"
      ? String(input)
      : (JSON.stringify(input) ?? "");
  return rendered.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function parseArgs(argv: string[]) {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) {
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

function shouldPrintHelp(argv: string[]) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return true;
    }
    if (!arg?.startsWith("--")) {
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

function usage(message: string, status = 2): never {
  const text =
    "usage: node --import tsx scripts/kova-ci-summary.mts --report <report.json> [--output <summary.md>] [--lane <name>] [--report-url <url>] [--artifact-url <url>]\n";
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
