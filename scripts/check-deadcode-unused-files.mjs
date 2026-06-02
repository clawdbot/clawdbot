#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  KNIP_OPTIONAL_UNUSED_FILE_ALLOWLIST,
  KNIP_UNUSED_FILE_ALLOWLIST,
} from "./deadcode-unused-files.allowlist.mjs";

const KNIP_VERSION = "6.8.0";
export const KNIP_TIMEOUT_MS = 10 * 60 * 1000;
export const KNIP_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
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

function normalizeRepoPath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function uniqueSorted(values) {
  return [...new Set(values.map(normalizeRepoPath))].toSorted((left, right) =>
    left.localeCompare(right),
  );
}

function isLikelyRepoFilePath(value) {
  return /^(apps|docs|extensions|packages|scripts|src|test|ui)\//u.test(normalizeRepoPath(value));
}

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
    if (separatorIndex === -1) {
      continue;
    }
    if (sawUnusedFilesSection && !inUnusedFilesSection) {
      continue;
    }
    const file = line.slice(separatorIndex + 2).trim();
    if (isLikelyRepoFilePath(file)) {
      files.push(file);
    }
  }

  return uniqueSorted(files);
}

export function compareUnusedFilesToAllowlist(
  actualFiles,
  allowlistFiles,
  optionalAllowlistFiles = [],
) {
  const actual = uniqueSorted(actualFiles);
  const allowed = uniqueSorted(allowlistFiles);
  const optionalAllowed = uniqueSorted(optionalAllowlistFiles);
  const allowedOrOptionalSet = new Set([...allowed, ...optionalAllowed]);
  const actualSet = new Set(actual);

  return {
    actual,
    allowed,
    unexpected: actual.filter((file) => !allowedOrOptionalSet.has(file)),
    stale: allowed.filter((file) => !actualSet.has(file)),
    duplicateAllowedCount: allowlistFiles.length - new Set(allowlistFiles).size,
    allowlistIsSorted:
      JSON.stringify(allowlistFiles.map(normalizeRepoPath)) === JSON.stringify(allowed),
  };
}

export function formatUnusedFileComparison(comparison) {
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

function spawnErrorCode(error) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

export function runKnipUnusedFiles(params = {}) {
  const run = params.spawnSyncCommand ?? spawnSync;
  const result = run(
    "pnpm",
    ["--config.minimum-release-age=0", "dlx", `knip@${KNIP_VERSION}`, ...KNIP_ARGS],
    {
      encoding: "utf8",
      killSignal: "SIGTERM",
      maxBuffer: params.maxBufferBytes ?? KNIP_MAX_BUFFER_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: params.timeoutMs ?? KNIP_TIMEOUT_MS,
    },
  );
  return {
    status: result.status,
    signal: result.signal,
    errorCode: spawnErrorCode(result.error),
    errorMessage: result.error?.message,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

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

function main() {
  const result = runKnipUnusedFiles();
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
  main();
}
