import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { openLegacyAuditRawCheckpointStore } from "./state-migrations.audit-checkpoints.js";
import {
  buildAuditScrubbedContent,
  configAuditRecord,
  failChmodCall,
  FIRST_AUDIT_SCRUB_BYTE,
  systemAuditEvent,
  withAuditMigrationFixture,
  writeAuditRestoreJournal,
} from "./state-migrations.audit.test-support.js";

describe("legacy audit recovery byte handling", () => {
  afterEach(resetPluginStateStoreForTests);

  it("blanks a zero-slack source within the fixed-size recovery inode", async () => {
    await withAuditMigrationFixture(async (audit) => {
      const { raw, restore, sanitized, source } = audit.config;
      const record = configAuditRecord("x");
      const original = `${JSON.stringify(record)}\n`;
      await audit.write(source, original);

      const result = await audit.migrate();

      expect(result.warnings).toEqual([]);
      const sanitizedContent = await fs.readFile(sanitized, "utf8");
      const recovery = await fs.readFile(raw, "utf8");
      expect(Buffer.byteLength(recovery)).toBe(Buffer.byteLength(original));
      expect(JSON.parse(sanitizedContent.trim())).toMatchObject({
        argv: ["openclaw", "config", "set", "token", "***"],
      });
      expect(recovery.trim()).toBe("");
      await expect(fs.access(restore)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("uses original byte offsets when decoded audit text contains replacement characters", async () => {
    await withAuditMigrationFixture(async (audit) => {
      const { raw: rawPath, source: sourcePath } = audit.system;
      const original = Buffer.concat([
        Buffer.from(
          '{"timestamp":"2026-07-03T00:00:00.000Z","operation":"gateway.restart","summary":"',
        ),
        Buffer.from([0x80]),
        Buffer.from('"}'),
      ]);
      await audit.write(sourcePath, original);

      const migrated = await audit.migrate();

      expect(migrated.warnings).toEqual([]);
      const blanked = await fs.readFile(rawPath);
      expect(blanked).toHaveLength(original.length);
      expect(blanked.every((byte) => byte === 0x20 || byte === 0x09)).toBe(true);

      await audit.appendJsonLines(rawPath, [
        systemAuditEvent("later", { timestamp: "2026-07-04T00:00:00.000Z" }),
      ]);
      const recovered = await audit.migrate();

      expect(recovered.warnings).toEqual([]);
      expect(audit.systemSummaries()).toEqual(["�", "later"]);
    });
  });

  it("upgrades a legacy nonzero raw checkpoint to the blank append pad", async () => {
    await withAuditMigrationFixture(async (audit) => {
      const { raw: rawPath, source: sourcePath } = audit.system;
      await audit.writeJsonLines(sourcePath, [systemAuditEvent("original")]);
      await audit.migrate();
      const legacyRaw = Buffer.concat([
        Buffer.from(
          '{"timestamp":"2026-07-03T00:00:00.000Z","operation":"gateway.restart","summary":"',
        ),
        Buffer.from([0x80]),
        Buffer.from('"}\n'),
      ]);
      await fs.writeFile(rawPath, legacyRaw);
      const legacyStat = await fs.stat(rawPath);
      const checkpointStore = openLegacyAuditRawCheckpointStore(audit.stateDir);
      const checkpoint = checkpointStore.entries()[0]!;
      checkpointStore.upsert(checkpoint.key, {
        ...checkpoint.value,
        dev: legacyStat.dev,
        ino: legacyStat.ino,
        mtimeMs: legacyStat.mtimeMs,
        size: legacyStat.size,
        contentHash: createHash("sha256").update(legacyRaw.toString("utf8")).digest("hex"),
        recordCount: 1,
      });

      const detected = audit.detect();
      expect(detected.hasLegacy).toBe(true);
      const result = await audit.migrate(detected);

      expect(result.warnings).toEqual([]);
      expect(
        openLegacyAuditRawCheckpointStore(audit.stateDir).entries()[0]?.value.recordCount,
      ).toBe(0);
    });
  });

  it("does not confuse an older prefix checkpoint with a later scrub generation", async () => {
    await withAuditMigrationFixture(async (audit) => {
      const { raw: rawPath, restore: restorePath, source: sourcePath } = audit.system;
      await audit.writeJsonLines(sourcePath, [systemAuditEvent("original")]);
      await audit.migrate();
      await audit.appendJsonLines(rawPath, [
        systemAuditEvent("later", { timestamp: "2026-07-04T00:00:00.000Z" }),
      ]);
      const interruptedRaw = await fs.readFile(rawPath);
      await writeAuditRestoreJournal(rawPath, interruptedRaw, {
        restoredBytes: 0,
        scrubbedBytes: interruptedRaw.length,
      });
      await fs.writeFile(rawPath, buildAuditScrubbedContent(interruptedRaw.length));

      const result = await audit.migrate();

      expect(result.warnings).toEqual([]);
      expect(audit.systemSummaries()).toEqual(["original", "later"]);
      await expect(fs.access(restorePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("does not replay a scrub journal over an equal-width space redaction", async () => {
    await withAuditMigrationFixture(async (audit) => {
      const { raw: rawPath, restore: restorePath } = audit.system;
      const originalContent = `${JSON.stringify(systemAuditEvent("secret archive value"))}\n`;
      const replacementContent = originalContent.replace("secret archive value", " ".repeat(20));
      await audit.seedRawArchive(audit.system, replacementContent);
      await writeAuditRestoreJournal(rawPath, Buffer.from(originalContent, "utf8"));

      const result = await audit.migrate();

      expect(result.warnings.join("\n")).toContain("no longer matches its restore journal target");
      await expect(fs.readFile(rawPath, "utf8")).resolves.toBe(replacementContent);
      await fs.access(restorePath);
    });
  });

  it("resumes a one-byte scrub interruption using exact journal progress", async () => {
    await withAuditMigrationFixture(async (audit) => {
      const { raw: rawPath, restore: restorePath } = audit.system;
      const originalContent = `${JSON.stringify(systemAuditEvent("original archive"))}\n`;
      const replacementBytes = Buffer.from(originalContent);
      replacementBytes[0] = FIRST_AUDIT_SCRUB_BYTE;
      await audit.seedRawArchive(audit.system, replacementBytes);
      await writeAuditRestoreJournal(rawPath, Buffer.from(originalContent), {
        restoredBytes: 0,
        scrubbedBytes: 1,
      });

      const result = await audit.migrate();

      expect(result.warnings).toEqual([]);
      expect((await fs.readFile(rawPath, "utf8")).trim()).toBe("");
      await expect(fs.access(restorePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("resumes restoration after an interrupted rollback write", async () => {
    await withAuditMigrationFixture(async (audit) => {
      const { raw: rawPath, restore: restorePath } = audit.system;
      const originalContent = `${JSON.stringify(systemAuditEvent("restore after restart"))}\n`;
      const originalBytes = Buffer.from(originalContent, "utf8");
      const interruptedRestore = buildAuditScrubbedContent(originalBytes.length);
      originalBytes.subarray(0, Math.floor(originalBytes.length / 2)).copy(interruptedRestore);
      await audit.seedRawArchive(audit.system, interruptedRestore);
      await writeAuditRestoreJournal(rawPath, originalBytes, {
        restoredBytes: Math.floor(originalBytes.length / 2),
        scrubbedBytes: originalBytes.length,
      });

      const result = await audit.migrate();

      expect(result.warnings).toEqual([]);
      expect(audit.systemSummaries()).toEqual(["restore after restart"]);
      await expect(fs.access(restorePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("retries raw archive recovery when sanitized archive hardening fails", async () => {
    await withAuditMigrationFixture(async (audit) => {
      const { raw, sanitized, source } = audit.system;
      await audit.writeJsonLines(source, [systemAuditEvent("before archive")]);
      await audit.migrate();
      await audit.appendJsonLines(raw, [systemAuditEvent("later row")]);
      // fs-safe applies the write mode before the migration's explicit hardening check.
      const chmodSpy = await failChmodCall(
        audit,
        "recovery-chmod-probe",
        3,
        "simulated recovery chmod failure",
      );

      let failed: Awaited<ReturnType<typeof audit.migrate>>;
      try {
        failed = await audit.migrate();
      } finally {
        chmodSpy.mockRestore();
      }

      expect(failed.changes).toEqual([]);
      expect(failed.warnings.join("\n")).toContain(
        "Failed securing sanitized system-agent audit log",
      );
      expect(audit.detect().sources).toMatchObject([{ storage: "raw-archive" }]);

      const recovered = await audit.migrate();
      expect(recovered.warnings).toEqual([]);
      expect(audit.systemSummaries()).toEqual(["before archive", "later row"]);
      const sanitizedRows = await audit.readJsonLines<{ summary: string }>(sanitized);
      expect(sanitizedRows.map((row) => row.summary)).toEqual(["before archive", "later row"]);
      expect(audit.detect().sources).toEqual([]);
    });
  });

  it("completes a verified partial sanitized tail after an interrupted write", async () => {
    await withAuditMigrationFixture(async (audit) => {
      const { raw, sanitized, source } = audit.system;
      const event = (day: string, summary: string) =>
        systemAuditEvent(summary, { timestamp: `2026-07-${day}T00:00:00.000Z` });
      await audit.writeJsonLines(source, [event("01", "before archive")]);
      await audit.migrate();
      const firstLater = event("02", "first later row");
      const secondLater = event("03", "second later row");
      await audit.appendJsonLines(raw, [firstLater, secondLater]);
      // Simulate a stopped sanitized write: the durable checkpoint prefix plus
      // one complete candidate row is a byte-for-byte prefix of the desired file.
      await audit.appendJsonLines(sanitized, [firstLater]);

      const recovered = await audit.migrate();

      expect(recovered.warnings).toEqual([]);
      expect(audit.systemSummaries()).toEqual([
        "before archive",
        "first later row",
        "second later row",
      ]);
      const sanitizedRows = await audit.readJsonLines<{ summary: string }>(sanitized);
      expect(sanitizedRows.map((row) => row.summary)).toEqual([
        "before archive",
        "first later row",
        "second later row",
      ]);
    });
  });

  it("preserves identical appends and blocks checkpointless whitespace ambiguity", async () => {
    await withAuditMigrationFixture(async (audit) => {
      const { raw, sanitized, source } = audit.system;
      const event = systemAuditEvent("Repeated operation");
      await audit.write(source, `${JSON.stringify(event)}\n\n${JSON.stringify(event)}\n`);
      await audit.migrate();
      await audit.appendJsonLines(raw, [event]);

      const recovered = await audit.migrate();

      expect(recovered.warnings).toEqual([]);
      expect(audit.systemSummaries()).toEqual([
        "Repeated operation",
        "Repeated operation",
        "Repeated operation",
      ]);
      const sanitizedRows = (await fs.readFile(sanitized, "utf8")).trim().split("\n");
      expect(sanitizedRows).toHaveLength(3);

      runOpenClawStateWriteTransaction(
        (database) => {
          database.db
            .prepare("DELETE FROM diagnostic_events WHERE scope = ?")
            .run("migration.legacy-audit-raw");
        },
        { env: audit.env },
      );
      await audit.appendJsonLines(raw, [event]);
      const ambiguous = await audit.migrate();
      expect(ambiguous.changes).toEqual([]);
      expect(ambiguous.warnings).toEqual([
        expect.stringContaining("checkpointless raw archive begins with ambiguous whitespace"),
      ]);
      expect(audit.systemEntries()).toHaveLength(3);
      expect((await fs.readFile(sanitized, "utf8")).trim().split("\n")).toHaveLength(3);
    });
  });
});
