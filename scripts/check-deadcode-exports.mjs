#!/usr/bin/env node
// Enforces a hard-zero policy for Knip's unused exports.
import { fileURLToPath } from "node:url";
import { isLikelyRepoFilePath, runKnip, uniqueSorted } from "./deadcode-knip-runner.mjs";

const KNIP_ARGS = [
  "--config",
  "config/knip.config.ts",
  "--production",
  "--no-progress",
  "--reporter",
  "compact",
  "--include",
  "exports,types,enumMembers",
  "--no-config-hints",
];

/** Parses compact Knip export sections into one path-and-symbol entry per finding. */
export function parseKnipCompactUnusedExportsResult(output) {
  const entries = [];
  let inExportSection = false;
  let sawExportSection = false;

  for (const line of output.split(/\r?\n/u)) {
    const sectionMatch = /^Unused (exports|exported types|exported enum members) \(\d+\)$/u.exec(
      line,
    );
    if (sectionMatch) {
      inExportSection = true;
      sawExportSection = true;
      continue;
    }
    if (/^Unused .+ \(\d+\)$/u.test(line)) {
      inExportSection = false;
      continue;
    }
    if (!inExportSection) {
      continue;
    }

    const separatorIndex = line.indexOf(": ");
    if (separatorIndex === -1) {
      continue;
    }
    const file = line.slice(0, separatorIndex).trim();
    if (!isLikelyRepoFilePath(file)) {
      continue;
    }
    const symbols = line.slice(separatorIndex + 2).split(", ");
    for (const symbol of symbols) {
      const trimmedSymbol = symbol.trim();
      if (trimmedSymbol) {
        entries.push(`${file}: ${trimmedSymbol}`);
      }
    }
  }

  return { entries: uniqueSorted(entries), sawExportSection };
}

/** Parses compact Knip export sections into one path-and-symbol entry per finding. */
export function parseKnipCompactUnusedExports(output) {
  return parseKnipCompactUnusedExportsResult(output).entries;
}

/** Rejects every unused export reported by Knip. */
export function checkUnusedExports(output) {
  const entries = parseKnipCompactUnusedExports(output);
  return {
    ok: entries.length === 0,
    entries,
    message:
      entries.length === 0
        ? ""
        : [
            "Unused exports are not allowed:",
            ...entries.map((entry) => `  ${entry}`),
            "Delete the exports or model their real production consumers in Knip.",
          ].join("\n"),
  };
}

async function main() {
  const result = await runKnip(KNIP_ARGS, { scanName: "unused-export scan" });
  if (result.errorCode || result.status === null) {
    console.error(
      `deadcode unused-export scan failed: ${result.errorCode ?? result.signal ?? "unknown"}${
        result.errorMessage ? `: ${result.errorMessage}` : ""
      }`,
    );
    if (result.output) {
      console.error(result.output);
    }
    process.exitCode = 1;
    return;
  }

  const parsed = parseKnipCompactUnusedExportsResult(result.output);
  // Knip's compact reporter omits empty sections, so a clean scan (exit 0)
  // legitimately prints no export sections; sectionless output is only a
  // failure signal when Knip also exited nonzero (crash/config error).
  if (!parsed.sawExportSection && result.status !== 0) {
    console.error("deadcode unused-export scan produced no export sections.");
    if (result.output) {
      console.error(result.output);
    }
    process.exitCode = 1;
    return;
  }

  const check = checkUnusedExports(result.output);
  if (!check.ok) {
    console.error(check.message);
    process.exitCode = 1;
    return;
  }
  console.log("[deadcode] Knip unused-export check passed with 0 entries.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
