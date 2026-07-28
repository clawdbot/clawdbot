// Covers backup archive creation and verification filtering.
import fsSync, { rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import * as tar from "tar";
import { describe, expect, it, vi } from "vitest";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import { backupVerifyCommand } from "../commands/backup-verify.js";
import { CONFIG_AUDIT_MAX_ENTRIES, CONFIG_AUDIT_SCOPE } from "../config/io.audit.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabase,
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  sanitizeOpenClawGlobalStateSnapshot,
  sanitizeOpenClawStateLeaseRows,
} from "../state/openclaw-state-snapshot-sanitizer.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createBackupArchive,
  formatBackupCreateSummary,
  type BackupCreateResult,
} from "./backup-create.js";
import { writeTarArchiveWithRetry } from "./backup-tar-retry.js";
import { isVolatileBackupPath } from "./backup-volatile-filter.js";
import { createBackupVolatileStatCache } from "./backup-volatile-stat-cache.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { createSqliteAuditRecordStore } from "./sqlite-audit-record-store.js";
import { detectLegacyAuditLogs, migrateLegacyAuditLogs } from "./state-migrations.audit-logs.js";

function makeResult(overrides: Partial<BackupCreateResult> = {}): BackupCreateResult {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    archiveRoot: "openclaw-backup-2026-01-01",
    archivePath: "/tmp/openclaw-backup.tar.gz",
    dryRun: false,
    includeWorkspace: true,
    onlyConfig: false,
    verified: false,
    assets: [],
    skipped: [],
    skippedVolatileCount: 0,
    ...overrides,
  };
}

async function listArchiveEntries(archivePath: string): Promise<string[]> {
  const entries: string[] = [];
  await tar.t({
    file: archivePath,
    gzip: true,
    onentry: (entry) => {
      entries.push(entry.path);
      entry.resume();
    },
  });
  return entries;
}

async function listArchiveEntryDetails(
  archivePath: string,
): Promise<Array<{ path: string; linkpath?: string; type?: string }>> {
  const entries: Array<{ path: string; linkpath?: string; type?: string }> = [];
  await tar.t({
    file: archivePath,
    gzip: true,
    onentry: (entry) => {
      entries.push({
        path: entry.path,
        ...(entry.linkpath ? { linkpath: entry.linkpath } : {}),
        ...(entry.type ? { type: entry.type } : {}),
      });
      entry.resume();
    },
  });
  return entries;
}

