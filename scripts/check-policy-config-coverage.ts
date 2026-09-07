#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import {
  renderConfigDocBaselineArtifacts,
  type ConfigDocBaselineEntry,
} from "../src/config/doc-baseline.js";

type ClassificationStatus = "observed" | "ignored" | "out-of-scope" | "deferred";

type CoverageClassification = {
  readonly pattern: string;
  readonly status: ClassificationStatus;
  readonly area: string;
  readonly policy?: string;
  readonly reason: string;
  readonly allowNoSchemaPath?: boolean;
};

type CoverageConfig = {
  readonly monitored: readonly string[];
  readonly classifications: readonly CoverageClassification[];
};

type ConfigDocBaseline = {
  readonly coreEntries: readonly ConfigDocBaselineEntry[];
  readonly channelEntries: readonly ConfigDocBaselineEntry[];
  readonly pluginEntries: readonly ConfigDocBaselineEntry[];
};

function flattenConfigDocBaselineEntries(
  baseline: ConfigDocBaseline,
): readonly ConfigDocBaselineEntry[] {
  return [...baseline.coreEntries, ...baseline.channelEntries, ...baseline.pluginEntries];
}

type ClassifiedEntry = {
  readonly path: string;
  readonly kind: ConfigDocBaselineEntry["kind"];
  readonly classification?: CoverageClassification;
};

type UnmatchedMonitoredPattern = {
  readonly pattern: string;
};

const args = new Set(process.argv.slice(2));
const json = args.has("--json");
const check = args.has("--check");
const showCovered = args.has("--show-covered");

if (args.has("--help")) {
  console.log(`Usage: pnpm policy:config-coverage [--check] [--json] [--show-covered]

Internal maintainer report for Policy config coverage.

Default mode is report-only and exits 0 even when paths are unclassified.
Use --check when a policy maintainer intentionally wants unclassified or stale
coverage entries to fail locally.`);
  process.exit(0);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(repoRoot, "scripts/lib/policy-config-coverage.jsonc");

const config = JSON5.parse(await fs.readFile(configPath, "utf8")) as CoverageConfig;
const { baseline } = await renderConfigDocBaselineArtifacts();
const monitoredEntries = flattenConfigDocBaselineEntries(baseline)
  .filter((entry) => !entry.hasChildren)
  .filter((entry) => matchesAny(config.monitored, entry.path))
  .toSorted((left, right) => left.path.localeCompare(right.path));
const leafEntries = flattenConfigDocBaselineEntries(baseline).filter((entry) => !entry.hasChildren);
const unmatchedMonitored = config.monitored
  .filter(
    (pattern) =>
      !leafEntries.some((entry) => pathMatchesPattern(pattern, entry.path)) &&
      !config.classifications.some(
        (item) => item.allowNoSchemaPath === true && pathMatchesPattern(item.pattern, pattern),
      ),
  )
  .map((pattern) => ({ pattern }))
  .toSorted((left, right) => left.pattern.localeCompare(right.pattern));

const classified: ClassifiedEntry[] = monitoredEntries.map((entry) => ({
  path: entry.path,
  kind: entry.kind,
  classification: config.classifications.find((item) =>
    pathMatchesPattern(item.pattern, entry.path),
  ),
}));
const unclassified = classified.filter((entry) => entry.classification === undefined);
const stale = config.classifications.filter(
  (item) =>
    item.allowNoSchemaPath !== true &&
    !monitoredEntries.some((entry) => pathMatchesPattern(item.pattern, entry.path)),
);
const summaryCounts = summarize(classified);

if (json) {
  console.log(
    JSON.stringify(
      {
        ok: unclassified.length === 0 && stale.length === 0 && unmatchedMonitored.length === 0,
        monitoredPaths: monitoredEntries.length,
        counts: summaryCounts,
        unclassified,
        unmatchedMonitored,
        stale,
      },
      null,
      2,
    ),
  );
} else {
  printTextReport({
    monitoredPaths: monitoredEntries.length,
    counts: summaryCounts,
    unclassified,
    unmatchedMonitored,
    stale,
    classified,
  });
}

if (check && (unclassified.length > 0 || stale.length > 0 || unmatchedMonitored.length > 0)) {
  process.exit(1);
}

function printTextReport(input: {
  readonly monitoredPaths: number;
  readonly counts: Record<string, number>;
  readonly unclassified: readonly ClassifiedEntry[];
  readonly unmatchedMonitored: readonly UnmatchedMonitoredPattern[];
  readonly stale: readonly CoverageClassification[];
  readonly classified: readonly ClassifiedEntry[];
}): void {
  console.log(`Policy config coverage: ${input.monitoredPaths} monitored config leaf paths`);
  for (const [key, count] of Object.entries(input.counts).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    console.log(`  ${key}: ${count}`);
  }

  if (input.unclassified.length > 0) {
    console.log("\nUnclassified config paths:");
    for (const entry of input.unclassified) {
      console.log(`  - ${entry.path} (${entry.kind})`);
    }
    console.log(
      "\nClassify each as observed, ignored, out-of-scope, or deferred in scripts/lib/policy-config-coverage.jsonc.",
    );
  } else {
    console.log("\nNo unclassified monitored config paths.");
  }

  if (input.unmatchedMonitored.length > 0) {
    console.log("\nMonitored patterns with no matching config paths:");
    for (const entry of input.unmatchedMonitored) {
      console.log(`  - ${entry.pattern}`);
    }
  } else {
    console.log("\nNo monitored patterns without matching config paths.");
  }

  if (input.stale.length > 0) {
    console.log("\nStale coverage classifications:");
    for (const entry of input.stale) {
      console.log(`  - ${entry.pattern} (${entry.area}, ${entry.status})`);
    }
  }

  if (showCovered) {
    console.log("\nCovered paths:");
    for (const entry of input.classified) {
      const classification = entry.classification;
      console.log(
        `  - ${entry.path}: ${classification?.area ?? "unclassified"} / ${
          classification?.status ?? "unclassified"
        }`,
      );
    }
  }
}

function summarize(entries: readonly ClassifiedEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    const key =
      entry.classification === undefined
        ? "unclassified"
        : `${entry.classification.area}.${entry.classification.status}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function matchesAny(patterns: readonly string[], value: string): boolean {
  return patterns.some((pattern) => pathMatchesPattern(pattern, value));
}

function pathMatchesPattern(pattern: string, value: string): boolean {
  const patternParts = pattern.split(".");
  const valueParts = value.split(".");
  return matchesParts(patternParts, valueParts);
}

function matchesParts(patternParts: readonly string[], valueParts: readonly string[]): boolean {
  if (patternParts.length === 0) {
    return valueParts.length === 0;
  }
  const [head, ...tail] = patternParts;
  if (head === "**") {
    if (tail.length === 0) {
      return true;
    }
    for (let index = 0; index <= valueParts.length; index += 1) {
      if (matchesParts(tail, valueParts.slice(index))) {
        return true;
      }
    }
    return false;
  }
  if (valueParts.length === 0) {
    return false;
  }
  if (head !== "*" && head !== valueParts[0]) {
    return false;
  }
  return matchesParts(tail, valueParts.slice(1));
}
