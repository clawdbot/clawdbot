import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (fullPath === DOCTOR_ROOT) {
        continue;
      }
      collectSourceFiles(fullPath, acc);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
      continue;
    }
    acc.push(fullPath);
  }
  return acc;
}

function collectViolations(files: string[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file).replaceAll(path.sep, "/");
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
  it("keeps legacy config repair flags and migration modules under doctor", () => {
    const files = collectSourceFiles(SRC_ROOT);
    const violations = collectViolations(files);

    expect(violations).toEqual([]);
  });
});
