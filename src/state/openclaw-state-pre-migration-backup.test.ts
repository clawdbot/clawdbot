import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  createPreMigrationStateBackup,
  PRE_MIGRATION_BACKUP_RETENTION,
  prunePreMigrationStateBackups,
} from "./openclaw-state-pre-migration-backup.js";

/**
 * Pinned by literal rather than imported: the directory name is the on-disk
 * contract an operator follows to find a recovery copy, so a test that reads it
 * back from the module under test would assert nothing.
 */
const PRE_MIGRATION_BACKUP_DIRNAME = "pre-migration-backups";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function makeStateDir(): string {
  return makeTempDir(tempDirs, "openclaw-pre-migration-backup-");
}

function seedStateDb(dbPath: string, userVersion: number): void {
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS demo (id INTEGER PRIMARY KEY, note TEXT);");
  db.exec("INSERT INTO demo (id, note) VALUES (1, 'keep-me');");
  db.exec(`PRAGMA user_version = ${userVersion};`);
  db.close();
}

describe("createPreMigrationStateBackup", () => {
  it("snapshots the database before a forward migration", () => {
    const dir = makeStateDir();
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
      if (result.status !== "created") {
        return;
      }
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

  it("writes the snapshot 0600 inside a 0700 directory", () => {
    const dir = makeStateDir();
    const dbPath = path.join(dir, "openclaw.sqlite");
    seedStateDb(dbPath, 5);
    const db = new DatabaseSync(dbPath);
    try {
      const result = createPreMigrationStateBackup(db, dbPath, 5, 6, Date.now());
      expect(result.status).toBe("created");
      if (result.status !== "created") {
        return;
      }
      // Shared state is sensitive, so a copy of it must not be world readable.
      expect(fs.statSync(result.backupPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(result.backupPath)).mode & 0o777).toBe(0o700);
    } finally {
      db.close();
    }
  });

  it("tightens a backup directory that already exists with loose permissions", () => {
    const dir = makeStateDir();
    const dbPath = path.join(dir, "openclaw.sqlite");
    seedStateDb(dbPath, 5);
    // mkdirSync applies its mode only to directories it creates, so a directory
    // left behind world readable would otherwise keep those permissions and the
    // snapshot inside it would be reachable regardless of its own mode.
    const backupDir = path.join(dir, "pre-migration-backups");
    fs.mkdirSync(backupDir, { recursive: true });
    fs.chmodSync(backupDir, 0o755);
    const db = new DatabaseSync(dbPath);
    try {
      const result = createPreMigrationStateBackup(db, dbPath, 5, 6, Date.now());
      expect(result.status).toBe("created");
      expect(fs.statSync(backupDir).mode & 0o777).toBe(0o700);
    } finally {
      db.close();
    }
  });

  it("reuses the existing copy when the same migration is attempted again", () => {
    const dir = makeStateDir();
    const dbPath = path.join(dir, "openclaw.sqlite");
    seedStateDb(dbPath, 5);
    const db = new DatabaseSync(dbPath);
    try {
      const base = Date.parse("2026-07-25T09:00:00Z");
      const first = createPreMigrationStateBackup(db, dbPath, 5, 6, base);
      expect(first).toMatchObject({ status: "created", reused: false });
      if (first.status !== "created") {
        return;
      }

      // A migration that never commits leaves the database as this copy found
      // it, so retrying must not write a second one. Retention cannot bound this:
      // pruning runs only after a migration commits, and this one never does.
      for (let i = 1; i <= 50; i += 1) {
        const retry = createPreMigrationStateBackup(db, dbPath, 5, 6, base + i * 60_000);
        expect(retry).toMatchObject({ status: "created", backupPath: first.backupPath });
        expect(retry.status === "created" && retry.reused).toBe(true);
      }
      const backupDir = path.join(dir, PRE_MIGRATION_BACKUP_DIRNAME);
      expect(fs.readdirSync(backupDir)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("reports a failure instead of aborting when the directory cannot be made", () => {
    const dir = makeStateDir();
    const dbPath = path.join(dir, "openclaw.sqlite");
    seedStateDb(dbPath, 5);
    const db = new DatabaseSync(dbPath);
    // A read-only state directory cannot receive the backup directory. Best
    // effort by contract: this reports rather than throwing, so a migration that
    // would otherwise succeed is not turned into a failed startup.
    fs.chmodSync(dir, 0o500);
    try {
      const result = createPreMigrationStateBackup(db, dbPath, 5, 6, Date.now());
      expect(result.status).toBe("failed");
      expect(fs.existsSync(path.join(dir, "pre-migration-backups"))).toBe(false);
    } finally {
      fs.chmodSync(dir, 0o700);
      db.close();
    }
  });

  it("keeps only the newest snapshots and reports what it pruned", () => {
    const dir = makeStateDir();
    const dbPath = path.join(dir, "openclaw.sqlite");
    seedStateDb(dbPath, 5);
    const db = new DatabaseSync(dbPath);
    try {
      // Successive upgrades, one per minute: v1→v2, v2→v3, and so on. Distinct
      // version pairs because that is what a real upgrade history looks like,
      // and because repeating one pair is now deliberately reused rather than
      // recopied.
      const base = Date.parse("2026-07-25T09:00:00Z");
      const created: string[] = [];
      const total = PRE_MIGRATION_BACKUP_RETENTION + 2;
      for (let i = 0; i < total; i += 1) {
        const result = createPreMigrationStateBackup(db, dbPath, i + 1, i + 2, base + i * 60_000);
        expect(result.status).toBe("created");
        if (result.status !== "created") {
          return;
        }
        created.push(result.backupPath);
        // Creation never prunes; the caller does that once the migration has
        // committed. Nothing to prune until the cap is exceeded, and exactly one
        // after that, so snapshots never pile up across successful migrations.
        const pruned = prunePreMigrationStateBackups(dbPath);
        expect(pruned.length).toBe(i + 1 > PRE_MIGRATION_BACKUP_RETENTION ? 1 : 0);
      }

      const backupDir = path.join(dir, PRE_MIGRATION_BACKUP_DIRNAME);
      expect(fs.readdirSync(backupDir).length).toBe(PRE_MIGRATION_BACKUP_RETENTION);
      // The survivors are the newest ones, and the oldest are gone.
      for (const survivor of created.slice(-PRE_MIGRATION_BACKUP_RETENTION)) {
        expect(fs.existsSync(survivor)).toBe(true);
      }
      for (const evicted of created.slice(0, total - PRE_MIGRATION_BACKUP_RETENTION)) {
        expect(fs.existsSync(evicted)).toBe(false);
      }
    } finally {
      db.close();
    }
  });

  it("does not prune when the migration is never committed", () => {
    const dir = makeStateDir();
    const dbPath = path.join(dir, "openclaw.sqlite");
    seedStateDb(dbPath, 5);
    const db = new DatabaseSync(dbPath);
    try {
      // Fill the directory to the cap through committed migrations.
      const base = Date.parse("2026-07-25T09:00:00Z");
      const settled: string[] = [];
      for (let i = 0; i < PRE_MIGRATION_BACKUP_RETENTION; i += 1) {
        const result = createPreMigrationStateBackup(db, dbPath, i + 1, i + 2, base + i * 60_000);
        if (result.status !== "created") {
          throw new Error(`expected a snapshot, got ${result.status}`);
        }
        settled.push(result.backupPath);
        prunePreMigrationStateBackups(dbPath);
      }

      // Now a repair that gets rejected: the snapshot is taken, but the caller
      // never reaches the prune because the transaction rolled back.
      const attempted = createPreMigrationStateBackup(db, dbPath, 5, 6, base + 60 * 60_000);
      expect(attempted.status).toBe("created");

      // The operator keeps every recovery copy they arrived with. Losing the
      // oldest here would trade a real older snapshot for a duplicate of a
      // database the failed repair left untouched.
      for (const survivor of settled) {
        expect(fs.existsSync(survivor)).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it("does not reuse a look-alike file as a recovery copy", () => {
    const dir = makeStateDir();
    const dbPath = path.join(dir, "openclaw.sqlite");
    seedStateDb(dbPath, 5);
    const backupDir = path.join(dir, PRE_MIGRATION_BACKUP_DIRNAME);
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    // Right prefix, wrong everything else. Trusting the name would skip
    // VACUUM INTO and report this as the migration's rollback copy.
    const impostor = path.join(backupDir, "openclaw-state-v5-to-v6-my-own-copy.sqlite");
    fs.writeFileSync(impostor, "not a database");
    const db = new DatabaseSync(dbPath);
    try {
      const result = createPreMigrationStateBackup(db, dbPath, 5, 6, Date.now());
      expect(result).toMatchObject({ status: "created", reused: false });
      if (result.status !== "created") {
        return;
      }
      expect(result.backupPath).not.toBe(impostor);
      // A real copy was taken, and the impostor was left where the operator put it.
      expect(new DatabaseSync(result.backupPath, { readOnly: true }).close()).toBeUndefined();
      expect(fs.readFileSync(impostor, "utf8")).toBe("not a database");
    } finally {
      db.close();
    }
  });

  it("does not prune a look-alike file", () => {
    const dir = makeStateDir();
    const dbPath = path.join(dir, "openclaw.sqlite");
    seedStateDb(dbPath, 5);
    const backupDir = path.join(dir, PRE_MIGRATION_BACKUP_DIRNAME);
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    // Sorts before every real snapshot, so retention would evict it first.
    const impostor = path.join(backupDir, "openclaw-state-v0-to-v1-operator-kept-this.sqlite");
    fs.writeFileSync(impostor, "not a database");
    const db = new DatabaseSync(dbPath);
    try {
      const base = Date.parse("2026-07-25T09:00:00Z");
      for (let i = 0; i < PRE_MIGRATION_BACKUP_RETENTION + 2; i += 1) {
        expect(
          createPreMigrationStateBackup(db, dbPath, i + 1, i + 2, base + i * 60_000).status,
        ).toBe("created");
        prunePreMigrationStateBackups(dbPath);
      }
      // Retention only ever deletes files this module actually wrote.
      expect(fs.existsSync(impostor)).toBe(true);
      expect(fs.readFileSync(impostor, "utf8")).toBe("not a database");
    } finally {
      db.close();
    }
  });

  it("leaves unrelated files in the backup directory alone", () => {
    const dir = makeStateDir();
    const dbPath = path.join(dir, "openclaw.sqlite");
    seedStateDb(dbPath, 5);
    const backupDir = path.join(dir, PRE_MIGRATION_BACKUP_DIRNAME);
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const parked = path.join(backupDir, "operator-notes.txt");
    fs.writeFileSync(parked, "do not delete me");
    const db = new DatabaseSync(dbPath);
    try {
      const base = Date.parse("2026-07-25T09:00:00Z");
      for (let i = 0; i < PRE_MIGRATION_BACKUP_RETENTION + 2; i += 1) {
        expect(
          createPreMigrationStateBackup(db, dbPath, i + 1, i + 2, base + i * 60_000).status,
        ).toBe("created");
        prunePreMigrationStateBackups(dbPath);
      }
      // Pruning only ever considers files this module wrote.
      expect(fs.existsSync(parked)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("skips when the database is already at the target version", () => {
    const dir = makeStateDir();
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
    const dir = makeStateDir();
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
