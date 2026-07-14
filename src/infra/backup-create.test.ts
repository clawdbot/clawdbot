// Covers backup archive creation and verification filtering.
import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import * as tar from "tar";
import { describe, expect, it, vi } from "vitest";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import { backupVerifyCommand } from "../commands/backup-verify.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createBackupArchive,
  formatBackupCreateSummary,
  type BackupCreateResult,
} from "./backup-create.js";
import { writeTarArchiveWithRetry } from "./backup-tar-retry.js";
import { isVolatileBackupPath } from "./backup-volatile-filter.js";
import { createBackupVolatileStatCache } from "./backup-volatile-stat-cache.js";
import { requireNodeSqlite } from "./node-sqlite.js";

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

  it("uses a fresh temp archive path when cleanup cannot remove a failed attempt", async () => {
    const eofErr = Object.assign(new Error("did not encounter expected EOF"), {
      path: "/state/sessions/s-abc/transcript.jsonl",
    });
    const tempArchivePath = "/tmp/backup.tar.gz.tmp";
    const runTar = vi
      .fn<(attemptTempArchivePath: string) => Promise<void>>()
      .mockRejectedValueOnce(eofErr)
      .mockResolvedValueOnce(undefined);
    const log = vi.fn();
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async () => {
      throw Object.assign(new Error("resource busy"), { code: "EBUSY" });
    });

    try {
      const completedTempArchivePath = await writeTarArchiveWithRetry({
        tempArchivePath,
        runTar,
        log,
        sleepMs: sleep,
      });

      expect(runTar).toHaveBeenNthCalledWith(1, tempArchivePath);
      expect(runTar).toHaveBeenNthCalledWith(2, `${tempArchivePath}.retry-2`);
      expect(completedTempArchivePath).toBe(`${tempArchivePath}.retry-2`);
      expect(rmSpy).toHaveBeenCalledWith(tempArchivePath, { force: true });
      expect(log).toHaveBeenCalledWith(
        `Backup archiver could not remove temp archive ${tempArchivePath} between retries: EBUSY. Continuing.`,
      );
    } finally {
      rmSpy.mockRestore();
    }
  });

  it("cleans retry temp archive paths when a later attempt fails", async () => {
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
      expect(rmSpy).toHaveBeenCalledWith(`${tempArchivePath}.retry-2`, { force: true });
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
            list: [{ id: "main", default: true, workspace: state.workspaceDir }],
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

  it("scrubs transient SQLite delivery queue rows from archive snapshots", async () => {
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
          } finally {
            archivedDb.close();
          }

          expect(db.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get()).toEqual({
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
        } finally {
          archivedDb.close();
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
              role TEXT NOT NULL
            );
            INSERT INTO schema_meta (meta_key, role) VALUES ('primary', 'agent');
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
          INSERT INTO backup_meta (id, last_seq) VALUES (1, 0);
          INSERT INTO delivery_queue_entries (id) VALUES ('must-stay');
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

          try {
            await expect(
              createBackupArchive({
                output: outputDir,
                includeWorkspace: false,
                nowMs: Date.UTC(2026, 4, 9, 8, 33, 30),
              }),
            ).rejects.toThrow(/SQLite state appeared after snapshot discovery/);
            expect(createdLatePath).toBe(true);
            expect(await fs.readdir(outputDir)).toEqual([]);
          } finally {
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

  it("snapshots the canonical global SQLite symlink as a complete regular file", async () => {
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
        const externalDbPath = path.join(state.workspaceDir, "external-global.sqlite");
        const linkedDbPath = state.statePath("state", "openclaw.sqlite");
        await state.writeConfig({
          agents: {
            list: [{ id: "main", default: true, workspace: state.workspaceDir }],
          },
        });
        await fs.mkdir(path.dirname(linkedDbPath), { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(extractDir, { recursive: true });
        const sqlite = requireNodeSqlite();
        const db = new sqlite.DatabaseSync(externalDbPath);
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
          CREATE TABLE schema_meta (
            meta_key TEXT NOT NULL PRIMARY KEY,
            role TEXT NOT NULL
          );
          INSERT INTO schema_meta (meta_key, role) VALUES ('primary', 'global');
          PRAGMA wal_checkpoint(TRUNCATE);
          INSERT INTO durable_state (id, value) VALUES (1, 'must-stay');
          INSERT INTO delivery_queue_entries (id) VALUES ('must-drop');
        `);
        await fs.symlink(externalDbPath, linkedDbPath);

        try {
          const result = await createBackupArchive({
            output: outputDir,
            includeWorkspace: true,
            nowMs: Date.UTC(2026, 4, 9, 8, 34, 30),
          });
          const entries = await listArchiveEntryDetails(result.archivePath);
          const archivedDbEntries = entries.filter((entry) =>
            entry.path.endsWith("/state/state/openclaw.sqlite"),
          );
          expect(archivedDbEntries).toEqual([
            expect.objectContaining({
              type: "File",
            }),
          ]);
          for (const suffix of ["", "-wal", "-shm", "-journal"]) {
            expect(
              entries.some((entry) =>
                entry.path.endsWith(`/workspace/external-global.sqlite${suffix}`),
              ),
              suffix || "database",
            ).toBe(false);
          }

          await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
          const archivedDb = new sqlite.DatabaseSync(
            path.join(
              extractDir,
              expectDefined(archivedDbEntries[0], "archivedDbEntries[0] test invariant").path,
            ),
            { readOnly: true },
          );
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
          } finally {
            archivedDb.close();
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

  it("omits installed plugin node_modules from the real archive while keeping plugin files", async () => {
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
        expect(entrySuffixes).toContain("/state/npm/projects/demo/node_modules/dep/fixture.sqlite");
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
    it.each([
      ["hard link", false],
      ["copy fallback", true],
    ] as const)("publishes via %s with owner-only 0o600 permissions", async (_name, forceCopy) => {
      const linkSpy = forceCopy
        ? vi
            .spyOn(fs, "link")
            .mockRejectedValue(
              Object.assign(new Error("hard links unsupported"), { code: "EPERM" }),
            )
        : undefined;
      try {
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
      } finally {
        linkSpy?.mockRestore();
      }
    });
  });
});
