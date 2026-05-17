import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expectNoReaddirSyncDuring } from "../../../test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles, toRepoRelativePath } from "../../../test-utils/repo-files.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const SRC_ROOT = path.join(REPO_ROOT, "src");
const DOCTOR_ROOT = path.join(SRC_ROOT, "commands", "doctor");
const LEGACY_REPAIR_FLAG = "migrateLegacyConfig";
const LEGACY_MIGRATION_MODULE = "legacy-config-migrate";
const LEGACY_REPAIR_FLAG_BYTES = Buffer.from(LEGACY_REPAIR_FLAG);
const LEGACY_MIGRATION_MODULE_BYTES = Buffer.from(LEGACY_MIGRATION_MODULE);
const LEGACY_REPAIR_FLAG_RE = /migrateLegacyConfig\s*:\s*true/;
const LEGACY_MIGRATION_MODULE_RE =
  /legacy-config-migrate(?:\.js)?|legacy-config-migrations(?:\.[\w-]+)?(?:\.js)?/;

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  const externalFiles = listExternalSourceFiles(dir);
  if (externalFiles) {
    acc.push(...externalFiles);
    return acc;
  }
  return collectSourceFilesByDirectory(dir, acc);
}

function listExternalSourceFiles(dir: string): string[] | null {
  return listGitSourceFiles(dir) ?? listFindSourceFiles(dir);
}

function listGitSourceFiles(dir: string): string[] | null {
  const relativeRoot = toRepoRelativePath(REPO_ROOT, dir);
  const files = listGitTrackedFiles({ repoRoot: REPO_ROOT, pathspecs: relativeRoot });
  if (!files) {
    return null;
  }
  return files
    .map((file) => path.join(REPO_ROOT, file))
    .filter((filePath) => fs.existsSync(filePath))
    .filter(isOwnedSourceFile)
    .toSorted();
}

function listFindSourceFiles(dir: string): string[] | null {
  const result = spawnSync(
    "find",
    [
      dir,
      "(",
      "-name",
      "dist",
      "-o",
      "-name",
      "node_modules",
      ")",
      "-prune",
      "-o",
      "-type",
      "f",
      "-name",
      "*.ts",
      "-print",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 4,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter(isOwnedSourceFile)
    .toSorted();
}

function collectSourceFilesByDirectory(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (fullPath === DOCTOR_ROOT) {
        continue;
      }
      collectSourceFilesByDirectory(fullPath, acc);
      continue;
    }
    if (!entry.isFile() || !isOwnedSourceFile(fullPath)) {
      continue;
    }
    acc.push(fullPath);
  }
  return acc;
}

function isOwnedSourceFile(file: string): boolean {
  return file.endsWith(".ts") && !file.endsWith(".test.ts") && !isUnderDoctorRoot(file);
}

function isUnderDoctorRoot(file: string): boolean {
  const relativePath = path.relative(DOCTOR_ROOT, file);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function collectViolations(files: string[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const rel = toRepoRelativePath(REPO_ROOT, file);
    const sourceBytes = fs.readFileSync(file);
    const hasRepairFlag = sourceBytes.includes(LEGACY_REPAIR_FLAG_BYTES);
    const hasMigrationModule = sourceBytes.includes(LEGACY_MIGRATION_MODULE_BYTES);
    if (!hasRepairFlag && !hasMigrationModule) {
      continue;
    }
    const source = sourceBytes.toString("utf8");

    if (hasRepairFlag && LEGACY_REPAIR_FLAG_RE.test(source)) {
      violations.push(`${rel}: migrateLegacyConfig:true outside doctor`);
    }

    if (hasMigrationModule && LEGACY_MIGRATION_MODULE_RE.test(source)) {
      violations.push(`${rel}: doctor legacy migration module referenced outside doctor`);
    }
  }
  return violations;
}

describe("legacy config write ownership", () => {
  it("lists ownership scan files without scanning source directories in-process", () => {
    expectNoReaddirSyncDuring(() => {
      const files = collectSourceFiles(SRC_ROOT);

      expect(files.length).toBeGreaterThan(0);
      expect(files.every(isOwnedSourceFile)).toBe(true);
    });
  });

  it("keeps legacy config repair flags and migration modules under doctor", () => {
    const files = collectSourceFiles(SRC_ROOT);
    const violations = collectViolations(files);

    expect(violations).toStrictEqual([]);
  });
});
