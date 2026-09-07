import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runManagedCommand, terminateManagedChild } from "./lib/managed-child-process.mts";

const DEFAULT_HEAP_MB = 768;
const DEFAULT_RSS_MB = 1024;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_CAPTURE_BYTES = 512 * 1024;
const MAX_REPORT_BYTES = 1024 * 1024;
const SCANNER_PATH = fileURLToPath(new URL("./plugin-npm-security-scan.mts", import.meta.url));

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) {
      throw new Error(`Invalid plugin npm security runner argument near ${String(name)}.`);
    }
    values.set(name, value);
  }
  const artifactRoot = values.get("--artifact-root") ?? "";
  const candidateSha = values.get("--candidate-sha") ?? "";
  const report = values.get("--report") ?? "";
  const toolingSha = values.get("--tooling-sha") ?? "";
  if (
    !artifactRoot ||
    !/^[0-9a-f]{40}$/u.test(candidateSha) ||
    !report ||
    !/^[0-9a-f]{40}$/u.test(toolingSha)
  ) {
    throw new Error("Plugin npm security runner received an invalid identity or path.");
  }
  return {
    artifactRoot: path.resolve(artifactRoot),
    candidateSha,
    report: path.resolve(report),
    toolingSha,
  };
}

function testOverride(name, fallback) {
  if (process.env.NODE_ENV !== "test") {
    return fallback;
  }
  return process.env[name] || fallback;
}

function boundedAppend(current, chunk) {
  if (current.length >= MAX_CAPTURE_BYTES) {
    return current;
  }
  return Buffer.concat([current, chunk]).subarray(0, MAX_CAPTURE_BYTES);
}

function processGroupRssBytes(pid) {
  if (process.platform === "win32") {
    return { status: "unavailable" };
  }
  const result = spawnSync("ps", ["-A", "-o", "pid=,pgid=,rss=,stat="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
  });
  if (result.error || result.status !== 0) {
    return { status: "failed" };
  }
  const rows = result.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .filter((columns) => columns.length >= 4 && Number(columns[1]) === pid);
  const activeRows = rows.filter((columns) => !columns[3].startsWith("Z"));
  if (activeRows.length === 0) {
    return rows.length > 0 || !processExists(pid) ? { status: "exited" } : { status: "failed" };
  }
  const samples = activeRows.map((columns) => Number(columns[2]));
  // Linux can release a task's memory before marking it zombie; zero RSS is
  // a valid measurement, not a sampler failure or proof that the group exited.
  if (samples.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    return { status: "failed" };
  }
  return {
    bytes: samples.reduce((total, value) => total + value, 0) * 1024,
    status: "measured",
  };
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function sanitizeOutput(value, args) {
  let output = value.toString("utf8");
  for (const [source, replacement] of [
    [args.artifactRoot, "<artifacts>"],
    [path.dirname(args.report), "<report-dir>"],
    [process.cwd(), "<tooling>"],
  ]) {
    output = output.replaceAll(source, replacement);
  }
  return output
    .replaceAll(/\/(?:private\/)?tmp\/openclaw-plugin-npm-scan-[^/\s:]+/gu, "<scanner-stage>")
    .replaceAll(/(^|[\s:(])\/[^ \t\n\r:,)\]}]+/gu, "$1<path>");
}

function compactFailureReport(args, category) {
  return {
    candidateSha: args.candidateSha,
    errors: [`Plugin npm security scanner ${category}.`],
    layout: null,
    packages: [],
    scanScope: "supplemental-inert-package-input",
    schemaVersion: 1,
    status: "fail",
    summary: {
      findingCount: 0,
      packageCount: 0,
      reviewedCriticalFindingCount: 0,
      unexpectedCriticalFindingCount: 0,
    },
    toolingSha: args.toolingSha,
  };
}

