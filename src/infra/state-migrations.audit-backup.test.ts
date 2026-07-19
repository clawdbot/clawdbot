import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  createLegacyAuditBackupSnapshots,
  hasLegacyAuditBackupSources,
  isLegacyAuditMigrationBackupPath,
} from "./state-migrations.audit-backup.js";

const TEST_SCRUB_PATTERN = Buffer.from(
  Array.from({ length: 32 }, (_, index) => (index % 2 === 0 ? 0x20 : 0x09)),
);

function configAuditRecord(value: string) {
  return {
    ts: "2026-07-01T00:00:00.000Z",
    source: "config-io",
    event: "config.write",
    argv: ["openclaw", "config", "set", "token", value],
    execArgv: [],
  };
}

async function buildTestAuditRestoreJournal(
  rawPath: string,
  sourceRaw: Buffer,
  scrubbedBytes = 0,
): Promise<string> {
  const stat = await fs.stat(rawPath);
  const journal = `${JSON.stringify({
    schemaVersion: 6,
    rawBase64: sourceRaw.toString("base64"),
    scrubPatternBase64: TEST_SCRUB_PATTERN.toString("base64"),
    target: { dev: stat.dev, ino: stat.ino, size: sourceRaw.length },
  })}\n`;
  await fs.writeFile(
    `${rawPath}.doctor-scrub-progress`,
    `${JSON.stringify({
      schemaVersion: 1,
      journalHash: createHash("sha256").update(journal).digest("hex"),
      direction: "scrubbing",
      committedBytes: scrubbedBytes,
      pendingEnd: scrubbedBytes,
      extentBytes: sourceRaw.length,
    })}\n`,
  );
  return journal;
}

