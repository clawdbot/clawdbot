import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { generateIdentity, MemoryAuditStore, signReceipt } from "./protocol/index.js";
import {
  countStoredReefAuditWindow,
  streamLegacyReefAuditWindow,
  validateLegacyReefAuditJournal,
} from "./src/legacy-audit-import.js";
import {
  REEF_AUDIT_HEAD_KEY,
  REEF_AUDIT_HEAD_MAX_ENTRIES,
  REEF_AUDIT_HEAD_NAMESPACE,
  REEF_AUDIT_NAMESPACE,
  REEF_AUDIT_STORE_MAX_ENTRIES,
  REEF_REPLAY_MAX_ENTRIES,
  REEF_REPLAY_NAMESPACE,
  REEF_REPLAY_TTL_MS,
  reefAuditEntryKey,
  reefReplayStoreKey,
  type ReefAuditHeadRecord,
  type ReefAuditStateRecord,
  type ReefReplayRecord,
} from "./src/state.js";

const journalMutation = vi.hoisted(() => ({
  reads: 0,
  betweenPasses: undefined as (() => void) | undefined,
}));

vi.mock("./src/legacy-jsonl.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./src/legacy-jsonl.js")>();
  return {
    ...actual,
    forEachLegacyReefJsonlRecord: async (
      filePath: string,
      finalRecord: "reject-torn" | "ignore-torn",
      visit: (value: unknown, recordBytes: number) => void | Promise<void>,
    ) => {
      journalMutation.reads += 1;
      if (journalMutation.betweenPasses && journalMutation.reads === 2) {
        const mutate = journalMutation.betweenPasses;
        journalMutation.betweenPasses = undefined;
        mutate();
      }
      return actual.forEachLegacyReefJsonlRecord(filePath, finalRecord, visit);
    },
  };
});

