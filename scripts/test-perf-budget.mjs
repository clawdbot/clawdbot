import { pathToFileURL } from "node:url";
import { parseFlagArgs, stringFlag } from "./lib/arg-utils.mjs";
import { formatMs } from "./lib/vitest-report-cli-utils.mjs";
import { readJsonFile, runVitestJsonReport } from "./test-report-utils.mjs";

function parseBudgetNumber(raw, label) {
  const value = raw?.trim();
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return parsed;
}

function readBudgetEnvNumber(name, env) {
  return parseBudgetNumber(env[name], name);
}

function budgetFloatFlag(flag, key) {
  return {
    consume(argv, index) {
      if (argv[index] !== flag) {
        return null;
      }
      return {
        nextIndex: index + 1,
        apply(target) {
          const parsed = parseBudgetNumber(argv[index + 1], flag);
          if (parsed === null) {
            throw new Error(`${flag} requires a value`);
          }
          target[key] = parsed;
        },
      };
    },
  };
}

function parseArgs(argv, env = process.env) {
  return parseFlagArgs(
    argv,
    {
      config: "test/vitest/vitest.unit.config.ts",
      maxWallMs: readBudgetEnvNumber("OPENCLAW_TEST_PERF_MAX_WALL_MS", env),
      baselineWallMs: readBudgetEnvNumber("OPENCLAW_TEST_PERF_BASELINE_WALL_MS", env),
      maxRegressionPct: readBudgetEnvNumber("OPENCLAW_TEST_PERF_MAX_REGRESSION_PCT", env) ?? 10,
    },
    [
      stringFlag("--config", "config"),
      budgetFloatFlag("--max-wall-ms", "maxWallMs"),
      budgetFloatFlag("--baseline-wall-ms", "baselineWallMs"),
      budgetFloatFlag("--max-regression-pct", "maxRegressionPct"),
    ],
  );
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const startedAt = process.hrtime.bigint();
  const reportPath = runVitestJsonReport({
    config: opts.config,
    prefix: "openclaw-vitest-perf",
  });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

  let totalFileDurationMs = 0;
  let fileCount = 0;
  try {
    const report = readJsonFile(reportPath);
    for (const result of report.testResults ?? []) {
      if (typeof result.startTime === "number" && typeof result.endTime === "number") {
        totalFileDurationMs += Math.max(0, result.endTime - result.startTime);
        fileCount += 1;
      }
    }
  } catch {
    // Keep budget checks based on wall time when JSON parsing fails.
  }

  const allowedByBaseline =
    opts.baselineWallMs !== null
      ? opts.baselineWallMs * (1 + (opts.maxRegressionPct ?? 0) / 100)
      : null;

  let failed = false;
  if (opts.maxWallMs !== null && elapsedMs > opts.maxWallMs) {
    console.error(
      `[test-perf-budget] wall time ${formatMs(elapsedMs)} exceeded max ${formatMs(
        opts.maxWallMs,
      )}.`,
    );
    failed = true;
  }
  if (allowedByBaseline !== null && elapsedMs > allowedByBaseline) {
    console.error(
      `[test-perf-budget] wall time ${formatMs(elapsedMs)} exceeded baseline budget ${formatMs(
        allowedByBaseline,
      )} (baseline ${formatMs(opts.baselineWallMs ?? 0)}, +${String(opts.maxRegressionPct)}%).`,
    );
    failed = true;
  }

  console.log(
    `[test-perf-budget] config=${opts.config} wall=${formatMs(elapsedMs)} file-sum=${formatMs(
      totalFileDurationMs,
    )} files=${String(fileCount)}`,
  );

  if (failed) {
    process.exit(1);
  }
}

export const testing = {
  parseArgs,
  parseBudgetNumber,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
