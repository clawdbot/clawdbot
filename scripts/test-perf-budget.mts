// Runs a Vitest config and enforces wall-time regression budgets.
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  booleanFlag,
  isStrictAffirmativeValue,
  parseFlagArgs,
  stringFlag,
  type FlagSpec,
} from "./lib/arg-utils.mts";
import {
  budgetFloatFlag,
  parseBudgetNumber,
  readBudgetEnvNumber,
} from "./lib/budget-number-args.mts";
import { coerceErrorMessage } from "./lib/error-format.mts";
import { formatMs } from "./lib/vitest-report-cli-utils.mts";
import { readJsonFile, runVitestJsonReport } from "./test-report-utils.mts";

type PerfBudgetOptions = {
  baselineWallMs: number | null;
  config: string;
  maxRegressionPct: number;
  maxWallMs: number | null;
  reportOnly: boolean;
};

function nullableBudgetFloatFlag(
  flag: string,
  key: "baselineWallMs" | "maxWallMs",
): FlagSpec<PerfBudgetOptions> {
  return {
    consume(argv, index) {
      if (argv[index] !== flag) {
        return null;
      }
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`${flag} requires a value`);
      }
      return {
        flag,
        nextIndex: index + 1,
        repeatable: false,
        apply(target) {
          const parsed = parseBudgetNumber(value, flag);
          if (parsed === null) {
            throw new Error(`${flag} requires a value`);
          }
          target[key] = parsed;
        },
      };
    },
  };
}

function parseArgs(argv: readonly string[], env = process.env) {
  const opts = parseFlagArgs(
    argv,
    {
      config: "test/vitest/vitest.unit.config.ts",
      maxWallMs: readBudgetEnvNumber("OPENCLAW_TEST_PERF_MAX_WALL_MS", env),
      baselineWallMs: readBudgetEnvNumber("OPENCLAW_TEST_PERF_BASELINE_WALL_MS", env),
      maxRegressionPct: readBudgetEnvNumber("OPENCLAW_TEST_PERF_MAX_REGRESSION_PCT", env) ?? 10,
      reportOnly: isStrictAffirmativeValue(env.OPENCLAW_TEST_PERF_REPORT_ONLY),
    },
    [
      stringFlag("--config", "config"),
      nullableBudgetFloatFlag("--max-wall-ms", "maxWallMs"),
      nullableBudgetFloatFlag("--baseline-wall-ms", "baselineWallMs"),
      budgetFloatFlag("--max-regression-pct", "maxRegressionPct"),
      booleanFlag("--report-only", "reportOnly", true),
    ],
  );
  if (opts.maxWallMs === null && opts.baselineWallMs === null && !opts.reportOnly) {
    throw new Error(
      "[test-perf-budget] provide --max-wall-ms, --baseline-wall-ms, or set --report-only for an explicit timing-only run",
    );
  }
  return opts;
}

function collectPerfReportStats(reportPath: string) {
  let report: unknown;
  try {
    report = readJsonFile(reportPath);
  } catch (error) {
    throw new Error(
      `[test-perf-budget] failed to read Vitest JSON report ${reportPath}: ${coerceErrorMessage(
        error,
      )}`,
      { cause: error },
    );
  }

  let totalFileDurationMs = 0;
  let fileCount = 0;
  const testResults =
    isRecord(report) && Array.isArray(report.testResults) ? report.testResults : [];
  for (const result of testResults.filter(isRecord)) {
    if (typeof result.startTime === "number" && typeof result.endTime === "number") {
      totalFileDurationMs += Math.max(0, result.endTime - result.startTime);
      fileCount += 1;
    }
  }
  if (fileCount === 0) {
    throw new Error(`[test-perf-budget] Vitest JSON report contained no timed file results`);
  }
  return { fileCount, totalFileDurationMs };
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(coerceErrorMessage(error));
    process.exit(1);
  }

  const startedAt = process.hrtime.bigint();
  const reportPath = runVitestJsonReport({
    config: opts.config,
    prefix: "openclaw-vitest-perf",
  });
  const elapsedMs = Number.parseFloat(String(process.hrtime.bigint() - startedAt)) / 1_000_000;

  let reportStats;
  try {
    reportStats = collectPerfReportStats(reportPath);
  } catch (error) {
    console.error(coerceErrorMessage(error));
    process.exit(1);
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
      reportStats.totalFileDurationMs,
    )} files=${String(reportStats.fileCount)}`,
  );

  if (failed) {
    process.exit(1);
  }
}

/** Test-facing parser helpers for budget validation. */
export const testing = {
  collectPerfReportStats,
  parseArgs,
  parseBudgetNumber,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
