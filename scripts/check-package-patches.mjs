#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const ALLOWED_PATCHED_DEPENDENCIES = new Map([
  [
    "@agentclientprotocol/claude-agent-acp@0.33.1",
    "patches/@agentclientprotocol__claude-agent-acp@0.33.1.patch",
  ],
  ["baileys@7.0.0-rc11", "patches/baileys@7.0.0-rc11.patch"],
]);

const ALLOWED_PATCH_FILES = new Set(["patches/.gitkeep", ...ALLOWED_PATCHED_DEPENDENCIES.values()]);

function listTrackedFiles(cwd, patterns) {
  return execFileSync("git", ["ls-files", "-z", "--", ...patterns], {
    cwd,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .toSorted((left, right) => left.localeCompare(right));
}

function readYamlFile(cwd, relativePath) {
  const filePath = path.join(cwd, relativePath);
  if (!fs.existsSync(filePath)) {
    return {};
  }
  return YAML.parse(fs.readFileSync(filePath, "utf8")) ?? {};
}

function readJsonFile(cwd, relativePath) {
  const filePath = path.join(cwd, relativePath);
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function collectPatchedDependencyViolations(file, patchedDependencies, violations, options = {}) {
  for (const [specifier, patchPathOrHash] of Object.entries(patchedDependencies ?? {})) {
    if (
      options.allowAnyValueForLegacy === true
        ? ALLOWED_PATCHED_DEPENDENCIES.has(specifier)
        : ALLOWED_PATCHED_DEPENDENCIES.get(specifier) === patchPathOrHash
    ) {
      continue;
    }
    violations.push({
      file,
      kind: "patchedDependency",
      detail: `${specifier} -> ${String(patchPathOrHash)}`,
    });
  }
}

function collectWorkspacePatchViolations(cwd, violations) {
  const workspace = readYamlFile(cwd, "pnpm-workspace.yaml");
  collectPatchedDependencyViolations(
    "pnpm-workspace.yaml",
    workspace?.patchedDependencies,
    violations,
  );
}

function collectLockfilePatchViolations(cwd, violations) {
  const lockfile = readYamlFile(cwd, "pnpm-lock.yaml");
  collectPatchedDependencyViolations("pnpm-lock.yaml", lockfile?.patchedDependencies, violations, {
    allowAnyValueForLegacy: true,
  });
}

function collectPackageJsonPatchViolations(cwd, violations) {
  for (const relativePath of listTrackedFiles(cwd, ["*package.json"])) {
    const packageJson = readJsonFile(cwd, relativePath);
    const patchedDependencies = packageJson?.pnpm?.patchedDependencies;
    for (const [specifier, patchPath] of Object.entries(patchedDependencies ?? {})) {
      violations.push({
        file: relativePath,
        kind: "packageJsonPatchedDependency",
        detail: `${specifier} -> ${String(patchPath)}`,
      });
    }
  }
}

function collectPatchFileViolations(cwd, violations) {
  for (const relativePath of listTrackedFiles(cwd, ["*.patch"])) {
    if (ALLOWED_PATCH_FILES.has(relativePath)) {
      continue;
    }
    violations.push({
      file: relativePath,
      kind: "patchFile",
      detail: "new package patch file",
    });
  }
}

export function collectPackagePatchViolations(cwd = process.cwd()) {
  const violations = [];
  collectWorkspacePatchViolations(cwd, violations);
  collectLockfilePatchViolations(cwd, violations);
  collectPackageJsonPatchViolations(cwd, violations);
  collectPatchFileViolations(cwd, violations);
  return violations;
}

export async function main() {
  const violations = collectPackagePatchViolations();
  if (violations.length === 0) {
    process.stdout.write(
      `PASS package patch guard: no new pnpm patches; ${ALLOWED_PATCHED_DEPENDENCIES.size} legacy patches allowlisted.\n`,
    );
    return;
  }

  console.error(
    "FAIL package patch guard: new pnpm package patches are not allowed. Upstream the fix, publish a new package version, then bump the dependency instead.",
  );
  for (const violation of violations) {
    console.error(`- ${violation.file}: ${violation.kind}: ${violation.detail}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