function createDoctorContext(env: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("reef", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

function migrationById(id: string) {
  const migration = stateMigrations.find((entry) => entry.id === id);
  if (!migration) {
    throw new Error(`missing migration ${id}`);
  }
  return migration;
}

describe("Reef doctor journal capacity", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    journalMutation.reads = 0;
    journalMutation.betweenPasses = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginStateStoreForTests();
  });

  it("migrates aggregate replay state beyond 64 MiB when every record fits the value limit", async () => {
    await withTempDir("openclaw-reef-doctor-replay-", async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      vi.spyOn(os, "homedir").mockReturnValue(stateDir);
      const legacyDir = path.join(stateDir, ".openclaw", "data", "reef");
      const replayPath = path.join(legacyDir, "replay.jsonl");
      fs.mkdirSync(legacyDir, { recursive: true });
      // 2,000 claims, each with a ~40 KiB envelope hash, exceed the former
      // 64 MiB aggregate budget while every record stays under the 65,536-byte
      // plugin-state value limit and the 3,000-entry replay capacity.
      const recordCount = 2_000;
      const envelopeHash = "c".repeat(40 * 1024);
      const lines = Array.from({ length: recordCount }, (_, index) =>
        JSON.stringify({
          op: "claim",
          peer: "alice",
          id: `01JZ000000000000000000000${String(index).padStart(4, "0")}`,
          envelopeHash,
        }),
      );
      fs.writeFileSync(replayPath, `${lines.join("\n")}\n`);
      const context = createDoctorContext(env);
      const params = {
        config: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context,
      };

      const result = await migrationById("reef-runtime-files-to-plugin-state").migrateLegacyState(
        params,
      );

      expect(result.warnings).toEqual([]);
      expect(result.changes).toEqual([
        `Migrated ${recordCount} Reef replay bindings -> plugin state`,
        expect.stringContaining("Archived Reef replay state legacy source"),
        expect.stringContaining("Verified all Reef durable state; cleared migration barrier"),
      ]);
      expect(fs.existsSync(`${replayPath}.migrated`)).toBe(true);
      const replayStore = context.openPluginStateKeyedStore<ReefReplayRecord>({
        namespace: REEF_REPLAY_NAMESPACE,
        maxEntries: REEF_REPLAY_MAX_ENTRIES,
        overflowPolicy: "reject-new",
        defaultTtlMs: REEF_REPLAY_TTL_MS,
      });
      await expect(
        replayStore.lookup(reefReplayStoreKey("alice", "01JZ0000000000000000000000001")),
      ).resolves.toMatchObject({
        peer: "alice",
        envelopeHash,
        state: "available",
      });
    });
  });

  it("migrates aggregate audit state beyond 64 MiB within the canonical window", async () => {
    await withTempDir("openclaw-reef-doctor-audit-", async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      vi.spyOn(os, "homedir").mockReturnValue(stateDir);
      const legacyDir = path.join(stateDir, ".openclaw", "data", "reef");
      const auditPath = path.join(legacyDir, "audit.jsonl");
      fs.mkdirSync(legacyDir, { recursive: true });
      // 2,000 valid chain entries with ~40 KiB event bodies exceed the former
      // 64 MiB aggregate budget while every record stays under the 65,536-byte
      // plugin-state value limit and the 30,000-entry audit window.
      const entryCount = 2_000;
      const audit = new MemoryAuditStore(new Uint8Array(32).fill(1));
      const body = { payload: "c".repeat(40 * 1024) };
      for (let index = 0; index < entryCount; index += 1) {
        await audit.appendEvent("one", body, 10 + index);
      }
      const entries = await audit.entries();
      fs.writeFileSync(auditPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
      const context = createDoctorContext(env);
      const params = {
        config: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context,
      };

      const result = await migrationById("reef-audit-jsonl-to-plugin-state").migrateLegacyState(
        params,
      );

      expect(result.warnings).toEqual([]);
      expect(result.changes).toEqual([
        `Migrated ${entryCount} Reef audit entries -> plugin state`,
        expect.stringContaining("Archived Reef audit trail legacy source"),
      ]);
      const headStore = context.openPluginStateKeyedStore<ReefAuditHeadRecord>({
        namespace: REEF_AUDIT_HEAD_NAMESPACE,
        maxEntries: REEF_AUDIT_HEAD_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      await expect(headStore.lookup(REEF_AUDIT_HEAD_KEY)).resolves.toMatchObject({
        hash: entries.at(-1)!.entryHash,
        seq: entryCount,
        oldestHash: entries[0]!.entryHash,
      });
      const store = context.openPluginStateKeyedStore<ReefAuditStateRecord>({
        namespace: REEF_AUDIT_NAMESPACE,
        maxEntries: REEF_AUDIT_STORE_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      await expect(
        store.lookup(reefAuditEntryKey(entries.at(-1)!.entryHash)),
      ).resolves.toMatchObject({ kind: "entry", entry: entries.at(-1)! });
    });
  });

  it("streams near-limit audit entries with bounded memory and window retention", async () => {
    await withTempDir("openclaw-reef-doctor-audit-near-limit-", async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      vi.spyOn(os, "homedir").mockReturnValue(stateDir);
      const legacyDir = path.join(stateDir, ".openclaw", "data", "reef");
      const auditPath = path.join(legacyDir, "audit.jsonl");
      fs.mkdirSync(legacyDir, { recursive: true });
      // 2,500 valid chain entries with ~60 KiB event bodies exceed the former
      // 64 MiB aggregate budget and the streaming window, while every record
      // stays under the 65,536-byte plugin-state value limit.
      const windowSize = 2_000;
      const entryCount = 2_500;
      const audit = new MemoryAuditStore(new Uint8Array(32).fill(1));
      const body = { payload: "c".repeat(60 * 1024) };
      for (let index = 0; index < entryCount; index += 1) {
        await audit.appendEvent("one", body, 10 + index);
      }
      const entries = await audit.entries();
      fs.writeFileSync(auditPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
      const context = createDoctorContext(env);
      const store = context.openPluginStateKeyedStore<ReefAuditStateRecord>({
        namespace: REEF_AUDIT_NAMESPACE,
        maxEntries: REEF_AUDIT_STORE_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      const headStore = context.openPluginStateKeyedStore<ReefAuditHeadRecord>({
        namespace: REEF_AUDIT_HEAD_NAMESPACE,
        maxEntries: REEF_AUDIT_HEAD_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });

      const imported = await streamLegacyReefAuditWindow(
        auditPath,
        {
          totalEntries: entryCount,
          lastHash: entries.at(-1)!.entryHash,
          lastSeq: entries.at(-1)!.event.seq,
        },
        store,
        headStore,
        windowSize,
      );

      expect(imported.persistedCount).toBe(windowSize);
      expect(imported.oldestHash).toBe(entries[entryCount - windowSize]!.entryHash);
      await expect(countStoredReefAuditWindow(store, headStore, windowSize)).resolves.toBe(
        windowSize,
      );
      await expect(store.lookup(reefAuditEntryKey(entries[0]!.entryHash))).resolves.toBeUndefined();
      await expect(
        store.lookup(reefAuditEntryKey(entries.at(-1)!.entryHash)),
      ).resolves.toMatchObject({ kind: "entry", entry: entries.at(-1)! });
      await expect(headStore.lookup(REEF_AUDIT_HEAD_KEY)).resolves.toMatchObject({
        hash: entries.at(-1)!.entryHash,
        seq: entryCount,
        oldestHash: entries[entryCount - windowSize]!.entryHash,
      });
    });
  });

  it("rejects an audit journal that changes between validation and import", async () => {
    await withTempDir("openclaw-reef-doctor-audit-mutation-", async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      vi.spyOn(os, "homedir").mockReturnValue(stateDir);
      const legacyDir = path.join(stateDir, ".openclaw", "data", "reef");
      const auditPath = path.join(legacyDir, "audit.jsonl");
      fs.mkdirSync(legacyDir, { recursive: true });
      const audit = new MemoryAuditStore(new Uint8Array(32).fill(1));
      for (let index = 0; index < 3; index += 1) {
        await audit.appendEvent("one", { id: index }, 10 + index);
      }
      const entries = await audit.entries();
      fs.writeFileSync(auditPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
      const context = createDoctorContext(env);
      const store = context.openPluginStateKeyedStore<ReefAuditStateRecord>({
        namespace: REEF_AUDIT_NAMESPACE,
        maxEntries: REEF_AUDIT_STORE_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      const headStore = context.openPluginStateKeyedStore<ReefAuditHeadRecord>({
        namespace: REEF_AUDIT_HEAD_NAMESPACE,
        maxEntries: REEF_AUDIT_HEAD_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      const summary = await validateLegacyReefAuditJournal(auditPath);
      expect(summary).toEqual({
        totalEntries: 3,
        lastHash: entries.at(-1)!.entryHash,
        lastSeq: entries.at(-1)!.event.seq,
      });

      // Replace the validated source with only its first two entries before
      // the persistence pass starts, exactly the pass-to-pass change that must
      // abort the import instead of archiving the replaced source.
      fs.writeFileSync(
        auditPath,
        `${entries
          .slice(0, 2)
          .map((entry) => JSON.stringify(entry))
          .join("\n")}\n`,
      );

      await expect(
        streamLegacyReefAuditWindow(auditPath, summary, store, headStore),
      ).rejects.toThrow("Reef audit journal changed between validation and import");
      await expect(headStore.lookup(REEF_AUDIT_HEAD_KEY)).resolves.toBeUndefined();
      for (const entry of entries) {
        await expect(store.lookup(reefAuditEntryKey(entry.entryHash))).resolves.toBeUndefined();
      }
    });
  });

  it("leaves the legacy source in place when the audit journal changes between passes", async () => {
    await withTempDir("openclaw-reef-doctor-audit-swap-", async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      vi.spyOn(os, "homedir").mockReturnValue(stateDir);
      const legacyDir = path.join(stateDir, ".openclaw", "data", "reef");
      const filePath = path.join(legacyDir, "audit.jsonl");
      fs.mkdirSync(legacyDir, { recursive: true });
      const audit = new MemoryAuditStore(new Uint8Array(32).fill(1));
      await audit.appendEvent("one", { id: 1 }, 10);
      await audit.appendEvent("two", { id: 2 }, 11);
      await audit.appendEvent("three", { id: 3 }, 12);
      const entries = await audit.entries();
      fs.writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
      journalMutation.betweenPasses = () => {
        fs.writeFileSync(
          filePath,
          `${entries
            .slice(0, 2)
            .map((entry) => JSON.stringify(entry))
            .join("\n")}\n`,
        );
      };
      const context = createDoctorContext(env);
      const params = {
        config: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context,
      };

      const result = await migrationById("reef-audit-jsonl-to-plugin-state").migrateLegacyState(
        params,
      );

      expect(result.warnings).toEqual([
        expect.stringContaining("Failed importing Reef audit trail"),
      ]);
      expect(result.changes).toEqual([]);
      expect(fs.existsSync(`${filePath}.migrated`)).toBe(false);
      const headStore = context.openPluginStateKeyedStore<ReefAuditHeadRecord>({
        namespace: REEF_AUDIT_HEAD_NAMESPACE,
        maxEntries: REEF_AUDIT_HEAD_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      await expect(headStore.lookup(REEF_AUDIT_HEAD_KEY)).resolves.toBeUndefined();
      const store = context.openPluginStateKeyedStore<ReefAuditStateRecord>({
        namespace: REEF_AUDIT_NAMESPACE,
        maxEntries: REEF_AUDIT_STORE_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      for (const entry of entries) {
        await expect(store.lookup(reefAuditEntryKey(entry.entryHash))).resolves.toBeUndefined();
      }

      // Restore the valid journal and rerun: the aborted attempt must not
      // leave rows behind that conflict with the repaired source.
      fs.writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
      const recovered = await migrationById("reef-audit-jsonl-to-plugin-state").migrateLegacyState(
        params,
      );

      expect(recovered.warnings).toEqual([]);
      expect(recovered.changes).toEqual([
        "Migrated 3 Reef audit entries -> plugin state",
        expect.stringContaining("Archived Reef audit trail legacy source"),
      ]);
      expect(fs.existsSync(`${filePath}.migrated`)).toBe(true);
      await expect(headStore.lookup(REEF_AUDIT_HEAD_KEY)).resolves.toMatchObject({
        hash: entries.at(-1)!.entryHash,
        seq: 3,
        oldestHash: entries[0]!.entryHash,
      });
    });
  });

  it("rejects an audit entry whose serialized store record exceeds the value limit", async () => {
    await withTempDir("openclaw-reef-doctor-audit-wrapped-limit-", async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      vi.spyOn(os, "homedir").mockReturnValue(stateDir);
      const legacyDir = path.join(stateDir, ".openclaw", "data", "reef");
      const filePath = path.join(legacyDir, "audit.jsonl");
      fs.mkdirSync(legacyDir, { recursive: true });
      // The raw legacy entry fits the 65,536-byte per-value limit, but the
      // persisted record wraps it with kind plus the next hash, so the stored
      // value itself exceeds the limit and must be rejected before any write.
      const probeAudit = new MemoryAuditStore(new Uint8Array(32).fill(1));
      await probeAudit.appendEvent("one", { payload: "x" }, 10);
      const probeEntry = (await probeAudit.entries())[0]!;
      const probeRaw = Buffer.byteLength(JSON.stringify(probeEntry));
      const overhead =
        Buffer.byteLength(
          JSON.stringify({ kind: "entry", entry: probeEntry, nextHash: "h".repeat(64) }),
        ) - probeRaw;
      const bodySize = Math.max(1, 65_536 - 20 - probeRaw + 1);
      const audit = new MemoryAuditStore(new Uint8Array(32).fill(1));
      await audit.appendEvent("one", { payload: "x".repeat(bodySize) }, 10);
      await audit.appendEvent("two", { id: 2 }, 11);
      const entries = await audit.entries();
      const firstRaw = Buffer.byteLength(JSON.stringify(entries[0]));
      const firstWrapped = Buffer.byteLength(
        JSON.stringify({
          kind: "entry",
          entry: entries[0],
          nextHash: entries[1]!.entryHash,
        }),
      );
      expect(firstRaw).toBeLessThanOrEqual(65_536);
      expect(firstWrapped).toBeGreaterThan(65_536);
      expect(overhead).toBeGreaterThan(0);
      fs.writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

      const context = createDoctorContext(env);
      const params = {
        config: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context,
      };
      const result = await migrationById("reef-audit-jsonl-to-plugin-state").migrateLegacyState(
        params,
      );

      expect(result.warnings).toEqual([
        expect.stringContaining("Reef audit record exceeds 65536 byte plugin-state value limit"),
      ]);
      expect(result.changes).toEqual([]);
      expect(fs.existsSync(`${filePath}.migrated`)).toBe(false);
      const headStore = context.openPluginStateKeyedStore<ReefAuditHeadRecord>({
        namespace: REEF_AUDIT_HEAD_NAMESPACE,
        maxEntries: REEF_AUDIT_HEAD_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      const store = context.openPluginStateKeyedStore<ReefAuditStateRecord>({
        namespace: REEF_AUDIT_NAMESPACE,
        maxEntries: REEF_AUDIT_STORE_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      await expect(headStore.lookup(REEF_AUDIT_HEAD_KEY)).resolves.toBeUndefined();
      for (const entry of entries) {
        await expect(store.lookup(reefAuditEntryKey(entry.entryHash))).resolves.toBeUndefined();
      }

      // Replace the oversized source with a storable journal and rerun: the
      // failed attempt must not leave rows behind.
      const repairAudit = new MemoryAuditStore(new Uint8Array(32).fill(1));
      await repairAudit.appendEvent("repaired", { id: 1 }, 10);
      await repairAudit.appendEvent("repaired", { id: 2 }, 11);
      const repairedEntries = await repairAudit.entries();
      fs.writeFileSync(
        filePath,
        `${repairedEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );
      const recovered = await migrationById("reef-audit-jsonl-to-plugin-state").migrateLegacyState(
        params,
      );

      expect(recovered.warnings).toEqual([]);
      expect(recovered.changes).toEqual([
        "Migrated 2 Reef audit entries -> plugin state",
        expect.stringContaining("Archived Reef audit trail legacy source"),
      ]);
      await expect(headStore.lookup(REEF_AUDIT_HEAD_KEY)).resolves.toMatchObject({
        hash: repairedEntries.at(-1)!.entryHash,
        seq: 2,
      });
    });
  });

  it("streams complete legacy audit and replay records beyond 32 MiB", async () => {
    await withTempDir("openclaw-reef-doctor-bounds-", async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      vi.spyOn(os, "homedir").mockReturnValue(stateDir);
      const legacyDir = path.join(stateDir, ".openclaw", "data", "reef");
      const auditPath = path.join(legacyDir, "audit.jsonl");
      const replayPath = path.join(legacyDir, "replay.jsonl");
      const audit = new MemoryAuditStore(new Uint8Array(32).fill(1));
      await audit.appendEvent("one", { id: 1 }, 10);
      await audit.appendEvent("two", { id: 2 }, 11);
      const auditEntries = await audit.entries();
      const replayId = "01JZ0000000000000000000000";
      const laterReplayId = "01JZ0000000000000000000001";
      const receipt = signReceipt(
        {
          id: laterReplayId,
          bodyHash: "a".repeat(64),
          auditHead: "b".repeat(64),
          status: "rejected",
        },
        generateIdentity().signing.secretKey,
      );
      const gap = "\n".repeat(33 * 1024 * 1024);
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(
        auditPath,
        `${JSON.stringify(auditEntries[0])}\n${gap}${JSON.stringify(auditEntries[1])}\n`,
      );
      fs.writeFileSync(
        replayPath,
        `${JSON.stringify({ op: "claim", peer: "alice", id: replayId, envelopeHash: "c".repeat(64) })}\n${gap}${JSON.stringify({ op: "claim", peer: "bob", id: laterReplayId, envelopeHash: "d".repeat(64) })}\n${JSON.stringify({ op: "complete", peer: "bob", id: laterReplayId, receipt })}\n`,
      );
      const context = createDoctorContext(env);
      const params = {
        config: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context,
      };

      const auditResult = await migrationById(
        "reef-audit-jsonl-to-plugin-state",
      ).migrateLegacyState(params);
      const replayResult = await migrationById(
        "reef-runtime-files-to-plugin-state",
      ).migrateLegacyState(params);

      expect(auditResult.warnings).toEqual([]);
      expect(replayResult.warnings).toEqual([]);
      const headStore = context.openPluginStateKeyedStore<ReefAuditHeadRecord>({
        namespace: REEF_AUDIT_HEAD_NAMESPACE,
        maxEntries: REEF_AUDIT_HEAD_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      await expect(headStore.lookup(REEF_AUDIT_HEAD_KEY)).resolves.toMatchObject({
        hash: auditEntries[1]!.entryHash,
        seq: 2,
      });
      const replayStore = context.openPluginStateKeyedStore<ReefReplayRecord>({
        namespace: REEF_REPLAY_NAMESPACE,
        maxEntries: REEF_REPLAY_MAX_ENTRIES,
        overflowPolicy: "reject-new",
        defaultTtlMs: REEF_REPLAY_TTL_MS,
      });
      await expect(replayStore.lookup(reefReplayStoreKey("bob", laterReplayId))).resolves.toEqual({
        peer: "bob",
        id: laterReplayId,
        envelopeHash: "d".repeat(64),
        state: "completed",
        receipt,
      });
      expect(fs.existsSync(`${auditPath}.migrated`)).toBe(true);
      expect(fs.existsSync(`${replayPath}.migrated`)).toBe(true);
    });
  });

  it("leaves an oversized legacy JSONL record blocked and unarchived", async () => {
    await withTempDir("openclaw-reef-doctor-bounds-", async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      vi.spyOn(os, "homedir").mockReturnValue(stateDir);
      const legacyDir = path.join(stateDir, ".openclaw", "data", "reef");
      const replayPath = path.join(legacyDir, "replay.jsonl");
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(
        replayPath,
        JSON.stringify({
          op: "claim",
          peer: "alice",
          id: "01JZ0000000000000000000000",
          envelopeHash: "c".repeat(64),
        }),
      );
      fs.truncateSync(replayPath, 32 * 1024 * 1024 + 1);
      const migration = migrationById("reef-runtime-files-to-plugin-state");
      const params = {
        config: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: createDoctorContext(env),
      };

      const result = await migration.migrateLegacyState(params);

      expect(result.changes).toEqual([]);
      expect(result.warnings).toEqual([
        expect.stringContaining("Reef legacy JSONL record exceeds 33554432 bytes"),
        expect.stringContaining("Reef durable state migration is incomplete"),
      ]);
      expect(fs.existsSync(replayPath)).toBe(true);
      expect(fs.existsSync(`${replayPath}.migrated`)).toBe(false);
    });
  });

  it("rejects a legacy replay record that exceeds the plugin-state value limit", async () => {
    await withTempDir("openclaw-reef-doctor-bounds-", async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      vi.spyOn(os, "homedir").mockReturnValue(stateDir);
      const legacyDir = path.join(stateDir, ".openclaw", "data", "reef");
      const replayPath = path.join(legacyDir, "replay.jsonl");
      fs.mkdirSync(legacyDir, { recursive: true });
      const oversizedHash = "c".repeat(24 * 1024 * 1024);
      for (let index = 0; index < 3; index += 1) {
        fs.appendFileSync(
          replayPath,
          `${JSON.stringify({
            op: "claim",
            peer: "alice",
            id: `01JZ000000000000000000000${index}`,
            envelopeHash: oversizedHash,
          })}\n`,
        );
      }
      const migration = migrationById("reef-runtime-files-to-plugin-state");
      const params = {
        config: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: createDoctorContext(env),
      };

      const result = await migration.migrateLegacyState(params);

      expect(result.changes).toEqual([]);
      expect(result.warnings).toEqual([
        expect.stringContaining(
          "Reef legacy JSONL replay record exceeds 65536 byte plugin-state value limit",
        ),
        expect.stringContaining("Reef durable state migration is incomplete"),
      ]);
      expect(fs.existsSync(replayPath)).toBe(true);
      expect(fs.existsSync(`${replayPath}.migrated`)).toBe(false);
    });
  });
});
