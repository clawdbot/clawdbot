#!/usr/bin/env node

// Guards pnpm package patches against unapproved additions.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import YAML from "yaml";
import { pnpmLockfileDocuments } from "./lib/pnpm-lockfile-documents.mjs";

const ALLOWED_PATCHED_DEPENDENCIES = new Map([
  ["@vitest/runner@4.1.11", "patches/@vitest__runner@4.1.11.patch"],
  ["baileys@7.0.0-rc12", "patches/baileys@7.0.0-rc12.patch"],
  ["baileys@7.0.0-rc13", "patches/baileys@7.0.0-rc13.patch"],
]);

const ALLOWED_PATCH_FILES = new Set(["patches/.gitkeep", ...ALLOWED_PATCHED_DEPENDENCIES.values()]);

type PackagePatchViolation = { file: string; kind: string; detail: string };

function listTrackedFiles(cwd: string, patterns: string[]) {
  return execFileSync("git", ["ls-files", "-z", "--", ...patterns], {
    cwd,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .toSorted((left, right) => left.localeCompare(right));
}

function readRecordFile(cwd: string, relativePath: string, parse: (source: string) => unknown) {
  const filePath = path.join(cwd, relativePath);
  if (!fs.existsSync(filePath)) {
    return {};
  }
  return asRecord(parse(fs.readFileSync(filePath, "utf8")));
}

function collectPatchedDependencyViolations(
  file: string,
  patchedDependencies: unknown,
  violations: PackagePatchViolation[],
  options: { allowAnyValueForLegacy?: boolean } = {},
) {
  for (const [specifier, patchPathOrHash] of Object.entries(asRecord(patchedDependencies))) {
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

function collectWorkspacePatchViolations(cwd: string, violations: PackagePatchViolation[]) {
  const workspace = readRecordFile(cwd, "pnpm-workspace.yaml", YAML.parse);
  collectPatchedDependencyViolations(
    "pnpm-workspace.yaml",
    workspace.patchedDependencies,
    violations,
  );
}

function collectLockfilePatchViolations(cwd: string, violations: PackagePatchViolation[]) {
  const filePath = path.join(cwd, "pnpm-lock.yaml");
  if (!fs.existsSync(filePath)) {
    return;
  }
  for (const document of Object.values(pnpmLockfileDocuments(fs.readFileSync(filePath, "utf8")))) {
    if (document === null) {
      continue;
    }
    const lockfile = asRecord(YAML.parse(document));
    collectPatchedDependencyViolations("pnpm-lock.yaml", lockfile.patchedDependencies, violations, {
      allowAnyValueForLegacy: true,
    });
  }
}

function collectPackageJsonPatchViolations(cwd: string, violations: PackagePatchViolation[]) {
  for (const relativePath of listTrackedFiles(cwd, ["*package.json"])) {
    const packageJson = readRecordFile(cwd, relativePath, JSON.parse);
    const patchedDependencies = asRecord(asRecord(packageJson.pnpm).patchedDependencies);
    for (const [specifier, patchPath] of Object.entries(patchedDependencies)) {
      violations.push({
        file: relativePath,
        kind: "packageJsonPatchedDependency",
        detail: `${specifier} -> ${String(patchPath)}`,
      });
    }
  }
}

function collectPatchFileViolations(cwd: string, violations: PackagePatchViolation[]) {
  for (const relativePath of listTrackedFiles(cwd, ["*.patch"])) {
    if (!fs.existsSync(path.join(cwd, relativePath))) {
      continue;
    }
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

/**
 * Collects disallowed package patch declarations and patch files.
 */
export function collectPackagePatchViolations(cwd = process.cwd()) {
  const violations: PackagePatchViolation[] = [];
  collectWorkspacePatchViolations(cwd, violations);
  collectLockfilePatchViolations(cwd, violations);
  collectPackageJsonPatchViolations(cwd, violations);
  collectPatchFileViolations(cwd, violations);
  return violations;
}

/**
 * Runs the package patch guard.
 */
export async function main() {
  const violations = collectPackagePatchViolations();
  if (violations.length === 0) {
    process.stdout.write(
      `PASS package patch guard: no new pnpm patches; ${ALLOWED_PATCHED_DEPENDENCIES.size} approved patches allowlisted.\n`,
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
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
