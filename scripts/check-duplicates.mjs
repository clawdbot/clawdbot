#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jscpdBin = path.join(repoRoot, "node_modules", "jscpd", "bin", "jscpd");

const targets = [
  "src",
  "extensions",
  "scripts",
  "packages",
  "ui",
  "apps",
  "docs",
  "qa",
  "security",
  "test",
  "skills",
  "openclaw.mjs",
  "config/knip.config.ts",
  "tsdown.config.ts",
  "vitest.config.ts",
];

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const sourcePattern = "**/*.{ts,tsx,js,mjs,cjs}";
const testPattern = "**/*.{test,e2e.test,live.test}.{ts,tsx,js,mjs,cjs}";
// Keep local agent support trees and vendored snapshots classified but outside jscpd.
const intentionallyUnscannedPrefixes = [".agents/", "vendor/"];

const generatedIgnores = [
  "extensions/qa-matrix/src/shared/**",
  "extensions/qa-matrix/src/report.ts",
  "extensions/qa-matrix/src/docker-runtime.ts",
  "extensions/qa-matrix/src/cli-paths.ts",
  "**/node_modules/**",
  "**/dist/**",
  "**/.git/**",
  "**/coverage/**",
  "**/build/**",
  "**/.build/**",
  "**/.artifacts/**",
  "vendor/**",
];

const testIgnores = [
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.test.js",
  "**/*.test.mjs",
  "**/*.test.cjs",
  "**/*.e2e.test.ts",
  "**/*.e2e.test.tsx",
  "**/*.e2e.test.js",
  "**/*.e2e.test.mjs",
  "**/*.e2e.test.cjs",
  "**/*.live.test.ts",
  "**/*.live.test.tsx",
  "**/*.live.test.js",
  "**/*.live.test.mjs",
  "**/*.live.test.cjs",
];

const commonArgs = [
  "--format",
  "typescript,javascript",
  "--gitignore",
  "--noSymlinks",
  "--min-lines",
  "50",
  "--min-tokens",
  "300",
];

const json = process.argv.includes("--json");
const coverageOnly = process.argv.includes("--coverage");

function normalizeRepoPath(value) {
  return value.split(path.sep).join("/");
}

function isUnderPrefix(value, prefix) {
  return value === prefix.slice(0, -1) || value.startsWith(prefix);
}

function isCoveredByTargets(file) {
  return targets.some((target) => {
    const normalizedTarget = normalizeRepoPath(target);
    if (file === normalizedTarget) {
      return true;
    }
    return file.startsWith(`${normalizedTarget}/`);
  });
}

function listTrackedSourceFiles() {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || "git ls-files failed");
  }
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map(normalizeRepoPath)
    .filter((file) => sourceExtensions.has(path.extname(file)))
    .filter((file) => !intentionallyUnscannedPrefixes.some((prefix) => isUnderPrefix(file, prefix)))
    .toSorted((left, right) => left.localeCompare(right));
}

function assertTargetCoverage() {
  const uncovered = listTrackedSourceFiles().filter((file) => !isCoveredByTargets(file));
  if (uncovered.length === 0) {
    console.log(`[dup:check] target coverage ok`);
    return true;
  }
  console.error(
    "[dup:check] tracked duplicate-scan source files are outside scan targets or intentional excludes:",
  );
  for (const file of uncovered) {
    console.error(`  - ${file}`);
  }
  return false;
}

function reportArgs(name) {
  if (!json) {
    return ["--reporters", "console"];
  }
  return ["--reporters", "json", "--output", path.join(".artifacts", "jscpd", name)];
}

const scans = [
  {
    name: "production",
    targets,
    pattern: sourcePattern,
    ignore: [...testIgnores, ...generatedIgnores],
  },
  {
    name: "tests",
    targets,
    pattern: testPattern,
    ignore: generatedIgnores,
  },
  {
    name: "src-mixed",
    targets: ["src"],
    pattern: sourcePattern,
    ignore: generatedIgnores,
  },
  {
    name: "extensions-mixed",
    targets: ["extensions"],
    pattern: sourcePattern,
    ignore: generatedIgnores,
  },
  {
    name: "test-mixed",
    targets: ["test"],
    pattern: sourcePattern,
    ignore: generatedIgnores,
  },
];

let failed = !assertTargetCoverage();
if (coverageOnly) {
  process.exit(failed ? 1 : 0);
}
for (const scan of scans) {
  console.log(`\n[dup:check] ${scan.name}`);
  const result = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=8192",
      jscpdBin,
      ...scan.targets,
      ...commonArgs,
      "--pattern",
      scan.pattern,
      "--ignore",
      scan.ignore.join(","),
      ...reportArgs(scan.name),
    ],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    },
  );
  if (result.status !== 0) {
    failed = true;
  }
  if (result.error) {
    console.error(result.error.message);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}
