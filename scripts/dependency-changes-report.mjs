#!/usr/bin/env node

// Builds dependency change reports from lockfile and manifest diffs.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  collectAllResolvedPackagesFromLockfile,
  createBulkAdvisoryPayload,
} from "./pre-commit/pnpm-audit-prod.mjs";

const DEPENDENCY_FILE_PATTERNS = [
  /^package\.json$/u,
  /^package-lock\.json$/u,
  /\/package-lock\.json$/u,
  /^npm-shrinkwrap\.json$/u,
  /\/npm-shrinkwrap\.json$/u,
  /^pnpm-lock\.yaml$/u,
  /^pnpm-workspace\.yaml$/u,
  /^patches\//u,
  /\/package\.json$/u,
];

const DEPENDENCY_DIFF_PATHS = [
  "package.json",
  "package-lock.json",
  "extensions/*/package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "extensions/*/npm-shrinkwrap.json",
  "*package.json",
  "patches",
];

function payloadFromLockfile(lockfileText) {
  return createBulkAdvisoryPayload(collectAllResolvedPackagesFromLockfile(lockfileText));
}

function versionsFor(payload, packageName) {
  return new Set(payload[packageName] ?? []);
}

/**
 * Creates a structured dependency diff report from base/head payloads.
 */
export function createDependencyChangesReport({
  basePayload,
  headPayload,
  dependencyFileChanges = [],
  baseLabel = "base",
  headLabel = "head",
  generatedAt = new Date().toISOString(),
}) {
  const packageNames = [
    ...new Set([...Object.keys(basePayload), ...Object.keys(headPayload)]),
  ].toSorted((left, right) => left.localeCompare(right));
  const addedPackages = [];
  const removedPackages = [];
  const changedPackages = [];

  for (const packageName of packageNames) {
    const baseVersions = versionsFor(basePayload, packageName);
    const headVersions = versionsFor(headPayload, packageName);
    if (baseVersions.size === 0) {
      addedPackages.push({
        packageName,
        versions: [...headVersions].toSorted((left, right) => left.localeCompare(right)),
      });
      continue;
    }
    if (headVersions.size === 0) {
      removedPackages.push({
        packageName,
        versions: [...baseVersions].toSorted((left, right) => left.localeCompare(right)),
      });
      continue;
    }
    const addedVersions = [...headVersions]
      .filter((version) => !baseVersions.has(version))
      .toSorted((left, right) => left.localeCompare(right));
    const removedVersions = [...baseVersions]
      .filter((version) => !headVersions.has(version))
      .toSorted((left, right) => left.localeCompare(right));
    if (addedVersions.length > 0 || removedVersions.length > 0) {
      changedPackages.push({ packageName, addedVersions, removedVersions });
    }
  }

  return {
    generatedAt,
    baseLabel,
    headLabel,
    summary: {
      basePackages: Object.keys(basePayload).length,
      headPackages: Object.keys(headPayload).length,
      addedPackages: addedPackages.length,
      removedPackages: removedPackages.length,
      changedPackages: changedPackages.length,
      dependencyFileChanges: dependencyFileChanges.length,
    },
    dependencyFileChanges,
    addedPackages,
    removedPackages,
    changedPackages,
  };
}

function markdownCode(value) {
  return `\`${String(value).replaceAll("`", "\\`")}\``;
}

function renderMarkdownReport(report) {
  const lines = [
    "# Dependency Change Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Target",
    "",
    `- Base: ${report.baseLabel}`,
    `- Head lockfile: ${report.headLabel}`,
    "",
    "## Scope",
    "",
    "This report compares dependency-related files and resolved lockfile package versions between the selected base and the current checkout.",
    "",
    "It reports two related but different things:",
    "",
    "- Dependency file changes: package manifests, npm shrinkwrap/package-lock, pnpm workspace config, lockfile, and patches.",
    "- Resolved package changes: package versions added, removed, or changed in pnpm-lock.yaml; inspect shrinkwrap/package-lock diffs directly.",
    "",
    "## Summary",
    "",
    "**Dependency files**",
    `- Changed files: ${report.summary.dependencyFileChanges}`,
    "",
    "**Resolved packages**",
    `- Base: ${report.summary.basePackages}`,
    `- Head: ${report.summary.headPackages}`,
    `- Added: ${report.summary.addedPackages}`,
    `- Removed: ${report.summary.removedPackages}`,
    `- Changed versions: ${report.summary.changedPackages}`,
    "",
  ];

  if (report.dependencyFileChanges.length > 0) {
    lines.push("## Dependency File Changes", "");
    for (const item of report.dependencyFileChanges) {
      lines.push(`- ${markdownCode(item.path)}: ${item.status}`);
    }
    lines.push("");
  }

  if (report.addedPackages.length > 0) {
    lines.push("## Added Resolved Packages", "");
    for (const item of report.addedPackages) {
      lines.push(`- ${markdownCode(item.packageName)}: ${item.versions.join(", ")}`);
    }
    lines.push("");
  }
  if (report.removedPackages.length > 0) {
    lines.push("## Removed Resolved Packages", "");
    for (const item of report.removedPackages) {
      lines.push(`- ${markdownCode(item.packageName)}: ${item.versions.join(", ")}`);
    }
    lines.push("");
  }
  if (report.changedPackages.length > 0) {
    lines.push("## Changed Resolved Package Versions", "");
    for (const item of report.changedPackages) {
      lines.push(
        `- ${markdownCode(item.packageName)}: +${item.addedVersions.join(", ") || "none"} ` +
          `-${item.removedVersions.join(", ") || "none"}`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function readGitFile(ref, filePath, cwd) {
  return execFileSync("git", ["show", `${ref}:${filePath}`], {
    cwd,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
}

/**
 * Reports whether a path is a dependency-related file.
 */
export function isDependencyFile(filePath) {
  return DEPENDENCY_FILE_PATTERNS.some((pattern) => pattern.test(filePath));
}

/**
 * Returns git pathspecs used for dependency diff collection.
 */
export function dependencyDiffPathspecs() {
  return [...DEPENDENCY_DIFF_PATHS];
}

function gitDiffDependencyFiles(baseRef, cwd) {
  const output = execFileSync(
    "git",
    ["diff", "--name-status", baseRef, "--", ...DEPENDENCY_DIFF_PATHS],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...paths] = line.split("\t");
      return {
        status,
        path: paths.at(-1),
        oldPath: paths.length > 1 ? paths[0] : null,
      };
    })
    .filter((item) => item.path && isDependencyFile(item.path))
    .toSorted((left, right) => {
      if (left.path !== right.path) {
        return left.path.localeCompare(right.path);
      }
      return left.status.localeCompare(right.status);
    });
}

function readRequiredValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseArgs(argv) {
  const options = {
    rootDir: process.cwd(),
    baseRef: null,
    baseLockfile: null,
    headLockfile: "pnpm-lock.yaml",
    jsonPath: null,
    markdownPath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--root") {
      options.rootDir = readRequiredValue(argv, index, "--root");
      index += 1;
      continue;
    }
    if (arg === "--base-ref") {
      options.baseRef = readRequiredValue(argv, index, "--base-ref");
      index += 1;
      continue;
    }
    if (arg === "--base-lockfile") {
      options.baseLockfile = readRequiredValue(argv, index, "--base-lockfile");
      index += 1;
      continue;
    }
    if (arg === "--head-lockfile") {
      options.headLockfile = readRequiredValue(argv, index, "--head-lockfile");
      index += 1;
      continue;
    }
    if (arg === "--json") {
      options.jsonPath = readRequiredValue(argv, index, "--json");
      index += 1;
      continue;
    }
    if (arg === "--markdown") {
      options.markdownPath = readRequiredValue(argv, index, "--markdown");
      index += 1;
      continue;
    }
    throw new Error(`Unsupported argument: ${arg}`);
  }
  if (!options.baseRef && !options.baseLockfile) {
    throw new Error("Expected --base-ref <git-ref> or --base-lockfile <path>.");
  }
  return options;
}

async function writeArtifact(filePath, content) {
  if (!filePath) {
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

/**
 * Generates and writes dependency change report artifacts.
 */
export async function runDependencyChangesReport(options) {
  const headLockfileText = await readFile(path.join(options.rootDir, options.headLockfile), "utf8");
  const baseLockfileText = options.baseRef
    ? readGitFile(options.baseRef, "pnpm-lock.yaml", options.rootDir)
    : await readFile(path.join(options.rootDir, options.baseLockfile), "utf8");
  const dependencyFileChanges = options.baseRef
    ? gitDiffDependencyFiles(options.baseRef, options.rootDir)
    : [];
  return createDependencyChangesReport({
    basePayload: payloadFromLockfile(baseLockfileText),
    headPayload: payloadFromLockfile(headLockfileText),
    dependencyFileChanges,
    baseLabel: options.baseRef ?? options.baseLockfile,
    headLabel: options.headLockfile,
  });
}

/**
 * Runs the dependency changes report CLI.
 */
export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const report = await runDependencyChangesReport(options);
  await writeArtifact(options.jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeArtifact(options.markdownPath, renderMarkdownReport(report));
  const artifactHint =
    typeof options.markdownPath === "string" ? " See ".concat(options.markdownPath, ".") : "";
  process.stdout.write(
    `INFO dependency change report: ${report.summary.addedPackages} added, ` +
      `${report.summary.removedPackages} removed, ${report.summary.changedPackages} changed ` +
      `resolved packages and ${report.summary.dependencyFileChanges} dependency file changes ` +
      `relative to ${report.baseLabel}.${artifactHint}\n`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    /** @param {unknown} error */ (error) => {
      process.stderr.write(`${error.stack ?? error.message ?? String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
