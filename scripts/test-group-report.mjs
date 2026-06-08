// Builds grouped Vitest duration reports or compares two grouped reports.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parsePositiveInt } from "./lib/numeric-options.mjs";
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
import {
  applyParallelVitestCachePaths,
  buildFullSuiteVitestRunPlans,
} from "./test-projects.test-support.mjs";

const DEFAULT_OUTPUT = ".artifacts/test-perf/group-report.json";
const DEFAULT_COMPARE_OUTPUT = ".artifacts/test-perf/group-report-compare.json";
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_TIMEOUT_KILL_GRACE_MS = 10_000;
const DEFAULT_SPAWN_LOG_MAX_BYTES = 1024 * 1024 * 256;
const DEFAULT_SPAWN_OUTPUT_MAX_BYTES = 1024 * 1024 * 64;
const DEFAULT_SPAWN_OUTPUT_TAIL_BYTES = 1024 * 256;

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
    "  --max-test-ms <ms>    Fail when any individual test exceeds this duration",
    "  --timeout-ms <ms>     Per-config wall-clock timeout (default: 1800000)",
    "  --kill-grace-ms <ms>  Grace after timeout before SIGKILL (default: 10000)",
    "  --concurrency <count> Run this many config reports at once (default: 2 for",
    "                        repeated explicit configs, 1 for full-suite)",
    "  --allow-failures      Write a report even when a Vitest run exits non-zero",
    "  --no-rss              Skip max RSS measurement",
    "  --help                Show this help",
    "",
    "Examples:",
    "  pnpm test:perf:groups --config test/vitest/vitest.unit-fast.config.ts",
    "  pnpm test:perf:groups --full-suite --allow-failures",
    "  pnpm test:perf:groups:compare .artifacts/test-perf/baseline-before.json .artifacts/test-perf/after-first-fix.json",
  ].join("\n");
}

function readRequiredValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function readPositiveIntValue(argv, index, flag) {
  return parsePositiveInt(readRequiredValue(argv, index, flag), flag);
}

/**
 * Parses report, compare, and Vitest-run options for grouped test reports.
 */
