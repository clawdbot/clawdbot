#!/usr/bin/env node
// Enforces a ratcheting baseline for Knip's unused exports.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  KNIP_OPTIONAL_UNUSED_EXPORT_BASELINE,
  KNIP_UNUSED_EXPORT_BASELINE,
} from "./deadcode-exports.baseline.mjs";
import {
  compareStringListToAllowlist,
  isLikelyRepoFilePath,
  runKnip,
  uniqueSorted,
} from "./deadcode-knip-runner.mjs";

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

const BASELINE_HEADER = `// Pre-existing unused exports awaiting deletion.
// New entries fail CI. After deleting dead code, run \`pnpm deadcode:exports:update\`.
// Do not add entries to avoid fixing new findings.`;

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

/** Compares detected unused exports against the checked-in baseline. */
export function compareUnusedExportsToBaseline(
  actualEntries,
  baselineEntries,
  optionalBaselineEntries = [],
) {
  return compareStringListToAllowlist(actualEntries, baselineEntries, optionalBaselineEntries);
}

function formatUnusedExportComparison(comparison) {
  const lines = [];
  if (!comparison.allowlistIsSorted) {
    lines.push("deadcode unused-export baseline is not sorted.");
  }
  if (comparison.duplicateAllowedCount > 0) {
    lines.push(
      `deadcode unused-export baseline contains ${comparison.duplicateAllowedCount} duplicate entr${
        comparison.duplicateAllowedCount === 1 ? "y" : "ies"
      }.`,
    );
  }
  if (comparison.unexpected.length > 0) {
    lines.push("Unexpected unused exports:");
    lines.push(...comparison.unexpected.map((entry) => `  ${entry}`));
  }
  if (comparison.stale.length > 0) {
    lines.push("Stale required baseline entries:");
    lines.push(...comparison.stale.map((entry) => `  ${entry}`));
  }
  if (lines.length > 0) {
    lines.push("Run `pnpm deadcode:exports:update` after removing dead code.");
  }
  return lines.join("\n");
}

function formatArrayExport(name, entries) {
  if (entries.length === 0) {
    return `export const ${name} = [];`;
  }
  return `export const ${name} = [\n${entries.map((entry) => `  ${JSON.stringify(entry)},`).join("\n")}\n];`;
}

/** Emits the checked-in baseline module used by --update. */
export function formatUnusedExportBaseline(
  requiredEntries,
  optionalEntries = KNIP_OPTIONAL_UNUSED_EXPORT_BASELINE,
) {
  // Optional entries are platform-variant: promoting one into the required
  // list would make CI stale-fail on platforms where it is legitimately absent.
  const optionalSet = new Set(uniqueSorted(optionalEntries));
  return `${BASELINE_HEADER}\n${formatArrayExport(
    "KNIP_UNUSED_EXPORT_BASELINE",
    uniqueSorted(requiredEntries).filter((entry) => !optionalSet.has(entry)),
  )}\n\n// Platform-variant findings. Allowed when present; never required.\n${formatArrayExport(
    "KNIP_OPTIONAL_UNUSED_EXPORT_BASELINE",
    uniqueSorted(optionalEntries),
  )}\n`;
}

/** Checks Knip output against the current baseline. */
export function checkUnusedExports(
  output,
  baselineEntries = KNIP_UNUSED_EXPORT_BASELINE,
  optionalBaselineEntries = KNIP_OPTIONAL_UNUSED_EXPORT_BASELINE,
) {
  const actual = parseKnipCompactUnusedExports(output);
  const comparison = compareUnusedExportsToBaseline(
    actual,
    baselineEntries,
    optionalBaselineEntries,
  );
  return {
    ok:
      comparison.allowlistIsSorted &&
      comparison.duplicateAllowedCount === 0 &&
      comparison.unexpected.length === 0 &&
      comparison.stale.length === 0,
    comparison,
    message: formatUnusedExportComparison(comparison),
  };
}

async function main() {
  const update = process.argv.slice(2).includes("--update");
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

  const actual = parsed.entries;
  if (update) {
    const baselinePath = fileURLToPath(new URL("./deadcode-exports.baseline.mjs", import.meta.url));
    await writeFile(
      baselinePath,
      formatUnusedExportBaseline(actual, KNIP_OPTIONAL_UNUSED_EXPORT_BASELINE),
      "utf8",
    );
    console.log(`[deadcode] Updated unused-export baseline with ${actual.length} entries.`);
    return;
  }

  const check = checkUnusedExports(result.output);
  if (!check.ok) {
    console.error(check.message);
    process.exitCode = 1;
    return;
  }
  console.log(`[deadcode] Knip unused-export baseline matched ${actual.length} entries.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