describe("legacy audit raw backup snapshots", () => {
  afterEach(() => {
    resetPluginStateStoreForTests();
  });

  it("recognizes only supported audit migration paths", () => {
    const stateDir = "/opt/openclaw/state";
    expect(
      isLegacyAuditMigrationBackupPath(
        `${stateDir}/logs/config-audit.jsonl.migrated.10.raw.doctor-scrub-restore`,
        stateDir,
      ),
    ).toBe(true);
    expect(
      isLegacyAuditMigrationBackupPath(
        `${stateDir}/audit/.system-agent.jsonl.doctor-importing.2`,
        stateDir,
      ),
    ).toBe(true);
    expect(
      isLegacyAuditMigrationBackupPath(
        `${stateDir}/logs/config-audit.jsonl.migrated.raw.doctor-scrub-progress`,
        stateDir,
      ),
    ).toBe(true);
    expect(
      isLegacyAuditMigrationBackupPath(
        `${stateDir}/plugins/example/cache.jsonl.migrated.raw`,
        stateDir,
      ),
    ).toBe(false);
  });

  it("propagates audit-directory inspection failures", async () => {
    await withTempDir({ prefix: "openclaw-audit-backup-inspection-" }, async (stateDir) => {
      await fs.writeFile(path.join(stateDir, "logs"), "not a directory");

      await expect(hasLegacyAuditBackupSources(stateDir)).rejects.toMatchObject({
        code: "ENOTDIR",
      });
    });
  });

  it("captures an active legacy source before the later SQLite snapshot", async () => {
    await withTempDir({ prefix: "openclaw-audit-backup-active-" }, async (rootDir) => {
      const stateDir = path.join(rootDir, "state");
      const tempDir = path.join(rootDir, "backup-temp");
      const sourcePath = path.join(stateDir, "logs", "config-audit.jsonl");
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.mkdir(tempDir);
      await fs.writeFile(sourcePath, `${JSON.stringify(configAuditRecord("active-value-7f3c"))}\n`);

      const snapshots = await createLegacyAuditBackupSnapshots({ stateDir, tempDir });
      const snapshotAsset = expectDefined(snapshots[0], "snapshot");
      const snapshot = await fs.readFile(snapshotAsset.sourcePath, "utf8");

      expect(snapshotAsset.archiveSourcePath).toBe(sourcePath);
      expect(snapshot).not.toContain("active-value-7f3c");
      expect(JSON.parse(snapshot.trim())).toMatchObject({
        argv: ["openclaw", "config", "set", "token", "***"],
      });
    });
  });

  it("captures a stable active prefix while an old writer keeps appending", async () => {
    await withTempDir({ prefix: "openclaw-audit-backup-appending-" }, async (rootDir) => {
      const stateDir = path.join(rootDir, "state");
      const tempDir = path.join(rootDir, "backup-temp");
      const sourcePath = path.join(stateDir, "logs", "config-audit.jsonl");
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.mkdir(tempDir);
      await fs.writeFile(
        sourcePath,
        Buffer.concat([
          Buffer.from(`${JSON.stringify(configAuditRecord("initial-value-7f3c"))}\n`),
          Buffer.alloc(4 * 1024 * 1024, 0x20),
        ]),
      );

      const snapshotPromise = createLegacyAuditBackupSnapshots({ stateDir, tempDir });
      for (let index = 0; index < 8; index += 1) {
        await fs.appendFile(
          sourcePath,
          `${JSON.stringify(configAuditRecord(`late-value-${index}-9a21`))}\n`,
        );
      }
      const snapshots = await snapshotPromise;
      const snapshotAsset = expectDefined(snapshots[0], "snapshot");
      const snapshot = await fs.readFile(snapshotAsset.sourcePath, "utf8");

      expect(snapshot).not.toContain("initial-value-7f3c");
      expect(snapshot).not.toContain("late-value-");
      expect(
        snapshot
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).not.toHaveLength(0);
    });
  });

  it("captures an unimported append without archiving its secret", async () => {
    await withTempDir({ prefix: "openclaw-audit-backup-" }, async (rootDir) => {
      const stateDir = path.join(rootDir, "state");
      const tempDir = path.join(rootDir, "backup-temp");
      const rawPath = path.join(stateDir, "logs", "config-audit.jsonl.migrated.raw");
      await fs.mkdir(path.dirname(rawPath), { recursive: true });
      await fs.mkdir(tempDir);
      await fs.writeFile(rawPath, `${JSON.stringify(configAuditRecord("late-value-7f3c"))}\n`);

      const snapshots = await createLegacyAuditBackupSnapshots({ stateDir, tempDir });

      expect(snapshots).toHaveLength(1);
      const snapshotAsset = expectDefined(snapshots[0], "snapshot");
      expect(snapshotAsset.archiveSourcePath).toBe(rawPath);
      const snapshot = await fs.readFile(snapshotAsset.sourcePath, "utf8");
      expect(snapshot).not.toContain("late-value-7f3c");
      expect(JSON.parse(snapshot.trim())).toMatchObject({
        argv: ["openclaw", "config", "set", "token", "***"],
      });
    });
  });

  it("reconstructs a scrub-in-progress source and sanitizes its later append", async () => {
    await withTempDir({ prefix: "openclaw-audit-backup-recovery-" }, async (rootDir) => {
      const stateDir = path.join(rootDir, "state");
      const tempDir = path.join(rootDir, "backup-temp");
      const rawPath = path.join(stateDir, "logs", "config-audit.jsonl.migrated.raw");
      const original = Buffer.from(`${JSON.stringify(configAuditRecord("original-value-7f3c"))}\n`);
      const later = `${JSON.stringify(configAuditRecord("later-value-9a21"))}\n`;
      const partial = Buffer.from(original);
      for (let index = 0; index < Math.floor(partial.length / 2); index += 1) {
        partial[index] = TEST_SCRUB_PATTERN[index % TEST_SCRUB_PATTERN.length]!;
      }
      await fs.mkdir(path.dirname(rawPath), { recursive: true });
      await fs.mkdir(tempDir);
      await fs.writeFile(rawPath, Buffer.concat([partial, Buffer.from(later)]));
      await fs.writeFile(
        `${rawPath}.doctor-scrub-restore`,
        await buildTestAuditRestoreJournal(rawPath, original, Math.floor(partial.length / 2)),
      );

      const snapshots = await createLegacyAuditBackupSnapshots({ stateDir, tempDir });
      const snapshotAsset = expectDefined(snapshots[0], "snapshot");
      const snapshot = await fs.readFile(snapshotAsset.sourcePath, "utf8");

      expect(snapshot).not.toContain("original-value-7f3c");
      expect(snapshot).not.toContain("later-value-9a21");
      expect(
        snapshot
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toMatchObject([
        { argv: ["openclaw", "config", "set", "token", "***"] },
        { argv: ["openclaw", "config", "set", "token", "***"] },
      ]);
    });
  });

  it("ignores a stale restore journal after the raw archive is replaced", async () => {
    await withTempDir({ prefix: "openclaw-audit-backup-stale-journal-" }, async (rootDir) => {
      const stateDir = path.join(rootDir, "state");
      const tempDir = path.join(rootDir, "backup-temp");
      const rawPath = path.join(stateDir, "logs", "config-audit.jsonl.migrated.raw");
      const original = Buffer.from(`${JSON.stringify(configAuditRecord("old-value-7f3c"))}\n`);
      const replacement = {
        ...configAuditRecord("replacement-value-9a21"),
        event: "config.delete",
      };
      await fs.mkdir(path.dirname(rawPath), { recursive: true });
      await fs.mkdir(tempDir);
      await fs.writeFile(rawPath, `${JSON.stringify(replacement)}\n`);
      await fs.writeFile(
        `${rawPath}.doctor-scrub-restore`,
        await buildTestAuditRestoreJournal(rawPath, original),
      );

      const snapshots = await createLegacyAuditBackupSnapshots({ stateDir, tempDir });
      const snapshotAsset = expectDefined(snapshots[0], "snapshot");
      const snapshot = JSON.parse(await fs.readFile(snapshotAsset.sourcePath, "utf8"));

      expect(snapshot).toMatchObject({
        event: "config.delete",
        argv: ["openclaw", "config", "set", "token", "***"],
      });
    });
  });
});