export function parseTestGroupReportArgs(argv) {
  const args = {
    allowFailures: false,
    compare: null,
    concurrency: null,
    configs: [],
    fullSuite: false,
    groupBy: "area",
    limit: 25,
    killGraceMs: DEFAULT_TIMEOUT_KILL_GRACE_MS,
    maxTestMs: null,
    output: null,
    reports: [],
    rss: process.platform !== "win32",
    timeoutMs: DEFAULT_RUN_TIMEOUT_MS,
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
      args.configs.push(readRequiredValue(argv, index, "--config"));
      index += 1;
      continue;
    }
    if (arg === "--compare") {
      args.compare = {
        before: readRequiredValue(argv, index, "--compare"),
        after: readRequiredValue(argv, index + 1, "--compare"),
      };
      index += 2;
      continue;
    }
    if (arg === "--report") {
      args.reports.push(readRequiredValue(argv, index, "--report"));
      index += 1;
      continue;
    }
    if (arg === "--group-by") {
      args.groupBy = readRequiredValue(argv, index, "--group-by");
      index += 1;
      continue;
    }
    if (arg === "--output") {
      args.output = readRequiredValue(argv, index, "--output");
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      args.limit = readPositiveIntValue(argv, index, "--limit");
      index += 1;
      continue;
    }
    if (arg === "--max-test-ms") {
      args.maxTestMs = readPositiveIntValue(argv, index, "--max-test-ms");
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      args.timeoutMs = readPositiveIntValue(argv, index, "--timeout-ms");
      index += 1;
      continue;
    }
    if (arg === "--kill-grace-ms") {
      args.killGraceMs = readPositiveIntValue(argv, index, "--kill-grace-ms");
      index += 1;
      continue;
    }
    if (arg === "--concurrency") {
      args.concurrency = readPositiveIntValue(argv, index, "--concurrency");
      index += 1;
      continue;
    }
    if (arg === "--top-files") {
      args.topFiles = readPositiveIntValue(argv, index, "--top-files");
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

function resolveTimeArgs(command) {
  if (process.platform === "darwin") {
    return { command: "/usr/bin/time", args: ["-l", ...command] };
  }
  if (process.platform === "linux") {
    return { command: "/usr/bin/time", args: ["-v", ...command] };
  }
  return { command: command[0], args: command.slice(1) };
}

function parseMaxRssBytes(output) {
  const macMatch = output.match(/(\d+)\s+maximum resident set size/u);
  if (macMatch) {
    return Number.parseInt(macMatch[1], 10);
  }
  const linuxMatch = output.match(/Maximum resident set size \(kbytes\):\s*(\d+)/u);
  if (linuxMatch) {
    return Number.parseInt(linuxMatch[1], 10) * 1024;
  }
  return null;
}

function formatSpawnError(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs a command, captures text output, and terminates timed-out process groups.
 */
export function spawnText(command, args, options) {
  const maxBuffer = options.maxBufferBytes ?? DEFAULT_SPAWN_OUTPUT_MAX_BYTES;
  const maxLogBytes = options.maxLogBytes ?? DEFAULT_SPAWN_LOG_MAX_BYTES;
  const tailBytes = options.outputTailBytes ?? DEFAULT_SPAWN_OUTPUT_TAIL_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_TIMEOUT_KILL_GRACE_MS;
  const useProcessGroup = process.platform !== "win32";
  const logPath = options.logPath ?? null;
  return new Promise((resolve) => {
    let logFd = null;
    if (logPath) {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      logFd = fs.openSync(logPath, "w");
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: useProcessGroup,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let outputBytes = 0;
    let outputTail = Buffer.alloc(0);
    let stderrTail = Buffer.alloc(0);
    let streamedLogBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    let settled = false;
    let killTimer = null;
    let childClosedResult = null;
    let waitingForKillGrace = false;
    const signalChild = (signal) => {
      if (useProcessGroup && typeof child.pid === "number") {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch (error) {
          if (error && error.code !== "ESRCH") {
            appendDiagnostic(
              `[test-group-report] failed to send ${signal} to process group: ${formatSpawnError(error)}\n`,
            );
          }
        }
      }
      child.kill(signal);
    };
    const parentSignalHandlers = [];
    const cleanupParentSignalHandlers = () => {
      for (const { signal, handler } of parentSignalHandlers) {
        process.off(signal, handler);
      }
      parentSignalHandlers.length = 0;
    };
    const relayParentSignal = (signal) => {
      const handler = () => {
        signalChild(signal);
        cleanupParentSignalHandlers();
        process.kill(process.pid, signal);
      };
      parentSignalHandlers.push({ signal, handler });
      process.once(signal, handler);
    };
    if (useProcessGroup) {
      relayParentSignal("SIGINT");
      relayParentSignal("SIGTERM");
      relayParentSignal("SIGHUP");
    }
    const processGroupIsAlive = () => {
      if (!useProcessGroup || typeof child.pid !== "number") {
        return false;
      }
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return Boolean(error && error.code === "EPERM");
      }
    };
    const scheduleKill = (message) => {
      if (waitingForKillGrace) {
        return;
      }
      waitingForKillGrace = true;
      killTimer = setTimeout(() => {
        waitingForKillGrace = false;
        killTimer = null;
        appendDiagnostic(message);
        signalChild("SIGKILL");
        if (childClosedResult) {
          finish(childClosedResult);
        }
      }, killGraceMs);
      killTimer.unref?.();
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      appendDiagnostic(`\n[test-group-report] command timed out after ${String(timeoutMs)}ms\n`);
      signalChild("SIGTERM");
      scheduleKill(
        `[test-group-report] command did not exit after ${String(killGraceMs)}ms grace; sending SIGKILL\n`,
      );
    }, timeoutMs);
    timeoutTimer.unref?.();
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      cleanupParentSignalHandlers();
      if (killTimer) {
        clearTimeout(killTimer);
      }
      if (logFd !== null) {
        fs.closeSync(logFd);
        logFd = null;
      }
      resolve(result);
    };
    function appendTail(chunk, target = "output") {
      if (tailBytes < 1) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      const currentTail = target === "stderr" ? stderrTail : outputTail;
      if (buffer.byteLength >= tailBytes) {
        if (target === "stderr") {
          stderrTail = buffer.subarray(buffer.byteLength - tailBytes);
        } else {
          outputTail = buffer.subarray(buffer.byteLength - tailBytes);
        }
        return;
      }
      let nextTail = Buffer.concat([currentTail, buffer]);
      if (nextTail.byteLength > tailBytes) {
        nextTail = nextTail.subarray(nextTail.byteLength - tailBytes);
      }
      if (target === "stderr") {
        stderrTail = nextTail;
      } else {
        outputTail = nextTail;
      }
    }
    function appendDiagnostic(message) {
      const buffer = Buffer.from(message, "utf8");
      if (logFd !== null) {
        fs.writeSync(logFd, buffer);
        appendTail(buffer);
        return;
      }
      appendTail(buffer);
    }
    const appendOutput = (chunk, streamName) => {
      if (logFd !== null) {
        if (outputExceeded) {
          return;
        }
        const remainingLogBytes = maxLogBytes - streamedLogBytes;
        const chunkToWrite =
          chunk.byteLength > remainingLogBytes ? chunk.subarray(0, remainingLogBytes) : chunk;
        if (chunkToWrite.byteLength > 0) {
          fs.writeSync(logFd, chunkToWrite);
          streamedLogBytes += chunkToWrite.byteLength;
          appendTail(chunkToWrite);
          if (streamName === "stderr") {
            appendTail(chunkToWrite, "stderr");
          }
        }
        if (chunk.byteLength > remainingLogBytes) {
          outputExceeded = true;
          appendDiagnostic(
            `\n[test-group-report] output log exceeded ${String(maxLogBytes)} bytes\n`,
          );
          signalChild("SIGTERM");
          scheduleKill(
            "[test-group-report] command did not exit after output log limit; sending SIGKILL\n",
          );
        }
        return;
      }
      if (outputExceeded) {
        return;
      }

      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      outputBytes += buffer.byteLength;
      appendTail(buffer);
      if (streamName === "stderr") {
        appendTail(buffer, "stderr");
      }
      if (outputBytes > maxBuffer) {
        outputExceeded = true;
        appendDiagnostic(`\n[test-group-report] output exceeded ${String(maxBuffer)} bytes\n`);
        signalChild("SIGTERM");
        scheduleKill(
          "[test-group-report] command did not exit after output limit; sending SIGKILL\n",
        );
      }
    };
    function streamedOutput() {
      const tail = outputTail.toString("utf8");
      const stderr = stderrTail.toString("utf8");
      if (!stderr || tail.includes(stderr)) {
        return tail;
      }
      return `${tail}\n${stderr}`;
    }
    child.stdout?.on("data", (chunk) => appendOutput(chunk, "stdout"));
    child.stderr?.on("data", (chunk) => appendOutput(chunk, "stderr"));
    child.on("error", (error) => {
      appendDiagnostic(`${String(error)}\n`);
    });
    child.on("close", (code, signal) => {
      const result = {
        status: outputExceeded || timedOut ? 1 : (code ?? 1),
        signal,
        output: streamedOutput(),
        timedOut,
      };
      if (waitingForKillGrace && processGroupIsAlive()) {
        childClosedResult = result;
        return;
      }
      finish(result);
    });
  });
}

async function runVitestJsonReport(params) {
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
  const spawnCommand = params.rss
    ? resolveTimeArgs(command)
    : { command: command[0], args: command.slice(1) };
  const result = await spawnText(spawnCommand.command, spawnCommand.args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...params.env,
      NODE_OPTIONS: [
        (params.env?.NODE_OPTIONS ?? process.env.NODE_OPTIONS)?.trim(),
        ...resolveVitestNodeArgs({ ...process.env, ...params.env }).filter(
          (arg) => arg !== "--no-maglev",
        ),
      ]
        .filter(Boolean)
        .join(" "),
    },
    killGraceMs: params.killGraceMs,
    logPath: params.logPath,
    timeoutMs: params.timeoutMs,
  });
  const elapsedMs = Number.parseFloat(String(process.hrtime.bigint() - startedAt)) / 1_000_000;
  const output = result.output;
  return {
    config: params.config,
    elapsedMs,
    label: params.label,
    logPath: params.logPath,
    maxRssBytes: params.rss ? parseMaxRssBytes(output) : null,
    reportPath: params.reportPath,
    status: result.status,
  };
}

