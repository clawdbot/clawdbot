import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { availableParallelism, cpus, totalmem } from "node:os";

const files = JSON.parse(readFileSync(new URL("./node-wire-cohort.json", import.meta.url), "utf8"));
if (
  !Array.isArray(files) ||
  files.length !== 60 ||
  new Set(files).size !== files.length ||
  files.some(
    (file) =>
      typeof file !== "string" ||
      !/^(?:src|test|extensions|packages)\/[a-zA-Z0-9./_-]+\.test\.ts$/.test(file),
  )
) {
  throw new Error("Expected the fixed 60-file Gateway 3/4 diagnostic cohort");
}
process.stderr.write("Diagnostic source only; this run cannot qualify release 2026.9.3.\n");
const nofile = readFileSync("/proc/self/limits", "utf8")
  .split("\n")
  .find((line) => line.startsWith("Max open files"));
process.stderr.write(
  `Diagnostic resources: ${JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    logicalCpus: cpus().length,
    availableParallelism: availableParallelism(),
    totalMemoryBytes: totalmem(),
    uid: process.getuid(),
    gid: process.getgid(),
    nofile,
  })}\n`,
);
const result = spawnSync(
  process.execPath,
  ["scripts/run-vitest.mjs", "run", "--config", "test/vitest/vitest.e2e.config.ts", ...files],
  { stdio: "inherit", env: { ...process.env, OPENCLAW_E2E_VERBOSE: "1" } },
);
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
