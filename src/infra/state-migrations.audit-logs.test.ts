import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_AUDIT_MAX_ENTRIES, CONFIG_AUDIT_SCOPE } from "../config/io.audit.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { SYSTEM_AGENT_AUDIT_SCOPE } from "../system-agent/audit.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { createSqliteAuditRecordStore } from "./sqlite-audit-record-store.js";
import { openLegacyAuditRawCheckpointStore } from "./state-migrations.audit-checkpoints.js";
import {
  AuditMigrationFixture,
  buildAuditScrubbedContent,
  configAuditRecord,
  failChmodCall,
  failSecondScrubWrite,
  systemAuditEvent,
  withAuditMigrationFixture,
  writeAuditRestoreJournal,
} from "./state-migrations.audit.test-support.js";

describe("legacy core audit log migration", () => {
  afterEach(resetPluginStateStoreForTests);

  it("imports config and system audit JSONL only through explicit doctor repair", async () => {
    await withAuditMigrationFixture(async (audit) => {
      const { source: configPath } = audit.config;
      const { source: systemPath } = audit.system;
      const crestodianPath = path.join(audit.stateDir, "audit", "crestodian.jsonl");
      const unredactedConfigRecord = configAuditRecord("must-redact");
      const unredactedDigest = createHash("sha256")
        .update(JSON.stringify(unredactedConfigRecord))
        .digest("hex")
        .slice(0, 16);
      await audit.writeJsonLines(configPath, [unredactedConfigRecord]);
      await audit.writeJsonLines(systemPath, [
        systemAuditEvent("Set config", {
          timestamp: "2026-07-02T00:00:00.000Z",
          operation: "config.set",
        }),
      ]);
      await audit.writeJsonLines(crestodianPath, [systemAuditEvent("Restarted gateway")]);

      expect(audit.detect(false).hasLegacy).toBe(false);
      const detected = audit.detect();
      expect(detected.sources).toHaveLength(3);

      const result = await audit.migrate(detected);
      expect(result.warnings).toEqual([]);
      expect(result.changes).toHaveLength(6);

      const { env } = audit;
      const configRecords = audit.configRecords();
      expect(configRecords).toHaveLength(1);
      expect(JSON.stringify(configRecords)).not.toContain("must-redact");
      const configEntries = createSqliteAuditRecordStore({
        scope: CONFIG_AUDIT_SCOPE,
        maxEntries: CONFIG_AUDIT_MAX_ENTRIES,
        env,
      }).entries();
      expect(configEntries[0]?.key).not.toContain(unredactedDigest);
      const archivedConfig = await fs.readFile(`${configPath}.migrated`, "utf8");
      expect(archivedConfig).not.toContain("must-redact");
      const rawArchivedConfig = await fs.readFile(`${configPath}.migrated.raw`, "utf8");
      expect(rawArchivedConfig).not.toContain("must-redact");
      expect(rawArchivedConfig.trim()).toBe("");
      if (process.platform !== "win32") {
        expect((await fs.stat(`${configPath}.migrated`)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(`${configPath}.migrated.raw`)).mode & 0o777).toBe(0o600);
      }
      expect(JSON.parse(archivedConfig.trim())).toMatchObject({
        argv: ["openclaw", "config", "set", "token", "***"],
      });
      expect(audit.systemOperations()).toEqual(["config.set", "gateway.restart"]);
      await expect(fs.access(configPath)).rejects.toThrow();
      await expect(fs.access(systemPath)).rejects.toThrow();
      await expect(fs.access(crestodianPath)).rejects.toThrow();

      expect(audit.detect().hasLegacy).toBe(false);
      const laterConfigRecord = {
        ...unredactedConfigRecord,
        ts: "2026-07-04T00:00:00.000Z",
        argv: ["openclaw", "config", "set", "token", "later-redaction-marker"],
      };
      await fs.appendFile(`${configPath}.migrated.raw`, `${JSON.stringify(laterConfigRecord)}\n`);
      const rawRecovery = audit.detect();
      expect(rawRecovery.sources).toMatchObject([{ storage: "raw-archive" }]);
      const recovered = await audit.migrate(rawRecovery);
      expect(recovered.warnings).toEqual([]);
      expect(recovered.changes.join("\n")).toContain("Recovered 1 later config audit log row");
      expect(audit.configRecords()).toHaveLength(2);
      await expect(fs.readFile(`${configPath}.migrated`, "utf8")).resolves.not.toContain(
        "later-redaction-marker",
      );
      await expect(fs.readFile(`${configPath}.migrated.raw`, "utf8")).resolves.not.toContain(
        "later-redaction-marker",
      );
      const recoveredArchiveRows = await audit.readJsonLines<{ ts: string }>(
        audit.config.sanitized,
      );
      expect(recoveredArchiveRows.map((row) => row.ts)).toEqual([
        "2026-07-01T00:00:00.000Z",
        "2026-07-04T00:00:00.000Z",
      ]);
      expect(audit.detect().hasLegacy).toBe(false);
    });
  });

  it("rehashes a checkpointed raw archive before treating it as clean", async () => {
    await withAuditMigrationFixture(async (audit) => {
      const { raw: rawPath, source: sourcePath } = audit.system;
      const original = systemAuditEvent("original");
      const modified = { ...original, summary: "modified" };
      await audit.writeJsonLines(sourcePath, [original]);
      const stableMtime = new Date("2026-07-03T01:00:00.000Z");
      await fs.utimes(sourcePath, stableMtime, stableMtime);
      await audit.migrate();
      const checkpointedStat = await fs.stat(rawPath);
      const modifiedRaw = `${JSON.stringify(modified)}\n`;
      expect(Buffer.byteLength(modifiedRaw)).toBe(checkpointedStat.size);
      await fs.writeFile(rawPath, modifiedRaw);
      const rewrittenStat = await fs.stat(rawPath);
      expect(rewrittenStat.size).toBe(checkpointedStat.size);
      const checkpointStore = openLegacyAuditRawCheckpointStore(audit.stateDir);
      const checkpoint = checkpointStore.entries()[0];
      if (!checkpoint) {
        throw new Error("expected a raw archive checkpoint");
      }
      // Match the rewritten file's cheap identity while retaining the original content hash.
      // Detection must still hash the archive before treating the checkpoint as current.
      checkpointStore.upsert(
        checkpoint.key,
        {
          ...checkpoint.value,
          dev: rewrittenStat.dev,
          ino: rewrittenStat.ino,
          mtimeMs: rewrittenStat.mtimeMs,
          size: rewrittenStat.size,
        },
        checkpoint.createdAt,
      );

      const detected = audit.detect();
      expect(detected.sources).toMatchObject([{ sourcePath: rawPath, storage: "raw-archive" }]);
      const result = await audit.migrate(detected);

      expect(result.warnings.join("\n")).toContain("changed other than by append");
      expect(audit.systemSummaries()).toEqual(["original"]);
    });
  });

  it("restores the captured archive prefix when an in-place scrub write fails", async () => {
    await withAuditMigrationFixture(async (audit) => {
      const { raw: rawPath, source: sourcePath } = audit.config;
      const originalRecord = configAuditRecord("scrub-write-marker");
      const originalContent = `${JSON.stringify(originalRecord)}\n`;
      await audit.write(sourcePath, originalContent);
      const writeSpy = await failSecondScrubWrite(audit);

      let failed: Awaited<ReturnType<typeof audit.migrate>>;
      try {
        failed = await audit.migrate();
      } finally {
        writeSpy.mockRestore();
      }

      expect(failed.warnings.join("\n")).toContain("restored it for Doctor retry");
      await expect(fs.readFile(rawPath, "utf8")).resolves.toBe(originalContent);
      expect(audit.detect().hasLegacy).toBe(true);

      const recovered = await audit.migrate();
      expect(recovered.warnings).toEqual([]);
      await expect(fs.readFile(rawPath, "utf8")).resolves.not.toContain("scrub-write-marker");
      expect(audit.detect().hasLegacy).toBe(false);
    });
  });

  it("restores a moved scrub journal before parsing an interrupted archive", async () => {
    await withAuditMigrationFixture(async (audit) => {
      const { raw, restore } = audit.config;
      const originalRecord = configAuditRecord("restart-redaction-marker");
      const originalContent = `${JSON.stringify(originalRecord)}\n`;
      const damagedContent = Buffer.from(originalContent, "utf8");
      buildAuditScrubbedContent(damagedContent.length)
        .subarray(0, Math.floor(damagedContent.length / 2))
        .copy(damagedContent);
      await audit.seedRawArchive(audit.config, damagedContent);
      await writeAuditRestoreJournal(raw, Buffer.from(originalContent, "utf8"), {
        restoredBytes: 0,
        scrubbedBytes: Math.floor(damagedContent.length / 2),
      });

      const result = await audit.migrate();

      expect(result.warnings).toEqual([]);
      await expect(fs.access(restore)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(raw, "utf8")).resolves.not.toContain("restart-redaction-marker");
      expect(audit.configRecords()).toHaveLength(1);
      expect(audit.detect().hasLegacy).toBe(false);
    });
  });

  it("discards a stale restore journal while recovering a post-checkpoint append", async () => {
    await withAuditMigrationFixture(async (audit) => {
      const { raw, restore, source } = audit.system;
      const originalContent = `${JSON.stringify(
        systemAuditEvent(["token", "redaction-marker"].join("="), { operation: "config.set" }),
      )}\n`;
      await audit.write(source, originalContent);
      await audit.migrate();
      await writeAuditRestoreJournal(raw, Buffer.from(originalContent, "utf8"));
      await audit.appendJsonLines(raw, [
        systemAuditEvent("later", { timestamp: "2026-07-04T00:00:00.000Z" }),
      ]);

      const detected = audit.detect();
      expect(detected.hasLegacy).toBe(true);
      const result = await audit.migrate(detected);

      expect(result.warnings).toEqual([]);
      expect(result.changes.join("\n")).toContain("Recovered 1 later");
      await expect(fs.readFile(raw, "utf8")).resolves.not.toContain(
        ["token", "redaction-marker"].join("="),
      );
      await expect(fs.access(restore)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("does not replay a scrub journal over a same-inode replacement archive", async () => {
    await withAuditMigrationFixture(async (audit) => {
      const { raw, restore } = audit.system;
      const originalContent = `${JSON.stringify(systemAuditEvent("original archive"))}\n`;
      const replacementContent = `${JSON.stringify(
        systemAuditEvent("replacement archive", { timestamp: "2026-07-04T00:00:00.000Z" }),
      )}\n`;
      await audit.seedRawArchive(audit.system, originalContent);
      await writeAuditRestoreJournal(raw, Buffer.from(originalContent, "utf8"));
      await fs.writeFile(raw, replacementContent);

      const result = await audit.migrate();

      expect(result.warnings.join("\n")).toContain("no longer matches its restore journal target");
      await expect(fs.readFile(raw, "utf8")).resolves.toBe(replacementContent);
      await expect(fs.access(restore)).resolves.toBeUndefined();
    });
  });

  it("resumes a deterministic audit claim left by an interrupted Doctor", async () => {
    await withAuditMigrationFixture(async (audit) => {
      const { claim, raw, source } = audit.system;
      await audit.writeJsonLines(source, [systemAuditEvent("Restarted gateway")]);
      await fs.rename(source, claim);

      const detected = audit.detect();
      expect(detected.sources).toMatchObject([{ sourcePath: claim, storage: "claim" }]);
      const result = await audit.migrate(detected);

      expect(result.warnings).toEqual([]);
      await expect(fs.access(claim)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(raw)).resolves.toBeUndefined();
      expect(audit.systemEntries()).toHaveLength(1);

      const tenthRawArchive = `${source}.migrated.10.raw`;
      await audit.writeJsonLines(tenthRawArchive, [
        systemAuditEvent("Reloaded gateway", {
          timestamp: "2026-07-04T00:00:00.000Z",
          operation: "gateway.reload",
        }),
      ]);
      const numberedRaw = audit.detect();
      expect(numberedRaw.sources).toMatchObject([
        { sourcePath: tenthRawArchive, storage: "raw-archive" },
      ]);
      await audit.migrate(numberedRaw);
      expect(audit.systemEntries()).toHaveLength(2);
    });
  });

  it("does not resurrect a pruned raw-archive head when later rows are appended", async () => {
    await withAuditMigrationFixture(async (audit) => {
      const { raw, source } = audit.system;
      const records = ["first", "second", "third"].map((summary, index) =>
        systemAuditEvent(summary, { timestamp: `2026-07-03T00:00:0${index}.000Z` }),
      );
      await audit.writeJsonLines(source, records);
      await audit.migrate();
      createSqliteAuditRecordStore({
        scope: SYSTEM_AGENT_AUDIT_SCOPE,
        maxEntries: 3,
        env: audit.env,
      }).register(
        "runtime",
        systemAuditEvent("runtime", {
          timestamp: "2026-07-04T00:00:00.000Z",
          operation: "gateway.reload",
        }),
      );
      await audit.appendJsonLines(raw, [
        systemAuditEvent("appended", { timestamp: "2026-07-05T00:00:00.000Z" }),
      ]);

      const recovered = await audit.migrate();

      expect(recovered.warnings).toEqual([]);
      expect(recovered.changes.join("\n")).toContain("Recovered 1 later");
      expect(audit.systemSummaries()).toEqual(["second", "third", "appended", "runtime"]);
      const rawCheckpoints = createSqliteAuditRecordStore<{ recordCount: number }>({
        scope: "migration.legacy-audit-raw",
        maxEntries: 10_000,
        env: audit.env,
      }).entries();
      expect(rawCheckpoints).toHaveLength(1);
      expect(rawCheckpoints[0]?.value.recordCount).toBe(0);
    });
  });

  it("keeps identical rows from separate raw archive generations", async () => {
    await withAuditMigrationFixture(async (audit) => {
      const { raw, source } = audit.system;
      const record = systemAuditEvent("Repeated operation");
      await audit.writeJsonLines(raw, [record]);
      await audit.writeJsonLines(`${source}.migrated.2.raw`, [record]);
      await audit.writeJsonLines(`${source}.migrated.10.raw`, [record]);
      const claimPath = path.join(
        path.dirname(source),
        `.${path.basename(source)}.doctor-importing.11`,
      );
      await audit.writeJsonLines(claimPath, [record]);
      await audit.writeJsonLines(source, [record]);

      const detected = audit.detect();
      expect(detected.sources.map((entry) => path.basename(entry.sourcePath))).toEqual([
        "system-agent.jsonl.migrated.raw",
        "system-agent.jsonl.migrated.2.raw",
        "system-agent.jsonl.migrated.10.raw",
        ".system-agent.jsonl.doctor-importing.11",
        "system-agent.jsonl",
      ]);
      const result = await audit.migrate(detected);

      expect(result.warnings).toEqual([]);
      expect(audit.systemEntries()).toHaveLength(5);
      expect(audit.detect().hasLegacy).toBe(false);
    });
  });

  it("keeps restored raw archives idempotent after device and inode changes", async () => {
    await withAuditMigrationFixture(async (root) => {
      const sourceAudit = new AuditMigrationFixture(path.join(root.stateDir, "source-state"));
      const restoredAudit = new AuditMigrationFixture(path.join(root.stateDir, "restored-state"));
      await sourceAudit.writeJsonLines(sourceAudit.system.source, [
        systemAuditEvent("Restored operation"),
      ]);
      await sourceAudit.migrate();
      resetPluginStateStoreForTests();
      await fs.cp(sourceAudit.stateDir, restoredAudit.stateDir, { recursive: true });
      createSqliteAuditRecordStore({
        scope: SYSTEM_AGENT_AUDIT_SCOPE,
        maxEntries: 1,
        env: restoredAudit.env,
      }).register(
        "runtime-after-restore",
        systemAuditEvent("Runtime after restore", {
          timestamp: "2026-07-04T00:00:00.000Z",
          operation: "gateway.reload",
        }),
      );

      const restored = restoredAudit.detect();
      expect(restored.sources).toMatchObject([{ storage: "raw-archive" }]);
      const result = await restoredAudit.migrate(restored);

      expect(result.warnings).toEqual([]);
      expect(restoredAudit.systemSummaries()).toEqual(["Runtime after restore"]);
      expect(restoredAudit.detect().hasLegacy).toBe(false);
    });
  });

  it("resumes the stable generation of an interrupted sanitized archive", async () => {
    await withAuditMigrationFixture(async (audit) => {
      const { claim, raw, sanitized, source } = audit.system;
      const record = systemAuditEvent("Interrupted operation");
      await audit.writeJsonLines(claim, [record]);
      await audit.writeJsonLines(sanitized, [record]);

      const result = await audit.migrate();

      expect(result.warnings).toEqual([]);
      await expect(fs.access(raw)).resolves.toBeUndefined();
      await expect(fs.access(`${source}.migrated.2.raw`)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(audit.systemEntries()).toHaveLength(1);
    });
  });

  it("allocates a new generation when an active source follows a sanitized-only archive", async () => {
    await withAuditMigrationFixture(async (audit) => {
      const { raw, sanitized, source } = audit.system;
      const record = systemAuditEvent("Repeated after downgrade");
      await audit.writeJsonLines(source, [record]);
      await audit.migrate();
      await fs.rm(raw);
      const firstSanitized = await fs.readFile(sanitized, "utf8");
      await audit.writeJsonLines(source, [record]);

      const repeated = await audit.migrate();

      expect(repeated.warnings).toEqual([]);
      expect(repeated.changes.join("\n")).toContain("1 new row");
      await expect(fs.readFile(sanitized, "utf8")).resolves.toBe(firstSanitized);
      await expect(fs.access(`${source}.migrated.2.raw`)).resolves.toBeUndefined();
      expect(audit.systemEntries()).toHaveLength(2);
    });
  });

  it("resumes a claim at its reserved generation instead of an older sanitized-only slot", async () => {
    await withAuditMigrationFixture(async (audit) => {
      const { raw, source } = audit.system;
      const secondClaimPath = path.join(
        path.dirname(source),
        `.${path.basename(source)}.doctor-importing.2`,
      );
      const record = systemAuditEvent("Repeated after interrupted downgrade");
      await audit.writeJsonLines(source, [record]);
      await audit.migrate();
      await fs.rm(raw);
      await audit.writeJsonLines(source, [record]);
      await fs.rename(source, secondClaimPath);

      const detected = audit.detect();
      expect(detected.sources).toMatchObject([
        {
          sourcePath: secondClaimPath,
          storage: "claim",
          sanitizedArchivePath: `${source}.migrated.2`,
          rawArchivePath: `${source}.migrated.2.raw`,
        },
      ]);
      const resumed = await audit.migrate(detected);

      expect(resumed.warnings).toEqual([]);
      await expect(fs.access(`${source}.migrated.2.raw`)).resolves.toBeUndefined();
      expect(audit.systemEntries()).toHaveLength(2);
    });
  });

  it("leaves malformed audit sources in place without partial imports", async () => {
    await withAuditMigrationFixture(async (audit) => {
      const { source } = audit.system;
      await audit.write(source, "{bad json\n");
      const detected = audit.detect();

      const result = await audit.migrate(detected);
      expect(result.warnings.join("\n")).toContain("Failed reading system-agent audit log");
      await expect(fs.access(source)).resolves.toBeUndefined();
      expect(audit.systemEntries()).toEqual([]);
    });
  });

  it("does not migrate newer audit generations before an older source is repaired", async () => {
    await withAuditMigrationFixture(async (audit) => {
      const { raw, source } = audit.system;
      await audit.write(raw, "{bad json\n");
      await audit.writeJsonLines(source, [systemAuditEvent("newer generation")]);

      const blocked = await audit.migrate();

      expect(blocked.changes).toEqual([]);
      expect(blocked.warnings.join("\n")).toContain("Failed reading system-agent audit log");
      await expect(fs.access(source)).resolves.toBeUndefined();
      expect(audit.systemEntries()).toEqual([]);

      await audit.writeJsonLines(raw, [systemAuditEvent("repaired older generation")]);
      const repaired = await audit.migrate();

      expect(repaired.warnings).toEqual([]);
      expect(audit.systemSummaries()).toEqual(["repaired older generation", "newer generation"]);
    });
  });

  it("restores the active source when raw archive hardening fails", async () => {
    await withAuditMigrationFixture(async (audit) => {
      const { raw, sanitized, source } = audit.config;
      await audit.writeJsonLines(source, [configAuditRecord("must-redact")]);
      // fs-safe applies the write mode before the migration's explicit hardening checks.
      const chmodSpy = await failChmodCall(audit, "chmod-probe", 4, "simulated chmod failure");

      let failed: Awaited<ReturnType<typeof audit.migrate>>;
      try {
        failed = await audit.migrate();
      } finally {
        chmodSpy.mockRestore();
      }

      expect(failed.changes).toEqual([]);
      expect(failed.warnings.join("\n")).toContain("Failed securing raw archived config audit log");
      await expect(fs.readFile(source, "utf8")).resolves.toContain("must-redact");
      await expect(fs.access(sanitized)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(raw)).rejects.toMatchObject({ code: "ENOENT" });

      const recovered = await audit.migrate();
      expect(recovered.warnings).toEqual([]);
      await expect(fs.access(source)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(raw)).resolves.toBeUndefined();
    });
  });

  it("requires exclusive state ownership before claiming legacy audit files", async () => {
    await withAuditMigrationFixture(async (audit) => {
      const { source } = audit.system;
      await audit.writeJsonLines(source, [systemAuditEvent("Restarted gateway")]);
      const gatewayLock = await acquireGatewayLock({
        allowInTests: true,
        env: audit.env,
        pollIntervalMs: 10,
        port: 18_791,
        timeoutMs: 100,
      });
      if (!gatewayLock) {
        throw new Error("expected test Gateway lock");
      }

      let result: Awaited<ReturnType<typeof audit.migrate>>;
      try {
        result = await audit.migrate();
      } finally {
        await gatewayLock.release();
      }

      expect(result.warnings.join("\n")).toContain("exclusive state ownership is unavailable");
      await expect(fs.access(source)).resolves.toBeUndefined();
      expect(audit.systemEntries()).toEqual([]);
    });
  });

  it("leaves rows from an old config writer at the recreated source path", async () => {
    await withAuditMigrationFixture(async (audit) => {
      const { source } = audit.config;
      const records = Array.from({ length: 10_000 }, (_, index) =>
        JSON.stringify({
          ts: new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString(),
          source: "config-io",
          event: "config.write",
          argv: ["openclaw", "config", "set", `key-${index}`, "value"],
          execArgv: [],
        }),
      );
      await audit.write(source, `${records.join("\n")}\n`);
      const retainedRecord = configAuditRecord("value", {
        ts: "2026-07-02T00:00:00.000Z",
        argv: ["openclaw", "config", "set", "later", "value"],
      });

      let settled = false;
      const migration = audit.migrate().finally(() => {
        settled = true;
      });
      for (let attempt = 0; attempt < 500; attempt += 1) {
        try {
          await fs.access(source);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            break;
          }
          throw error;
        }
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      expect(settled).toBe(false);
      await audit.appendJsonLines(source, [retainedRecord]);

      const first = await migration;
      expect(first.warnings.join("\n")).toContain("An old writer recreated config audit log");
      await expect(fs.readFile(source, "utf8")).resolves.toBe(
        `${JSON.stringify(retainedRecord)}\n`,
      );

      const second = await audit.migrate();
      expect(second.warnings).toEqual([]);
      await expect(fs.access(source)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        createSqliteAuditRecordStore({
          scope: CONFIG_AUDIT_SCOPE,
          maxEntries: CONFIG_AUDIT_MAX_ENTRIES,
          env: audit.env,
        }).entries(),
      ).toHaveLength(10_001);
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects audit sources beneath symlinked state parents",
    async () => {
      const externalAuditDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-audit-migration-external-"),
      );
      try {
        await withAuditMigrationFixture(async (audit) => {
          const externalSource = path.join(externalAuditDir, "system-agent.jsonl");
          await audit.writeJsonLines(externalSource, [systemAuditEvent("Outside state root")]);
          await fs.symlink(externalAuditDir, path.join(audit.stateDir, "audit"));
          const detected = audit.detect();

          const result = await audit.migrate(detected);

          expect(result.changes).toEqual([]);
          expect(result.warnings.join("\n")).toMatch(/alias|symlink|outside workspace/u);
          await expect(fs.readFile(externalSource, "utf8")).resolves.toContain(
            "Outside state root",
          );
          await expect(fs.access(`${externalSource}.migrated`)).rejects.toMatchObject({
            code: "ENOENT",
          });
          expect(audit.systemEntries()).toEqual([]);
        });
      } finally {
        await fs.rm(externalAuditDir, { recursive: true, force: true });
      }
    },
  );
});
