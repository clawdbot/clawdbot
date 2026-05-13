#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const PACKAGE_DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"];
const WORKSPACE_DEPENDENCY_SECTIONS = ["overrides"];
const EXACT_SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const EXACT_NPM_ALIAS_PATTERN =
  /^npm:(?:@[^/\s]+\/)?[^@\s]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const PINNED_GIT_PATTERN = /(?:#|\/commit\/)[0-9a-f]{40}$/iu;

function listTrackedPackageJsonFiles(cwd) {
  return execFileSync("git", ["ls-files", "-z", "--", "*package.json"], {
    cwd,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .toSorted((left, right) => left.localeCompare(right));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isAllowedPinnedSpec(spec) {
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
  return false;
}

function collectPackageJsonViolations(cwd) {
  const violations = [];
  for (const relativePath of listTrackedPackageJsonFiles(cwd)) {
    const packageJson = readJson(path.join(cwd, relativePath));
    for (const section of PACKAGE_DEPENDENCY_SECTIONS) {
      for (const [name, spec] of Object.entries(packageJson[section] ?? {})) {
        if (!isAllowedPinnedSpec(spec)) {
          violations.push({ file: relativePath, section, name, spec });
        }
      }
    }
  }
  return violations;
}

function collectDependencyMapViolations(file, section, dependencyMap, violations) {
  for (const [name, spec] of Object.entries(dependencyMap ?? {})) {
    if (!isAllowedPinnedSpec(spec)) {
      violations.push({ file, section, name, spec });
    }
  }
}

function collectWorkspaceViolations(cwd) {
  const file = "pnpm-workspace.yaml";
  const workspacePath = path.join(cwd, file);
  if (!fs.existsSync(workspacePath)) {
    return [];
  }
  const workspace = YAML.parse(fs.readFileSync(workspacePath, "utf8"));
  const violations = [];
  for (const section of WORKSPACE_DEPENDENCY_SECTIONS) {
    collectDependencyMapViolations(file, section, workspace?.[section], violations);
  }
  for (const [packageName, extension] of Object.entries(workspace?.packageExtensions ?? {})) {
    collectDependencyMapViolations(
      file,
      `packageExtensions.${packageName}.dependencies`,
      extension?.dependencies,
      violations,
    );
  }
  return violations;
}

export function collectDependencyPinViolations(cwd = process.cwd()) {
  return [...collectPackageJsonViolations(cwd), ...collectWorkspaceViolations(cwd)];
}

export function collectDependencyPinAudit(cwd = process.cwd()) {
  const packageJsonFiles = listTrackedPackageJsonFiles(cwd);
  let packageSpecCount = 0;
  for (const relativePath of packageJsonFiles) {
    const packageJson = readJson(path.join(cwd, relativePath));
    for (const section of PACKAGE_DEPENDENCY_SECTIONS) {
      packageSpecCount += Object.keys(packageJson[section] ?? {}).length;
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
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
