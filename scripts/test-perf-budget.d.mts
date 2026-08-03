export namespace testing {
  export { collectPerfReportStats };
  export { parseArgs };
  export { parseBudgetNumber };
}
declare function collectPerfReportStats(reportPath: unknown): {
  fileCount: number;
  totalFileDurationMs: number;
};
declare function parseArgs(argv: unknown, env?: NodeJS.ProcessEnv): unknown;
import { parseBudgetNumber } from "./lib/budget-number-args.mjs";
