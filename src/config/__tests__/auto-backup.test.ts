import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAutoBackup } from "../auto-backup.js";

describe("createAutoBackup", () => {
  let tmpDir: string;
  let configFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-test-"));
    configFile = path.join(tmpDir, "openclaw.json");
    await fs.writeFile(configFile, JSON.stringify({ version: "1.0" }), "utf-8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a backup file in the default backup directory", async () => {
    const backupPath = await createAutoBackup(configFile);
    expect(backupPath).not.toBeNull();

    if (backupPath) {
      const content = await fs.readFile(backupPath, "utf-8");
      expect(JSON.parse(content)).toEqual({ version: "1.0" });
    }
  });

  it("returns null if configuration file does not exist", async () => {
    const missingFile = path.join(tmpDir, "nonexistent.json");
    const backupPath = await createAutoBackup(missingFile);
    expect(backupPath).toBeNull();
  });

  it("rotates old backups when maxBackups limit is exceeded", async () => {
    const backupDir = path.join(tmpDir, "backups");

    for (let i = 0; i < 5; i++) {
      await createAutoBackup(configFile, { backupDir, maxBackups: 2 });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const files = await fs.readdir(backupDir);
    expect(files.length).toBeLessThanOrEqual(2);
  });
});
