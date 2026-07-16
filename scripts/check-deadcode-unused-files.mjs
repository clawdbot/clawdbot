#!/usr/bin/env node
// Enforces a hard-zero policy for Knip's unused files.
import { fileURLToPath } from "node:url";
import {
  isLikelyRepoFilePath,
  KNIP_MAX_BUFFER_BYTES,
  runKnip,
  uniqueSorted,
} from "./deadcode-knip-runner.mjs";

export { KNIP_MAX_BUFFER_BYTES };

const KNIP_COMMON_ARGS = ["--no-progress", "--reporter", "compact", "--files", "--no-config-hints"];

const KNIP_SCANS = [
  {
    name: "production unused-file scan",
    args: ["--config", "config/knip.config.ts", "--production"],
  },
  {
    name: "full-tree unused-file scan",
    args: ["--config", "config/knip.all-exports.config.ts"],
  },
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

/** Runs Knip and returns parsed unused-file results. */
export async function runKnipUnusedFiles(params = {}) {
  return await runKnip([...KNIP_SCANS[0].args, ...KNIP_COMMON_ARGS], {
    ...params,
    scanName: KNIP_SCANS[0].name,
  });
}

/** Rejects every unused file reported by Knip. */
export function checkUnusedFiles(output) {
  const files = parseKnipCompactUnusedFiles(output);
  return {
    ok: files.length === 0,
    files,
    message:
      files.length === 0
        ? ""
        : [
            "Unused files are not allowed:",
            ...files.map((file) => `  ${file}`),
            "Delete the files or model their real entrypoints in Knip.",
          ].join("\n"),
  };
}

/** Validates both Knip process completion and the unused-file report. */
export function checkKnipUnusedFileScanResult(result) {
  if (result.errorCode || result.status === null || result.status !== 0) {
    return {
      ok: false,
      failureReason: result.errorCode ?? result.signal ?? `exit status ${String(result.status)}`,
      message: "",
    };
  }
  const check = checkUnusedFiles(result.output);
  return { ok: check.ok, failureReason: "", message: check.message };
}

async function main() {
  for (const scan of KNIP_SCANS) {
    const ok = await runUnusedFileScan(scan);
    if (!ok) {
      process.exitCode = 1;
      return;
    }
  }
  console.log("[deadcode] Knip production and full-tree unused-file checks passed with 0 entries.");
}

async function runUnusedFileScan(scan) {
  const result = await runKnip([...scan.args, ...KNIP_COMMON_ARGS], { scanName: scan.name });
  const validation = checkKnipUnusedFileScanResult(result);
  if (validation.failureReason) {
    console.error(
      `deadcode ${scan.name} failed: ${validation.failureReason}${
        result.errorMessage ? `: ${result.errorMessage}` : ""
      }`,
    );
    if (result.output) {
      console.error(result.output);
    }
    return false;
  }
  if (!validation.ok) {
    if (validation.message) {
      console.error(`${scan.name}:\n${validation.message}`);
    }
    return false;
  }
  console.log(`[deadcode] Knip ${scan.name} passed with 0 entries.`);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
