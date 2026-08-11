#!/usr/bin/env node
// Generate Plugin Sdk Api Baseline script supports OpenClaw repository automation.
import path from "node:path";
import { writePluginSdkApiBaselineArtifacts } from "../src/plugin-sdk/api-baseline.ts";

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const writeMode = args.has("--write");
const DRIFT_PREVIEW_LIMIT = 40;

if (checkOnly === writeMode) {
  console.error("Use exactly one of --check or --write.");
  process.exit(1);
}

const repoRoot = process.cwd();

async function main(): Promise<void> {
  const result = await writePluginSdkApiBaselineArtifacts({ repoRoot, check: checkOnly });
  if (checkOnly) {
    if (result.changed) {
      const contractDirectory = path.relative(repoRoot, result.contractDirectory);
      const diff = result.contractDiff;
      const driftedRecords = [
        ...(diff?.modified ?? []).map((fileName) => `- modified: ${fileName}`),
        ...(diff?.missing ?? []).map((fileName) => `- missing: ${fileName}`),
        ...(diff?.stale ?? []).map((fileName) => `- stale: ${fileName}`),
      ];
      console.error(
        [
          "Plugin SDK API contract drift detected.",
          `Contract directory: ${contractDirectory}`,
          `Modified: ${diff?.modified.length ?? 0}; missing: ${diff?.missing.length ?? 0}; stale: ${diff?.stale.length ?? 0}`,
          ...driftedRecords.slice(0, DRIFT_PREVIEW_LIMIT),
          ...(driftedRecords.length > DRIFT_PREVIEW_LIMIT
            ? [`... ${driftedRecords.length - DRIFT_PREVIEW_LIMIT} more record(s)`]
            : []),
          "If this Plugin SDK surface change is intentional, run `pnpm plugin-sdk:api:gen` and commit the updated contract.",
          "If not intentional, fix the plugin-sdk exports or metadata first.",
        ].join("\n"),
      );
      process.exit(1);
    }
    console.log(`OK ${path.relative(repoRoot, result.contractDirectory)}`);
    return;
  }
  console.log(
    [
      `Wrote ${path.relative(repoRoot, result.contractDirectory)} (${result.removedStaleCount} stale record(s) removed)`,
      `Wrote ${path.relative(repoRoot, result.jsonPath)} (gitignored, local only)`,
    ].join("\n"),
  );
}

await main();
