import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const normalizeRepoPath = (value) => value.split(path.sep).join("/");
const repoRoot = path.resolve(process.cwd());

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

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function tryReadJsonFile(filePath, fallback) {
  try {
    return readJsonFile(filePath);
  } catch {
    return fallback;
  }
}

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

  return resolvedReportPath;
}

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
