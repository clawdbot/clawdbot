#!/usr/bin/env node
// Generate Plugin Sdk Api Baseline script supports OpenClaw repository automation.
import path from "node:path";
import { writePluginSdkApiBaselineArtifacts } from "../src/plugin-sdk/api-baseline.ts";

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const writeMode = args.has("--write");

if (checkOnly === writeMode) {
  console.error("Use exactly one of --check or --write.");
  process.exit(1);
}

const repoRoot = process.cwd();

async function main(): Promise<void> {
  const result = await writePluginSdkApiBaselineArtifacts({ repoRoot, check: checkOnly });
  if (checkOnly) {
    if (result.changed) {
      console.error(
        [
          "Plugin SDK API contract drift detected.",
          `Manifest mismatch: ${path.relative(repoRoot, result.hashPath)}`,
          "If this Plugin SDK surface change is intentional, run `pnpm plugin-sdk:api:gen` and commit the updated manifest.",
          "If not intentional, fix the plugin-sdk exports or metadata first.",
        ].join("\n"),
      );
      process.exit(1);
    }
    console.log(`OK ${path.relative(repoRoot, result.hashPath)}`);
    return;
  }
  console.log(
    [
      `Wrote ${path.relative(repoRoot, result.hashPath)}`,
      `Wrote ${path.relative(repoRoot, result.jsonPath)} (gitignored, local only)`,
      `Wrote ${path.relative(repoRoot, result.statefilePath)} (gitignored, local only)`,
    ].join("\n"),
  );
}

await main();
