#!/usr/bin/env node

import { readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function check(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function selectKovaReport(reportDir) {
  const root = realpathSync(reportDir);
  const reports = readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".summary.json"),
    )
    .map((entry) => path.join(root, entry.name));

  check(
    reports.length === 1,
    `expected exactly one full Kova JSON report; found ${reports.length}`,
  );
  check(statSync(reports[0]).size > 0, "full Kova JSON report is empty");
  return reports[0];
}

function runCli(argv) {
  check(argv.length === 2 && argv[0] === "--report-dir", "usage: --report-dir <directory>");
  console.log(selectKovaReport(argv[1]));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
