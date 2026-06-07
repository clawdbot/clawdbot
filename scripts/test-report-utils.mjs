// Shared helpers for running Vitest JSON reports and reading duration data.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const normalizeRepoPath = (value) => value.split(path.sep).join("/");
const repoRoot = path.resolve(process.cwd());

/**
 * Normalizes absolute or relative file names to repo-relative POSIX paths.
 */
export function normalizeTrackedRepoPath(value) {
  const normalizedValue = typeof value === "string" ? value : String(value ?? "");
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
export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * Reads a JSON file or returns the provided fallback on failure.
 */
export function tryReadJsonFile(filePath, fallback) {
  try {
    return readJsonFile(filePath);
  } catch {
    return fallback;
  }
}

function validateVitestJsonReport(reportPath) {
  if (!fs.existsSync(reportPath)) {
    return `missing Vitest JSON report: ${reportPath}`;
  }
  try {
    const report = readJsonFile(reportPath);
    if (!report || typeof report !== "object" || Array.isArray(report)) {
      return `invalid Vitest JSON report: ${reportPath} (report must be an object)`;
    }
    if (!Array.isArray(report.testResults)) {
      return `invalid Vitest JSON report: ${reportPath} (missing testResults array)`;
    }
  } catch (error) {
    return `invalid Vitest JSON report: ${reportPath} (${
      error instanceof Error ? error.message : String(error)
    })`;
  }
  return null;
}

/**
 * Runs Vitest with the JSON reporter unless an existing report was supplied.
 */
export function runVitestJsonReport({
  config,
  reportPath = "",
  prefix = "openclaw-vitest-report",
}) {
  const resolvedReportPath = reportPath || path.join(os.tmpdir(), `${prefix}-${Date.now()}.json`);

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
export function collectVitestFileDurations(report, normalizeFile = (value) => value) {
  return (report.testResults ?? [])
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
export function collectVitestAssertionDurations(report, normalizeFile = (value) => value) {
  return (report.testResults ?? []).flatMap((result) => {
    const file = typeof result.name === "string" ? normalizeFile(result.name) : "";
    if (!file) {
      return [];
    }
    return (result.assertionResults ?? [])
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
