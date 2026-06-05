#!/usr/bin/env node
// Generate Config Doc Baseline script supports OpenClaw repository automation.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeConfigDocBaselineArtifacts } from "../src/config/doc-baseline.js";

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");

if (checkOnly && args.has("--write")) {
  console.error("Use either --check or --write, not both.");
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = await writeConfigDocBaselineArtifacts({
  repoRoot,
  check: checkOnly,
});

if (checkOnly) {
  if (!result.changed) {
    console.log(`OK ${path.relative(repoRoot, result.hashPath)}`);
    process.exit(0);
  }
  console.error(
    [
      "Config baseline drift detected.",
      `Hash mismatch: ${path.relative(repoRoot, result.hashPath)}`,
      "If this config-surface change is intentional, run `pnpm config:docs:gen` and commit the updated hash file.",
      "If not intentional, treat this as docs drift or a possible breaking config change and fix the schema/help changes first.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(
  [
    `Wrote ${path.relative(repoRoot, result.hashPath)}`,
    `Wrote ${path.relative(repoRoot, result.jsonPaths.combined)} (gitignored, local only)`,
    `Wrote ${path.relative(repoRoot, result.jsonPaths.core)} (gitignored, local only)`,
    `Wrote ${path.relative(repoRoot, result.jsonPaths.channel)} (gitignored, local only)`,
    `Wrote ${path.relative(repoRoot, result.jsonPaths.plugin)} (gitignored, local only)`,
  ].join("\n"),
);
