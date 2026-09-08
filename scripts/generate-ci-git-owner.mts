#!/usr/bin/env node
// This dependency-free closure also runs before workspace dependencies exist.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { writeGeneratedOutput } from "./lib/generated-output-utils.mts";

try {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check")) {
    throw new Error("Usage: node scripts/generate-ci-git-owner.mts [--check]");
  }
  const repoRoot = fileURLToPath(new URL("../", import.meta.url));
  const workflowPath = ".github/workflows/ci.yml";
  const workflow = readFileSync(new URL(`../${workflowPath}`, import.meta.url), "utf8");
  const source = readFileSync(
    new URL("../.github/actions/git-owner/owner.py", import.meta.url),
    "utf8",
  );
  const marker =
    "          # Generated from .github/actions/git-owner/owner.py; do not edit here.\n";
  const endMarker = "          # End generated CI Git owner.\n";
  const start = workflow.indexOf(marker) + marker.length;
  const end = workflow.indexOf(endMarker, start);
  if (workflow.split(marker).length !== 2 || end < start) {
    throw new Error("Expected exactly one CI Git owner projection");
  }
  // Bash can block before starting the reader of a large heredoc on Darwin.
  // A literal argument preserves the source without pre-filling an unread pipe.
  const projection = `run_owner '${source.replaceAll("'", "'\\''")}'\n`;
  const next =
    workflow.slice(0, start) + projection.replace(/^(?=.)/gmu, "          ") + workflow.slice(end);
  const check = args.includes("--check");
  const result = writeGeneratedOutput({ check, next, outputPath: workflowPath, repoRoot });
  if (check && result.changed) {
    throw new Error("Stale CI Git owner projection; run pnpm ci:git-owner:gen");
  }
  console.log(`[ci-git-owner] ${check ? "checked" : "generated"} ${workflowPath}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("[ci-git-owner] FAILED (exit 1)");
  process.exitCode = 1;
}
