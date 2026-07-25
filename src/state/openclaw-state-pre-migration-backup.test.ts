import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  createPreMigrationStateBackup,
  PRE_MIGRATION_BACKUP_DIRNAME,
} from "./openclaw-state-pre-migration-backup.js";

afterEach(() => {
  cleanupTempDirs();
});

function seedStateDb(dbPath: string, userVersion: number): void {
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS demo (id INTEGER PRIMARY KEY, note TEXT);");
  db.exec("INSERT INTO demo (id, note) VALUES (1, 'keep-me');");
  db.exec(`PRAGMA user_version = ${userVersion};`);
  db.close();
}

describe("createPreMigrationStateBackup", () => {
  it("snapshots the database before a forward migration", () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, "openclaw.sqlite");
    seedStateDb(dbPath, 5);
    const db = new DatabaseSync(dbPath);
    try {
      const result = createPreMigrationStateBackup(
        db,
        dbPath,
        5,
        6,
        Date.parse("2026-07-25T09:40:00Z"),
      );
      expect(result.status).toBe("created");
      if (result.status !== "created") return;
      expect(fs.existsSync(result.backupPath)).toBe(true);
      expect(result.backupPath).toContain(PRE_MIGRATION_BACKUP_DIRNAME);
      expect(result.backupPath).toContain("v5-to-v6");

      // The backup is a valid SQLite database carrying the pre-migration
      // version and the pre-migration data.
      const backup = new DatabaseSync(result.backupPath);
      try {
        const version = backup.prepare("PRAGMA user_version;").get() as {
          user_version: number;
        };
        expect(version.user_version).toBe(5);
        const row = backup.prepare("SELECT note FROM demo WHERE id = 1;").get() as {
          note: string;
        };
        expect(row.note).toBe("keep-me");
      } finally {
        backup.close();
      }
    } finally {
      db.close();
    }
  });

  it("skips when the database is already at the target version", () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, "openclaw.sqlite");
    seedStateDb(dbPath, 6);
    const db = new DatabaseSync(dbPath);
    try {
      const result = createPreMigrationStateBackup(db, dbPath, 6, 6, Date.now());
      expect(result.status).toBe("skipped");
      expect(fs.existsSync(path.join(dir, PRE_MIGRATION_BACKUP_DIRNAME))).toBe(false);
    } finally {
      db.close();
    }
  });

  it("skips a brand new (version 0) database", () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, "openclaw.sqlite");
    seedStateDb(dbPath, 0);
    const db = new DatabaseSync(dbPath);
    try {
      const result = createPreMigrationStateBackup(db, dbPath, 0, 6, Date.now());
      expect(result.status).toBe("skipped");
    } finally {
      db.close();
    }
  });
});
