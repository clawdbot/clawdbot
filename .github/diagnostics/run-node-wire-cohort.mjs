import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
const result = spawnSync(
  process.execPath,
  ["scripts/run-vitest.mjs", "run", "--config", "test/vitest/vitest.e2e.config.ts", ...files],
  { stdio: "inherit", env: { ...process.env, OPENCLAW_E2E_VERBOSE: "1" } },
);
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
