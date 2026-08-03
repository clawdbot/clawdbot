#!/usr/bin/env node
// Generate Runtime Sidecar Paths Baseline script supports OpenClaw repository automation.
import path from "node:path";
import { writeBundledRuntimeSidecarPathBaseline } from "../src/plugins/runtime-sidecar-paths-baseline.js";

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const writeMode = args.has("--write");

if (checkOnly === writeMode) {
  console.error("Use exactly one of --check or --write.");
  process.exit(1);
}

const repoRoot = process.cwd();
const result = await writeBundledRuntimeSidecarPathBaseline({
  repoRoot,
  check: checkOnly,
});

if (checkOnly) {
  if (result.changed) {
    console.error(
      [
        "Bundled runtime sidecar path baseline drift detected.",
        `Expected current: ${path.relative(repoRoot, result.jsonPath)}`,
        "If this bundled plugin runtime-sidecar change is intentional, run `pnpm runtime-sidecars:gen` and commit the updated baseline file.",
        "If not intentional, fix the bundled plugin metadata/public surface drift first.",
      ].join("\n"),
    );
    process.exit(1);
  }
  console.log(`OK ${path.relative(repoRoot, result.jsonPath)}`);
} else {
  console.log(`Wrote ${path.relative(repoRoot, result.jsonPath)}`);
}
