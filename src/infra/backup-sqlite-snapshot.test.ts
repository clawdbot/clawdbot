import { describe, expect, it } from "vitest";
import type { BackupResourceInventory } from "../commands/backup-resource-inventory.js";
import { classifyBackupSqliteSource } from "./backup-sqlite-snapshot.js";

const inventory: BackupResourceInventory = {
  stateDir: "/fixture/state",
  agentRoots: [],
  regenerableRoots: [],
  isIncluded: () => true,
  isTraversable: () => true,
  isPackageContent: () => false,
  isVolatile: () => false,
};

describe("backup SQLite AppleDouble classification", () => {
  it("does not classify AppleDouble metadata as a database", () => {
    expect(classifyBackupSqliteSource("/fixture/state/._cron.sqlite", inventory)).toBeUndefined();
  });

  it("keeps ordinary SQLite files classified as databases", () => {
    expect(classifyBackupSqliteSource("/fixture/state/cron.sqlite", inventory)).toBe("sqlite");
  });
});
