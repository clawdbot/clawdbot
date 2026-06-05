// Refreshes the checked-in CLI startup benchmark fixture.
import { spawnSync } from "node:child_process";
import { parseFlagArgs, stringFlag, intFlag } from "./lib/arg-utils.mjs";

const CLI_STARTUP_BENCH_FIXTURE_PATH = "test/fixtures/cli-startup-bench.json";

if (process.argv.slice(2).includes("--help")) {
  console.log(
    [
      "Usage: node scripts/test-update-cli-startup-bench.mjs [options]",
      "",
      "Refresh the checked-in CLI benchmark fixture.",
      "",
      "Options:",
      "  --out <path>          Output path (default: test/fixtures/cli-startup-bench.json)",
      "  --entry <path>        CLI entry to benchmark (default: openclaw.mjs)",
      "  --preset <name>       startup | real | all (default: all)",
      "  --runs <n>            Measured runs per case (default: 5)",
      "  --warmup <n>          Warmup runs per case (default: 1)",
      "  --timeout-ms <ms>     Per-run timeout (default: 30000)",
      "  --help                Show this help text",
      "",
      "Example:",
      "  node scripts/test-update-cli-startup-bench.mjs --preset all --runs 3 --warmup 1",
    ].join("\n"),
  );
  process.exit(0);
}

const opts = parseFlagArgs(
  process.argv.slice(2),
  {
    out: CLI_STARTUP_BENCH_FIXTURE_PATH,
    entry: "openclaw.mjs",
    preset: "all",
    runs: 5,
    warmup: 1,
    timeoutMs: 30_000,
  },
  [
    stringFlag("--out", "out"),
    stringFlag("--entry", "entry"),
    stringFlag("--preset", "preset"),
    intFlag("--runs", "runs", { min: 1 }),
    intFlag("--warmup", "warmup", { min: 0 }),
    intFlag("--timeout-ms", "timeoutMs", { min: 1 }),
  ],
);

const args = [
  "--import",
  "tsx",
  "scripts/bench-cli-startup.ts",
  "--entry",
  opts.entry,
  "--preset",
  opts.preset,
  "--runs",
  String(opts.runs),
  "--warmup",
  String(opts.warmup),
  "--timeout-ms",
  String(opts.timeoutMs),
  "--output",
  opts.out,
];

const run = spawnSync(process.execPath, args, {
  cwd: process.cwd(),
  stdio: "inherit",
  env: process.env,
});

if (run.status !== 0) {
  process.exit(run.status ?? 1);
}

console.log(`[test-update-cli-startup-bench] wrote fixture to ${opts.out}`);
