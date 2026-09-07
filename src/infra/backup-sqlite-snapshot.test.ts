import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BackupResourceInventory } from "../commands/backup-resource-inventory.js";
import { classifyBackupSqliteSource } from "./backup-sqlite-snapshot.js";

const APPLE_DOUBLE_MAGIC = Buffer.from([0x00, 0x05, 0x16, 0x07]);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function createInventory(stateDir: string): BackupResourceInventory {
  return {
    stateDir,
    agentRoots: [],
    regenerableRoots: [],
    isIncluded: () => true,
    isTraversable: () => true,
    isPackageContent: () => false,
    isVolatile: () => false,
  };
}

async function writeFixture(fileName: string, bytes: Buffer): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-classify-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, bytes);
  return filePath;
}

describe("backup SQLite AppleDouble classification", () => {
  it("excludes genuine AppleDouble metadata without treating it as SQLite", async () => {
    const filePath = await writeFixture("._cron.sqlite", APPLE_DOUBLE_MAGIC);
    expect(classifyBackupSqliteSource(filePath, createInventory(path.dirname(filePath)))).toBe(
      "excluded",
    );
  });

  it("keeps a matching-name SQLite hardlink alias on the sanitized snapshot path", async () => {
    const filePath = await writeFixture("._alias.sqlite", Buffer.from("SQLite format 3\0"));
    expect(classifyBackupSqliteSource(filePath, createInventory(path.dirname(filePath)))).toBe(
      "sqlite",
    );
  });

  it("keeps ordinary SQLite files classified as databases", async () => {
    const filePath = await writeFixture("cron.sqlite", Buffer.from("SQLite format 3\0"));
    expect(classifyBackupSqliteSource(filePath, createInventory(path.dirname(filePath)))).toBe(
      "sqlite",
    );
  });
});
