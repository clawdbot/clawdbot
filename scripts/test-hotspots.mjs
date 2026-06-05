// Prints the slowest test files from a Vitest JSON report.
import {
  formatMs,
  loadVitestReportFromArgs,
  parseVitestReportArgs,
} from "./lib/vitest-report-cli-utils.mjs";
import { collectVitestFileDurations } from "./test-report-utils.mjs";

if (process.argv.slice(2).includes("--help")) {
  console.log(
    [
      "Usage: node scripts/test-hotspots.mjs [options]",
      "",
      "Print the slowest test files from a Vitest JSON report.",
      "",
      "Options:",
      "  --config <path>    Vitest config to run when no report is supplied",
      "  --report <path>    Reuse an existing Vitest JSON report",
      "  --limit <count>    Number of files to print (default: 20)",
      "  --help             Show this help text",
      "",
      "Examples:",
      "  node scripts/test-hotspots.mjs",
      "  node scripts/test-hotspots.mjs --config test/vitest/vitest.channels.config.ts --limit 10",
      "  node scripts/test-hotspots.mjs --report /tmp/vitest-report.json",
    ].join("\n"),
  );
  process.exit(0);
}

const opts = parseVitestReportArgs(process.argv.slice(2), {
  config: "test/vitest/vitest.unit.config.ts",
  limit: 20,
});
const report = loadVitestReportFromArgs(opts, "openclaw-vitest-hotspots");
const fileResults = collectVitestFileDurations(report).toSorted(
  (a, b) => b.durationMs - a.durationMs,
);

const top = fileResults.slice(0, opts.limit);
const totalDurationMs = fileResults.reduce((sum, item) => sum + item.durationMs, 0);
console.log(
  `\n[test-hotspots] top ${String(top.length)} by file duration (${formatMs(totalDurationMs)} total)`,
);
for (const [index, item] of top.entries()) {
  const label = String(index + 1).padStart(2, " ");
  const duration = formatMs(item.durationMs).padStart(10, " ");
  const tests = String(item.testCount).padStart(4, " ");
  console.log(`${label}. ${duration} | tests=${tests} | ${item.file}`);
}
