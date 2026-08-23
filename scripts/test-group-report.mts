// Builds grouped Vitest duration reports or compares two grouped reports.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import pMap from "p-map";
import { coerceErrorMessage } from "./lib/error-format.mts";
import {
  inspectManagedProcessGroup,
  terminateManagedChild,
  waitForManagedProcessGroupExit,
} from "./lib/managed-child-process.mts";
import { parsePositiveInt } from "./lib/numeric-options.mjs";
import {
  buildGroupedTestComparison,
  buildGroupedTestReport,
  formatBytesAsMb,
  normalizeConfigLabel,
  renderGroupedTestComparison,
  renderGroupedTestReport,
} from "./lib/test-group-report.mts";
import { formatMs } from "./lib/vitest-report-cli-utils.mts";
import { resolveVitestNodeArgs } from "./run-vitest.mts";
import {
  applyParallelVitestCachePaths,
  buildFullSuiteVitestRunPlans,
} from "./test-projects.test-support.mts";

const DEFAULT_OUTPUT = ".artifacts/test-perf/group-report.json";
const DEFAULT_COMPARE_OUTPUT = ".artifacts/test-perf/group-report-compare.json";
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_TIMEOUT_KILL_GRACE_MS = 10_000;
const DEFAULT_SPAWN_LOG_MAX_BYTES = 1024 * 1024 * 256;
const DEFAULT_SPAWN_OUTPUT_MAX_BYTES = 1024 * 1024 * 64;
const DEFAULT_SPAWN_OUTPUT_TAIL_BYTES = 1024 * 256;

type ProcessSignal = `SIG${string}`;
type TimerHandle = ReturnType<typeof setTimeout>;
export type TestGroupReportArgs = {
  allowFailures: boolean;
  compare: { after: string; before: string } | null;
  concurrency: number | null;
  configs: string[];
  fullSuite: boolean;
  groupBy: string;
  help?: boolean;
  killGraceMs: number;
  limit: number;
  maxTestMs: number | null;
  output: string | null;
  reports: string[];
  rss: boolean;
  timeoutMs: number;
  topFiles: number;
  vitestArgs: string[];
};

export type TestGroupRunPlan = {
  config: string;
  forwardedArgs: string[];
  label: string;
};

export type TestGroupRunSpec = TestGroupRunPlan & {
  env: NodeJS.ProcessEnv;
  vitestArgs: string[];
};

export type TestGroupRun = Awaited<ReturnType<typeof runVitestJsonReport>>;

type ReportInputEntry = Pick<TestGroupRun, "config" | "reportPath"> & {
  run?: TestGroupRun | null;
};

type SpawnTextOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  killGraceMs?: number;
  logPath?: string | null;
  timeoutMs?: number;
  maxBufferBytes?: number;
  maxLogBytes?: number;
  outputTailBytes?: number;
};

type SpawnTextResult = {
  output: string;
  status: number;
  signal: ProcessSignal | null;
  timedOut: boolean;
};

type GroupedComparisonInput = Parameters<typeof buildGroupedTestComparison>[0]["before"];

type RunVitestParams = TestGroupRunSpec &
  Pick<TestGroupReportArgs, "killGraceMs" | "rss" | "timeoutMs"> & {
    logPath: string;
    reportPath: string;
  };