function writeFailureReport(args, category) {
  mkdirSync(path.dirname(args.report), { recursive: true });
  writeFileSync(args.report, `${JSON.stringify(compactFailureReport(args, category))}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function existingReportStatus(args) {
  if (!existsSync(args.report)) {
    return null;
  }
  const stat = lstatSync(args.report);
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_REPORT_BYTES) {
    return null;
  }
  try {
    const report = JSON.parse(readFileSync(args.report, "utf8"));
    const valid =
      report?.candidateSha === args.candidateSha &&
      Array.isArray(report?.errors) &&
      Array.isArray(report?.packages) &&
      report?.scanScope === "supplemental-inert-package-input" &&
      (report?.status === "pass" || report?.status === "fail") &&
      typeof report?.summary === "object" &&
      report?.toolingSha === args.toolingSha &&
      report?.schemaVersion === 1;
    return valid ? report.status : null;
  } catch {
    return null;
  }
}

async function run(argv) {
  const args = parseArgs(argv);
  const scannerPath = testOverride("OPENCLAW_PLUGIN_SECURITY_RUNNER_CHILD", SCANNER_PATH);
  const heapMb = Number(testOverride("OPENCLAW_PLUGIN_SECURITY_RUNNER_HEAP_MB", DEFAULT_HEAP_MB));
  const rssMb = Number(testOverride("OPENCLAW_PLUGIN_SECURITY_RUNNER_RSS_MB", DEFAULT_RSS_MB));
  const timeoutMs = Number(
    testOverride("OPENCLAW_PLUGIN_SECURITY_RUNNER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
  );
  if (
    !Number.isSafeInteger(heapMb) ||
    heapMb < 16 ||
    heapMb > 4096 ||
    !Number.isSafeInteger(rssMb) ||
    rssMb < 16 ||
    rssMb > 4096 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 10 ||
    timeoutMs > DEFAULT_TIMEOUT_MS
  ) {
    throw new Error("Plugin npm security runner limits are invalid.");
  }

  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let rssFailure;
  let cancellationSignal;
  let child;
  let rssTimer;
  let exitCode = 1;
  let failure;
  try {
    exitCode = await runManagedCommand({
      bin: process.execPath,
      args: [`--max-old-space-size=${heapMb}`, "--import", "tsx", scannerPath, ...argv],
      cwd: process.cwd(),
      shell: false,
      requireProcessTreeExit: process.platform !== "win32",
      timeoutMs,
      timeoutKillGraceMs: 0,
      env: {
        CI: "1",
        HOME: process.env.HOME,
        NODE_ENV: process.env.NODE_ENV,
        PATH: process.env.PATH,
      },
      stdio: ["ignore", "pipe", "pipe"],
      onSignal: (signal) => {
        cancellationSignal ??= signal;
      },
      onReady: (scanner) => {
        child = scanner;
        scanner.stdout.on("data", (chunk) => {
          stdout = boundedAppend(stdout, chunk);
        });
        scanner.stderr.on("data", (chunk) => {
          stderr = boundedAppend(stderr, chunk);
        });
        rssTimer = setInterval(() => {
          if (scanner.exitCode !== null || scanner.signalCode !== null || !scanner.pid) {
            return;
          }
          const rssMeasurement = processGroupRssBytes(scanner.pid);
          if (rssMeasurement.status === "failed") {
            rssFailure ??= "could not measure RSS";
          } else if (
            rssMeasurement.status === "measured" &&
            rssMeasurement.bytes > rssMb * 1024 * 1024
          ) {
            rssFailure ??= "exceeded its RSS limit";
          } else {
            return;
          }
          terminateManagedChild(scanner, "SIGKILL");
        }, 250);
      },
    });
  } catch (error) {
    failure = error;
  } finally {
    clearInterval(rssTimer);
  }

  const safeStdout = sanitizeOutput(stdout, args);
  const safeStderr = sanitizeOutput(stderr, args);
  if (safeStdout) {
    process.stdout.write(safeStdout);
  }
  if (safeStderr) {
    process.stderr.write(safeStderr);
  }
  // Failed physical cleanup must not look like a successfully joined cancellation or timeout.
  if (failure && failure.code !== "ETIMEDOUT") {
    writeFailureReport(args, child?.pid ? "could not complete process cleanup" : "could not start");
    return 1;
  }
  const failureCategory = cancellationSignal
    ? `cancelled by ${String(cancellationSignal)}`
    : failure
      ? "timed out"
      : rssFailure;
  if (failureCategory) {
    writeFailureReport(args, failureCategory);
    return cancellationSignal ? exitCode : 1;
  }
  const reportStatus = existingReportStatus(args);
  if (!reportStatus) {
    writeFailureReport(
      args,
      child?.signalCode
        ? "exceeded its process limit"
        : existsSync(args.report)
          ? "wrote an invalid report"
          : "did not write a report",
    );
    return 1;
  }
  return exitCode === 0 && reportStatus === "pass" ? 0 : 1;
}

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
