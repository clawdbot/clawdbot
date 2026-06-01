#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const options = { baselineSourceDir: null, sourceDir: null, output: null };
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

function loadSourceArtifacts(sourceDir) {
  if (!sourceDir || !fs.existsSync(sourceDir)) {
    return null;
  }
  return {
    startup: readJsonIfExists(path.join(sourceDir, "gateway-cpu", "gateway-startup-bench.json")),
    cli: readJsonIfExists(path.join(sourceDir, "cli-startup.json")),
    extensionMemory: readJsonIfExists(path.join(sourceDir, "extension-memory.json")),
    mockHelloSummaries: loadMockHelloSummaries(sourceDir),
  };
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

function buildMarkdown(sourceDir, baselineSourceDir) {
  const current = loadSourceArtifacts(sourceDir) ?? {
    startup: null,
    cli: null,
    extensionMemory: null,
    mockHelloSummaries: [],
  };
  const baseline = loadSourceArtifacts(baselineSourceDir);
  const gatewaySummary = readJsonIfExists(path.join(sourceDir, "gateway-cpu", "summary.json"));
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

main().catch(
  /** @param {unknown} error */ (error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  },
);