function usage() {
  return [
    "Usage: node --import tsx scripts/test-group-report.mts [options] [-- <vitest args>]",
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

function readRequiredValue(argv: string[], index: number, flag: string) {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function readPositiveIntValue(argv: string[], index: number, flag: string) {
  return parsePositiveInt(readRequiredValue(argv, index, flag), flag);
}

/**
 * Parses report, compare, and Vitest-run options for grouped test reports.
 */
export function parseTestGroupReportArgs(argv: string[]) {
  const args: TestGroupReportArgs = {
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
  const seenSingleValueFlags = new Set<string>();
  const setSingleValueFlag = (flag: string, apply: () => void) => {
    if (seenSingleValueFlags.has(flag)) {
      throw new Error(`${flag} was provided more than once`);
    }
    seenSingleValueFlags.add(flag);
    apply();
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
      const before = readRequiredValue(argv, index, "--compare");
      const after = readRequiredValue(argv, index + 1, "--compare");
      setSingleValueFlag(arg, () => {
        args.compare = { before, after };
      });
      index += 2;
      continue;
    }
    if (arg === "--report") {
      args.reports.push(readRequiredValue(argv, index, "--report"));
      index += 1;
      continue;
    }
    if (arg === "--group-by") {
      const value = readRequiredValue(argv, index, "--group-by");
      setSingleValueFlag(arg, () => {
        args.groupBy = value;
      });
      index += 1;
      continue;
    }
    if (arg === "--output") {
      const value = readRequiredValue(argv, index, "--output");
      setSingleValueFlag(arg, () => {
        args.output = value;
      });
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      const value = readPositiveIntValue(argv, index, "--limit");
      setSingleValueFlag(arg, () => {
        args.limit = value;
      });
      index += 1;
      continue;
    }
    if (arg === "--max-test-ms") {
      const value = readPositiveIntValue(argv, index, "--max-test-ms");
      setSingleValueFlag(arg, () => {
        args.maxTestMs = value;
      });
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      const value = readPositiveIntValue(argv, index, "--timeout-ms");
      setSingleValueFlag(arg, () => {
        args.timeoutMs = value;
      });
      index += 1;
      continue;
    }
    if (arg === "--kill-grace-ms") {
      const value = readPositiveIntValue(argv, index, "--kill-grace-ms");
      setSingleValueFlag(arg, () => {
        args.killGraceMs = value;
      });
      index += 1;
      continue;
    }
    if (arg === "--concurrency") {
      const value = readPositiveIntValue(argv, index, "--concurrency");
      setSingleValueFlag(arg, () => {
        args.concurrency = value;
      });
      index += 1;
      continue;
    }
    if (arg === "--top-files") {
      const value = readPositiveIntValue(argv, index, "--top-files");
      setSingleValueFlag(arg, () => {
        args.topFiles = value;
      });
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

function sanitizePathSegment(value: string) {
  return (
    value
      .replace(/[^A-Za-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 180) || "report"
  );
}

function resolveTimeArgs(command: [string, ...string[]]) {
  if (process.platform === "darwin") {
    return { command: "/usr/bin/time", args: ["-l", ...command] };
  }
  if (process.platform === "linux") {
    return { command: "/usr/bin/time", args: ["-v", ...command] };
  }
  return { command: command[0], args: command.slice(1) };
}

function parseMaxRssBytes(output: string) {
  const macMatch = output.match(/(\d+)\s+maximum resident set size/u);
  if (macMatch) {
    return Number.parseInt(macMatch[1] ?? "", 10);
  }
  const linuxMatch = output.match(/Maximum resident set size \(kbytes\):\s*(\d+)/u);
  if (linuxMatch) {
    return Number.parseInt(linuxMatch[1] ?? "", 10) * 1024;
  }
  return null;
}

/**
 * Runs a command, captures text output, and terminates timed-out process groups.
 */
export function spawnText(command: string, args: readonly string[], options: SpawnTextOptions) {
  const maxBuffer = options.maxBufferBytes ?? DEFAULT_SPAWN_OUTPUT_MAX_BYTES;
  const maxLogBytes = options.maxLogBytes ?? DEFAULT_SPAWN_LOG_MAX_BYTES;
  const tailBytes = options.outputTailBytes ?? DEFAULT_SPAWN_OUTPUT_TAIL_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_TIMEOUT_KILL_GRACE_MS;
  const useProcessGroup = process.platform !== "win32";
  const logPath = options.logPath ?? null;
  return new Promise<SpawnTextResult>((resolve) => {
    let logFd: number | null = null;
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
    let outputTail: Buffer = Buffer.alloc(0);
    let stderrTail: Buffer = Buffer.alloc(0);
    let streamedLogBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    let settled = false;
    let killTimer: TimerHandle | null = null;
    let killGraceDeadline: number | null = null;
    let killGraceMessage: string | null = null;
    let childClosedResult: SpawnTextResult | null = null;
    let waitingForKillGrace = false;
    const signalChild = (signal: ProcessSignal) =>
      terminateManagedChild(child, signal as NodeJS.Signals, {
        onChildSignalError(error) {
          throw error;
        },
        onProcessGroupSignalError(error) {
          appendDiagnostic(
            `[test-group-report] failed to send ${signal} to process group: ${coerceErrorMessage(error)}\n`,
          );
        },
        taskkillTimeoutMs: null,
      });
    const parentSignalHandlers: { signal: ProcessSignal; handler: () => void }[] = [];
    const cleanupParentSignalHandlers = () => {
      for (const { signal, handler } of parentSignalHandlers) {
        process.off(signal, handler);
      }
      parentSignalHandlers.length = 0;
    };
    const relayParentSignal = (signal: ProcessSignal) => {
      const handler = () => {
        signalChild(signal);
        signalChild("SIGKILL");
        cleanupParentSignalHandlers();
        process.kill(process.pid, signal as NodeJS.Signals);
      };
      parentSignalHandlers.push({ signal, handler });
      process.once(signal, handler);
    };
    if (useProcessGroup) {
      relayParentSignal("SIGINT");
      relayParentSignal("SIGTERM");
      relayParentSignal("SIGHUP");
    } else if (process.platform === "win32") {
      relayParentSignal("SIGINT");
      relayParentSignal("SIGTERM");
    }
    const processGroupIsAlive = () =>
      inspectManagedProcessGroup(child, { errorPolicy: "alive-on-eperm" }) === "live";
    const finishAfterProcessGroupCleanup = async (result: SpawnTextResult) => {
      const graceRemainingMs =
        killGraceDeadline === null ? killGraceMs : Math.max(0, killGraceDeadline - Date.now());
      if (graceRemainingMs > 0) {
        await waitForManagedProcessGroupExit(child, graceRemainingMs, {
          errorPolicy: "alive-on-eperm",
        });
      }
      if (settled) {
        return;
      }
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      waitingForKillGrace = false;
      killGraceDeadline = null;
      if (processGroupIsAlive()) {
        appendDiagnostic(killGraceMessage ?? "");
        signalChild("SIGKILL");
      }
      killGraceMessage = null;
      childClosedResult = null;
      finish(result);
    };
    const scheduleKill = (message: string) => {
      if (waitingForKillGrace) {
        return;
      }
      waitingForKillGrace = true;
      killGraceDeadline = Date.now() + killGraceMs;
      killGraceMessage = message;
      killTimer = setTimeout(() => {
        waitingForKillGrace = false;
        killTimer = null;
        killGraceDeadline = null;
        appendDiagnostic(killGraceMessage ?? message);
        killGraceMessage = null;
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
    const finish = (result: SpawnTextResult) => {
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
    function appendTail(chunk: Buffer, target = "output") {
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
    function appendDiagnostic(message: string) {
      const buffer = Buffer.from(message, "utf8");
      if (logFd !== null) {
        fs.writeSync(logFd, buffer);
        appendTail(buffer);
        return;
      }
      appendTail(buffer);
    }
    const appendOutput = (chunk: Buffer, streamName: string) => {
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
        killTimer?.ref?.();
        childClosedResult = result;
        void finishAfterProcessGroupCleanup(result);
        return;
      }
      finish(result);
    });
  });
}

async function runVitestJsonReport(params: RunVitestParams) {
  fs.mkdirSync(path.dirname(params.reportPath), { recursive: true });
  fs.mkdirSync(path.dirname(params.logPath), { recursive: true });
  const command: [string, ...string[]] = [
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
      // The JSON reporter can stay silent for the entire config. The profiler
      // owns the wall-clock timeout and process-group cleanup for this child.
      OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "0",
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

function readReportInput(entry: ReportInputEntry) {
  const report = JSON.parse(fs.readFileSync(entry.reportPath, "utf8")) as unknown;
  if (!isRecord(report) || !Array.isArray(report.testResults)) {
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

function readReportInputs(entries: ReportInputEntry[]) {
  const invalid: Array<{ entry: ReportInputEntry; reason: string }> = [];
  const missing: ReportInputEntry[] = [];
  const reports: ReturnType<typeof readReportInput>[] = [];
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
        reason: coerceErrorMessage(error),
      });
    }
  }
  return { invalid, missing, reports };
}

function readGroupedReport(reportPath: fs.PathOrFileDescriptor) {
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as unknown;
  validateGroupedReport(report, reportPath);
  return report;
}

function isFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value);
}

function displayReportPath(reportPath: fs.PathOrFileDescriptor) {
  return typeof reportPath === "string" || typeof reportPath === "number"
    ? String(reportPath)
    : reportPath.toString();
}

function validateCounter(
  counter: unknown,
  reportPath: fs.PathOrFileDescriptor,
  fieldName: string,
  index: number | null = null,
) {
  const label = index === null ? fieldName : `${fieldName}[${index}]`;
  const displayPath = displayReportPath(reportPath);
  if (!isRecord(counter)) {
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

function validateCounterRows(
  report: Record<string, unknown>,
  reportPath: fs.PathOrFileDescriptor,
  fieldName: string,
) {
  const displayPath = displayReportPath(reportPath);
  const rows = report[fieldName];
  if (!Array.isArray(rows)) {
    throw new Error(
      `[test-group-report] invalid grouped report ${displayPath}: ${fieldName} must be an array`,
    );
  }
  rows.forEach((row, index) => {
    validateCounter(row, reportPath, fieldName, index);
    if (!isRecord(row) || typeof row.key !== "string" || !row.key) {
      throw new Error(
        `[test-group-report] invalid grouped report ${displayPath}: ${fieldName}[${index}].key must be a non-empty string`,
      );
    }
  });
  return rows;
}

function validateTopFileRows(report: Record<string, unknown>, reportPath: fs.PathOrFileDescriptor) {
  const displayPath = displayReportPath(reportPath);
  if (!Array.isArray(report.topFiles)) {
    throw new Error(
      `[test-group-report] invalid grouped report ${displayPath}: topFiles must be an array`,
    );
  }
  report.topFiles.forEach((row, index) => {
    if (!isRecord(row)) {
      throw new Error(
        `[test-group-report] invalid grouped report ${displayPath}: topFiles[${index}] must be an object`,
      );
    }
    for (const key of ["config", "file", "group"]) {
      if (typeof row[key] !== "string" || !row[key]) {
        throw new Error(
          `[test-group-report] invalid grouped report ${displayPath}: topFiles[${index}].${key} must be a non-empty string`,
        );
      }
    }
    for (const key of ["durationMs", "testCount"]) {
      if (!isFiniteNumber(row[key])) {
        throw new Error(
          `[test-group-report] invalid grouped report ${displayPath}: topFiles[${index}].${key} must be a finite number`,
        );
      }
    }
  });
  return report.topFiles;
}

function validateRunRows(report: Record<string, unknown>, reportPath: fs.PathOrFileDescriptor) {
  const displayPath = displayReportPath(reportPath);
  if (!Array.isArray(report.runs)) {
    throw new Error(
      `[test-group-report] invalid grouped report ${displayPath}: runs must be an array`,
    );
  }
  report.runs.forEach((row, index) => {
    if (!isRecord(row)) {
      throw new Error(
        `[test-group-report] invalid grouped report ${displayPath}: runs[${index}] must be an object`,
      );
    }
    if (typeof row.config !== "string" && typeof row.label !== "string") {
      throw new Error(
        `[test-group-report] invalid grouped report ${displayPath}: runs[${index}] must include config or label`,
      );
    }
    if (!isFiniteNumber(row.elapsedMs) || !isFiniteNumber(row.status)) {
      throw new Error(
        `[test-group-report] invalid grouped report ${displayPath}: runs[${index}] must include finite elapsedMs and status`,
      );
    }
    if (
      row.maxRssBytes !== null &&
      row.maxRssBytes !== undefined &&
      !isFiniteNumber(row.maxRssBytes)
    ) {
      throw new Error(
        `[test-group-report] invalid grouped report ${displayPath}: runs[${index}].maxRssBytes must be finite when present`,
      );
    }
  });
  return report.runs;
}

function validateGroupedReport(
  report: unknown,
  reportPath: fs.PathOrFileDescriptor,
): asserts report is Record<string, unknown> & GroupedComparisonInput {
  const displayPath = displayReportPath(reportPath);
  if (!isRecord(report)) {
    throw new Error(
      `[test-group-report] invalid grouped report ${displayPath}: report must be an object`,
    );
  }
  if (report.command !== "test-group-report") {
    throw new Error(
      `[test-group-report] invalid grouped report ${displayPath}: command must be test-group-report`,
    );
  }
  if (typeof report.groupBy !== "string" || !["area", "folder", "top"].includes(report.groupBy)) {
    throw new Error(
      `[test-group-report] invalid grouped report ${displayPath}: groupBy must be area, folder, or top`,
    );
  }
  validateCounter(report.totals, reportPath, "totals");
  const groups = validateCounterRows(report, reportPath, "groups");
  const configs = validateCounterRows(report, reportPath, "configs");
  const topFiles = validateTopFileRows(report, reportPath);
  if (!Array.isArray(report.slowTests)) {
    throw new Error(
      `[test-group-report] invalid grouped report ${displayPath}: slowTests must be an array`,
    );
  }
  const runs = validateRunRows(report, reportPath);
  if (groups.length === 0 && configs.length === 0 && topFiles.length === 0 && runs.length === 0) {
    throw new Error(`[test-group-report] invalid grouped report ${displayPath}: no evidence rows`);
  }
}

/**
 * Resolves JSON report and per-run artifact directories from an output path.
 */
export function resolveReportArtifactDirs(outputPath: string) {
  const outputDir = path.dirname(outputPath);
  const outputExt = path.extname(outputPath);
  const outputStem = path.basename(outputPath, outputExt) || "group-report";
  const artifactDir = path.join(outputDir, outputStem);
  return {
    reportDir: path.join(artifactDir, "vitest-json"),
    logDir: path.join(artifactDir, "logs"),
  };
}

function withUniqueLabels<Plan extends { label: string }>(plans: Plan[]) {
  const totals = new Map<string, number>();
  for (const plan of plans) {
    totals.set(plan.label, (totals.get(plan.label) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
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
export function resolveRunPlans(args: TestGroupReportArgs): TestGroupRunPlan[] {
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
export function resolveFullSuiteVitestEnv(
  args: Pick<TestGroupReportArgs, "fullSuite">,
  env: NodeJS.ProcessEnv = process.env,
  label = "",
): NodeJS.ProcessEnv {
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
export function resolveRunPlanConcurrency(
  args: Pick<TestGroupReportArgs, "concurrency" | "fullSuite">,
  runPlanCount: number,
) {
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

function hasExplicitIsolationArg(args: string[]) {
  return args.some(
    (arg) => arg === "--isolate" || arg === "--no-isolate" || arg.startsWith("--isolate="),
  );
}

/**
 * Gives full-suite duration reports one process lifetime per test file.
 * This prevents unrelated retained module graphs and GC pauses from being
 * attributed to whichever assertion happens to run next in a shared worker.
 */
export function resolveReportVitestArgs(
  args: Pick<TestGroupReportArgs, "fullSuite" | "vitestArgs">,
) {
  if (!args.fullSuite || hasExplicitIsolationArg(args.vitestArgs)) {
    return args.vitestArgs;
  }
  return [...args.vitestArgs, "--isolate=true"];
}

/**
 * Builds concrete report run specs from parsed args and config plans.
 */
export function resolveReportRunSpecs(
  args: TestGroupReportArgs,
  runPlans: TestGroupRunPlan[],
  params: { concurrency?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): TestGroupRunSpec[] {
  const concurrency = params.concurrency ?? resolveRunPlanConcurrency(args, runPlans.length);
  const env = params.env ?? process.env;
  const vitestArgs = resolveReportVitestArgs(args);
  const specs = runPlans.map((plan) => ({
    ...plan,
    env: resolveFullSuiteVitestEnv(args, env, plan.label),
    vitestArgs,
  }));
  if (concurrency <= 1) {
    return specs;
  }
  return applyParallelVitestCachePaths(specs, {
    cwd: params.cwd ?? process.cwd(),
    env,
  });
}

function printRunLine(run: TestGroupRun) {
  console.log(
    `[test-group-report] ${run.label} status=${run.status} wall=${formatMs(run.elapsedMs)} rss=${formatBytesAsMb(run.maxRssBytes)} report=${run.reportPath}`,
  );
}

function printSlowTestsForRun(entry: ReportInputEntry, maxTestMs: number | null) {
  if (maxTestMs === null || !fs.existsSync(entry.reportPath)) {
    return;
  }
  const input = readReportInputs([entry]).reports[0];
  if (!input) {
    return;
  }
  const report = buildGroupedTestReport({
    groupBy: "area",
    maxTestMs,
    reports: [input],
  });
  for (const test of report.slowTests) {
    console.log(
      `[test-group-report] slow-test config=${test.config} duration=${formatMs(test.durationMs)} file=${test.file} name=${test.fullName}`,
    );
  }
}

export async function runReportPlans(params: {
  args: TestGroupReportArgs;
  logDir: string;
  reportDir: string;
  runPlans: TestGroupRunPlan[];
  runVitestJsonReport?: (params: RunVitestParams) => Promise<TestGroupRun>;
}) {
  const concurrency = resolveRunPlanConcurrency(params.args, params.runPlans.length);
  const runSpecs = resolveReportRunSpecs(params.args, params.runPlans, { concurrency });
  const runVitest = params.runVitestJsonReport ?? runVitestJsonReport;
  let failed = false;
  let exitCode = 0;

  const results = await pMap(
    runSpecs,
    async (plan) => {
      if (exitCode !== 0) {
        return null;
      }
      const slug = sanitizePathSegment(plan.label);
      const run = await runVitest({
        config: plan.config,
        forwardedArgs: plan.forwardedArgs,
        env: plan.env,
        label: plan.label,
        logPath: path.join(params.logDir, `${slug}.log`),
        reportPath: path.join(params.reportDir, `${slug}.json`),
        rss: params.args.rss,
        timeoutMs: params.args.timeoutMs,
        killGraceMs: params.args.killGraceMs,
        vitestArgs: plan.vitestArgs,
      });
      printRunLine(run);
      let includeEntry = true;
      if (run.status !== 0) {
        failed = true;
        if (!fs.existsSync(run.reportPath)) {
          console.error(
            `[test-group-report] missing JSON report for failed config; see ${run.logPath}`,
          );
          includeEntry = false;
        } else {
          try {
            readReportInput({ config: plan.label, reportPath: run.reportPath, run });
            console.error(
              `[test-group-report] config failed; keeping partial report from ${run.reportPath}`,
            );
          } catch (error) {
            const reason = coerceErrorMessage(error);
            console.error(
              `[test-group-report] config failed; skipping unusable JSON report from ${run.reportPath} (${reason})`,
            );
            includeEntry = false;
          }
        }
        if (!params.args.allowFailures) {
          exitCode = run.status || 1;
        }
      }
      const entry = includeEntry ? { config: plan.label, reportPath: run.reportPath, run } : null;
      if (entry) {
        printSlowTestsForRun(entry, params.args.maxTestMs);
      }
      return { entry, run };
    },
    { concurrency, stopOnError: true },
  );

  return {
    failed,
    exitCode,
    runEntries: results.flatMap((result) => (result?.entry ? [result.entry] : [])),
    runs: results.flatMap((result) => (result ? [result.run] : [])),
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
  const runs = [];
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
    runs.push(...result.runs);
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
    maxTestMs: args.maxTestMs ?? undefined,
    reports: reportInputs,
  });
  const envelope = {
    ...report,
    command: "test-group-report",
    failed,
    runs: runs.length > 0 ? runs : reportInputs.map((entry) => entry.run).filter(Boolean),
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
  main().catch((error: unknown) => {
    console.error(coerceErrorMessage(error));
    process.exit(1);
  });
}
