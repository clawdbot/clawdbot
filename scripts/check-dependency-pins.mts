#!/usr/bin/env node

// Audits patched dependency pins for exact versions and drift.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import YAML from "yaml";

const PACKAGE_DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"];
const WORKSPACE_DEPENDENCY_SECTIONS = ["overrides"];
const EXACT_SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const EXACT_NPM_ALIAS_PATTERN =
  /^npm:(?:@[^/\s]+\/)?[^@\s]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const PINNED_GIT_PATTERN = /(?:#|\/commit\/)[0-9a-f]{40}$/iu;
const PINNED_GITHUB_TARBALL_PATTERN =
  /^https:\/\/codeload\.github\.com\/[^/\s]+\/[^/\s]+\/tar\.gz\/[0-9a-f]{40}$/iu;
const DEFAULT_GIT_TIMEOUT_MS = 60_000;

type DependencyPinViolation = {
  file: string;
  section: string;
  name: string;
  spec: unknown;
};

function runGit(cwd: string, args: string[], timeoutMs = DEFAULT_GIT_TIMEOUT_MS): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      // A synchronous child that ignores SIGTERM otherwise keeps its parent blocked.
      killSignal: "SIGKILL",
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ETIMEDOUT") {
      throw new Error(
        `dependency pin guard: git ${args.join(" ")} timed out after ${timeoutMs}ms.`,
        { cause: error },
      );
    }
    throw error;
  }
}

function listTrackedPackageJsonFiles(cwd: string, timeoutMs = DEFAULT_GIT_TIMEOUT_MS): string[] {
  return runGit(cwd, ["ls-files", "-z", "--", "*package.json"], timeoutMs)
    .split("\0")
    .filter(Boolean)
    .toSorted((left, right) => left.localeCompare(right));
}

function readJson(filePath: string): Record<string, unknown> {
  return asRecord(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
}

function readTrackedJson(
  cwd: string,
  relativePath: string,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
): Record<string, unknown> {
  const filePath = path.join(cwd, relativePath);
  if (fs.existsSync(filePath)) {
    return readJson(filePath);
  }
  return asRecord(JSON.parse(runGit(cwd, ["show", `:${relativePath}`], timeoutMs)) as unknown);
}

function isAllowedPinnedSpec(spec: unknown): boolean {
  if (typeof spec !== "string") {
    return false;
  }
  if (EXACT_SEMVER_PATTERN.test(spec) || EXACT_NPM_ALIAS_PATTERN.test(spec)) {
    return true;
  }
  if (spec === "workspace:*" || spec.startsWith("file:") || spec.startsWith("link:")) {
    return true;
  }
  if (/^(?:git\+|github:|gitlab:|bitbucket:)/u.test(spec)) {
    return PINNED_GIT_PATTERN.test(spec);
  }
  if (PINNED_GITHUB_TARBALL_PATTERN.test(spec)) {
    return true;
  }
  return false;
}

function collectPackageJsonViolations(
  cwd: string,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
): DependencyPinViolation[] {
  const violations: DependencyPinViolation[] = [];
  for (const relativePath of listTrackedPackageJsonFiles(cwd, timeoutMs)) {
    const packageJson = readTrackedJson(cwd, relativePath, timeoutMs);
    for (const section of PACKAGE_DEPENDENCY_SECTIONS) {
      for (const [name, spec] of Object.entries(asRecord(packageJson[section]))) {
        if (!isAllowedPinnedSpec(spec)) {
          violations.push({ file: relativePath, section, name, spec });
        }
      }
    }
  }
  return violations;
}

function collectDependencyMapViolations(
  file: string,
  section: string,
  dependencyMap: unknown,
  violations: DependencyPinViolation[],
): void {
  for (const [name, spec] of Object.entries(asRecord(dependencyMap))) {
    if (!isAllowedPinnedSpec(spec)) {
      violations.push({ file, section, name, spec });
    }
  }
}

function collectWorkspaceViolations(cwd: string): DependencyPinViolation[] {
  const file = "pnpm-workspace.yaml";
  const workspacePath = path.join(cwd, file);
  if (!fs.existsSync(workspacePath)) {
    return [];
  }
  const workspace = asRecord(YAML.parse(fs.readFileSync(workspacePath, "utf8")) as unknown);
  const violations: DependencyPinViolation[] = [];
  for (const section of WORKSPACE_DEPENDENCY_SECTIONS) {
    collectDependencyMapViolations(file, section, workspace?.[section], violations);
  }
  for (const [packageName, extension] of Object.entries(asRecord(workspace.packageExtensions))) {
    collectDependencyMapViolations(
      file,
      `packageExtensions.${packageName}.dependencies`,
      asRecord(extension).dependencies,
      violations,
    );
  }
  return violations;
}

/**
 * Collects dependency pin violations for the current workspace.
 */
export function collectDependencyPinViolations(
  cwd = process.cwd(),
  { gitTimeoutMs = DEFAULT_GIT_TIMEOUT_MS } = {},
): DependencyPinViolation[] {
  return [...collectPackageJsonViolations(cwd, gitTimeoutMs), ...collectWorkspaceViolations(cwd)];
}

/**
 * Builds the full dependency pin audit payload.
 */
function collectDependencyPinAudit(cwd = process.cwd()) {
  const packageJsonFiles = listTrackedPackageJsonFiles(cwd);
  let packageSpecCount = 0;
  for (const relativePath of packageJsonFiles) {
    const packageJson = readTrackedJson(cwd, relativePath);
    for (const section of PACKAGE_DEPENDENCY_SECTIONS) {
      packageSpecCount += Object.keys(asRecord(packageJson[section])).length;
    }
  }
  const workspaceViolations = collectWorkspaceViolations(cwd);
  const violations = [...collectPackageJsonViolations(cwd), ...workspaceViolations];
  return {
    packageManifestCount: packageJsonFiles.length,
    packageSpecCount,
    violations,
  };
}

/**
 * Runs the dependency pin check.
 */
export async function main() {
  const audit = collectDependencyPinAudit();
  const { violations } = audit;
  if (violations.length === 0) {
    process.stdout.write(
      `PASS direct dependency pin guard: checked ${audit.packageSpecCount} directly declared ` +
        `dependency specs across ${audit.packageManifestCount} tracked package manifests; ` +
        "0 violations.\n",
    );
    return;
  }

  console.error(
    `FAIL direct dependency pin guard: ${violations.length} unpinned directly declared ` +
      "dependency specs found. Direct dependency specs must be pinned exactly outside peer " +
      "dependency contracts:",
  );
  for (const violation of violations) {
    console.error(
      `- ${violation.file}:${violation.section}:${violation.name} -> ${JSON.stringify(violation.spec)}`,
    );
  }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