function createUnsafeIndexDrift(sqlitePath: string): void {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(sqlitePath);
  try {
    database.exec(`
      CREATE TABLE unsafe_index_records (
        id INTEGER PRIMARY KEY,
        indexed_value TEXT NOT NULL,
        alternate_value TEXT NOT NULL
      );
      CREATE INDEX unsafe_index_records_value ON unsafe_index_records(indexed_value);
      INSERT INTO unsafe_index_records (indexed_value, alternate_value)
      VALUES ('alpha', 'zeta'), ('beta', 'eta'), ('gamma', 'theta');
    `);
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare(
        "UPDATE sqlite_schema SET sql = 'CREATE INDEX unsafe_index_records_value ON unsafe_index_records(alternate_value)' WHERE name = 'unsafe_index_records_value'",
      )
      .run();
    const schemaVersion = Number(
      Object.values(database.prepare("PRAGMA schema_version;").get() as Record<string, unknown>)[0],
    );
    database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion + 1};`);
  } finally {
    database.close();
  }
}

function createEmptySqliteDatabase(sqlitePath: string): void {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(sqlitePath);
  try {
    database.exec("VACUUM;");
  } finally {
    database.close();
  }
}

function createOwnedSqliteDatabase(params: {
  sqlitePath: string;
  role: "agent" | "global";
  agentId?: string;
  schemaVersion?: number;
}): void {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(params.sqlitePath);
  const schemaVersion = params.schemaVersion ?? 1;
  try {
    database.exec(`
      CREATE TABLE schema_meta (
        meta_key TEXT NOT NULL PRIMARY KEY,
        role TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        agent_id TEXT,
        app_version TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      PRAGMA user_version = ${schemaVersion};
    `);
    database
      .prepare(
        `INSERT INTO schema_meta
          (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
         VALUES ('primary', ?, ?, ?, NULL, 1, 1)`,
      )
      .run(params.role, schemaVersion, params.agentId ?? null);
  } finally {
    database.close();
  }
}

function resolveCanonicalTestSqlitePath(
  state: OpenClawTestState,
  kind: "agent" | "global",
): string {
  return kind === "global"
    ? resolveOpenClawStateSqlitePath(state.env)
    : state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
}

describe("formatBackupCreateSummary", () => {
  const backupArchiveLine = "Backup archive: /tmp/openclaw-backup.tar.gz";

  it.each([
    {
      name: "formats created archives with included and skipped paths",
      result: makeResult({
        verified: true,
        assets: [
          {
            kind: "state",
            sourcePath: "/state",
            archivePath: "archive/state",
            displayPath: "~/.openclaw",
          },
        ],
        skipped: [
          {
            kind: "workspace",
            sourcePath: "/workspace",
            displayPath: "~/Projects/openclaw",
            reason: "covered",
            coveredBy: "~/.openclaw",
          },
        ],
      }),
      expected: [
        backupArchiveLine,
        "Included 1 path:",
        "- state: ~/.openclaw",
        "Skipped 1 path:",
        "- workspace: ~/Projects/openclaw (covered by ~/.openclaw)",
        "Created /tmp/openclaw-backup.tar.gz",
        "Archive verification: passed",
      ],
    },
    {
      name: "formats dry runs and pluralized counts",
      result: makeResult({
        dryRun: true,
        assets: [
          {
            kind: "config",
            sourcePath: "/config",
            archivePath: "archive/config",
            displayPath: "~/.openclaw/config.json",
          },
          {
            kind: "credentials",
            sourcePath: "/oauth",
            archivePath: "archive/oauth",
            displayPath: "~/.openclaw/oauth",
          },
        ],
      }),
      expected: [
        backupArchiveLine,
        "Included 2 paths:",
        "- config: ~/.openclaw/config.json",
        "- credentials: ~/.openclaw/oauth",
        "Dry run only; archive was not written.",
      ],
    },
  ])("$name", ({ result, expected }) => {
    expect(formatBackupCreateSummary(result)).toEqual(expected);
  });

  it("surfaces the volatile skip count in the summary", () => {
    expect(
      formatBackupCreateSummary(
        makeResult({
          assets: [
            {
              kind: "state",
              sourcePath: "/state",
              archivePath: "archive/state",
              displayPath: "~/.openclaw",
            },
          ],
          skippedVolatileCount: 3,
        }),
      ),
    ).toEqual([
      "Backup archive: /tmp/openclaw-backup.tar.gz",
      "Included 1 path:",
      "- state: ~/.openclaw",
      "Created /tmp/openclaw-backup.tar.gz",
      "Skipped 3 volatile files (live sessions, cron logs, queues, sockets, pid/tmp).",
    ]);
  });
});

describe("sanitizeOpenClawGlobalStateSnapshot", () => {
  it("tolerates legacy databases without current transient tables", () => {
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(":memory:");
    try {
      expect(() => sanitizeOpenClawGlobalStateSnapshot(database)).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("removes leases without applying global queue or blob policy", () => {
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE state_leases (scope TEXT, lease_key TEXT);
        INSERT INTO state_leases VALUES ('plugin:test', 'write');
        CREATE TABLE delivery_queue_entries (id TEXT);
        INSERT INTO delivery_queue_entries VALUES ('keep');
        CREATE TABLE plugin_blob_entries (entry_key TEXT, expires_at INTEGER);
        INSERT INTO plugin_blob_entries VALUES ('keep', 1);
      `);

      sanitizeOpenClawStateLeaseRows(database);

      expect(database.prepare("SELECT COUNT(*) AS count FROM state_leases").get()).toEqual({
        count: 0,
      });
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get(),
      ).toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM plugin_blob_entries").get()).toEqual({
        count: 1,
      });
    } finally {
      database.close();
    }
  });

  it("leaves diagnostic state to its backup-specific sanitizer", () => {
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE diagnostic_events (scope TEXT);
        INSERT INTO diagnostic_events VALUES ('migration.legacy-audit-raw');
        INSERT INTO diagnostic_events VALUES ('system-agent.audit');
      `);

      sanitizeOpenClawGlobalStateSnapshot(database);

      expect(database.prepare("SELECT scope FROM diagnostic_events").all()).toEqual([
        { scope: "migration.legacy-audit-raw" },
        { scope: "system-agent.audit" },
      ]);
    } finally {
      database.close();
    }
  });
});

describe("writeTarArchiveWithRetry", () => {
  it.each([
    new Error("did not encounter expected EOF"),
    new Error("encountered unexpected EOF"),
    new Error("TAR_BAD_ARCHIVE: Unrecognized archive format"),
    new Error("Truncated input (needed 512 more bytes, only 0 available) (TAR_BAD_ARCHIVE)"),
    Object.assign(new Error(""), { code: "EOF" }),
  ])("retries tar-specific EOF-class errors: $message", async (error) => {
    const runTar = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce();
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    await writeTarArchiveWithRetry({
      tempArchivePath: "/tmp/backup.tar.gz.tmp",
      runTar,
      sleepMs: sleep,
    });

    expect(runTar).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it.each([
    new Error("EOF occurred in violation of protocol"),
    new Error("unexpected eof while reading"),
    new Error("ran out of EOF markers"),
    new Error("permission denied"),
    new Error(""),
    null,
    undefined,
    "did not encounter expected EOF",
  ])("does not retry unrelated errors: %s", async (error) => {
    const runTar = vi.fn<() => Promise<void>>().mockRejectedValueOnce(error);
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    await expect(
      writeTarArchiveWithRetry({
        tempArchivePath: "/tmp/backup.tar.gz.tmp",
        runTar,
        sleepMs: sleep,
      }),
    ).rejects.toThrow(/Backup archive write failed/);
    expect(runTar).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries on EOF-class errors and eventually succeeds", async () => {
    const eofErr = Object.assign(new Error("did not encounter expected EOF"), {
      path: "/state/sessions/s-abc/transcript.jsonl",
    });
    const runTar = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(eofErr)
      .mockRejectedValueOnce(eofErr)
      .mockResolvedValueOnce(undefined);
    const log = vi.fn();
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    await writeTarArchiveWithRetry({
      tempArchivePath: "/tmp/backup.tar.gz.tmp",
      runTar,
      log,
      sleepMs: sleep,
    });

    expect(runTar).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 10_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 20_000);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("uses a fresh temp archive path without pathname-based cleanup", async () => {
    const eofErr = Object.assign(new Error("did not encounter expected EOF"), {
      path: "/state/sessions/s-abc/transcript.jsonl",
    });
    const tempArchivePath = "/tmp/backup.tar.gz.tmp";
    const runTar = vi
      .fn<(attemptTempArchivePath: string) => Promise<string>>()
      .mockRejectedValueOnce(eofErr)
      .mockResolvedValueOnce("complete");
    const log = vi.fn();
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const rmSpy = vi.spyOn(fs, "rm");

    try {
      const result = await writeTarArchiveWithRetry({
        tempArchivePath,
        runTar,
        log,
        sleepMs: sleep,
      });

      expect(runTar).toHaveBeenNthCalledWith(1, tempArchivePath);
      expect(runTar).toHaveBeenNthCalledWith(2, `${tempArchivePath}.retry-2`);
      expect(result).toBe("complete");
      expect(rmSpy).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledOnce();
    } finally {
      rmSpy.mockRestore();
    }
  });

  it("does not remove retry paths by pathname when a later attempt fails", async () => {
    const eofErr = Object.assign(new Error("did not encounter expected EOF"), {
      path: "/state/sessions/s-abc/transcript.jsonl",
    });
    const tempArchivePath = "/tmp/backup.tar.gz.tmp";
    const runTar = vi
      .fn<(attemptTempArchivePath: string) => Promise<void>>()
      .mockRejectedValueOnce(eofErr)
      .mockRejectedValueOnce(new Error("permission denied"));
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const rmSpy = vi.spyOn(fs, "rm").mockResolvedValue(undefined);

    try {
      await expect(
        writeTarArchiveWithRetry({
          tempArchivePath,
          runTar,
          sleepMs: sleep,
        }),
      ).rejects.toThrow(/permission denied/);

      expect(runTar).toHaveBeenNthCalledWith(1, tempArchivePath);
      expect(runTar).toHaveBeenNthCalledWith(2, `${tempArchivePath}.retry-2`);
      expect(rmSpy).not.toHaveBeenCalled();
    } finally {
      rmSpy.mockRestore();
    }
  });

  it("surfaces the offending path and attempt count after exhausting retries", async () => {
    const eofErr = Object.assign(new Error("did not encounter expected EOF"), {
      path: "/state/logs/gateway.jsonl",
    });
    const runTar = vi.fn<() => Promise<void>>().mockRejectedValue(eofErr);
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    await expect(
      writeTarArchiveWithRetry({
        tempArchivePath: "/tmp/backup.tar.gz.tmp",
        runTar,
        sleepMs: sleep,
      }),
    ).rejects.toThrow(/last offending path: \/state\/logs\/gateway\.jsonl, after 3 attempts/);
    expect(runTar).toHaveBeenCalledTimes(3);
  });

  it("lets callers reset per-attempt counters so retries report the final attempt's count, not a running sum", async () => {
    // Simulate the caller's pattern: a closure counter populated by a filter
    // that tar.c invokes while walking the tree. Each attempt re-walks the
    // same tree, so the runTar closure must reset the counter before calling
    // tar.c -- otherwise the reported count accumulates across attempts.
    let skippedVolatileCount = 0;
    const volatileFilesSeenPerAttempt = 5;
    let attempt = 0;

    const eofErr = Object.assign(new Error("did not encounter expected EOF"), {
      path: "/state/sessions/s-abc/transcript.jsonl",
    });

    const runTar = vi.fn<() => Promise<void>>().mockImplementation(async () => {
      attempt += 1;
      skippedVolatileCount = 0;
      for (let i = 0; i < volatileFilesSeenPerAttempt; i += 1) {
        skippedVolatileCount += 1;
      }
      if (attempt < 3) {
        throw eofErr;
      }
    });
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    await writeTarArchiveWithRetry({
      tempArchivePath: "/tmp/backup.tar.gz.tmp",
      runTar,
      sleepMs: sleep,
    });

    expect(runTar).toHaveBeenCalledTimes(3);
    // Without the reset, this would be 15 (5 * 3 attempts). With the reset,
    // it equals the count from the final (successful) attempt.
    expect(skippedVolatileCount).toBe(volatileFilesSeenPerAttempt);
  });

  it("does not retry on non-EOF errors", async () => {
    const runTar = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("permission denied"));
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    await expect(
      writeTarArchiveWithRetry({
        tempArchivePath: "/tmp/backup.tar.gz.tmp",
        runTar,
        sleepMs: sleep,
      }),
    ).rejects.toThrow(/permission denied/);
    expect(runTar).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("createBackupVolatileStatCache", () => {
  it("lets tar filter a volatile file that disappears before lstat", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-volatile-stat-cache-",
        scenario: "minimal",
      },
      async (state) => {
        const volatilePath = await state.writeText("logs/gateway.log", "live log\n");
        await state.writeText("settings.json", '{"keep":true}\n');
        const archivePath = state.path("volatile-stat-cache.tar.gz");
        const volatilePlan = { stateDirs: [state.stateDir] };
        const statCache = createBackupVolatileStatCache(volatilePlan);
        const getCachedStat = statCache.get.bind(statCache);
        let removedBeforeStat = false;

        statCache.get = (key: string) => {
          if (path.resolve(key) === path.resolve(volatilePath)) {
            rmSync(volatilePath, { force: true });
            removedBeforeStat = true;
          }
          return getCachedStat(key);
        };

        await tar.c(
          {
            file: archivePath,
            gzip: true,
            portable: true,
            preservePaths: true,
            statCache,
            filter: (entryPath) => !isVolatileBackupPath(entryPath, volatilePlan),
          },
          [state.stateDir],
        );

        const entries = await listArchiveEntries(archivePath);
        expect(removedBeforeStat).toBe(true);
        expect(entries.some((entry) => entry.endsWith("/settings.json"))).toBe(true);
        expect(entries.some((entry) => entry.endsWith("/logs/gateway.log"))).toBe(false);
      },
    );
  });
});

describe("createBackupArchive", () => {
  it("falls back when injected nowMs is outside Date range", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-invalid-now-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        await fs.mkdir(outputDir, { recursive: true });
        const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 4, 30, 12, 0, 0));

        try {
          const result = await createBackupArchive({
            output: outputDir,
            dryRun: true,
            includeWorkspace: false,
            nowMs: 8_640_000_000_000_001,
          });

          expect(result.createdAt).toBe("2026-05-30T12:00:00.000Z");
          expect(path.basename(result.archivePath)).toContain("openclaw-backup.tar.gz");
          expect(path.basename(result.archivePath)).not.toContain("NaN");
        } finally {
          dateNowSpy.mockRestore();
        }
      },
    );
  });

  it("falls back to epoch when injected nowMs and Date.now are outside Date range", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-invalid-fallback-now-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        await fs.mkdir(outputDir, { recursive: true });
        const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);

        try {
          const result = await createBackupArchive({
            output: outputDir,
            dryRun: true,
            includeWorkspace: false,
            nowMs: 8_640_000_000_000_001,
          });

          expect(result.createdAt).toBe("1970-01-01T00:00:00.000Z");
          expect(path.basename(result.archivePath)).toContain("openclaw-backup.tar.gz");
          expect(path.basename(result.archivePath)).not.toContain("NaN");
        } finally {
          dateNowSpy.mockRestore();
        }
      },
    );
  });

  it("skips current live volatile state files while preserving workspace locks", async () => {
    await withOpenClawTestState(
      {
        layout: "split",
        prefix: "openclaw-backup-volatile-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        await state.writeConfig({
          agents: {
            entries: { main: { default: true, workspace: state.workspaceDir } },
          },
        });
        await fs.mkdir(outputDir, { recursive: true });
        await fs.writeFile(path.join(state.workspaceDir, "Cargo.lock"), "workspace lock\n", "utf8");
        await fs.writeFile(
          path.join(state.workspaceDir, "pending.tmp"),
          "workspace temp fixture\n",
          "utf8",
        );
        await state.writeText("agents/main/sessions/live-session.jsonl", "session\n");
        await state.writeText("sessions/legacy-session.jsonl", "legacy session\n");
        await state.writeText("cron/runs/nightly.jsonl", "cron\n");
        await state.writeText("logs/gateway.log", "log\n");
        await state.writeJson("delivery-queue/message.json", { id: "delivery" });
        await state.writeText("delivery-queue/message.delivered", '{"id":"delivery"}\n');
        await state.writeJson("session-delivery-queue/message.json", { id: "session-delivery" });
        await state.writeText(
          "session-delivery-queue/message.delivered",
          '{"id":"session-delivery"}\n',
        );
        await state.writeText("tmp/staged.tmp", "tmp\n");
        await state.writeText("gateway.pid", "123\n");

        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: true,
          nowMs: Date.UTC(2026, 4, 9, 8, 0, 0),
        });
        const entries = await listArchiveEntries(result.archivePath);

        expect(entries.some((entry) => entry.endsWith("/workspace/Cargo.lock"))).toBe(true);
        expect(entries.some((entry) => entry.endsWith("/workspace/pending.tmp"))).toBe(true);
        for (const suffix of [
          "/state/agents/main/sessions/live-session.jsonl",
          "/state/sessions/legacy-session.jsonl",
          "/state/cron/runs/nightly.jsonl",
          "/state/logs/gateway.log",
          "/state/delivery-queue/message.json",
          "/state/delivery-queue/message.delivered",
          "/state/session-delivery-queue/message.json",
          "/state/session-delivery-queue/message.delivered",
          "/state/tmp/staged.tmp",
          "/state/gateway.pid",
        ]) {
          expect(
            entries.some((entry) => entry.endsWith(suffix)),
            suffix,
          ).toBe(false);
        }
        expect(result.skippedVolatileCount).toBe(10);
      },
    );
  });

  it("replaces legacy audit raw archives with sanitized restorable snapshots", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-audit-raw-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const extractDir = state.path("extract");
        const rawRelativePath = "logs/config-audit.jsonl.migrated.raw";
        const marker = "audit-value-7f3c";
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(extractDir, { recursive: true });
        await state.writeText(
          rawRelativePath,
          `${JSON.stringify({
            ts: "2026-07-01T00:00:00.000Z",
            source: "config-io",
            event: "config.write",
            argv: ["openclaw", "config", "set", "token", marker],
            execArgv: [],
          })}\n`,
        );
        const { db } = openOpenClawStateDatabase({ env: state.env });
        db.prepare(
          `
            INSERT INTO diagnostic_events (
              scope, event_key, payload_json, created_at, sequence
            ) VALUES ('migration.legacy-audit-raw', 'checkpoint', '{}', 1, 1)
          `,
        ).run();

        try {
          const result = await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 4, 9, 8, 15, 0),
          });
          const entries = await listArchiveEntries(result.archivePath);
          const rawEntry = expectDefined(
            entries.find((entry) => entry.endsWith(`/state/${rawRelativePath}`)),
            "sanitized raw archive entry",
          );
          const databaseEntry = expectDefined(
            entries.find((entry) => entry.endsWith("/state/state/openclaw.sqlite")),
            "global state database entry",
          );
          expect(entries.some((entry) => entry.endsWith(".doctor-scrub-restore"))).toBe(false);

          await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
          const archivedRaw = await fs.readFile(path.join(extractDir, rawEntry), "utf8");
          expect(archivedRaw).not.toContain(marker);
          expect(JSON.parse(archivedRaw.trim())).toMatchObject({
            argv: ["openclaw", "config", "set", "token", "***"],
          });
          const sqlite = requireNodeSqlite();
          const archivedDb = new sqlite.DatabaseSync(path.join(extractDir, databaseEntry), {
            readOnly: true,
          });
          try {
            expect(
              archivedDb
                .prepare(
                  "SELECT COUNT(*) AS count FROM diagnostic_events WHERE scope = 'migration.legacy-audit-raw'",
                )
                .get(),
            ).toEqual({ count: 0 });
          } finally {
            archivedDb.close();
          }
        } finally {
          closeOpenClawStateDatabase();
        }
      },
    );
  });

  it("omits completed blank audit append pads when dropping their checkpoints", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-completed-audit-pad-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const extractDir = state.path("extract");
        const sourcePath = state.statePath("logs/config-audit.jsonl");
        const rawRelativePath = "logs/config-audit.jsonl.migrated.raw";
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(extractDir, { recursive: true });
        await fs.mkdir(path.dirname(sourcePath), { recursive: true });
        await fs.writeFile(
          sourcePath,
          `${JSON.stringify({
            ts: "2026-07-01T00:00:00.000Z",
            source: "config-io",
            event: "config.write",
            argv: ["openclaw", "config", "set", "safe", "value"],
            execArgv: [],
          })}\n`,
        );
        await migrateLegacyAuditLogs({
          detected: detectLegacyAuditLogs({
            stateDir: state.stateDir,
            doctorOnlyStateMigrations: true,
          }),
          stateDir: state.stateDir,
        });
        expect(
          detectLegacyAuditLogs({
            stateDir: state.stateDir,
            doctorOnlyStateMigrations: true,
          }).hasLegacy,
        ).toBe(false);
        const { db } = openOpenClawStateDatabase({ env: state.env });
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM diagnostic_events WHERE scope = 'migration.legacy-audit-raw'",
            )
            .get(),
        ).toEqual({ count: 1 });

        try {
          const result = await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 4, 9, 8, 20, 0),
          });
          const entries = await listArchiveEntries(result.archivePath);
          expect(entries.some((entry) => entry.endsWith(`/state/${rawRelativePath}`))).toBe(false);
          const databaseEntry = expectDefined(
            entries.find((entry) => entry.endsWith("/state/state/openclaw.sqlite")),
            "global state database entry",
          );
          await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
          const sqlite = requireNodeSqlite();
          const archivedDb = new sqlite.DatabaseSync(path.join(extractDir, databaseEntry), {
            readOnly: true,
          });
          try {
            expect(
              archivedDb
                .prepare(
                  "SELECT COUNT(*) AS count FROM diagnostic_events WHERE scope = 'migration.legacy-audit-raw'",
                )
                .get(),
            ).toEqual({ count: 0 });
          } finally {
            archivedDb.close();
          }
        } finally {
          closeOpenClawStateDatabase();
        }
      },
    );
  });

  it("preserves audit ordinals for identical later appends across backup restore", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-audit-ordinal-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const extractDir = state.path("extract");
        const sourcePath = state.statePath("logs/config-audit.jsonl");
        const rawRelativePath = "logs/config-audit.jsonl.migrated.raw";
        const record = {
          ts: "2026-07-01T00:00:00.000Z",
          source: "config-io",
          event: "config.write",
          argv: ["openclaw", "config", "set", "safe", "same"],
          execArgv: [],
        };
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(extractDir, { recursive: true });
        await fs.mkdir(path.dirname(sourcePath), { recursive: true });
        await fs.writeFile(sourcePath, `${JSON.stringify(record)}\n`);
        await migrateLegacyAuditLogs({
          detected: detectLegacyAuditLogs({
            stateDir: state.stateDir,
            doctorOnlyStateMigrations: true,
          }),
          stateDir: state.stateDir,
        });
        await fs.appendFile(state.statePath(rawRelativePath), `${JSON.stringify(record)}\n`);

        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: Date.UTC(2026, 4, 9, 8, 25, 0),
        });
        const entries = await listArchiveEntries(result.archivePath);
        const databaseEntry = expectDefined(
          entries.find((entry) => entry.endsWith("/state/state/openclaw.sqlite")),
          "global state database entry",
        );
        await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
        closeOpenClawStateDatabase();

        const restoredDatabasePath = path.join(extractDir, databaseEntry);
        const restoredStateDir = path.dirname(path.dirname(restoredDatabasePath));
        try {
          const restoredDetection = detectLegacyAuditLogs({
            stateDir: restoredStateDir,
            doctorOnlyStateMigrations: true,
          });
          expect(restoredDetection.hasLegacy).toBe(true);
          await migrateLegacyAuditLogs({
            detected: restoredDetection,
            stateDir: restoredStateDir,
          });
          const restoredEntries = createSqliteAuditRecordStore({
            scope: CONFIG_AUDIT_SCOPE,
            maxEntries: CONFIG_AUDIT_MAX_ENTRIES,
            env: { ...process.env, OPENCLAW_STATE_DIR: restoredStateDir },
          }).entries();
          expect(restoredEntries).toHaveLength(2);
          expect(new Set(restoredEntries.map((entry) => entry.key)).size).toBe(2);
          expect(restoredEntries.map((entry) => entry.value)).toEqual([record, record]);
        } finally {
          closeOpenClawStateDatabaseByPath(restoredDatabasePath);
        }
      },
    );
  });

  it("scrubs transient SQLite queue and plugin blob rows from archive snapshots", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-sqlite-queue-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const extractDir = state.path("extract");
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(extractDir, { recursive: true });
        const { db } = openOpenClawStateDatabase({ env: state.env });
        db.prepare(
          `
            INSERT INTO delivery_queue_entries (
              queue_name, id, status, retry_count, entry_json, enqueued_at, updated_at
            ) VALUES ('outbound', 'queued-1', 'pending', 0, '{"id":"queued-1"}', 10, 10)
          `,
        ).run();
        const transientBlobMarker = `transient-diffs-blob-${"sensitive".repeat(32)}`;
        const durableBlobMarker = "durable-plugin-blob-control";
        const insertPluginBlob = db.prepare(
          `
            INSERT INTO plugin_blob_entries (
              plugin_id, namespace, entry_key, metadata_json, blob, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
        );
        insertPluginBlob.run(
          "diffs",
          "viewer-artifacts",
          "transient",
          JSON.stringify({ marker: transientBlobMarker }),
          Buffer.from(`<html>${transientBlobMarker}</html>`),
          10,
          Date.UTC(2099, 0, 1),
        );
        insertPluginBlob.run(
          "durable-plugin",
          "documents",
          "durable",
          JSON.stringify({ kind: "durable" }),
          Buffer.from(durableBlobMarker),
          10,
          null,
        );
        db.prepare(
          `
            INSERT INTO state_leases (
              scope, lease_key, owner, expires_at, heartbeat_at,
              payload_json, created_at, updated_at
            ) VALUES ('plugin:memory-core:qmd', 'embed', 'worker', 9999999999999, 10, NULL, 10, 10)
          `,
        ).run();

        try {
          const result = await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 4, 9, 8, 30, 0),
          });
          const entries = await listArchiveEntries(result.archivePath);
          const archivedDbEntry = entries.find((entry) =>
            entry.endsWith("/state/state/openclaw.sqlite"),
          );
          expect(archivedDbEntry).toBeDefined();
          expect(entries.some((entry) => entry.endsWith("/state/state/openclaw.sqlite-wal"))).toBe(
            false,
          );

          await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
          const sqlite = requireNodeSqlite();
          const archivedDb = new sqlite.DatabaseSync(path.join(extractDir, archivedDbEntry!), {
            readOnly: true,
          });
          try {
            expect(
              archivedDb.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get(),
            ).toEqual({ count: 0 });
            expect(
              archivedDb
                .prepare(
                  "SELECT plugin_id, entry_key FROM plugin_blob_entries ORDER BY plugin_id, entry_key",
                )
                .all(),
            ).toEqual([{ plugin_id: "durable-plugin", entry_key: "durable" }]);
            expect(archivedDb.prepare("SELECT COUNT(*) AS count FROM state_leases").get()).toEqual({
              count: 0,
            });
          } finally {
            archivedDb.close();
          }
          const archivedBytes = await fs.readFile(path.join(extractDir, archivedDbEntry!));
          expect(archivedBytes.includes(transientBlobMarker)).toBe(false);
          expect(archivedBytes.includes(durableBlobMarker)).toBe(true);

          expect(db.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get()).toEqual({
            count: 1,
          });
          expect(
            db
              .prepare(
                "SELECT plugin_id, entry_key FROM plugin_blob_entries ORDER BY plugin_id, entry_key",
              )
              .all(),
          ).toEqual([
            { plugin_id: "diffs", entry_key: "transient" },
            { plugin_id: "durable-plugin", entry_key: "durable" },
          ]);
          expect(db.prepare("SELECT COUNT(*) AS count FROM state_leases").get()).toEqual({
            count: 1,
          });
        } finally {
          closeOpenClawStateDatabase();
        }
      },
    );
  });

  it("rejects stale secondary indexes before creating a backup archive", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-unsafe-index-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        await fs.mkdir(outputDir, { recursive: true });
        openOpenClawStateDatabase({ env: state.env });
        closeOpenClawStateDatabase();
        createUnsafeIndexDrift(resolveOpenClawStateSqlitePath(state.env));

        await expect(
          createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 4, 9, 8, 30, 30),
          }),
        ).rejects.toThrow(
          /integrity_check failed.*missing from index unsafe_index_records_value/iu,
        );
        expect(await fs.readdir(outputDir)).toEqual([]);
      },
    );
  });

  it("rejects foreign-key violations before creating a backup archive", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-foreign-key-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        await fs.mkdir(outputDir, { recursive: true });
        openOpenClawStateDatabase({ env: state.env });
        closeOpenClawStateDatabase();

        const sqlite = requireNodeSqlite();
        const database = new sqlite.DatabaseSync(resolveOpenClawStateSqlitePath(state.env));
        try {
          database.exec("PRAGMA foreign_keys = OFF;");
          database
            .prepare("INSERT INTO task_delivery_state (task_id) VALUES (?)")
            .run("missing-task");
          expect(database.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
          expect(database.prepare("PRAGMA integrity_check").get()).toEqual({
            integrity_check: "ok",
          });
        } finally {
          database.close();
        }

        await expect(
          createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 4, 9, 8, 30, 30),
          }),
        ).rejects.toThrow(
          /foreign_key_check failed.*task_delivery_state row 1 references task_runs \(foreign key 0\)/iu,
        );
        expect(await fs.readdir(outputDir)).toEqual([]);
      },
    );
  });

  it("snapshots per-agent SQLite auth stores without deleted secret pages", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-agent-sqlite-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const extractDir = state.path("extract");
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(extractDir, { recursive: true });
        saveAuthProfileStore(
          {
            version: 1,
            profiles: {
              "openai:default": {
                type: "api_key",
                provider: "openai",
                key: "sk-backup",
              },
            },
          },
          state.agentDir(),
          { syncExternalCli: false },
        );
        closeOpenClawAgentDatabasesForTest();
        const sqlite = requireNodeSqlite();
        const liveDbPath = path.join(state.agentDir(), "openclaw-agent.sqlite");
        const deletedSecretMarker = "OPENCLAW_DELETED_SECRET_PAGE_MARKER";
        const deletedSecret = `${deletedSecretMarker}-${"x".repeat(16_384)}`;
        const liveDb = new sqlite.DatabaseSync(liveDbPath);
        try {
          liveDb.exec("PRAGMA secure_delete = OFF; CREATE TABLE deleted_secrets (value TEXT)");
          liveDb.prepare("INSERT INTO deleted_secrets (value) VALUES (?)").run(deletedSecret);
          liveDb
            .prepare("INSERT INTO deleted_secrets (value) VALUES (?)")
            .run(`keeper-${"y".repeat(16_384)}`);
          liveDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          liveDb.prepare("DELETE FROM deleted_secrets WHERE value = ?").run(deletedSecret);
          liveDb
            .prepare(
              `
                INSERT INTO state_leases (
                  scope, lease_key, owner, expires_at, heartbeat_at,
                  payload_json, created_at, updated_at
                ) VALUES ('plugin:memory-core:qmd', 'write', 'worker', 9999999999999, 1, NULL, 1, 1)
              `,
            )
            .run();
        } finally {
          liveDb.close();
        }
        expect((await fs.readFile(liveDbPath)).includes(Buffer.from(deletedSecretMarker))).toBe(
          true,
        );

        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: Date.UTC(2026, 4, 9, 8, 31, 0),
        });
        const entries = await listArchiveEntries(result.archivePath);
        const archivedDbEntry = entries.find((entry) =>
          entry.endsWith("/state/agents/main/agent/openclaw-agent.sqlite"),
        );
        expect(archivedDbEntry).toBeDefined();
        expect(
          entries.some((entry) =>
            entry.endsWith("/state/agents/main/agent/openclaw-agent.sqlite-wal"),
          ),
        ).toBe(false);

        await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
        const extractedPath = path.join(extractDir, archivedDbEntry!);
        expect((await fs.stat(extractedPath)).mode & 0o777).toBe(0o600);
        expect((await fs.readFile(extractedPath)).includes(Buffer.from(deletedSecretMarker))).toBe(
          false,
        );
        const archivedDb = new sqlite.DatabaseSync(extractedPath, {
          readOnly: true,
        });
        try {
          const row = archivedDb
            .prepare("SELECT store_json FROM auth_profile_store WHERE store_key = 'primary'")
            .get() as { store_json: string };
          expect(JSON.parse(row.store_json).profiles["openai:default"]).toMatchObject({
            type: "api_key",
            provider: "openai",
            key: "sk-backup",
          });
          expect(archivedDb.prepare("SELECT COUNT(*) AS count FROM state_leases").get()).toEqual({
            count: 0,
          });
        } finally {
          archivedDb.close();
        }
        const sourceDb = new sqlite.DatabaseSync(liveDbPath, { readOnly: true });
        try {
          expect(sourceDb.prepare("SELECT COUNT(*) AS count FROM state_leases").get()).toEqual({
            count: 1,
          });
        } finally {
          sourceDb.close();
        }
      },
    );
  });

  it("snapshots and verifies a canonical agent database when the agent id is node_modules", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-agent-node-modules-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const extractDir = state.path("extract");
        const dbPath = state.statePath("agents", "node_modules", "agent", "openclaw-agent.sqlite");
        await fs.mkdir(path.dirname(dbPath), { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(extractDir, { recursive: true });
        const sqlite = requireNodeSqlite();
        const db = new sqlite.DatabaseSync(dbPath);
        try {
          db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA wal_autocheckpoint = 0;
            CREATE TABLE schema_meta (
              meta_key TEXT NOT NULL PRIMARY KEY,
              role TEXT NOT NULL,
              schema_version INTEGER NOT NULL,
              agent_id TEXT
            );
            INSERT INTO schema_meta (meta_key, role, schema_version, agent_id)
            VALUES ('primary', 'agent', 1, 'node_modules');
            PRAGMA user_version = 1;
            CREATE TABLE markers (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
            PRAGMA wal_checkpoint(TRUNCATE);
            INSERT INTO markers (value) VALUES ('committed-in-wal');
          `);
          await expect(fs.access(`${dbPath}-wal`)).resolves.toBeUndefined();

          const result = await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 4, 9, 8, 31, 30),
          });
          const entries = await listArchiveEntries(result.archivePath);
          const archivedDbEntry = entries.find((entry) =>
            entry.endsWith("/state/agents/node_modules/agent/openclaw-agent.sqlite"),
          );
          expect(archivedDbEntry).toBeDefined();
          expect(
            entries.some((entry) =>
              entry.endsWith("/state/agents/node_modules/agent/openclaw-agent.sqlite-wal"),
            ),
          ).toBe(false);

          const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
          await expect(
            backupVerifyCommand(runtime, { archive: result.archivePath }),
          ).resolves.toMatchObject({ ok: true });

          await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
          const archivedDb = new sqlite.DatabaseSync(path.join(extractDir, archivedDbEntry!), {
            readOnly: true,
          });
          try {
            expect(archivedDb.prepare("SELECT value FROM markers").get()).toEqual({
              value: "committed-in-wal",
            });
          } finally {
            archivedDb.close();
          }
        } finally {
          db.close();
        }
      },
    );
  });

  it.each([
    {
      name: "global",
      kind: "global" as const,
    },
    {
      name: "agent",
      kind: "agent" as const,
    },
  ])("rejects a zero-byte canonical $name database", async ({ kind }) => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-zero-byte-canonical-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const dbPath = resolveCanonicalTestSqlitePath(state, kind);
        await fs.mkdir(path.dirname(dbPath), { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        await fs.writeFile(dbPath, "");

        await expect(
          createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 6, 24, 9, 0, 0),
          }),
        ).rejects.toThrow(/snapshot source must not be empty/iu);
        expect((await fs.stat(dbPath)).size).toBe(0);
        expect(await fs.readdir(outputDir)).toEqual([]);
      },
    );
  });

  it.each([
    {
      name: "global",
      kind: "global" as const,
    },
    {
      name: "agent",
      kind: "agent" as const,
    },
  ])("rejects a schema-empty canonical $name database", async ({ kind }) => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-schema-empty-canonical-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const dbPath = resolveCanonicalTestSqlitePath(state, kind);
        await fs.mkdir(path.dirname(dbPath), { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        createEmptySqliteDatabase(dbPath);

        await expect(
          createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 6, 24, 9, 1, 0),
          }),
        ).rejects.toThrow(/schema role missing|no schema ownership metadata/iu);
        const sqlite = requireNodeSqlite();
        const database = new sqlite.DatabaseSync(dbPath, { readOnly: true });
        try {
          expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
          expect(
            database
              .prepare(
                "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'",
              )
              .get(),
          ).toEqual({ count: 0 });
        } finally {
          database.close();
        }
        expect(await fs.readdir(outputDir)).toEqual([]);
      },
    );
  });

  it.each([
    {
      name: "global database with agent role",
      kind: "global" as const,
      role: "agent" as const,
      agentId: "main",
      expected: /schema role agent; expected global/iu,
    },
    {
      name: "agent database with global role",
      kind: "agent" as const,
      role: "global" as const,
      expected: /schema role global; expected agent/iu,
    },
    {
      name: "agent database with a different owner",
      kind: "agent" as const,
      role: "agent" as const,
      agentId: "worker",
      expected: /belongs to agent worker; requested agent main/iu,
    },
    {
      name: "agent database with a noncanonical owner spelling",
      kind: "agent" as const,
      role: "agent" as const,
      agentId: "Main",
      expected: /belongs to agent Main; requested agent main/iu,
    },
  ])("rejects a canonical $name", async ({ kind, role, agentId, expected }) => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-wrong-owner-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const dbPath = resolveCanonicalTestSqlitePath(state, kind);
        await fs.mkdir(path.dirname(dbPath), { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        createOwnedSqliteDatabase({ sqlitePath: dbPath, role, agentId });

        await expect(
          createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 6, 24, 9, 2, 0),
          }),
        ).rejects.toThrow(expected);
        expect(await fs.readdir(outputDir)).toEqual([]);
      },
    );
  });

  it("rejects a canonical agent database under a noncanonical agent path", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-noncanonical-agent-path-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const dbPath = state.statePath("agents", "Main", "agent", "openclaw-agent.sqlite");
        await fs.mkdir(path.dirname(dbPath), { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        createOwnedSqliteDatabase({
          sqlitePath: dbPath,
          role: "agent",
          agentId: "main",
        });

        await expect(
          createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 6, 24, 9, 2, 30),
          }),
        ).rejects.toThrow(/noncanonical agent owner Main/iu);
        expect(await fs.readdir(outputDir)).toEqual([]);
      },
    );
  });

  it("validates hard-linked canonical agent paths against each path owner", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-hardlinked-agent-owners-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const mainDbPath = state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
        const workerDbPath = state.statePath("agents", "worker", "agent", "openclaw-agent.sqlite");
        await fs.mkdir(path.dirname(mainDbPath), { recursive: true });
        await fs.mkdir(path.dirname(workerDbPath), { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        createOwnedSqliteDatabase({
          sqlitePath: mainDbPath,
          role: "agent",
          agentId: "main",
        });
        await fs.link(mainDbPath, workerDbPath);

        await expect(
          createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 6, 24, 9, 2, 45),
          }),
        ).rejects.toThrow(/belongs to agent main; requested agent worker/iu);
        expect(await fs.readdir(outputDir)).toEqual([]);
      },
    );
  });

  it("does not treat a canonical agent path as an alias of the global database", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-hardlinked-global-agent-owners-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const globalDbPath = resolveCanonicalTestSqlitePath(state, "global");
        const agentDbPath = resolveCanonicalTestSqlitePath(state, "agent");
        await fs.mkdir(path.dirname(globalDbPath), { recursive: true });
        await fs.mkdir(path.dirname(agentDbPath), { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        createOwnedSqliteDatabase({
          sqlitePath: globalDbPath,
          role: "global",
        });
        await fs.link(globalDbPath, agentDbPath);

        await expect(
          createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 6, 24, 9, 2, 50),
          }),
        ).rejects.toThrow(/schema role global; expected agent/iu);
        expect(await fs.readdir(outputDir)).toEqual([]);
      },
    );
  });

  it.runIf(process.platform !== "win32")(
    "fails closed when a canonical SQLite symlink retargets after discovery",
    async () => {
      await withOpenClawTestState(
        {
          layout: "state-only",
          prefix: "openclaw-backup-canonical-symlink-retarget-",
          scenario: "minimal",
        },
        async (state) => {
          const outputDir = state.path("backups");
          const canonicalDbPath = resolveCanonicalTestSqlitePath(state, "global");
          const firstDbPath = state.statePath("state", "first-global.sqlite");
          const secondDbPath = state.statePath("state", "second-global.sqlite");
          await fs.mkdir(path.dirname(canonicalDbPath), { recursive: true });
          await fs.mkdir(outputDir, { recursive: true });
          createOwnedSqliteDatabase({
            sqlitePath: firstDbPath,
            role: "global",
          });
          createOwnedSqliteDatabase({
            sqlitePath: secondDbPath,
            role: "global",
          });
          await fs.symlink(firstDbPath, canonicalDbPath);

          const originalRealpath = fs.realpath.bind(fs);
          let retargeted = false;
          const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (target) => {
            const resolved = await originalRealpath(target);
            if (!retargeted && path.resolve(String(target)) === path.resolve(canonicalDbPath)) {
              retargeted = true;
              await fs.unlink(canonicalDbPath);
              await fs.symlink(secondDbPath, canonicalDbPath);
            }
            return resolved;
          });

          try {
            await expect(
              createBackupArchive({
                output: outputDir,
                includeWorkspace: false,
                nowMs: Date.UTC(2026, 6, 24, 9, 2, 55),
              }),
            ).rejects.toThrow(/Canonical SQLite path changed after discovery/iu);
            expect(retargeted).toBe(true);
            expect(await fs.readdir(outputDir)).toEqual([]);
          } finally {
            realpathSpy.mockRestore();
          }
        },
      );
    },
  );

  it("backs up older owned canonical databases and a generic schema-empty plugin database", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-owned-older-schema-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const globalDbPath = resolveCanonicalTestSqlitePath(state, "global");
        const agentDbPath = resolveCanonicalTestSqlitePath(state, "agent");
        const pluginDbPath = state.statePath("plugins", "dedicated", "empty.sqlite");
        for (const dbPath of [globalDbPath, agentDbPath, pluginDbPath]) {
          await fs.mkdir(path.dirname(dbPath), { recursive: true });
        }
        await fs.mkdir(outputDir, { recursive: true });
        createOwnedSqliteDatabase({
          sqlitePath: globalDbPath,
          role: "global",
          schemaVersion: 1,
        });
        createOwnedSqliteDatabase({
          sqlitePath: agentDbPath,
          role: "agent",
          agentId: "main",
          schemaVersion: 1,
        });
        createEmptySqliteDatabase(pluginDbPath);

        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: Date.UTC(2026, 6, 24, 9, 3, 0),
        });
        const entries = await listArchiveEntries(result.archivePath);
        expect(entries.some((entry) => entry.endsWith("/state/state/openclaw.sqlite"))).toBe(true);
        expect(
          entries.some((entry) => entry.endsWith("/state/agents/main/agent/openclaw-agent.sqlite")),
        ).toBe(true);
        expect(
          entries.some((entry) => entry.endsWith("/state/plugins/dedicated/empty.sqlite")),
        ).toBe(true);

        const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        await expect(
          backupVerifyCommand(runtime, { archive: result.archivePath }),
        ).resolves.toMatchObject({ ok: true });

        const sqlite = requireNodeSqlite();
        for (const dbPath of [globalDbPath, agentDbPath]) {
          const database = new sqlite.DatabaseSync(dbPath, { readOnly: true });
          try {
            expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
            expect(
              database
                .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
                .get(),
            ).toEqual({ schema_version: 1 });
          } finally {
            database.close();
          }
        }
      },
    );
  });

  it("snapshots nested live SQLite databases with transaction continuity", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-nested-sqlite-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const extractDir = state.path("extract");
        const dbPath = state.statePath("plugins", "dedicated", "live.sqlite");
        await fs.mkdir(path.dirname(dbPath), { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(extractDir, { recursive: true });
        const sqlite = requireNodeSqlite();
        const db = new sqlite.DatabaseSync(dbPath);
        db.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA wal_autocheckpoint = 0;
          CREATE TABLE backup_meta (
            id INTEGER PRIMARY KEY,
            last_seq INTEGER NOT NULL
          );
          CREATE TABLE backup_markers (
            seq INTEGER PRIMARY KEY,
            transaction_id INTEGER NOT NULL
          );
          CREATE TABLE delivery_queue_entries (
            id TEXT PRIMARY KEY
          );
          CREATE TABLE state_leases (
            scope TEXT NOT NULL,
            lease_key TEXT NOT NULL
          );
          INSERT INTO backup_meta (id, last_seq) VALUES (1, 0);
          INSERT INTO delivery_queue_entries (id) VALUES ('must-stay');
          INSERT INTO state_leases (scope, lease_key) VALUES ('plugin-owned', 'must-stay');
          PRAGMA wal_checkpoint(TRUNCATE);
          BEGIN IMMEDIATE;
          INSERT INTO backup_markers (seq, transaction_id) VALUES (1, 7), (2, 7), (3, 7);
          UPDATE backup_meta SET last_seq = 3 WHERE id = 1;
          COMMIT;
        `);
        await fs.writeFile(`${dbPath}-journal`, "");

        try {
          await expect(fs.access(`${dbPath}-wal`)).resolves.toBeUndefined();
          await expect(fs.access(`${dbPath}-shm`)).resolves.toBeUndefined();
          const result = await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 4, 9, 8, 32, 0),
          });
          const entries = await listArchiveEntries(result.archivePath);
          const archivedDbEntries = entries.filter((entry) =>
            entry.endsWith("/state/plugins/dedicated/live.sqlite"),
          );
          expect(archivedDbEntries).toHaveLength(1);
          for (const suffix of ["-wal", "-shm", "-journal"]) {
            expect(
              entries.some((entry) =>
                entry.endsWith(`/state/plugins/dedicated/live.sqlite${suffix}`),
              ),
              suffix,
            ).toBe(false);
          }

          await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
          const archivedDb = new sqlite.DatabaseSync(
            path.join(
              extractDir,
              expectDefined(archivedDbEntries[0], "archivedDbEntries[0] test invariant"),
            ),
            {
              readOnly: true,
            },
          );
          try {
            expect(archivedDb.prepare("PRAGMA integrity_check").get()).toEqual({
              integrity_check: "ok",
            });
            expect(
              archivedDb.prepare("SELECT last_seq FROM backup_meta WHERE id = 1").get(),
            ).toEqual({ last_seq: 3 });
            expect(
              archivedDb
                .prepare(
                  "SELECT COUNT(*) AS count, MIN(seq) AS min_seq, MAX(seq) AS max_seq FROM backup_markers",
                )
                .get(),
            ).toEqual({ count: 3, min_seq: 1, max_seq: 3 });
            expect(
              archivedDb.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get(),
            ).toEqual({ count: 1 });
            expect(archivedDb.prepare("SELECT COUNT(*) AS count FROM state_leases").get()).toEqual({
              count: 1,
            });
          } finally {
            archivedDb.close();
          }
        } finally {
          db.close();
        }
      },
    );
  });

  it("fails closed when a plugin SQLite schema cannot be compacted safely", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-plugin-capability-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const dbPath = state.statePath("plugins", "dedicated", "custom.sqlite");
        await fs.mkdir(path.dirname(dbPath), { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        const sqlite = requireNodeSqlite();
        const db = new sqlite.DatabaseSync(dbPath);
        db.function("plugin_double", { deterministic: true }, (value) => Number(value) * 2);
        db.exec(`
          CREATE TABLE records (value INTEGER NOT NULL);
          INSERT INTO records (value) VALUES (1), (2);
          CREATE INDEX records_double ON records(plugin_double(value));
        `);
        db.close();

        await expect(
          createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 4, 9, 8, 33, 0),
          }),
        ).rejects.toThrow(/cannot be compacted safely.*custom\.sqlite/iu);
      },
    );
  });

  it("scrubs deleted plugin SQLite bytes from archive snapshots", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-plugin-deleted-bytes-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const extractDir = state.path("extract");
        const dbPath = state.statePath("plugins", "dedicated", "deleted.sqlite");
        const deletedValue = `deleted-plugin-secret-${"x".repeat(256)}`;
        await fs.mkdir(path.dirname(dbPath), { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(extractDir, { recursive: true });
        const sqlite = requireNodeSqlite();
        const db = new sqlite.DatabaseSync(dbPath);
        db.exec("PRAGMA secure_delete = OFF; CREATE TABLE records (value TEXT NOT NULL);");
        const insert = db.prepare("INSERT INTO records (value) VALUES (?)");
        insert.run("survivor");
        insert.run(deletedValue);
        db.prepare("DELETE FROM records WHERE value = ?").run(deletedValue);
        db.close();

        expect((await fs.readFile(dbPath)).includes(deletedValue)).toBe(true);
        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: Date.UTC(2026, 4, 9, 8, 34, 0),
        });
        const entries = await listArchiveEntries(result.archivePath);
        const archivedDbEntry = entries.find((entry) =>
          entry.endsWith("/state/plugins/dedicated/deleted.sqlite"),
        );
        expect(archivedDbEntry).toBeDefined();

        await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
        const archivedPath = path.join(extractDir, archivedDbEntry!);
        expect((await fs.readFile(archivedPath)).includes(deletedValue)).toBe(false);
        const archivedDb = new sqlite.DatabaseSync(archivedPath, { readOnly: true });
        try {
          expect(archivedDb.prepare("SELECT value FROM records").all()).toEqual([
            { value: "survivor" },
          ]);
        } finally {
          archivedDb.close();
        }
      },
    );
  });

  it("fails instead of raw-copying malformed nested SQLite databases", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-malformed-sqlite-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const dbPath = state.statePath("plugins", "dedicated", "malformed.sqlite");
        await fs.mkdir(path.dirname(dbPath), { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        await fs.writeFile(dbPath, "not a sqlite database", "utf8");

        await expect(
          createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 4, 9, 8, 33, 0),
          }),
        ).rejects.toThrow(/file is not a database|malformed/i);
      },
    );
  });

  it.each(["late.sqlite", "late.sqlite-wal"])(
    "fails when SQLite-looking state appears after snapshot discovery: %s",
    async (lateName) => {
      await withOpenClawTestState(
        {
          layout: "state-only",
          prefix: "openclaw-backup-late-sqlite-",
          scenario: "minimal",
        },
        async (state) => {
          const outputDir = state.path("backups");
          const latePath = state.statePath(lateName);
          await fs.mkdir(outputDir, { recursive: true });

          const originalReaddir = fs.readdir.bind(fs);
          let createdLatePath = false;
          let stagedArchiveCleanupAttempts = 0;
          const readdirSpy = vi.spyOn(fs, "readdir").mockImplementation((async (
            ...args: unknown[]
          ) => {
            const entries = await (
              originalReaddir as (...readdirArgs: unknown[]) => Promise<unknown>
            )(...args);
            if (
              !createdLatePath &&
              path.resolve(String(args[0])) === path.resolve(state.stateDir)
            ) {
              createdLatePath = true;
              await fs.writeFile(latePath, "late SQLite state");
            }
            return entries;
          }) as typeof fs.readdir);
          const originalUnlinkSync = fsSync.unlinkSync.bind(fsSync);
          const unlinkSpy = vi.spyOn(fsSync, "unlinkSync").mockImplementation((target) => {
            const targetPath = path.resolve(String(target));
            if (
              targetPath.startsWith(path.resolve(outputDir)) &&
              targetPath.includes(".openclaw-backup-publish-")
            ) {
              stagedArchiveCleanupAttempts += 1;
              if (stagedArchiveCleanupAttempts === 1) {
                throw Object.assign(new Error("busy"), { code: "EBUSY" });
              }
            }
            return originalUnlinkSync(target);
          });

          try {
            await expect(
              createBackupArchive({
                output: outputDir,
                includeWorkspace: false,
                nowMs: Date.UTC(2026, 4, 9, 8, 33, 30),
              }),
            ).rejects.toThrow(/SQLite state appeared after snapshot discovery/);
            expect(createdLatePath).toBe(true);
            expect(stagedArchiveCleanupAttempts).toBeGreaterThanOrEqual(2);
            expect(await fs.readdir(outputDir)).toEqual([]);
          } finally {
            unlinkSpy.mockRestore();
            readdirSpy.mockRestore();
          }
        },
      );
    },
  );

  it("omits pre-existing orphan SQLite sidecars without failing backup", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-orphan-sqlite-sidecars-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const orphanPath = state.statePath("plugins", "dedicated", "orphan.sqlite");
        await fs.mkdir(path.dirname(orphanPath), { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        for (const suffix of ["-wal", "-shm", "-journal"]) {
          await fs.writeFile(`${orphanPath}${suffix}`, "orphan SQLite sidecar");
        }

        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: Date.UTC(2026, 4, 9, 8, 33, 45),
        });
        const entries = await listArchiveEntries(result.archivePath);
        for (const suffix of ["-wal", "-shm", "-journal"]) {
          expect(
            entries.some((entry) =>
              entry.endsWith(`/state/plugins/dedicated/orphan.sqlite${suffix}`),
            ),
            suffix,
          ).toBe(false);
        }
      },
    );
  });

  it("omits transient memory reindex databases and sidecars", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-memory-reindex-lock-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const transientPaths = [
          state.statePath("memory", "main.sqlite.reindex-lock.sqlite"),
          state.statePath("memory", "main.sqlite.tmp-11111111-2222-3333-4444-555555555555"),
          state.statePath("memory", "main.sqlite.backup-66666666-7777-8888-9999-aaaaaaaaaaaa"),
          state.statePath(
            "agents",
            "main",
            "agent.sqlite.memory-reindex-bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
          ),
        ];
        await fs.mkdir(outputDir, { recursive: true });
        for (const transientPath of transientPaths) {
          await fs.mkdir(path.dirname(transientPath), { recursive: true });
          for (const suffix of ["", "-wal", "-shm", "-journal"]) {
            await fs.writeFile(`${transientPath}${suffix}`, "transient reindex database");
          }
        }

        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: Date.UTC(2026, 4, 9, 8, 34, 0),
        });
        const entries = await listArchiveEntries(result.archivePath);
        for (const transientPath of transientPaths) {
          const relativeTransientPath = path
            .relative(state.stateDir, transientPath)
            .split(path.sep)
            .join("/");
          for (const suffix of ["", "-wal", "-shm", "-journal"]) {
            expect(
              entries.some((entry) => entry.endsWith(`/state/${relativeTransientPath}${suffix}`)),
              `${relativeTransientPath}${suffix}`,
            ).toBe(false);
          }
        }
      },
    );
  });

  it("preserves noncanonical symlinked SQLite paths without dereferencing them", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-symlinked-sqlite-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const externalDbPath = state.path("external-malformed.sqlite");
        const linkedDbPath = state.statePath("plugins", "dedicated", "linked.sqlite");
        await fs.mkdir(path.dirname(linkedDbPath), { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        await fs.writeFile(externalDbPath, "not a sqlite database", "utf8");
        await fs.symlink(externalDbPath, linkedDbPath);

        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: Date.UTC(2026, 4, 9, 8, 34, 0),
        });
        const entries = await listArchiveEntryDetails(result.archivePath);
        expect(
          entries.find((entry) => entry.path.endsWith("/state/plugins/dedicated/linked.sqlite")),
        ).toMatchObject({ type: "SymbolicLink" });
        const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        await expect(
          backupVerifyCommand(runtime, { archive: result.archivePath }),
        ).resolves.toMatchObject({ ok: true });
      },
    );
  });

  it("sanitizes every in-state symlink and hardlink alias of the canonical global SQLite DB", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-global-sqlite-symlink-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const extractDir = state.path("extract");
        const backingDbPath = state.statePath("state", "backing-global.sqlite");
        const linkedDbPath = state.statePath("state", "openclaw.sqlite");
        const hardlinkedDbPath = state.statePath("state", "hardlinked-global.sqlite");
        await state.writeConfig({
          agents: {
            entries: { main: { default: true, workspace: state.workspaceDir } },
          },
        });
        await fs.mkdir(path.dirname(linkedDbPath), { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(extractDir, { recursive: true });
        const sqlite = requireNodeSqlite();
        const transientBlobMarker = `aliased-transient-blob-${"sensitive".repeat(32)}`;
        const db = new sqlite.DatabaseSync(backingDbPath);
        db.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA wal_autocheckpoint = 0;
          CREATE TABLE durable_state (
            id INTEGER PRIMARY KEY,
            value TEXT NOT NULL
          );
          CREATE TABLE delivery_queue_entries (
            id TEXT PRIMARY KEY
          );
          CREATE TABLE plugin_blob_entries (
            plugin_id TEXT NOT NULL,
            namespace TEXT NOT NULL,
            entry_key TEXT NOT NULL,
            metadata_json TEXT NOT NULL,
            blob BLOB NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER,
            PRIMARY KEY (plugin_id, namespace, entry_key)
          );
          CREATE TABLE schema_meta (
            meta_key TEXT NOT NULL PRIMARY KEY,
            role TEXT NOT NULL,
            schema_version INTEGER NOT NULL,
            agent_id TEXT
          );
          INSERT INTO schema_meta (meta_key, role, schema_version, agent_id)
          VALUES ('primary', 'global', 1, NULL);
          PRAGMA user_version = 1;
          PRAGMA wal_checkpoint(TRUNCATE);
          INSERT INTO durable_state (id, value) VALUES (1, 'must-stay');
          INSERT INTO delivery_queue_entries (id) VALUES ('must-drop');
        `);
        db.prepare(
          `INSERT INTO plugin_blob_entries
            (plugin_id, namespace, entry_key, metadata_json, blob, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          "diffs",
          "diff-artifacts",
          "transient",
          JSON.stringify({ marker: transientBlobMarker }),
          Buffer.from(transientBlobMarker),
          1,
          Date.UTC(2099, 0, 1),
        );
        await fs.symlink(backingDbPath, linkedDbPath);
        await fs.link(backingDbPath, hardlinkedDbPath);
        expect((await fs.stat(`${backingDbPath}-wal`)).size).toBeGreaterThan(0);
        await expect(fs.stat(`${hardlinkedDbPath}-wal`)).rejects.toMatchObject({ code: "ENOENT" });

        try {
          const result = await createBackupArchive({
            output: outputDir,
            includeWorkspace: true,
            nowMs: Date.UTC(2026, 4, 9, 8, 34, 30),
          });
          const entries = await listArchiveEntryDetails(result.archivePath);
          const archivedDbEntries = entries.filter(
            (entry) =>
              entry.path.endsWith("/state/state/openclaw.sqlite") ||
              entry.path.endsWith("/state/state/backing-global.sqlite") ||
              entry.path.endsWith("/state/state/hardlinked-global.sqlite"),
          );
          expect(archivedDbEntries).toEqual([
            expect.objectContaining({
              type: "File",
            }),
            expect.objectContaining({
              type: "File",
            }),
            expect.objectContaining({
              type: "File",
            }),
          ]);

          await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
          for (const archivedDbEntry of archivedDbEntries) {
            const archivedPath = path.join(extractDir, archivedDbEntry.path);
            expect((await fs.readFile(archivedPath)).includes(transientBlobMarker)).toBe(false);
            const archivedDb = new sqlite.DatabaseSync(archivedPath, { readOnly: true });
            try {
              expect(archivedDb.prepare("PRAGMA integrity_check").get()).toEqual({
                integrity_check: "ok",
              });
              expect(
                archivedDb.prepare("SELECT value FROM durable_state WHERE id = 1").get(),
              ).toEqual({ value: "must-stay" });
              expect(
                archivedDb.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get(),
              ).toEqual({ count: 0 });
              expect(
                archivedDb.prepare("SELECT COUNT(*) AS count FROM plugin_blob_entries").get(),
              ).toEqual({ count: 0 });
            } finally {
              archivedDb.close();
            }
          }

          const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
          const verification = await backupVerifyCommand(runtime, { archive: result.archivePath });
          expect(verification.ok).toBe(true);
        } finally {
          db.close();
        }
      },
    );
  });

  it("sanitizes every in-state symlink and hardlink alias of a canonical agent SQLite DB", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-agent-sqlite-alias-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const extractDir = state.path("extract");
        const agentDir = state.statePath("agents", "main", "agent");
        const backingDbPath = path.join(agentDir, "backing-agent.sqlite");
        const linkedDbPath = path.join(agentDir, "openclaw-agent.sqlite");
        const hardlinkedDbPath = state.statePath("plugins", "dedicated", "agent-alias.sqlite");
        await fs.mkdir(agentDir, { recursive: true });
        await fs.mkdir(path.dirname(hardlinkedDbPath), { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(extractDir, { recursive: true });
        const sqlite = requireNodeSqlite();
        const db = new sqlite.DatabaseSync(backingDbPath);
        db.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA wal_autocheckpoint = 0;
          CREATE TABLE schema_meta (
            meta_key TEXT NOT NULL PRIMARY KEY,
            role TEXT NOT NULL,
            schema_version INTEGER NOT NULL,
            agent_id TEXT
          );
          CREATE TABLE durable_state (
            id INTEGER PRIMARY KEY,
            value TEXT NOT NULL
          );
          CREATE TABLE state_leases (
            scope TEXT NOT NULL,
            lease_key TEXT NOT NULL
          );
          INSERT INTO schema_meta (meta_key, role, schema_version, agent_id)
          VALUES ('primary', 'agent', 1, 'main');
          PRAGMA user_version = 1;
          PRAGMA wal_checkpoint(TRUNCATE);
          INSERT INTO durable_state (id, value) VALUES (1, 'committed-in-wal');
          INSERT INTO state_leases (scope, lease_key) VALUES ('plugin:memory-core:qmd', 'write');
        `);
        await fs.symlink(backingDbPath, linkedDbPath);
        await fs.link(backingDbPath, hardlinkedDbPath);
        expect((await fs.stat(`${backingDbPath}-wal`)).size).toBeGreaterThan(0);
        await expect(fs.stat(`${linkedDbPath}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(`${hardlinkedDbPath}-wal`)).rejects.toMatchObject({ code: "ENOENT" });

        try {
          const result = await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 4, 9, 8, 34, 40),
          });
          const entries = await listArchiveEntryDetails(result.archivePath);
          const archivedDbEntries = entries.filter(
            (entry) =>
              entry.path.endsWith("/state/agents/main/agent/openclaw-agent.sqlite") ||
              entry.path.endsWith("/state/agents/main/agent/backing-agent.sqlite") ||
              entry.path.endsWith("/state/plugins/dedicated/agent-alias.sqlite"),
          );
          expect(archivedDbEntries).toHaveLength(3);
          expect(archivedDbEntries.every((entry) => entry.type === "File")).toBe(true);

          await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
          for (const archivedDbEntry of archivedDbEntries) {
            const archivedDb = new sqlite.DatabaseSync(
              path.join(extractDir, archivedDbEntry.path),
              { readOnly: true },
            );
            try {
              expect(
                archivedDb.prepare("SELECT value FROM durable_state WHERE id = 1").get(),
              ).toEqual({ value: "committed-in-wal" });
              expect(
                archivedDb.prepare("SELECT COUNT(*) AS count FROM state_leases").get(),
              ).toEqual({
                count: 0,
              });
            } finally {
              archivedDb.close();
            }
          }

          expect(db.prepare("SELECT COUNT(*) AS count FROM state_leases").get()).toEqual({
            count: 1,
          });
          const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
          await expect(
            backupVerifyCommand(runtime, { archive: result.archivePath }),
          ).resolves.toMatchObject({ ok: true });
        } finally {
          db.close();
        }
      },
    );
  });

  it("fails when the canonical global SQLite path is not a file", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-global-sqlite-directory-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const globalDbPath = state.statePath("state", "openclaw.sqlite");
        await fs.mkdir(globalDbPath, { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });

        await expect(
          createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 4, 9, 8, 34, 45),
          }),
        ).rejects.toThrow(/Canonical global SQLite path must be a regular file or symlink/);
        expect(await fs.readdir(outputDir)).toEqual([]);
      },
    );
  });

  it("omits reinstallable runtime trees and plugin dependencies while keeping plugin files", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-plugin-deps-",
        scenario: "minimal",
      },
      async (state) => {
        const stateDir = state.stateDir;
        const outputDir = state.path("backups");
        await fs.mkdir(path.join(stateDir, "extensions", "demo", "node_modules", "dep"), {
          recursive: true,
        });
        await fs.mkdir(path.join(stateDir, "extensions", "demo", "src"), { recursive: true });
        await fs.mkdir(path.join(stateDir, "node_modules", "root-dep"), { recursive: true });
        await fs.mkdir(path.join(stateDir, "npm", "projects", "demo", "node_modules", "dep"), {
          recursive: true,
        });
        for (const managedRoot of ["dev", "git", "npm-runtime", "tools"]) {
          await fs.mkdir(path.join(stateDir, managedRoot, "runtime"), { recursive: true });
          await fs.writeFile(
            path.join(stateDir, managedRoot, "runtime", "fixture.sqlite"),
            "reinstallable runtime content\n",
            "utf8",
          );
        }
        await fs.writeFile(
          path.join(stateDir, "extensions", "demo", "openclaw.plugin.json"),
          '{"id":"demo"}\n',
          "utf8",
        );
        await fs.writeFile(
          path.join(stateDir, "extensions", "demo", "src", "index.js"),
          "export default {}\n",
          "utf8",
        );
        await fs.writeFile(
          path.join(stateDir, "extensions", "demo", "node_modules", "dep", "index.js"),
          "module.exports = {}\n",
          "utf8",
        );
        await fs.writeFile(
          path.join(stateDir, "extensions", "demo", "node_modules", "dep", "cache.sqlite"),
          "not a sqlite database",
          "utf8",
        );
        await fs.writeFile(
          path.join(stateDir, "node_modules", "root-dep", "index.js"),
          "module.exports = {}\n",
          "utf8",
        );
        await fs.writeFile(
          path.join(stateDir, "node_modules", "root-dep", "fixture.sqlite"),
          "package-owned sqlite-named asset\n",
          "utf8",
        );
        await fs.writeFile(
          path.join(stateDir, "npm", "projects", "demo", "node_modules", "dep", "fixture.sqlite"),
          "managed-package sqlite-named asset\n",
          "utf8",
        );
        await fs.mkdir(outputDir, { recursive: true });

        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: Date.UTC(2026, 3, 28, 12, 0, 0),
        });
        const entries = await listArchiveEntries(result.archivePath);

        const entrySuffixes = entries.map((entry) => entry.replace(/^.*\/state\//, "/state/"));
        expect(entrySuffixes).toContain("/state/extensions/demo/openclaw.plugin.json");
        expect(entrySuffixes).toContain("/state/extensions/demo/src/index.js");
        expect(entrySuffixes).toContain("/state/node_modules/root-dep/index.js");
        expect(entrySuffixes).toContain("/state/node_modules/root-dep/fixture.sqlite");
        for (const managedRoot of ["dev", "git", "npm", "npm-runtime", "tools"]) {
          expect(
            entrySuffixes.some(
              (entry) =>
                entry === `/state/${managedRoot}` || entry.startsWith(`/state/${managedRoot}/`),
            ),
            managedRoot,
          ).toBe(false);
        }
        const pluginNodeModuleEntries = entries.filter((entry) =>
          entry.includes("/state/extensions/demo/node_modules/"),
        );
        expect(pluginNodeModuleEntries).toStrictEqual([]);

        const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        const verification = await backupVerifyCommand(runtime, { archive: result.archivePath });
        expect(verification.ok).toBe(true);
      },
    );
  });

  it("preserves configured state paths nested under managed runtime roots", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-managed-root-workspace-",
        scenario: "minimal",
        env: { OPENCLAW_OAUTH_DIR: undefined },
      },
      async (state) => {
        const stateDir = state.stateDir;
        const workspaceDir = path.join(stateDir, "dev", "workspace");
        const runtimeDir = path.join(stateDir, "dev", "openclaw");
        const configPath = path.join(stateDir, "git", "config", "openclaw.json");
        const oauthDir = path.join(stateDir, "tools", "oauth");
        const toolRuntimeDir = path.join(stateDir, "tools", "runtime");
        const workspaceDbPath = path.join(workspaceDir, "workspace.sqlite");
        const outputDir = state.path("backups");
        state.envVars.OPENCLAW_CONFIG_PATH = configPath;
        state.envVars.OPENCLAW_OAUTH_DIR = oauthDir;
        state.applyEnv();
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.mkdir(runtimeDir, { recursive: true });
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.mkdir(oauthDir, { recursive: true });
        await fs.mkdir(toolRuntimeDir, { recursive: true });
        await fs.writeFile(
          configPath,
          `${JSON.stringify({
            agents: {
              entries: { main: { default: true, workspace: workspaceDir } },
            },
          })}\n`,
          "utf8",
        );
        await fs.writeFile(path.join(oauthDir, "credentials.json"), "{}\n", "utf8");
        await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "durable workspace\n", "utf8");
        await fs.writeFile(path.join(runtimeDir, "package.json"), "{}\n", "utf8");
        await fs.writeFile(path.join(toolRuntimeDir, "tool.bin"), "runtime\n", "utf8");
        const sqlite = requireNodeSqlite();
        const workspaceDb = new sqlite.DatabaseSync(workspaceDbPath);
        try {
          workspaceDb.exec(
            "CREATE TABLE durable_state (value TEXT NOT NULL); INSERT INTO durable_state VALUES ('keep');",
          );
        } finally {
          workspaceDb.close();
        }
        await fs.mkdir(outputDir, { recursive: true });

        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: true,
          nowMs: Date.UTC(2026, 3, 28, 12, 30, 0),
        });
        const entries = await listArchiveEntries(result.archivePath);

        expect(entries.some((entry) => entry.endsWith("/state/dev/workspace/AGENTS.md"))).toBe(
          true,
        );
        expect(
          entries.some((entry) => entry.endsWith("/state/dev/workspace/workspace.sqlite")),
        ).toBe(true);
        expect(entries.some((entry) => entry.endsWith("/state/git/config/openclaw.json"))).toBe(
          true,
        );
        expect(entries.some((entry) => entry.endsWith("/state/tools/oauth/credentials.json"))).toBe(
          true,
        );
        expect(entries.some((entry) => entry.includes("/state/dev/openclaw/"))).toBe(false);
        expect(entries.some((entry) => entry.includes("/state/tools/runtime/"))).toBe(false);

        const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        await expect(
          backupVerifyCommand(runtime, { archive: result.archivePath }),
        ).resolves.toMatchObject({ ok: true });
      },
    );
  });

  it("dereferences hardlinks instead of emitting restore-hostile Link entries", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-hardlink-",
        scenario: "minimal",
      },
      async (state) => {
        const stateDir = state.stateDir;
        const outputDir = state.path("backups");
        const sourcePath = path.join(stateDir, "workspace-adx", "openclaw-src", "node_modules");
        const targetPath = path.join(sourcePath, "esbuild", "bin", "esbuild");
        const hardlinkPath = path.join(sourcePath, "@esbuild", "darwin-arm64", "bin", "esbuild");
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.mkdir(path.dirname(hardlinkPath), { recursive: true });
        await fs.writeFile(targetPath, "binary fixture\n", "utf8");
        await fs.link(targetPath, hardlinkPath);
        await fs.mkdir(outputDir, { recursive: true });

        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: Date.UTC(2026, 3, 29, 12, 0, 0),
        });
        const entries = await listArchiveEntryDetails(result.archivePath);

        expect(entries.filter((entry) => entry.type === "Link")).toStrictEqual([]);
        expect(entries.some((entry) => entry.path.endsWith("/esbuild/bin/esbuild"))).toBe(true);
        expect(
          entries.some((entry) => entry.path.endsWith("/@esbuild/darwin-arm64/bin/esbuild")),
        ).toBe(true);

        const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        const verification = await backupVerifyCommand(runtime, { archive: result.archivePath });
        expect(verification.ok).toBe(true);
      },
    );
  });

  it("does not duplicate the root manifest when the system tempdir lives inside the state dir", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-tmp-overlap-",
        scenario: "minimal",
      },
      async (state) => {
        const stateDir = state.stateDir;
        const outputDir = state.path("backups");
        const overlappingTmp = path.join(stateDir, "tmp");
        await fs.mkdir(overlappingTmp, { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        const tmpdirSpy = vi.spyOn(os, "tmpdir").mockReturnValue(overlappingTmp);

        try {
          const result = await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 4, 9, 12, 0, 0),
          });
          const entries = await listArchiveEntries(result.archivePath);
          const rootManifestEntries = entries.filter(
            (entry) => entry.endsWith("/manifest.json") && !entry.includes("/payload/"),
          );
          expect(rootManifestEntries).toHaveLength(1);

          const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
          const verification = await backupVerifyCommand(runtime, { archive: result.archivePath });
          expect(verification.ok).toBe(true);
        } finally {
          tmpdirSpy.mockRestore();
        }
      },
    );
  });

  it("does not duplicate the root manifest when the system tempdir is the state dir itself", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-tmp-equals-state-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const emptyDbPath = state.statePath("plugins", "dedicated", "empty.sqlite");
        const extractDir = state.path("extract");
        await fs.mkdir(path.dirname(emptyDbPath), { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(extractDir, { recursive: true });
        await fs.writeFile(emptyDbPath, "");
        const tmpdirSpy = vi.spyOn(os, "tmpdir").mockReturnValue(state.stateDir);

        try {
          const result = await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 4, 9, 12, 0, 0),
          });
          const entries = await listArchiveEntries(result.archivePath);
          const rootManifestEntries = entries.filter(
            (entry) => entry.endsWith("/manifest.json") && !entry.includes("/payload/"),
          );
          expect(rootManifestEntries).toHaveLength(1);
          const emptyDbEntries = entries.filter((entry) =>
            entry.endsWith("/state/plugins/dedicated/empty.sqlite"),
          );
          expect(emptyDbEntries).toHaveLength(1);
          expect(entries.some((entry) => entry.includes("/openclaw-state-db-"))).toBe(false);

          await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
          const sqlite = requireNodeSqlite();
          const archivedDb = new sqlite.DatabaseSync(
            path.join(
              extractDir,
              expectDefined(emptyDbEntries[0], "emptyDbEntries[0] test invariant"),
            ),
            {
              readOnly: true,
            },
          );
          try {
            expect(archivedDb.prepare("PRAGMA integrity_check").get()).toEqual({
              integrity_check: "ok",
            });
          } finally {
            archivedDb.close();
          }

          const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
          const verification = await backupVerifyCommand(runtime, { archive: result.archivePath });
          expect(verification.ok).toBe(true);
        } finally {
          tmpdirSpy.mockRestore();
        }
      },
    );
  });

  describe.runIf(process.platform !== "win32")("archive permissions", () => {
    it("publishes via hard link with owner-only 0o600 permissions", async () => {
      await withOpenClawTestState(
        {
          layout: "state-only",
          prefix: "openclaw-backup-mode-",
          scenario: "minimal",
        },
        async (state) => {
          const outputDir = state.path("backups");
          await fs.mkdir(outputDir, { recursive: true });

          const result = await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 4, 9, 12, 0, 0),
          });

          const stat = await fs.stat(result.archivePath);
          expect(stat.mode & 0o777).toBe(0o600);
        },
      );
    });

    it("fails closed when the destination does not support hard links", async () => {
      const linkSpy = vi
        .spyOn(fs, "link")
        .mockRejectedValue(Object.assign(new Error("hard links unsupported"), { code: "EPERM" }));
      try {
        await withOpenClawTestState(
          {
            layout: "state-only",
            prefix: "openclaw-backup-no-hardlinks-",
            scenario: "minimal",
          },
          async (state) => {
            const outputDir = state.path("backups");
            await fs.mkdir(outputDir, { recursive: true });

            await expect(
              createBackupArchive({
                output: outputDir,
                includeWorkspace: false,
                nowMs: Date.UTC(2026, 4, 9, 12, 0, 0),
              }),
            ).rejects.toThrow(/requires hard-link support/iu);
            await expect(fs.readdir(outputDir)).resolves.toEqual([]);
          },
        );
      } finally {
        linkSpy.mockRestore();
      }
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