function readReportInput(entry) {
  const report = JSON.parse(fs.readFileSync(entry.reportPath, "utf8"));
  if (!report || typeof report !== "object" || !Array.isArray(report.testResults)) {
    throw new Error("missing testResults array");
  }
  if (report.testResults.length === 0) {
    throw new Error("empty testResults array");
  }
  return {
    config: entry.config,
    report,
    reportPath: entry.reportPath,
    run: entry.run ?? null,
  };
}

export function readReportInputs(entries) {
  const invalid = [];
  const missing = [];
  const reports = [];
  for (const entry of entries) {
    if (!fs.existsSync(entry.reportPath)) {
      missing.push(entry);
      continue;
    }
    try {
      reports.push(readReportInput(entry));
    } catch (error) {
      invalid.push({
        entry,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { invalid, missing, reports };
}

function readGroupedReport(reportPath) {
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  validateGroupedReport(report, reportPath);
  return report;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validateCounter(counter, reportPath, fieldName, index = null) {
  const fieldLabel = String(fieldName);
  const label = index === null ? fieldLabel : `${fieldLabel}[${String(index)}]`;
  const displayPath = String(reportPath);
  if (!counter || typeof counter !== "object" || Array.isArray(counter)) {
    throw new Error(
      `[test-group-report] invalid grouped report ${displayPath}: ${label} must be an object`,
    );
  }
  for (const key of ["durationMs", "fileCount", "testCount"]) {
    if (!isFiniteNumber(counter[key])) {
      throw new Error(
        `[test-group-report] invalid grouped report ${displayPath}: ${label}.${key} must be a finite number`,
      );
    }
  }
}

function validateCounterRows(report, reportPath, fieldName) {
  const rows = report[fieldName];
  if (!Array.isArray(rows)) {
    throw new Error(
      `[test-group-report] invalid grouped report ${reportPath}: ${fieldName} must be an array`,
    );
  }
  rows.forEach((row, index) => {
    validateCounter(row, reportPath, fieldName, index);
    if (typeof row.key !== "string" || !row.key) {
      throw new Error(
        `[test-group-report] invalid grouped report ${reportPath}: ${fieldName}[${index}].key must be a non-empty string`,
      );
    }
  });
}

function validateTopFileRows(report, reportPath) {
  if (!Array.isArray(report.topFiles)) {
    throw new Error(
      `[test-group-report] invalid grouped report ${reportPath}: topFiles must be an array`,
    );
  }
  report.topFiles.forEach((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(
        `[test-group-report] invalid grouped report ${reportPath}: topFiles[${index}] must be an object`,
      );
    }
    for (const key of ["config", "file", "group"]) {
      if (typeof row[key] !== "string" || !row[key]) {
        throw new Error(
          `[test-group-report] invalid grouped report ${reportPath}: topFiles[${index}].${key} must be a non-empty string`,
        );
      }
    }
    for (const key of ["durationMs", "testCount"]) {
      if (!isFiniteNumber(row[key])) {
        throw new Error(
          `[test-group-report] invalid grouped report ${reportPath}: topFiles[${index}].${key} must be a finite number`,
        );
      }
    }
  });
}

function validateRunRows(report, reportPath) {
  if (!Array.isArray(report.runs)) {
    throw new Error(
      `[test-group-report] invalid grouped report ${reportPath}: runs must be an array`,
    );
  }
  report.runs.forEach((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(
        `[test-group-report] invalid grouped report ${reportPath}: runs[${index}] must be an object`,
      );
    }
    if (typeof row.config !== "string" && typeof row.label !== "string") {
      throw new Error(
        `[test-group-report] invalid grouped report ${reportPath}: runs[${index}] must include config or label`,
      );
    }
    if (!isFiniteNumber(row.elapsedMs) || !isFiniteNumber(row.status)) {
      throw new Error(
        `[test-group-report] invalid grouped report ${reportPath}: runs[${index}] must include finite elapsedMs and status`,
      );
    }
    if (
      row.maxRssBytes !== null &&
      row.maxRssBytes !== undefined &&
      !isFiniteNumber(row.maxRssBytes)
    ) {
      throw new Error(
        `[test-group-report] invalid grouped report ${reportPath}: runs[${index}].maxRssBytes must be finite when present`,
      );
    }
  });
}

function validateGroupedReport(report, reportPath) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error(
      `[test-group-report] invalid grouped report ${reportPath}: report must be an object`,
    );
  }
  if (report.command !== "test-group-report") {
    throw new Error(
      `[test-group-report] invalid grouped report ${reportPath}: command must be test-group-report`,
    );
  }
  if (!["area", "folder", "top"].includes(report.groupBy)) {
    throw new Error(
      `[test-group-report] invalid grouped report ${reportPath}: groupBy must be area, folder, or top`,
    );
  }
  validateCounter(report.totals, reportPath, "totals");
  validateCounterRows(report, reportPath, "groups");
  validateCounterRows(report, reportPath, "configs");
  validateTopFileRows(report, reportPath);
  if (!Array.isArray(report.slowTests)) {
    throw new Error(
      `[test-group-report] invalid grouped report ${reportPath}: slowTests must be an array`,
    );
  }
  validateRunRows(report, reportPath);
  if (
    report.groups.length === 0 &&
    report.configs.length === 0 &&
    report.topFiles.length === 0 &&
    report.runs.length === 0
  ) {
    throw new Error(`[test-group-report] invalid grouped report ${reportPath}: no evidence rows`);
  }
}

/**
 * Resolves JSON report and per-run artifact directories from an output path.
 */
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

function buildFullSuiteLeafRunPlans() {
  const previousLeafShards = process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
  process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS = "1";
  try {
    return buildFullSuiteVitestRunPlans([], process.cwd());
  } finally {
    if (previousLeafShards === undefined) {
      delete process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
    } else {
      process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS = previousLeafShards;
    }
  }
}

/**
 * Resolves explicit or full-suite Vitest config plans for report generation.
 */
export function resolveRunPlans(args) {
  if (args.reports.length > 0) {
    return [];
  }
  if (args.fullSuite) {
    return withUniqueLabels(
      buildFullSuiteLeafRunPlans().map((plan) => ({
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

/**
 * Builds env for full-suite report runs, including per-config cache paths.
 */
export function resolveFullSuiteVitestEnv(args, env = process.env, label = "") {
  if (
    !args.fullSuite ||
    env.OPENCLAW_VITEST_MAX_WORKERS?.trim() ||
    env.OPENCLAW_TEST_WORKERS?.trim()
  ) {
    return {};
  }

  return {
    OPENCLAW_VITEST_MAX_WORKERS: label === "commands" ? "1" : "2",
  };
}

/**
 * Resolves bounded concurrency for grouped report run plans.
 */
export function resolveRunPlanConcurrency(args, runPlanCount) {
  if (runPlanCount <= 1) {
    return 1;
  }
  if (args.concurrency !== null) {
    return Math.min(args.concurrency, runPlanCount);
  }
  if (args.fullSuite) {
    return 1;
  }
  return Math.min(2, runPlanCount);
}

/**
 * Builds concrete report run specs from parsed args and config plans.
 */
export function resolveReportRunSpecs(args, runPlans, params = {}) {
  const concurrency = params.concurrency ?? resolveRunPlanConcurrency(args, runPlans.length);
  const env = params.env ?? process.env;
  const specs = runPlans.map((plan) => ({
    ...plan,
    env: resolveFullSuiteVitestEnv(args, env, plan.label),
  }));
  if (concurrency <= 1) {
    return specs;
  }
  return applyParallelVitestCachePaths(specs, {
    cwd: params.cwd ?? process.cwd(),
    env,
  });
}

function printRunLine(run) {
  console.log(
    `[test-group-report] ${run.label} status=${run.status} wall=${formatMs(run.elapsedMs)} rss=${formatBytesAsMb(run.maxRssBytes)} report=${run.reportPath}`,
  );
}

async function runReportPlans(params) {
  const concurrency = resolveRunPlanConcurrency(params.args, params.runPlans.length);
  const runSpecs = resolveReportRunSpecs(params.args, params.runPlans, { concurrency });
  const results = [];
  results.length = runSpecs.length;
  let nextIndex = 0;
  let failed = false;
  let exitCode = 0;

  async function worker() {
    while (nextIndex < runSpecs.length && exitCode === 0) {
      const index = nextIndex;
      nextIndex += 1;
      const plan = runSpecs[index];
      const slug = sanitizePathSegment(plan.label);
      const run = await runVitestJsonReport({
        config: plan.config,
        forwardedArgs: plan.forwardedArgs,
        env: plan.env,
        label: plan.label,
        logPath: path.join(params.logDir, `${slug}.log`),
        reportPath: path.join(params.reportDir, `${slug}.json`),
        rss: params.args.rss,
        timeoutMs: params.args.timeoutMs,
        killGraceMs: params.args.killGraceMs,
        vitestArgs: params.args.vitestArgs,
      });
      printRunLine(run);
      let includeEntry = true;
      if (run.status !== 0) {
        failed = true;
        if (!fs.existsSync(run.reportPath)) {
          console.error(
            `[test-group-report] missing JSON report for failed config; see ${run.logPath}`,
          );
          exitCode = 1;
          includeEntry = false;
        } else {
          console.error(
            `[test-group-report] config failed; keeping partial report from ${run.reportPath}`,
          );
        }
        if (!params.args.allowFailures) {
          exitCode = run.status;
        }
      }
      results[index] = includeEntry
        ? { config: plan.label, reportPath: run.reportPath, run }
        : null;
    }
  }

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      await worker();
    }),
  );

  return {
    failed,
    exitCode,
    runEntries: results.filter(Boolean),
  };
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

  if (runPlans.length > 0) {
    const result = await runReportPlans({ args, logDir, reportDir, runPlans });
    failed = result.failed;
    exitCode = result.exitCode;
    runEntries.push(...result.runEntries);
  }

  if (exitCode !== 0) {
    process.exit(exitCode);
  }

  const reportInputsResult = readReportInputs(runEntries);
  if (reportInputsResult.missing.length > 0) {
    for (const entry of reportInputsResult.missing) {
      console.error(
        `[test-group-report] missing JSON report for ${entry.config}: ${entry.reportPath}`,
      );
    }
    process.exit(1);
  }
  if (reportInputsResult.invalid.length > 0) {
    for (const { entry, reason } of reportInputsResult.invalid) {
      console.error(
        `[test-group-report] invalid JSON report for ${entry.config}: ${entry.reportPath} (${reason})`,
      );
    }
    process.exit(1);
  }
  const reportInputs = reportInputsResult.reports;
  if (reportInputs.length === 0) {
    console.error("[test-group-report] no valid JSON reports were available");
    process.exit(1);
  }
  const report = buildGroupedTestReport({
    groupBy: args.groupBy,
    maxTestMs: args.maxTestMs,
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

  if (args.maxTestMs !== null && report.slowTests.length > 0) {
    console.error(
      `[test-group-report] ${report.slowTests.length} tests exceeded ${formatMs(args.maxTestMs)}`,
    );
    process.exit(1);
  }

  if (failed && !args.allowFailures) {
    process.exit(1);
  }
}

const isMain =
  typeof process.argv[1] === "string" &&
  process.argv[1].length > 0 &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main().catch(
    /** @param {unknown} error */ (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
