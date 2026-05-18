import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildGroupedTestComparison,
  buildGroupedTestReport,
  formatBytesAsMb,
  normalizeConfigLabel,
  renderGroupedTestComparison,
  renderGroupedTestReport,
} from "./lib/test-group-report.mjs";
import { formatMs } from "./lib/vitest-report-cli-utils.mjs";
import { resolveVitestNodeArgs } from "./run-vitest.mjs";
import { buildFullSuiteVitestRunPlans } from "./test-projects.test-support.mjs";

const DEFAULT_OUTPUT = ".artifacts/test-perf/group-report.json";
const DEFAULT_COMPARE_OUTPUT = ".artifacts/test-perf/group-report-compare.json";

function usage() {
  return [
    "Usage: node scripts/test-group-report.mjs [options] [-- <vitest args>]",
    "",
    "Build a grouped Vitest duration report from one or more JSON reports.",
    "",
    "Options:",
    "  --config <path>       Vitest config to run (repeatable)",
    "  --compare <before> <after>",
    "                        Compare two grouped report JSON files",
    "  --report <path>       Existing Vitest JSON report to read (repeatable)",
    "  --full-suite          Run every full-suite leaf Vitest config serially",
    "  --group-by <mode>     area | folder | top (default: area)",
    "  --output <path>       JSON report path (default: .artifacts/test-perf/group-report.json)",
    "  --limit <count>       Number of groups/configs to print (default: 25)",
    "  --top-files <count>   Number of files to print (default: 25)",
    "  --allow-failures      Write a report even when a Vitest run exits non-zero",
    "  --no-rss              Skip macOS max RSS measurement",
    "  --help                Show this help",
    "",
    "Examples:",
    "  pnpm test:perf:groups --config test/vitest/vitest.unit-fast.config.ts",
    "  pnpm test:perf:groups --full-suite --allow-failures",
    "  pnpm test:perf:groups:compare .artifacts/test-perf/baseline-before.json .artifacts/test-perf/after-first-fix.json",
  ].join("\n");
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseTestGroupReportArgs(argv) {
  const args = {
    allowFailures: false,
    compare: null,
    configs: [],
    fullSuite: false,
    groupBy: "area",
    limit: 25,
    output: null,
    reports: [],
    rss: process.platform === "darwin",
    topFiles: 25,
    vitestArgs: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      args.vitestArgs = argv.slice(index + 1);
      break;
    }
    if (arg === "--help") {
      args.help = true;
      continue;
    }
    if (arg === "--allow-failures") {
      args.allowFailures = true;
      continue;
    }
    if (arg === "--full-suite") {
      args.fullSuite = true;
      continue;
    }
    if (arg === "--no-rss") {
      args.rss = false;
      continue;
    }
    if (arg === "--config") {
      args.configs.push(argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg === "--compare") {
      args.compare = {
        before: argv[index + 1] ?? "",
        after: argv[index + 2] ?? "",
      };
      index += 2;
      continue;
    }
    if (arg === "--report") {
      args.reports.push(argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg === "--group-by") {
      args.groupBy = argv[index + 1] ?? args.groupBy;
      index += 1;
      continue;
    }
    if (arg === "--output") {
      args.output = argv[index + 1] ?? args.output;
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      args.limit = parsePositiveInt(argv[index + 1], args.limit);
      index += 1;
      continue;
    }
    if (arg === "--top-files") {
      args.topFiles = parsePositiveInt(argv[index + 1], args.topFiles);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (!["area", "folder", "top"].includes(args.groupBy)) {
    throw new Error(`Unsupported --group-by value: ${args.groupBy}`);
  }
  if (args.compare && (!args.compare.before || !args.compare.after)) {
    throw new Error("--compare requires before and after report paths");
  }
  if (
    args.compare &&
    (args.configs.length > 0 ||
      args.fullSuite ||
      args.reports.length > 0 ||
      args.vitestArgs.length > 0)
  ) {
    throw new Error("--compare cannot be combined with test run or report input options");
  }

  return args;
}

function sanitizePathSegment(value) {
  return (
    value
      .replace(/[^A-Za-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 180) || "report"
  );
}

function parseMaxRssBytes(output) {
  const match = output.match(/(\d+)\s+maximum resident set size/u);
  return match ? Number.parseInt(match[1], 10) : null;
}

function runVitestJsonReport(params) {
  fs.mkdirSync(path.dirname(params.reportPath), { recursive: true });
  fs.mkdirSync(path.dirname(params.logPath), { recursive: true });
  const command = [
    process.execPath,
    "scripts/run-vitest.mjs",
    "run",
    "--config",
    params.config,
    "--reporter=json",
    "--outputFile",
    params.reportPath,
    ...params.forwardedArgs,
    ...params.vitestArgs,
  ];
  const startedAt = process.hrtime.bigint();
  const result = spawnSync(
    params.rss ? "/usr/bin/time" : command[0],
    params.rss ? ["-l", ...command] : command.slice(1),
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS?.trim(),
          ...resolveVitestNodeArgs(process.env).filter((arg) => arg !== "--no-maglev"),
        ]
          .filter(Boolean)
          .join(" "),
      },
      maxBuffer: 1024 * 1024 * 64,
    },
  );
  const elapsedMs = Number.parseFloat(String(process.hrtime.bigint() - startedAt)) / 1_000_000;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  fs.writeFileSync(params.logPath, output, "utf8");
  return {
    config: params.config,
    elapsedMs,
    label: params.label,
    logPath: params.logPath,
    maxRssBytes: params.rss ? parseMaxRssBytes(output) : null,
    reportPath: params.reportPath,
    status: result.status ?? 1,
  };
}

function readReportInput(entry) {
  return {
    config: entry.config,
    report: JSON.parse(fs.readFileSync(entry.reportPath, "utf8")),
    reportPath: entry.reportPath,
    run: entry.run ?? null,
  };
}

function readGroupedReport(reportPath) {
  return JSON.parse(fs.readFileSync(reportPath, "utf8"));
}

export function resolveReportArtifactDirs(outputPath) {
  const outputDir = path.dirname(outputPath);
  const outputExt = path.extname(outputPath);
  const outputStem = path.basename(outputPath, outputExt) || "group-report";
  const artifactDir = path.join(outputDir, outputStem);
  return {
    reportDir: path.join(artifactDir, "vitest-json"),
    logDir: path.join(artifactDir, "logs"),
  };
}

function withUniqueLabels(plans) {
  const totals = new Map();
  for (const plan of plans) {
    totals.set(plan.label, (totals.get(plan.label) ?? 0) + 1);
  }
  const seen = new Map();
  return plans.map((plan) => {
    const total = totals.get(plan.label) ?? 0;
    if (total <= 1) {
      return plan;
    }
    const index = (seen.get(plan.label) ?? 0) + 1;
    seen.set(plan.label, index);
    return {
      ...plan,
      label: `${plan.label}-${index}`,
    };
  });
}

export function resolveRunPlans(args) {
  if (args.reports.length > 0) {
    return [];
  }
  if (args.fullSuite) {
    return withUniqueLabels(
      buildFullSuiteVitestRunPlans([], process.cwd()).map((plan) => ({
        config: plan.config,
        forwardedArgs: plan.forwardedArgs ?? [],
        label: normalizeConfigLabel(plan.config),
      })),
    );
  }
  const configs = args.configs.length > 0 ? args.configs : ["test/vitest/vitest.unit.config.ts"];
  return configs.map((config) => ({
    config,
    forwardedArgs: [],
    label: normalizeConfigLabel(config),
  }));
}

function printRunLine(run) {
  console.log(
    `[test-group-report] ${run.label} status=${run.status} wall=${formatMs(run.elapsedMs)} rss=${formatBytesAsMb(run.maxRssBytes)} report=${run.reportPath}`,
  );
}

async function main() {
  const args = parseTestGroupReportArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const output = path.resolve(
    args.output ?? (args.compare ? DEFAULT_COMPARE_OUTPUT : DEFAULT_OUTPUT),
  );

  if (args.compare) {
    const beforePath = path.resolve(args.compare.before);
    const afterPath = path.resolve(args.compare.after);
    const comparison = buildGroupedTestComparison({
      before: readGroupedReport(beforePath),
      after: readGroupedReport(afterPath),
      beforePath,
      afterPath,
    });

    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
    console.log(
      renderGroupedTestComparison(comparison, { limit: args.limit, topFiles: args.topFiles }),
    );
    console.log(`[test-group-report:compare] wrote ${path.relative(process.cwd(), output)}`);
    return;
  }

  const { reportDir, logDir } = resolveReportArtifactDirs(output);
  const runEntries = [];
  const runPlans = resolveRunPlans(args);
  let failed = false;
  let exitCode = 0;

  for (const reportPath of args.reports) {
    runEntries.push({
      config: path.basename(reportPath).replace(/\.json$/u, ""),
      reportPath: path.resolve(reportPath),
    });
  }

  for (const plan of runPlans) {
    const slug = sanitizePathSegment(plan.label);
    const run = runVitestJsonReport({
      config: plan.config,
      forwardedArgs: plan.forwardedArgs,
      label: plan.label,
      logPath: path.join(logDir, `${slug}.log`),
      reportPath: path.join(reportDir, `${slug}.json`),
      rss: args.rss,
      vitestArgs: args.vitestArgs,
    });
    printRunLine(run);
    if (run.status !== 0) {
      failed = true;
      if (!fs.existsSync(run.reportPath)) {
        console.error(
          `[test-group-report] missing JSON report for failed config; see ${run.logPath}`,
        );
        if (!args.allowFailures) {
          exitCode = run.status;
          break;
        }
        continue;
      }
      console.error(
        `[test-group-report] config failed; keeping partial report from ${run.reportPath}`,
      );
      if (!args.allowFailures) {
        exitCode = run.status;
        break;
      }
    }
    runEntries.push({ config: plan.label, reportPath: run.reportPath, run });
  }

  if (exitCode !== 0) {
    process.exit(exitCode);
  }

  const reportInputs = runEntries
    .filter((entry) => fs.existsSync(entry.reportPath))
    .map(readReportInput);
  const report = buildGroupedTestReport({
    groupBy: args.groupBy,
    reports: reportInputs,
  });
  const envelope = {
    ...report,
    command: "test-group-report",
    failed,
    runs: reportInputs.map((entry) => entry.run).filter(Boolean),
    system: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuCount: os.availableParallelism?.() ?? os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
  };

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  console.log(renderGroupedTestReport(report, { limit: args.limit, topFiles: args.topFiles }));
  console.log(`[test-group-report] wrote ${path.relative(process.cwd(), output)}`);

  if (failed && !args.allowFailures) {
    process.exit(1);
  }
}

const isMain =
  typeof process.argv[1] === "string" &&
  process.argv[1].length > 0 &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
