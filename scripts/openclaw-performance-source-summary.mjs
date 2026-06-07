#!/usr/bin/env node

// Summarizes OpenClaw performance source fixtures for reports.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

export function parseArgs(argv) {
  const options = { baselineSourceDir: null, sourceDir: null, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = readOptionValue(argv, index, arg);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--source-dir":
        options.sourceDir = path.resolve(readValue());
        break;
      case "--baseline-source-dir":
        options.baselineSourceDir = path.resolve(readValue());
        break;
      case "--output":
        options.output = path.resolve(readValue());
        break;
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.sourceDir) {
    throw new Error("--source-dir is required");
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/openclaw-performance-source-summary.mjs --source-dir <dir> [--baseline-source-dir <dir>] [--output <summary.md>]

Summarizes OpenClaw-native performance probe artifacts for CI reports.`);
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readRequiredJson(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`[source-performance] missing required ${label}: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function formatMs(value) {
  return finiteNumber(value) ? `${value.toFixed(1)}ms` : "n/a";
}

function formatMb(value) {
  return finiteNumber(value) ? `${value.toFixed(1)}MB` : "n/a";
}

function formatBytesAsMb(value) {
  return finiteNumber(value) ? formatMb(value / 1024 / 1024) : "n/a";
}

function formatRatio(value) {
  return finiteNumber(value) ? value.toFixed(3) : "n/a";
}

function metric(stats, key = "p50") {
  return stats && typeof stats[key] === "number" ? stats[key] : null;
}

function percentDelta(before, after) {
  if (typeof before !== "number" || typeof after !== "number") {
    return null;
  }
  if (before === 0) {
    return after === 0 ? 0 : null;
  }
  return ((after - before) / before) * 100;
}

function formatDeltaMb(before, after) {
  if (typeof before !== "number" || typeof after !== "number") {
    return "n/a";
  }
  const delta = after - before;
  const percent = percentDelta(before, after);
  const sign = delta > 0 ? "+" : "";
  const percentText = percent == null ? "new" : `${percent > 0 ? "+" : ""}${percent.toFixed(1)}%`;
  return `${sign}${formatMb(delta)} (${percentText})`;
}

function memoryRisk(before, after) {
  const percent = percentDelta(before, after);
  const delta = typeof before === "number" && typeof after === "number" ? after - before : null;
  if (percent == null || delta == null) {
    return "n/a";
  }
  if (percent >= 20 && delta >= 10) {
    return "watch";
  }
  if (percent <= -10 && delta <= -10) {
    return "improved";
  }
  return "stable";
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|");
}

function table(headers, rows) {
  if (rows.length === 0) {
    return ["No data.", ""];
  }
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map((cell) => escapeCell(cell)).join(" | ")} |`),
    "",
  ];
}

function validateMockHelloSummary(summary, filePath) {
  const counts = summary?.counts;
  const scenarios = Array.isArray(summary?.scenarios) ? summary.scenarios : null;
  if (
    !isNonNegativeInteger(counts?.total) ||
    !isNonNegativeInteger(counts?.passed) ||
    !isNonNegativeInteger(counts?.failed) ||
    counts.total <= 0 ||
    counts.failed !== 0 ||
    counts.passed !== counts.total
  ) {
    throw new Error(`[source-performance] invalid mock hello summary counts: ${filePath}`);
  }
  if (!scenarios || scenarios.length !== counts.total) {
    throw new Error(`[source-performance] invalid mock hello scenario evidence: ${filePath}`);
  }
  const passedScenarios = scenarios.filter((scenario) => scenario?.status === "pass").length;
  const failedScenarios = scenarios.filter((scenario) => scenario?.status === "fail").length;
  const invalidScenario = scenarios.find(
    (scenario) => !["pass", "fail", "skip"].includes(String(scenario?.status)),
  );
  if (invalidScenario || passedScenarios !== counts.passed || failedScenarios !== counts.failed) {
    throw new Error(`[source-performance] invalid mock hello scenario evidence: ${filePath}`);
  }
  const metrics = summary?.metrics;
  const requiredMetrics = [
    "wallMs",
    "gatewayCpuCoreRatio",
    "gatewayProcessRssStartBytes",
    "gatewayProcessRssEndBytes",
    "gatewayProcessRssDeltaBytes",
  ];
  const missingMetric = requiredMetrics.find((key) => !finiteNumber(metrics?.[key]));
  if (missingMetric) {
    throw new Error(`[source-performance] missing mock hello metric ${missingMetric}: ${filePath}`);
  }
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function loadMockHelloSummaries(sourceDir, { required = false } = {}) {
  const root = path.join(sourceDir, "mock-hello");
  if (!fs.existsSync(root)) {
    if (required) {
      throw new Error(`[source-performance] missing required mock hello directory: ${root}`);
    }
    return [];
  }
  const summaries = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      id: entry.name,
      summaryPath: path.join(root, entry.name, "qa-suite-summary.json"),
    }))
    .filter((entry) => fs.existsSync(entry.summaryPath))
    .map((entry) => ({
      id: entry.id,
      summary: JSON.parse(fs.readFileSync(entry.summaryPath, "utf8")),
      summaryPath: entry.summaryPath,
    }))
    .toSorted((a, b) => a.id.localeCompare(b.id));
  if (required && summaries.length === 0) {
    throw new Error(`[source-performance] missing required mock hello summaries: ${root}`);
  }
  if (required) {
    for (const entry of summaries) {
      validateMockHelloSummary(entry.summary, entry.summaryPath);
    }
  }
  return summaries.map(({ id, summary }) => ({ id, summary }));
}

function validateStartupArtifact(startup, filePath) {
  if (!Array.isArray(startup?.results) || startup.results.length === 0) {
    throw new Error(`[source-performance] missing gateway startup results: ${filePath}`);
  }
  for (const result of startup.results) {
    if (
      !finiteNumber(result?.summary?.readyzMs?.p50) ||
      !finiteNumber(result?.summary?.maxRssMb?.p95) ||
      !finiteNumber(result?.summary?.cpuCoreRatio?.p95)
    ) {
      throw new Error(
        `[source-performance] incomplete gateway startup metrics for ${result?.id ?? "unknown"}: ${filePath}`,
      );
    }
  }
}

function validateCliArtifact(cli, filePath) {
  if (!Array.isArray(cli?.primary?.cases) || cli.primary.cases.length === 0) {
    throw new Error(`[source-performance] missing CLI startup cases: ${filePath}`);
  }
  for (const entry of cli.primary.cases) {
    if (
      !finiteNumber(entry?.summary?.durationMs?.p50) ||
      !finiteNumber(entry?.summary?.maxRssMb?.p95)
    ) {
      throw new Error(
        `[source-performance] incomplete CLI startup metrics for ${entry?.id ?? "unknown"}: ${filePath}`,
      );
    }
  }
}

function validateExtensionMemoryArtifact(extensionMemory, filePath) {
  if (!Array.isArray(extensionMemory?.topByDeltaMb) || extensionMemory.topByDeltaMb.length === 0) {
    throw new Error(`[source-performance] missing extension memory rows: ${filePath}`);
  }
  for (const entry of extensionMemory.topByDeltaMb) {
    if (!finiteNumber(entry?.maxRssMb) || !finiteNumber(entry?.deltaFromBaselineMb)) {
      throw new Error(
        `[source-performance] incomplete extension memory metrics for ${entry?.dir ?? "unknown"}: ${filePath}`,
      );
    }
  }
}

function validateGatewaySummaryArtifact(gatewaySummary, filePath) {
  if (!Array.isArray(gatewaySummary?.observations)) {
    throw new Error(`[source-performance] missing gateway observation summary: ${filePath}`);
  }
}

function loadSourceArtifacts(sourceDir, { required = false } = {}) {
  if (!sourceDir || !fs.existsSync(sourceDir)) {
    if (required) {
      throw new Error(`[source-performance] missing required source dir: ${sourceDir}`);
    }
    return null;
  }
  const stat = fs.statSync(sourceDir);
  if (!stat.isDirectory()) {
    throw new Error(`[source-performance] source path is not a directory: ${sourceDir}`);
  }
  const startupPath = path.join(sourceDir, "gateway-cpu", "gateway-startup-bench.json");
  const cliPath = path.join(sourceDir, "cli-startup.json");
  const extensionMemoryPath = path.join(sourceDir, "extension-memory.json");
  const artifacts = {
    startup: required
      ? readRequiredJson(startupPath, "gateway startup artifact")
      : readJsonIfExists(startupPath),
    cli: required ? readRequiredJson(cliPath, "CLI startup artifact") : readJsonIfExists(cliPath),
    extensionMemory: required
      ? readRequiredJson(extensionMemoryPath, "extension memory artifact")
      : readJsonIfExists(extensionMemoryPath),
    mockHelloSummaries: loadMockHelloSummaries(sourceDir, { required }),
  };
  if (required) {
    validateStartupArtifact(artifacts.startup, startupPath);
    validateCliArtifact(artifacts.cli, cliPath);
    validateExtensionMemoryArtifact(artifacts.extensionMemory, extensionMemoryPath);
  }
  return artifacts;
}

function buildStartupRows(startup) {
  return (startup?.results ?? []).map((result) => [
    result.id ?? "unknown",
    result.name ?? result.id ?? "unknown",
    formatMs(metric(result.summary?.readyzMs)),
    formatMs(metric(result.summary?.readyzMs, "p95")),
    formatMs(metric(result.summary?.healthzMs)),
    formatMs(metric(result.summary?.httpListenLogMs)),
    formatMs(metric(result.summary?.gatewayReadyLogMs)),
    formatMs(metric(result.summary?.firstOutputMs)),
    formatMb(metric(result.summary?.maxRssMb, "p95")),
    formatRatio(metric(result.summary?.cpuCoreRatio, "p95")),
  ]);
}

function buildTraceRows(startup) {
  const rows = [];
  for (const result of startup?.results ?? []) {
    const traceEntries = Object.entries(result.summary?.startupTrace ?? {})
      .filter(([, stats]) => typeof stats?.p50 === "number")
      .toSorted((a, b) => (b[1].p50 ?? 0) - (a[1].p50 ?? 0))
      .slice(0, 5);
    for (const [name, stats] of traceEntries) {
      rows.push([result.id ?? "unknown", name, formatMs(stats.p50), formatMs(stats.p95)]);
    }
  }
  return rows;
}

function buildMockHelloRows(summaries) {
  return summaries.map(({ id, summary }) => {
    const status =
      typeof summary?.counts?.failed === "number" && summary.counts.failed > 0 ? "fail" : "pass";
    const counts = summary?.counts
      ? `${summary.counts.passed ?? 0}/${summary.counts.total ?? 0}`
      : "n/a";
    return [
      id,
      status,
      counts,
      formatMs(summary?.metrics?.wallMs),
      formatRatio(summary?.metrics?.gatewayCpuCoreRatio),
      formatBytesAsMb(summary?.metrics?.gatewayProcessRssStartBytes),
      formatBytesAsMb(summary?.metrics?.gatewayProcessRssEndBytes),
      formatBytesAsMb(summary?.metrics?.gatewayProcessRssDeltaBytes),
      summary?.run?.primaryModel ?? "n/a",
    ];
  });
}

function buildCliRows(cli) {
  return (cli?.primary?.cases ?? []).map((commandCase) => [
    commandCase.id ?? "unknown",
    commandCase.name ?? commandCase.id ?? "unknown",
    formatMs(commandCase.summary?.durationMs?.p50),
    formatMs(commandCase.summary?.durationMs?.p95),
    formatMb(commandCase.summary?.maxRssMb?.p95),
    formatExitSummary(commandCase.summary?.exitSummary),
  ]);
}

function buildStartupMemoryDeltaRows(current, baseline) {
  const baselineById = new Map((baseline?.results ?? []).map((result) => [result.id, result]));
  return (current?.results ?? [])
    .map((result) => {
      const before = baselineById.get(result.id);
      if (!before) {
        return null;
      }
      const beforeRss = metric(before.summary?.maxRssMb, "p95");
      const afterRss = metric(result.summary?.maxRssMb, "p95");
      const beforeReadyHeap = metric(
        before.summary?.startupTrace?.["memory.ready.heapUsedMb"],
        "p95",
      );
      const afterReadyHeap = metric(
        result.summary?.startupTrace?.["memory.ready.heapUsedMb"],
        "p95",
      );
      return [
        "gateway boot",
        result.id ?? "unknown",
        formatMb(beforeRss),
        formatMb(afterRss),
        formatDeltaMb(beforeRss, afterRss),
        formatDeltaMb(beforeReadyHeap, afterReadyHeap),
        memoryRisk(beforeRss, afterRss),
      ];
    })
    .filter(Boolean);
}

function buildCliMemoryDeltaRows(current, baseline) {
  const baselineById = new Map((baseline?.primary?.cases ?? []).map((entry) => [entry.id, entry]));
  return (current?.primary?.cases ?? [])
    .map((entry) => {
      const before = baselineById.get(entry.id);
      if (!before) {
        return null;
      }
      const beforeRss = metric(before.summary?.maxRssMb, "p95");
      const afterRss = metric(entry.summary?.maxRssMb, "p95");
      return [
        "cli",
        entry.id ?? "unknown",
        formatMb(beforeRss),
        formatMb(afterRss),
        formatDeltaMb(beforeRss, afterRss),
        "n/a",
        memoryRisk(beforeRss, afterRss),
      ];
    })
    .filter(Boolean);
}

function average(values) {
  const numeric = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (numeric.length === 0) {
    return null;
  }
  return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
}

function buildMockHelloMemoryDeltaRows(current, baseline) {
  const beforeDelta = average(
    (baseline ?? []).map(
      (entry) => entry.summary?.metrics?.gatewayProcessRssDeltaBytes / 1024 / 1024,
    ),
  );
  const afterDelta = average(
    (current ?? []).map(
      (entry) => entry.summary?.metrics?.gatewayProcessRssDeltaBytes / 1024 / 1024,
    ),
  );
  if (beforeDelta == null || afterDelta == null) {
    return [];
  }
  return [
    [
      "mock hello",
      "gateway RSS delta avg",
      formatMb(beforeDelta),
      formatMb(afterDelta),
      formatDeltaMb(beforeDelta, afterDelta),
      "n/a",
      memoryRisk(beforeDelta, afterDelta),
    ],
  ];
}

function buildExtensionMemoryRows(extensionMemory) {
  return (extensionMemory?.topByDeltaMb ?? [])
    .slice(0, 10)
    .map((entry) => [
      entry.dir ?? "unknown",
      formatMb(entry.maxRssMb),
      formatMb(entry.deltaFromBaselineMb),
      entry.status ?? "unknown",
    ]);
}

function buildMemoryDeltaRows(current, baseline) {
  if (!baseline) {
    return [];
  }
  return [
    ...buildStartupMemoryDeltaRows(current.startup, baseline.startup),
    ...buildCliMemoryDeltaRows(current.cli, baseline.cli),
    ...buildMockHelloMemoryDeltaRows(current.mockHelloSummaries, baseline.mockHelloSummaries),
  ];
}

function formatExitSummary(value) {
  if (typeof value !== "string" || !value) {
    return "n/a";
  }
  return value.replaceAll(/\b(code:(?:null|-?\d+)|signal:[^,\s]+)x(\d+)\b/g, "$1 x$2");
}

function buildObservationRows(summary) {
  return (summary?.observations ?? []).map((observation) => [
    observation.kind ?? "unknown",
    observation.id ?? "unknown",
    formatRatio(observation.cpuCoreRatio ?? observation.cpuCoreRatioMax),
    formatMs(observation.wallMs ?? observation.wallMsMax),
  ]);
}

export function buildMarkdown(sourceDir, baselineSourceDir) {
  const current = loadSourceArtifacts(sourceDir, { required: true });
  const baseline = loadSourceArtifacts(baselineSourceDir);
  const gatewaySummaryPath = path.join(sourceDir, "gateway-cpu", "summary.json");
  const gatewaySummary = readRequiredJson(gatewaySummaryPath, "gateway observation summary");
  validateGatewaySummaryArtifact(gatewaySummary, gatewaySummaryPath);
  const memoryDeltaRows = buildMemoryDeltaRows(current, baseline);

  const lines = [
    "# OpenClaw Source Performance",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Gateway Boot",
    "",
    ...table(
      [
        "case",
        "name",
        "readyz p50",
        "readyz p95",
        "healthz p50",
        "http listen p50",
        "gateway ready p50",
        "first output p50",
        "RSS p95",
        "CPU core p95",
      ],
      buildStartupRows(current.startup),
    ),
    "## Memory Trend",
    "",
    baseline
      ? "Compared with the latest published mock-provider source probe for this tested ref."
      : "No published source baseline was available for this tested ref.",
    "",
    ...table(
      [
        "surface",
        "case",
        "baseline RSS p95",
        "current RSS p95",
        "RSS delta",
        "heap delta",
        "state",
      ],
      memoryDeltaRows,
    ),
    "## Bundled Plugin Import Memory",
    "",
    ...table(
      ["plugin", "max RSS", "delta from empty process", "status"],
      buildExtensionMemoryRows(current.extensionMemory),
    ),
    "## Startup Hotspots",
    "",
    ...table(["case", "phase", "p50", "p95"], buildTraceRows(current.startup)),
    "## Fake Model Hello Loops",
    "",
    ...table(
      [
        "run",
        "status",
        "pass",
        "wall",
        "gateway CPU core",
        "RSS start",
        "RSS end",
        "RSS delta",
        "model",
      ],
      buildMockHelloRows(current.mockHelloSummaries),
    ),
    "## CLI Against Booted Gateway",
    "",
    ...table(
      ["case", "command", "duration p50", "duration p95", "RSS p95", "exits"],
      buildCliRows(current.cli),
    ),
    "## Observations",
    "",
    ...table(["kind", "id", "CPU core", "wall"], buildObservationRows(gatewaySummary)),
  ];

  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const markdown = buildMarkdown(options.sourceDir, options.baselineSourceDir);
  if (options.output) {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, markdown, "utf8");
  } else {
    process.stdout.write(markdown);
  }
}

function isCliEntry() {
  const cliArg = process.argv[1];
  return cliArg ? import.meta.url === pathToFileURL(cliArg).href : false;
}

if (isCliEntry()) {
  main().catch(
    /** @param {unknown} error */ (error) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    },
  );
}
