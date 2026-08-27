// Shared helpers for running Vitest JSON reports and reading duration data.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

const normalizeRepoPath = (value: string) => value.split(path.sep).join("/");
const identity = (value: string) => value;
const repoRoot = path.resolve(process.cwd());

/**
 * Normalizes absolute or relative file names to repo-relative POSIX paths.
 */
export function normalizeTrackedRepoPath(value: unknown) {
  const normalizedValue = typeof value === "string" ? value : "";
  const repoRelative = path.isAbsolute(normalizedValue)
    ? path.relative(repoRoot, path.resolve(normalizedValue))
    : normalizedValue;
  if (path.isAbsolute(repoRelative) || repoRelative.startsWith("..") || repoRelative === "") {
    return normalizeRepoPath(normalizedValue);
  }
  return normalizeRepoPath(repoRelative);
}

/**
 * Reads and parses a JSON file.
 */
export function readJsonFile(filePath: fs.PathOrFileDescriptor) {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return parsed;
}

function validateVitestJsonReport(reportPath: fs.PathLike) {
  const displayPath = typeof reportPath === "string" ? reportPath : reportPath.toString();
  if (!fs.existsSync(reportPath)) {
    return `missing Vitest JSON report: ${displayPath}`;
  }
  try {
    const report = readJsonFile(reportPath);
    if (!isRecord(report)) {
      return `invalid Vitest JSON report: ${displayPath} (report must be an object)`;
    }
    if (!Array.isArray(report.testResults)) {
      return `invalid Vitest JSON report: ${displayPath} (missing testResults array)`;
    }
  } catch (error) {
    return `invalid Vitest JSON report: ${displayPath} (${
      error instanceof Error ? error.message : String(error)
    })`;
  }
  return null;
}

function defaultVitestJsonReportPath(prefix: string) {
  return path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${randomUUID()}.json`);
}

/**
 * Runs Vitest with the JSON reporter unless an existing report was supplied.
 */
export function runVitestJsonReport({
  config,
  reportPath = "",
  prefix = "openclaw-vitest-report",
}: {
  config: string;
  reportPath?: string;
  prefix?: string;
}) {
  const resolvedReportPath = reportPath || defaultVitestJsonReportPath(prefix);

  if (!(reportPath && fs.existsSync(resolvedReportPath))) {
    const run = spawnSync(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--config",
        config,
        "--reporter=json",
        "--outputFile",
        resolvedReportPath,
      ],
      {
        stdio: "inherit",
        env: process.env,
      },
    );

    if (run.status !== 0) {
      process.exit(run.status ?? 1);
    }
  }

  const invalidReport = validateVitestJsonReport(resolvedReportPath);
  if (invalidReport) {
    console.error(`[test-report-utils] ${invalidReport}`);
    process.exit(1);
  }

  return resolvedReportPath;
}

/**
 * Extracts per-file durations from a Vitest JSON report.
 */
export function collectVitestFileDurations(report: unknown, normalizeFile = identity) {
  return readTestResults(report)
    .map((result) => {
      const file = typeof result.name === "string" ? normalizeFile(result.name) : "";
      const start = typeof result.startTime === "number" ? result.startTime : 0;
      const end = typeof result.endTime === "number" ? result.endTime : 0;
      const testCount = Array.isArray(result.assertionResults) ? result.assertionResults.length : 0;
      return {
        file,
        durationMs: Math.max(0, end - start),
        testCount,
      };
    })
    .filter((entry) => entry.file.length > 0 && entry.durationMs > 0);
}

/**
 * Extracts per-assertion durations from a Vitest JSON report.
 */
export function collectVitestAssertionDurations(report: unknown, normalizeFile = identity) {
  return readTestResults(report).flatMap((result) => {
    const file = typeof result.name === "string" ? normalizeFile(result.name) : "";
    if (!file) {
      return [];
    }
    const assertions = Array.isArray(result.assertionResults)
      ? result.assertionResults.filter(isRecord)
      : [];
    return assertions
      .map((assertion) => {
        const durationMs =
          typeof assertion?.duration === "number" && Number.isFinite(assertion.duration)
            ? assertion.duration
            : 0;
        return {
          file,
          durationMs,
          fullName: typeof assertion?.fullName === "string" ? assertion.fullName : "",
          status: typeof assertion?.status === "string" ? assertion.status : "unknown",
        };
      })
      .filter((entry) => entry.durationMs > 0);
  });
}

function readTestResults(report: unknown) {
  if (!isRecord(report) || !Array.isArray(report.testResults)) {
    return [];
  }
  return report.testResults.filter(isRecord);
}
