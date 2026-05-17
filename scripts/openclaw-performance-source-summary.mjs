#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const options = { sourceDir: null, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return value;
    };
    switch (arg) {
      case "--source-dir":
        options.sourceDir = path.resolve(readValue());
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
  console.log(`Usage: node scripts/openclaw-performance-source-summary.mjs --source-dir <dir> [--output <summary.md>]

Summarizes OpenClaw-native performance probe artifacts for CI reports.`);
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function formatMs(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}ms` : "n/a";
}

function formatMb(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}MB` : "n/a";
}

function formatBytesAsMb(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? formatMb(value / 1024 / 1024)
    : "n/a";
}

function formatRatio(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) : "n/a";
}

function metric(stats, key = "p50") {
  return stats && typeof stats[key] === "number" ? stats[key] : null;
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

function loadMockHelloSummaries(sourceDir) {
  const root = path.join(sourceDir, "mock-hello");
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      id: entry.name,
      summary: readJsonIfExists(path.join(root, entry.name, "qa-suite-summary.json")),
    }))
    .filter((entry) => entry.summary != null)
    .toSorted((a, b) => a.id.localeCompare(b.id));
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

function buildMarkdown(sourceDir) {
  const gatewaySummary = readJsonIfExists(path.join(sourceDir, "gateway-cpu", "summary.json"));
  const startup = readJsonIfExists(
    path.join(sourceDir, "gateway-cpu", "gateway-startup-bench.json"),
  );
  const cli = readJsonIfExists(path.join(sourceDir, "cli-startup.json"));
  const mockHelloSummaries = loadMockHelloSummaries(sourceDir);

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
      buildStartupRows(startup),
    ),
    "## Startup Hotspots",
    "",
    ...table(["case", "phase", "p50", "p95"], buildTraceRows(startup)),
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
      buildMockHelloRows(mockHelloSummaries),
    ),
    "## CLI Against Booted Gateway",
    "",
    ...table(
      ["case", "command", "duration p50", "duration p95", "RSS p95", "exits"],
      buildCliRows(cli),
    ),
    "## Observations",
    "",
    ...table(["kind", "id", "CPU core", "wall"], buildObservationRows(gatewaySummary)),
  ];

  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const markdown = buildMarkdown(options.sourceDir);
  if (options.output) {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, markdown, "utf8");
  } else {
    process.stdout.write(markdown);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
