#!/usr/bin/env node
// Runs Knip unused-file detection and compares results to the allowlist.
import { fileURLToPath } from "node:url";
import {
  compareStringListToAllowlist,
  isLikelyRepoFilePath,
  KNIP_MAX_BUFFER_BYTES,
  runKnip,
  uniqueSorted,
} from "./deadcode-knip-runner.mjs";
import {
  KNIP_OPTIONAL_UNUSED_FILE_ALLOWLIST,
  KNIP_UNUSED_FILE_ALLOWLIST,
} from "./deadcode-unused-files.allowlist.mjs";

export { KNIP_MAX_BUFFER_BYTES };

const KNIP_ARGS = [
  "--config",
  "config/knip.config.ts",
  "--production",
  "--no-progress",
  "--reporter",
  "compact",
  "--files",
  "--no-config-hints",
];

/** Parses compact Knip output into unused file paths. */
export function parseKnipCompactUnusedFiles(output) {
  const files = [];
  let inUnusedFilesSection = false;
  let sawUnusedFilesSection = false;

  for (const line of output.split(/\r?\n/u)) {
    if (/^Unused files \(\d+\)$/u.test(line)) {
      inUnusedFilesSection = true;
      sawUnusedFilesSection = true;
      continue;
    }
    if (inUnusedFilesSection && line.trim() === "") {
      break;
    }

    const separatorIndex = line.lastIndexOf(": ");
    if (separatorIndex === -1 || (sawUnusedFilesSection && !inUnusedFilesSection)) {
      continue;
    }
    const file = line.slice(separatorIndex + 2).trim();
    if (isLikelyRepoFilePath(file)) {
      files.push(file);
    }
  }

  return uniqueSorted(files);
}

/** Compares detected unused files against the checked-in allowlist. */
export function compareUnusedFilesToAllowlist(
  actualFiles,
  allowlistFiles,
  optionalAllowlistFiles = [],
) {
  return compareStringListToAllowlist(actualFiles, allowlistFiles, optionalAllowlistFiles);
}

function formatUnusedFileComparison(comparison) {
  const lines = [];
  if (!comparison.allowlistIsSorted) {
    lines.push("deadcode unused-file allowlist is not sorted.");
  }
  if (comparison.duplicateAllowedCount > 0) {
    lines.push(
      `deadcode unused-file allowlist contains ${comparison.duplicateAllowedCount} duplicate entr${
        comparison.duplicateAllowedCount === 1 ? "y" : "ies"
      }.`,
    );
  }
  if (comparison.unexpected.length > 0) {
    lines.push("Unexpected unused files:");
    lines.push(...comparison.unexpected.map((file) => `  ${file}`));
  }
  if (comparison.stale.length > 0) {
    lines.push("Stale allowlist entries:");
    lines.push(...comparison.stale.map((file) => `  ${file}`));
  }
  return lines.join("\n");
}

/** Runs Knip and returns parsed unused-file results. */
export async function runKnipUnusedFiles(params = {}) {
  return await runKnip(KNIP_ARGS, { ...params, scanName: "unused-file scan" });
}

/** Checks detected unused files against the current allowlist. */
export function checkUnusedFiles(
  output,
  allowlistFiles = KNIP_UNUSED_FILE_ALLOWLIST,
  optionalAllowlistFiles = KNIP_OPTIONAL_UNUSED_FILE_ALLOWLIST,
) {
  const actual = parseKnipCompactUnusedFiles(output);
  const comparison = compareUnusedFilesToAllowlist(actual, allowlistFiles, optionalAllowlistFiles);
  return {
    ok:
      comparison.allowlistIsSorted &&
      comparison.duplicateAllowedCount === 0 &&
      comparison.unexpected.length === 0 &&
      comparison.stale.length === 0,
    comparison,
    message: formatUnusedFileComparison(comparison),
  };
}

async function main() {
  const result = await runKnipUnusedFiles();
  if (result.errorCode || result.status === null) {
    console.error(
      `deadcode unused-file scan failed: ${result.errorCode ?? result.signal ?? "unknown"}${
        result.errorMessage ? `: ${result.errorMessage}` : ""
      }`,
    );
    if (result.output) {
      console.error(result.output);
    }
    process.exitCode = 1;
    return;
  }
  const check = checkUnusedFiles(result.output);
  if (!check.ok) {
    if (check.message) {
      console.error(check.message);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `[deadcode] Knip unused-file allowlist matched ${check.comparison.actual.length} intentional entries.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
