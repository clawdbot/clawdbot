#!/usr/bin/env node
// Generate SQLite Session Schema Baseline script supports OpenClaw repository automation.
import path from "node:path";
import { writeSqliteSessionSchemaBaselineArtifacts } from "./lib/sqlite-session-schema-baseline.ts";

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const writeMode = args.has("--write");

if (checkOnly === writeMode) {
  console.error("Use exactly one of --check or --write.");
  process.exit(1);
}

const repoRoot = process.cwd();
const result = await writeSqliteSessionSchemaBaselineArtifacts({
  repoRoot,
  check: checkOnly,
});

if (checkOnly) {
  if (result.changed) {
    console.error(
      [
        "SQLite sessions/transcripts schema baseline drift detected.",
        `Hash mismatch: ${path.relative(repoRoot, result.hashPath)}`,
        "This means the sessions, conversations, or transcripts SQLite DDL changed.",
        "If this schema change is intentional, run `pnpm sqlite:sessions-schema:gen` and commit the updated hash file.",
        "If not intentional, keep the schema stable or move unrelated state to a separate table/store.",
      ].join("\n"),
    );
    process.exit(1);
  }
  console.log(`OK ${path.relative(repoRoot, result.hashPath)}`);
} else {
  console.log(
    [
      `Wrote ${path.relative(repoRoot, result.hashPath)}`,
      `Wrote ${path.relative(repoRoot, result.sqlPath)} (gitignored, local only)`,
    ].join("\n"),
  );
}
