import { spawnSync } from "node:child_process";
import path from "node:path";
import { resolveRepoToolBinPath } from "./lib/local-check-runtime.mts";
import { runManagedCommand } from "./lib/managed-child-process.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
const repoRoot = resolveRepoRoot(import.meta.url);
const jscpdBin = resolveRepoToolBinPath("jscpd", { cwd: repoRoot });

const targets = [
  ".github/actions",
  "src",
  "extensions",
  "examples",
  "scripts",
  "packages",
  "ui",
  "apps",
  "docs",
  "qa",
  "security",
  "test",
  "skills",
  "config",
  "node-version.mjs",
  "openclaw.mjs",
  "tsdown.ai.config.ts",
  "tsdown.config.ts",
  "vitest.config.ts",
];

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const sourcePattern = "**/*.{ts,tsx,js,mjs,cjs}";
const testPattern = "**/*.{test,e2e.test,live.test}.{ts,tsx,js,mjs,cjs}";
// Keep local agent support trees and vendored snapshots classified but outside jscpd.
const intentionallyUnscannedPrefixes = [".agents/", "vendor/"];

const generatedIgnores = [
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
  "--min-lines",
  "50",
  "--min-tokens",
  "300",
];

const json = process.argv.includes("--json");
const coverageOnly = process.argv.includes("--coverage");

function normalizeRepoPath(value: string) {
  return value.split(path.sep).join("/");
}

function isUnderPrefix(value: string, prefix: string) {
  return value === prefix.slice(0, -1) || value.startsWith(prefix);
}

function isCoveredByTargets(file: string) {
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

function reportArgs(name: string) {
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
  const status = await runManagedCommand({
    bin: jscpdBin,
    args: [
      ...scan.targets,
      ...commonArgs,
      "--pattern",
      scan.pattern,
      "--ignore",
      scan.ignore.join(","),
      ...reportArgs(scan.name),
    ],
    cwd: repoRoot,
  }).catch((error: unknown) => {
    console.error(error);
    return 1;
  });
  if (status !== 0) {
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}
