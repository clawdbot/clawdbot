// Shared CLI parsing and formatting helpers for Vitest report scripts.
import { readJsonFile, runVitestJsonReport } from "../test-report-utils.mts";
import { intFlag, parseFlagArgs, stringFlag } from "./arg-utils.mts";

type ReportDefaults = { config: string; limit: number; reportPath?: string };
type ReportLocation = { config: string; reportPath: string };

/**
 * Parses common Vitest report flags with caller-provided defaults.
 */
export function parseVitestReportArgs(argv: readonly string[], defaults: ReportDefaults) {
  return parseFlagArgs(
    argv,
    {
      config: defaults.config,
      limit: defaults.limit,
      reportPath: defaults.reportPath ?? "",
    },
    [
      stringFlag("--config", "config"),
      intFlag("--limit", "limit", { min: 1 }),
      stringFlag("--report", "reportPath"),
    ],
  );
}

/**
 * Runs Vitest JSON reporting from parsed args and loads the generated report.
 */
export function loadVitestReportFromArgs(args: ReportLocation, prefix: string) {
  const reportPath = runVitestJsonReport({
    config: args.config,
    reportPath: args.reportPath,
    prefix,
  });
  return readJsonFile(reportPath);
}

/**
 * Formats milliseconds with a fixed decimal precision.
 */
export function formatMs(value: number, digits = 1) {
  return `${value.toFixed(digits)}ms`;
}
