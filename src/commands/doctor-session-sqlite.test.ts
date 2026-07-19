// Doctor session SQLite tests exercise real temp stores and per-agent SQLite files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadExactSqliteSessionEntry,
  loadSqliteTranscriptEventsSync,
  readSqliteTranscriptStatsSync,
  upsertSqliteSessionEntry,
} from "../config/sessions/session-accessor.sqlite.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import * as replaceFile from "../infra/replace-file.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import {
  readOpenClawDatabaseQuarantine,
  recordOpenClawDatabaseQuarantine,
} from "../state/openclaw-quarantine-store.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  assertSafeSessionSqliteMigrationMove,
  createSessionSqliteMigrationFailureIssue,
  restoreSessionSqliteMigrationRun,
  type ActiveSessionSqliteMigrationRun,
} from "./doctor-session-sqlite-migration-run.js";
import { resolveTargetSqlitePath } from "./doctor-session-sqlite-readers.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";

type SessionSqliteMigrationManifest = ActiveSessionSqliteMigrationRun["manifest"];

type TestStore = {
  configPath: string;
  env: NodeJS.ProcessEnv;
  sessionDir: string;
  stateDir: string;
  storePath: string;
  tempDir: string;
  unreferencedJsonlPath: string;
  trajectoryPath: string;
  transcriptPath: string;
};

const previousEnv = {
  OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
  OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
};
const autoCleanupTempDirs = useAutoCleanupTempDirTracker(afterEach);
const lexicalTempDir = path.resolve(os.tmpdir());
const realTempDir = fs.realpathSync.native(os.tmpdir());
const hasPlatformTempAlias = lexicalTempDir !== realTempDir;
const lexicalRootTempDir = path.resolve("/tmp");
const realRootTempDir = canonicalTestPath(lexicalRootTempDir);
const hasPlatformRootTempAlias = lexicalRootTempDir !== realRootTempDir;

beforeEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  restoreEnvValue("OPENCLAW_CONFIG_PATH", previousEnv.OPENCLAW_CONFIG_PATH);
  restoreEnvValue("OPENCLAW_STATE_DIR", previousEnv.OPENCLAW_STATE_DIR);
});

describe("runDoctorSessionSqlite", () => {
  it("dry-runs a legacy store without writing SQLite rows", async () => {
    const store = createLegacyStore();

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "dry-run",
      store: store.storePath,
    });

    expect(report.totals).toMatchObject({
      importedEntries: 0,
      importedTranscriptEvents: 0,
      issues: 0,
      legacyEntries: 1,
      sqliteEntries: 0,
      targets: 1,
      unreferencedJsonlFiles: 2,
      validatedEntries: 1,
      validatedTranscriptEvents: 2,
    });
    expect(report.targets[0]?.sqlitePath).toBeTruthy();
    expect(fs.existsSync(report.targets[0]?.sqlitePath ?? "")).toBe(false);
  });

  it("inspects a legacy store without creating a SQLite database", async () => {
    const store = createLegacyStore();

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "inspect",
      store: store.storePath,
    });

    expect(report.totals).toMatchObject({
      issues: 0,
      legacyEntries: 1,
      sqliteEntries: 0,
      targets: 1,
    });
    expect(report.targets[0]?.sqlitePath).toBeTruthy();
    expect(fs.existsSync(report.targets[0]?.sqlitePath ?? "")).toBe(false);
  });

  it("inspects SQLite-only all-agent targets without requiring a legacy store", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-session-sqlite-"));
    try {
      const stateDir = path.join(tempDir, "state");
      const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      await upsertSqliteSessionEntry(
        { agentId: "main", env, sessionKey: "agent:main:main", storePath },
        { sessionId: "sqlite-session", updatedAt: Date.now() },
      );

      const report = await runDoctorSessionSqlite({
        allAgents: true,
        cfg: {},
        env,
        mode: "inspect",
      });

      expect(fs.existsSync(storePath)).toBe(false);
      expect(report.totals).toMatchObject({
        issues: 0,
        legacyEntries: 0,
        sqliteEntries: 1,
        targets: 1,
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("migrates a dormant historical agent database before all-agent import compaction", async () => {
    const tempDir = autoCleanupTempDirs.make("openclaw-doctor-session-sqlite-");
    const stateDir = path.join(tempDir, "state");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const agentIds = ["dormant", "current"] as const;
    for (const agentId of agentIds) {
      const sessionsDir = path.join(stateDir, "agents", agentId, "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(path.join(sessionsDir, "sessions.json"), "{}\n", { mode: 0o600 });
    }
    const dormantPath = createHistoricalV1AgentDatabase({ agentId: "dormant", env });
    const currentPath = openOpenClawAgentDatabase({ agentId: "current", env }).path;
    closeOpenClawAgentDatabasesForTest();

    const sqlite = nodeSqlite.requireNodeSqlite();
    const currentBefore = new sqlite.DatabaseSync(currentPath);
    const currentUpdatedAt = expectDefined(
      currentBefore
        .prepare("SELECT updated_at FROM schema_meta WHERE meta_key = 'primary'")
        .get() as { updated_at?: number } | undefined,
      "current schema metadata",
    ).updated_at;
    currentBefore.close();

    const report = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: { agents: { list: agentIds.map((id) => ({ id })) } },
      env,
      mode: "import",
    });

    expect(report.totals).toMatchObject({
      importedEntries: 0,
      issues: 0,
      targets: 2,
    });
    expect(report.targets.find((target) => target.agentId === "dormant")?.compact).toMatchObject({
      skipped: false,
    });
    const dormantAfter = new sqlite.DatabaseSync(dormantPath);
    const currentAfter = new sqlite.DatabaseSync(currentPath);
    try {
      expect(dormantAfter.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      expect(
        dormantAfter
          .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
          .get(),
      ).toEqual({ schema_version: OPENCLAW_AGENT_SCHEMA_VERSION });
      expect(
        dormantAfter
          .prepare("PRAGMA table_info(sessions)")
          .all()
          .map((column) => (column as { name?: unknown }).name),
      ).toContain("session_scope");
      expect(
        dormantAfter
          .prepare("PRAGMA table_info(memory_index_sources)")
          .all()
          .map((column) => (column as { name?: unknown }).name),
      ).toEqual(["id", "path", "source", "hash", "mtime", "size"]);
      expect(dormantAfter.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
      expect(dormantAfter.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        currentAfter
          .prepare("SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary'")
          .get(),
      ).toEqual({
        schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
        updated_at: currentUpdatedAt,
      });
    } finally {
      dormantAfter.close();
      currentAfter.close();
    }
  });

  it("keeps mismatched older agent schema versions blocking during all-agent import", async () => {
    const tempDir = autoCleanupTempDirs.make("openclaw-doctor-session-sqlite-");
    const stateDir = path.join(tempDir, "state");
    const sessionsDir = path.join(stateDir, "agents", "drifted", "sessions");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "sessions.json"), "{}\n", { mode: 0o600 });
    const sqlitePath = openOpenClawAgentDatabase({ agentId: "drifted", env }).path;
    closeOpenClawAgentDatabasesForTest();

    const sqlite = nodeSqlite.requireNodeSqlite();
    const database = new sqlite.DatabaseSync(sqlitePath);
    try {
      database.exec("PRAGMA user_version = 1;");
      database
        .prepare("UPDATE schema_meta SET schema_version = 2 WHERE meta_key = 'primary'")
        .run();
    } finally {
      database.close();
    }

    const report = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: { agents: { list: [{ id: "drifted" }] } },
      env,
      mode: "import",
    });

    expect(report.targets[0]?.issues).toEqual([
      expect.objectContaining({
        code: "sqlite_compact_failed",
        message: expect.stringMatching(/uses schema version 1/iu),
      }),
    ]);
    const after = new sqlite.DatabaseSync(sqlitePath);
    try {
      expect(after.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      expect(
        after.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
      ).toEqual({ schema_version: 2 });
    } finally {
      after.close();
    }
  });

  it("repairs legacy message and route shapes at the import boundary", async () => {
    const store = createLegacyStore({
      entryOverrides: {
        route: "stale-custom-slot",
        deliveryContext: { channel: "telegram", to: "123" },
      },
      transcriptLines: [
        '{"type":"session","sessionId":"session-1"}',
        '{"type":"message","id":"m1","parentId":null,"message":{"role":"assistant","content":"legacy string"}}',
      ],
    });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });

    expect(report.totals).toMatchObject({ importedEntries: 1, issues: 0 });
    const imported = loadExactSqliteSessionEntry({
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath: store.storePath,
    });
    // The SQLite runtime does no read repair, so import must store canonical shapes.
    expect(typeof imported?.entry.route).not.toBe("string");
    const events = loadSqliteTranscriptEventsSync({
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath: store.storePath,
    });
    const message = events.find((event) => (event as { type?: string }).type === "message") as {
      message?: { content?: unknown };
    };
    expect(message?.message?.content).toEqual([{ type: "text", text: "legacy string" }]);
    closeOpenClawAgentDatabasesForTest();
    const sqlite = nodeSqlite.requireNodeSqlite();
    const migrated = new sqlite.DatabaseSync(
      resolveOpenClawAgentSqlitePath({ agentId: "main", env: store.env }),
      { readOnly: true },
    );
    try {
      expect(migrated.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      expect(
        migrated
          .prepare(
            "SELECT session_id, length(generation) AS generation_length FROM session_transcript_generations",
          )
          .all(),
      ).toEqual([{ generation_length: 32, session_id: "session-1" }]);
    } finally {
      migrated.close();
    }
  });

  it("preserves the legacy transcript mtime as the SQLite mutation watermark", async () => {
    const store = createLegacyStore();
    const transcriptMtimeMs = 1_700_000_000_000;
    const transcriptMtime = new Date(transcriptMtimeMs);
    fs.utimesSync(store.transcriptPath, transcriptMtime, transcriptMtime);

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });

    expect(report.totals).toMatchObject({ importedEntries: 1, issues: 0 });
    expect(
      readSqliteTranscriptStatsSync({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }).lastMutationAtMs,
    ).toBe(transcriptMtimeMs);
  });

  it("preserves a same-generation canonical harness owner during legacy import", async () => {
    const store = createLegacyStore({
      entryOverrides: { lifecycleRevision: "rev-1" },
    });
    await upsertSqliteSessionEntry(
      {
        agentId: "main",
        env: store.env,
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      },
      {
        agentHarnessId: "codex",
        lifecycleRevision: "rev-1",
        sessionId: "session-1",
        updatedAt: 3000,
      },
    );

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });

    expect(report.totals).toMatchObject({ importedEntries: 1, issues: 0 });
    expect(
      loadExactSqliteSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      })?.entry,
    ).toMatchObject({
      agentHarnessId: "codex",
      lifecycleRevision: "rev-1",
      sessionId: "session-1",
      sessionFile: expect.stringMatching(/^sqlite:/),
    });
  });

  it("imports and validates legacy sessions idempotently", async () => {
    const store = createLegacyStore();

    const firstImport = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const secondImport = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const validation = await runDoctorSessionSqlite({
      env: store.env,
      mode: "validate",
      store: store.storePath,
    });
    const inspect = await runDoctorSessionSqlite({
      env: store.env,
      mode: "inspect",
      store: store.storePath,
    });

    expect(firstImport.totals).toMatchObject({
      archivedLegacyStoreFiles: 1,
      archivedTranscriptFiles: 2,
      archivedUnreferencedJsonlFiles: 1,
      importedEntries: 1,
      importedTranscriptEvents: 2,
      issues: 0,
      sqliteEntries: 1,
      unreferencedJsonlFiles: 0,
    });
    expect(secondImport.totals).toMatchObject({
      archivedLegacyStoreFiles: 0,
      archivedTranscriptFiles: 0,
      archivedUnreferencedJsonlFiles: 0,
      importedEntries: 0,
      importedTranscriptEvents: 0,
      issues: 0,
      sqliteEntries: 0,
      unreferencedJsonlFiles: 0,
      validatedEntries: 0,
      validatedTranscriptEvents: 0,
    });
    expect(validation.totals).toMatchObject({
      issues: 0,
      validatedEntries: 0,
      validatedTranscriptEvents: 0,
    });
    expect(fs.existsSync(store.storePath)).toBe(false);
    expect(fs.existsSync(store.transcriptPath)).toBe(false);
    expect(fs.existsSync(store.trajectoryPath)).toBe(false);
    expect(fs.existsSync(store.unreferencedJsonlPath)).toBe(false);
    expect(firstImport.targets[0]?.archivedTranscriptFiles).toHaveLength(2);
    for (const archivedTranscriptPath of firstImport.targets[0]?.archivedTranscriptFiles ?? []) {
      expect(archivedTranscriptPath).toBeTruthy();
      expect(archivedTranscriptPath).not.toContain(`${path.sep}sessions${path.sep}`);
      expect(fs.existsSync(archivedTranscriptPath)).toBe(true);
    }
    expect(firstImport.targets[0]?.archivedUnreferencedJsonlFiles).toHaveLength(1);
    const archivedUnreferencedPath = expectDefined(
      firstImport.targets[0]?.archivedUnreferencedJsonlFiles[0],
      "firstImport.targets[0]?.archivedUnreferencedJsonlFiles[0] test invariant",
    );
    expect(archivedUnreferencedPath).toBeTruthy();
    expect(archivedUnreferencedPath).not.toContain(`${path.sep}sessions${path.sep}`);
    expect(archivedUnreferencedPath).toContain("archive-tier.orphan.jsonl.imported-");
    expect(fs.existsSync(archivedUnreferencedPath)).toBe(true);
    expect(fs.readFileSync(archivedUnreferencedPath, "utf-8")).toBe('{"type":"event"}\n');
    expect(inspect.totals.sqliteEntries).toBe(1);
    expect(inspect.totals.unreferencedJsonlFiles).toBe(0);
    expect(
      loadExactSqliteSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      })?.entry.sessionFile,
    ).toContain("sqlite:main:session-1:");
    expect(
      loadSqliteTranscriptEventsSync({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }),
    ).toHaveLength(2);
  });

  it("compacts migrated agent SQLite databases and reports reclaimed pages", async () => {
    const store = createLegacyStore({
      transcriptLines: [
        '{"type":"session","sessionId":"session-1"}',
        ...Array.from({ length: 240 }, (_, index) =>
          JSON.stringify({
            id: `evt-${index}`,
            message: { content: "x".repeat(2_000), role: "user" },
            type: "message",
          }),
        ),
      ],
    });
    const importReport = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const sqlitePath = importReport.targets[0]?.sqlitePath;
    expect(sqlitePath).toBeTruthy();
    const sqlite = nodeSqlite.requireNodeSqlite();
    const db = new sqlite.DatabaseSync(sqlitePath ?? "");
    try {
      db.exec("DELETE FROM transcript_events;");
    } finally {
      db.close();
    }

    const compact = await runDoctorSessionSqlite({
      env: store.env,
      mode: "compact",
      store: store.storePath,
    });

    expect(compact.totals.issues).toBe(0);
    expect(compact.totals.reclaimedBytes).toBeGreaterThan(0);
    expect(compact.targets[0]?.compact).toMatchObject({
      freelistAfterPages: 0,
      skipped: false,
    });
    expect(compact.targets[0]?.compact?.freelistBeforePages).toBeGreaterThan(0);
    expect(compact.targets[0]?.compact?.dbSizeAfterBytes).toBeLessThan(
      compact.targets[0]?.compact?.dbSizeBeforeBytes ?? 0,
    );
  });

  it("refuses compaction while this process owns an open agent database handle", async () => {
    const { sqlitePath, store } = await createImportedStoreForCompaction();
    openOpenClawAgentDatabase({
      agentId: "main",
      env: store.env,
      path: sqlitePath,
    });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "compact",
      store: store.storePath,
    });

    expect(report.targets[0]?.issues).toEqual([
      expect.objectContaining({
        code: "sqlite_compact_failed",
        message: expect.stringMatching(/already open in this process/iu),
      }),
    ]);
  });

  it.each([
    {
      label: "wrong schema role",
      mutate: (database: DatabaseSync) => {
        database.prepare("UPDATE schema_meta SET role = 'global' WHERE meta_key = 'primary'").run();
      },
      message: /schema role global.*expected agent/iu,
    },
    {
      label: "wrong agent owner",
      mutate: (database: DatabaseSync) => {
        database
          .prepare("UPDATE schema_meta SET agent_id = 'work' WHERE meta_key = 'primary'")
          .run();
      },
      message: /belongs to agent work.*requested agent main/iu,
    },
    {
      label: "stale metadata version",
      mutate: (database: DatabaseSync) => {
        database
          .prepare("UPDATE schema_meta SET schema_version = ? WHERE meta_key = 'primary'")
          .run(OPENCLAW_AGENT_SCHEMA_VERSION - 1);
      },
      message: /metadata schema version .* does not match/iu,
    },
    {
      label: "stale user version",
      mutate: (database: DatabaseSync) => {
        database.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION - 1};`);
      },
      message: /run openclaw doctor --fix before compacting/iu,
    },
  ])("rejects $label before compaction", async ({ mutate, message }) => {
    const { sqlitePath, store } = await createImportedStoreForCompaction();
    const sqlite = nodeSqlite.requireNodeSqlite();
    const database = new sqlite.DatabaseSync(sqlitePath);
    try {
      mutate(database);
    } finally {
      database.close();
    }

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "compact",
      store: store.storePath,
    });

    expect(report.targets[0]?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "sqlite_compact_failed",
          message: expect.stringMatching(message),
        }),
      ]),
    );
  });

  it.skipIf(process.platform === "win32")(
    "refuses a symlink at the agent database path",
    async () => {
      const { sqlitePath, store } = await createImportedStoreForCompaction();
      const realPath = `${sqlitePath}.real`;
      fs.renameSync(sqlitePath, realPath);
      fs.symlinkSync(realPath, sqlitePath);

      const report = await runDoctorSessionSqlite({
        env: store.env,
        mode: "compact",
        store: store.storePath,
      });

      expect(report.targets[0]?.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "sqlite_compact_failed",
            message: expect.stringMatching(/not a regular file/iu),
          }),
        ]),
      );
    },
  );

  it("clears agent quarantine after compaction", async () => {
    const { sqlitePath, store } = await createImportedStoreForCompaction();
    expect(
      recordOpenClawDatabaseQuarantine({
        env: store.env,
        kind: "agent",
        path: sqlitePath,
        reason: "corrupt index",
      }),
    ).toBe(true);

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "compact",
      store: store.storePath,
    });

    expect(report.totals.issues).toBe(0);
    expect(readOpenClawDatabaseQuarantine(sqlitePath, { env: store.env })).toBeUndefined();
    expect(openOpenClawAgentDatabase({ agentId: "main", env: store.env }).db.isOpen).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "reapplies owner-only permissions after compaction",
    async () => {
      const { sqlitePath, store } = await createImportedStoreForCompaction();
      fs.chmodSync(sqlitePath, 0o666);

      const report = await runDoctorSessionSqlite({
        env: store.env,
        mode: "compact",
        store: store.storePath,
      });

      expect(report.totals.issues).toBe(0);
      expect(fs.statSync(sqlitePath).mode & 0o777).toBe(0o600);
    },
  );

  it("rejects stale secondary indexes before compacting and quarantines them in recovery", async () => {
    const { sqlitePath, store } = await createImportedStoreForCompaction();
    createUnsafeIndexDrift(sqlitePath);

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "compact",
      store: store.storePath,
    });

    expect(report.targets[0]?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "sqlite_compact_failed",
          message: expect.stringMatching(
            /integrity_check failed.*missing from index unsafe_session_index/iu,
          ),
        }),
      ]),
    );

    const recovery = await runDoctorSessionSqlite({
      env: store.env,
      mode: "recover",
      store: store.storePath,
    });
    expect(recovery.totals.issues).toBe(0);
    expect(recovery.targets[0]?.corruptRecovery?.movedFiles).toEqual(
      expect.arrayContaining([expect.stringMatching(/openclaw-agent\.sqlite\.corrupt-/u)]),
    );
    expect(fs.existsSync(sqlitePath)).toBe(false);
  });

  it("does not report SQLite markers as missing transcript files", async () => {
    const store = createLegacyStore();
    fs.rmSync(store.transcriptPath);
    fs.rmSync(store.trajectoryPath);
    fs.writeFileSync(
      store.storePath,
      JSON.stringify(
        {
          "agent:main:main": {
            channel: "cli",
            chatType: "direct",
            sessionFile: `sqlite:main:session-1:${store.storePath}`,
            sessionId: "session-1",
            sessionStartedAt: 1000,
            updatedAt: 2000,
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const validation = await runDoctorSessionSqlite({
      env: store.env,
      mode: "validate",
      store: store.storePath,
    });

    expect(report.totals).toMatchObject({
      importedEntries: 1,
      importedTranscriptEvents: 0,
      issues: 0,
      sqliteEntries: 1,
    });
    expect(validation.totals).toMatchObject({
      issues: 0,
      validatedEntries: 0,
      validatedTranscriptEvents: 0,
    });
    expect(
      loadExactSqliteSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      })?.entry.sessionFile,
    ).toContain("sqlite:main:session-1:");
  });

  it("validates missing SQLite rows without creating the agent database", async () => {
    const store = createLegacyStore();

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "validate",
      store: store.storePath,
    });

    expect(report.totals).toMatchObject({
      issues: 1,
      sqliteEntries: 0,
      validatedEntries: 0,
      validatedTranscriptEvents: 0,
    });
    expect(report.targets[0]?.issues[0]).toMatchObject({
      code: "sqlite_entry_missing",
      sessionKey: "agent:main:main",
    });
    expect(fs.existsSync(report.targets[0]?.sqlitePath ?? "")).toBe(false);
  });

  it("writes a migration manifest with planned and completed archive moves", async () => {
    const store = createLegacyStore();
    const expectedStorePath = fs.realpathSync.native(store.storePath);

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const manifest = readMigrationManifest(report.migrationRun?.manifestPath);
    const target = expectDefined(manifest.targets[0], "manifest.targets[0] test invariant");

    expect(report.migrationRun?.runId).toBe(manifest.runId);
    expect(manifest.manifestVersion).toBe(2);
    expect(target).toMatchObject({
      agentId: "main",
      storePath: expectedStorePath,
      validationBeforeArchive: "passed",
    });
    expect(target.plannedMoves).toHaveLength(4);
    expect(target.completedMoves).toHaveLength(4);
    expect(target.plannedMoves.map((move) => path.basename(move.sourcePath)).toSorted()).toEqual([
      "orphan.jsonl",
      "session-1.jsonl",
      "session-1.trajectory.jsonl",
      "sessions.json",
    ]);
  });

  it("checkpoints bulk unreferenced archive moves without per-file manifest rewrites", async () => {
    const store = createLegacyStore();
    for (let index = 0; index < 64; index += 1) {
      fs.writeFileSync(path.join(store.sessionDir, `orphan-${index}.jsonl`), "{}\n", {
        mode: 0o600,
      });
    }
    fs.writeFileSync(path.join(store.sessionDir, "orphan collision.jsonl"), "{}\n", {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(store.sessionDir, "orphan_collision.jsonl"), "{}\n", {
      mode: 0o600,
    });
    const replaceFileAtomicSync = vi.spyOn(replaceFile, "replaceFileAtomicSync");

    try {
      const report = await runDoctorSessionSqlite({
        env: store.env,
        mode: "import",
        store: store.storePath,
      });
      const manifest = readMigrationManifest(report.migrationRun?.manifestPath);
      const manifestWrites = replaceFileAtomicSync.mock.calls.filter(([options]) =>
        options.filePath.includes("session-sqlite-migration-runs"),
      ).length;
      const plannedUnreferencedMoves =
        manifest.targets[0]?.plannedMoves.filter((move) => move.kind === "unreferenced-jsonl") ??
        [];

      expect(plannedUnreferencedMoves).toHaveLength(67);
      expect(new Set(plannedUnreferencedMoves.map((move) => move.archivePath)).size).toBe(67);
      expect(
        manifest.targets[0]?.completedMoves.filter((move) => move.kind === "unreferenced-jsonl"),
      ).toHaveLength(67);
      expect(manifestWrites).toBeLessThan(20);
      expect(replaceFileAtomicSync).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: report.migrationRun?.manifestPath,
          mode: 0o600,
          tempPrefix: path.basename(report.migrationRun?.manifestPath ?? ""),
        }),
      );
    } finally {
      replaceFileAtomicSync.mockRestore();
    }
  });

  it("archives legacy trajectory pointer files with imported transcripts", async () => {
    const store = createLegacyStore();
    const pointerPath = path.join(store.sessionDir, "session-1.trajectory-path.json");
    fs.writeFileSync(
      pointerPath,
      `${JSON.stringify({
        traceSchema: "openclaw-trajectory-pointer",
        schemaVersion: 1,
        sessionId: "session-1",
        runtimeFile: store.trajectoryPath,
      })}\n`,
      { mode: 0o600 },
    );
    const expectedPointerPath = canonicalTestPath(pointerPath);

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const archivedNames =
      report.targets[0]?.archivedTranscriptFiles.map((filePath) => path.basename(filePath)) ?? [];

    expect(fs.existsSync(pointerPath)).toBe(false);
    expect(archivedNames).toEqual(
      expect.arrayContaining([expect.stringContaining("session-1.trajectory-path.json.imported-")]),
    );
    expect(
      readMigrationManifest(report.migrationRun?.manifestPath).targets[0]?.plannedMoves,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "trajectory",
          sourcePath: expectedPointerPath,
        }),
      ]),
    );
  });

  it("restores archived artifacts from the migration manifest", async () => {
    const store = createLegacyStore();
    const importReport = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const manifest = readMigrationManifest(importReport.migrationRun?.manifestPath);
    const sourcePaths = manifest.targets[0]?.plannedMoves.map((move) => move.sourcePath) ?? [];

    const restore = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {},
      env: store.env,
      mode: "restore",
    });

    expect(restore.totals.issues).toBe(0);
    expect(restore.targets[0]?.restore).toMatchObject({
      conflicts: [],
      restoredFiles: expect.arrayContaining(sourcePaths),
    });
    expect(fs.existsSync(store.transcriptPath)).toBe(true);
    expect(fs.existsSync(store.trajectoryPath)).toBe(true);
    expect(fs.existsSync(store.unreferencedJsonlPath)).toBe(true);
  });

  it.each([false, true])(
    "restores archived artifacts after the replacement SQLite file is removed (allAgents=%s)",
    async (allAgents) => {
      const store = createLegacyStore();
      const importReport = await runDoctorSessionSqlite({
        env: store.env,
        mode: "import",
        store: store.storePath,
      });
      const sqlitePath = importReport.targets[0]?.sqlitePath;
      if (!sqlitePath) {
        throw new Error("expected imported SQLite path");
      }
      closeOpenClawAgentDatabasesForTest();
      for (const filePath of [sqlitePath, `${sqlitePath}-wal`, `${sqlitePath}-shm`]) {
        fs.rmSync(filePath, { force: true });
      }

      const restore = await runDoctorSessionSqlite({
        ...(allAgents ? { allAgents: true } : {}),
        cfg: {},
        env: store.env,
        mode: "restore",
      });

      expect(restore.totals.issues).toBe(0);
      expect(restore.targets[0]?.restore?.restoredFiles).toEqual(
        expect.arrayContaining(canonicalTestPaths([store.transcriptPath, store.trajectoryPath])),
      );
      expect(fs.existsSync(store.transcriptPath)).toBe(true);
    },
  );

  it("restores planned moves when a crash prevented completed move recording", async () => {
    const store = createLegacyStore();
    const importReport = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
    const manifest = readMigrationManifest(manifestPath);
    expectDefined(manifest.targets[0], "manifest.targets[0] test invariant").completedMoves = [];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    const restore = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {},
      env: store.env,
      mode: "restore",
    });

    expect(restore.totals.issues).toBe(0);
    expect(restore.targets[0]?.restore?.restoredFiles).toEqual(
      expect.arrayContaining(canonicalTestPaths([store.transcriptPath, store.trajectoryPath])),
    );
    expect(fs.existsSync(store.transcriptPath)).toBe(true);
    expect(fs.existsSync(store.trajectoryPath)).toBe(true);
  });

  it("rejects malformed restore manifests without throwing", () => {
    const store = createLegacyStore();
    const manifestPath = path.join(store.tempDir, "malformed-manifest.json");
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify({
        manifestVersion: 1,
        runId: "malformed",
        targets: {},
      })}\n`,
      { mode: 0o600 },
    );

    const restore = restoreSessionSqliteMigrationRun({
      manifestPath,
      trustedTargets: [trustedMigrationTarget(store)],
    });

    expect(restore).toMatchObject({
      conflicts: [
        {
          archivePath: manifestPath,
          reason: "manifest is missing or unreadable",
          sourcePath: manifestPath,
        },
      ],
      restoredFiles: [],
      skippedFiles: [],
    });
  });

  it("rejects restore moves outside the manifest target archive boundary", async () => {
    const store = createLegacyStore();
    const importReport = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
    const manifest = readMigrationManifest(manifestPath);
    const target = expectDefined(
      manifest.targets[0],
      "restore-boundary manifest target test invariant",
    );
    const outsideSourcePath = path.join(store.tempDir, "outside-source.jsonl");
    const outsideArchivePath = path.join(store.tempDir, "outside-archive.jsonl");
    fs.writeFileSync(outsideArchivePath, '{"type":"outside"}\n', { mode: 0o600 });
    const unsafeMove = {
      archivePath: outsideArchivePath,
      kind: "transcript" as const,
      sourcePath: outsideSourcePath,
    };
    target.plannedMoves = [unsafeMove];
    target.completedMoves = [unsafeMove];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    const restore = restoreSessionSqliteMigrationRun({
      manifestPath,
      trustedTargets: [trustedMigrationTarget(store)],
    });

    expect(restore.conflicts).toEqual([
      {
        archivePath: manifestPath,
        reason: "manifest is missing or unreadable",
        sourcePath: manifestPath,
      },
    ]);
    expect(fs.existsSync(outsideSourcePath)).toBe(false);
    expect(fs.existsSync(outsideArchivePath)).toBe(true);
  });

  it("rejects migration sources outside the target sessions directory", () => {
    const store = createLegacyStore();
    const outsideSourcePath = path.join(store.tempDir, "outside-source.jsonl");
    const archivePath = path.join(
      path.dirname(store.sessionDir),
      "session-sqlite-import-archive",
      "outside-source.jsonl.imported-1",
    );
    fs.writeFileSync(outsideSourcePath, '{"type":"outside"}\n', { mode: 0o600 });

    expect(() =>
      assertSafeSessionSqliteMigrationMove(
        {
          archivePath,
          kind: "transcript",
          sourcePath: outsideSourcePath,
        },
        trustedMigrationTarget(store),
      ),
    ).toThrow("Migration source is outside the target sessions directory");
    expect(fs.existsSync(outsideSourcePath)).toBe(true);
  });

  it("rejects a coherently rewritten target that is not trusted by the caller", async () => {
    const store = createLegacyStore();
    const importReport = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
    const manifest = readMigrationManifest(manifestPath);
    const target = expectDefined(
      manifest.targets[0],
      "untrusted-target manifest target test invariant",
    );
    const outsideSessionsDir = path.join(store.tempDir, "outside-agent", "sessions");
    const outsideStorePath = path.join(outsideSessionsDir, "sessions.json");
    const outsideSourcePath = path.join(outsideSessionsDir, "outside.jsonl");
    const outsideArchiveDir = path.join(
      path.dirname(outsideSessionsDir),
      "session-sqlite-import-archive",
    );
    const outsideArchivePath = path.join(outsideArchiveDir, "outside.jsonl.imported-1");
    fs.mkdirSync(outsideArchiveDir, { recursive: true });
    fs.writeFileSync(outsideArchivePath, '{"type":"outside"}\n', { mode: 0o600 });
    const rewrittenMove = {
      archivePath: outsideArchivePath,
      kind: "transcript" as const,
      sourcePath: outsideSourcePath,
    };
    target.storePath = outsideStorePath;
    target.plannedMoves = [rewrittenMove];
    target.completedMoves = [rewrittenMove];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    const restore = restoreSessionSqliteMigrationRun({
      manifestPath,
      trustedTargets: [trustedMigrationTarget(store)],
    });

    expect(restore.conflicts).toEqual([
      {
        archivePath: manifestPath,
        reason: "manifest does not match a trusted session target",
        sourcePath: manifestPath,
      },
    ]);
    expect(fs.existsSync(outsideSourcePath)).toBe(false);
    expect(fs.existsSync(outsideArchivePath)).toBe(true);
  });

  it("rejects recovery manifests with a rewritten SQLite path", async () => {
    const store = createLegacyStore();
    const importReport = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
    const manifest = readMigrationManifest(manifestPath);
    const target = expectDefined(
      manifest.targets[0],
      "rewritten-sqlite manifest target test invariant",
    );
    const outsideSqlitePath = path.join(store.tempDir, "outside.sqlite");
    manifest.failedAt = "2030-01-01T00:00:00.000Z";
    target.issues = [{ code: "startup_failure", message: "failed after archive" }];
    target.sqlitePath = outsideSqlitePath;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    const recover = await runDoctorSessionSqlite({
      env: store.env,
      mode: "recover",
      store: store.storePath,
    });

    expect(recover.migrationRun).toBeUndefined();
    expect(recover.targets[0]?.issues[0]?.code).toBe("recover_manifest_missing");
    expect(fs.existsSync(outsideSqlitePath)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "uses normalized restore paths instead of symlink-parent traversal paths",
    async () => {
      const store = createLegacyStore();
      const importReport = await runDoctorSessionSqlite({
        env: store.env,
        mode: "import",
        store: store.storePath,
      });
      const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
      const manifest = readMigrationManifest(manifestPath);
      const target = expectDefined(
        manifest.targets[0],
        "normalized-restore manifest target test invariant",
      );
      const plannedMove = expectDefined(
        target.plannedMoves[0],
        "normalized-restore planned move test invariant",
      );
      const archiveDir = path.dirname(plannedMove.archivePath);
      const outsideDir = path.join(store.tempDir, "outside", "nested");
      const outsideArchivePath = path.join(path.dirname(outsideDir), "payload.jsonl");
      const traversalArchivePath = path.join(archiveDir, "escape", "..", "payload.jsonl");
      const sourcePath = path.join(canonicalTestPath(store.sessionDir), "payload.jsonl");
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.symlinkSync(outsideDir, path.join(archiveDir, "escape"));
      fs.writeFileSync(outsideArchivePath, '{"type":"outside"}\n', { mode: 0o600 });
      const traversalMove = {
        archivePath: traversalArchivePath,
        kind: "transcript" as const,
        sourcePath,
      };
      target.plannedMoves = [traversalMove];
      target.completedMoves = [traversalMove];
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

      const restore = restoreSessionSqliteMigrationRun({
        manifestPath,
        trustedTargets: [trustedMigrationTarget(store)],
      });

      expect(restore.conflicts).toEqual([
        {
          archivePath: path.join(archiveDir, "payload.jsonl"),
          reason: "source and archive are both missing",
          sourcePath,
        },
      ]);
      expect(fs.existsSync(sourcePath)).toBe(false);
      expect(fs.existsSync(outsideArchivePath)).toBe(true);
    },
  );

  it.skipIf(!hasPlatformTempAlias)(
    "restores version 1 manifests written through a platform root alias",
    async () => {
      const store = createLegacyStore();
      const importReport = await runDoctorSessionSqlite({
        env: store.env,
        mode: "import",
        store: store.storePath,
      });
      const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
      const manifest = readMigrationManifest(manifestPath);
      const aliasPath = (filePath: string) =>
        path.join(lexicalTempDir, path.relative(realTempDir, filePath));
      manifest.manifestVersion = 1;
      for (const target of manifest.targets) {
        target.sqlitePath = aliasPath(target.sqlitePath);
        target.storePath = aliasPath(target.storePath);
        for (const move of [...target.plannedMoves, ...target.completedMoves]) {
          move.archivePath = aliasPath(move.archivePath);
          move.sourcePath = aliasPath(move.sourcePath);
        }
      }
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

      const restore = restoreSessionSqliteMigrationRun({
        manifestPath,
        trustedTargets: [trustedMigrationTarget(store)],
      });

      expect(restore.conflicts).toEqual([]);
      expect(restore.restoredFiles).toContain(canonicalTestPath(store.transcriptPath));
      expect(fs.existsSync(store.transcriptPath)).toBe(true);
    },
  );

  it.skipIf(!hasPlatformRootTempAlias)(
    "imports a legacy store written through a platform root alias",
    async () => {
      const store = createLegacyStore({ tempRoot: lexicalRootTempDir });

      const report = await runDoctorSessionSqlite({
        env: store.env,
        mode: "import",
        store: store.storePath,
      });

      expect(report.totals).toMatchObject({ importedEntries: 1, issues: 0 });
      const manifest = readMigrationManifest(report.migrationRun?.manifestPath);
      expect(manifest.targets[0]?.storePath).toBe(
        path.join(realRootTempDir, path.relative(lexicalRootTempDir, store.storePath)),
      );
      expect(
        manifest.targets[0]?.completedMoves.every((move) =>
          move.sourcePath.startsWith(realRootTempDir + path.sep),
        ),
      ).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects version 1 manifests through non-root directory symlinks",
    async () => {
      const store = createLegacyStore();
      const importReport = await runDoctorSessionSqlite({
        env: store.env,
        mode: "import",
        store: store.storePath,
      });
      const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
      const manifest = readMigrationManifest(manifestPath);
      const target = expectDefined(
        manifest.targets[0],
        "version-1 symlink manifest target test invariant",
      );
      const move = expectDefined(
        target.plannedMoves.find((candidate) => candidate.kind === "transcript"),
        "version-1 symlink transcript move test invariant",
      );
      manifest.manifestVersion = 1;
      manifest.startedAt = "2999-01-01T00:00:00.000Z";
      target.plannedMoves = [move];
      target.completedMoves = [move];
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      const agentDir = path.dirname(store.sessionDir);
      const relocatedAgentDir = path.join(store.tempDir, "relocated-v1-agent");
      fs.renameSync(agentDir, relocatedAgentDir);
      fs.symlinkSync(relocatedAgentDir, agentDir);

      const restore = restoreSessionSqliteMigrationRun({
        manifestPath,
        trustedTargets: [trustedMigrationTarget(store)],
      });

      expect(restore.conflicts).toEqual([
        {
          archivePath: manifestPath,
          reason: "manifest is missing or unreadable",
          sourcePath: manifestPath,
        },
      ]);
      expect(fs.existsSync(move.sourcePath)).toBe(false);
      expect(fs.existsSync(move.archivePath)).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked ancestor shared by restore directories",
    async () => {
      const store = createLegacyStore();
      const importReport = await runDoctorSessionSqlite({
        env: store.env,
        mode: "import",
        store: store.storePath,
      });
      const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
      const manifest = readMigrationManifest(manifestPath);
      const target = expectDefined(
        manifest.targets[0],
        "shared-symlink manifest target test invariant",
      );
      const move = expectDefined(
        target.plannedMoves.find((candidate) => candidate.kind === "transcript"),
        "shared-symlink transcript move test invariant",
      );
      target.plannedMoves = [move];
      target.completedMoves = [move];
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      const agentDir = path.dirname(store.sessionDir);
      const relocatedAgentDir = path.join(store.tempDir, "relocated-agent");
      fs.renameSync(agentDir, relocatedAgentDir);
      fs.symlinkSync(relocatedAgentDir, agentDir);

      const restore = restoreSessionSqliteMigrationRun({
        manifestPath,
        trustedTargets: [trustedMigrationTarget(store)],
      });

      expect(restore.conflicts).toEqual([
        {
          archivePath: move.archivePath,
          reason: "source or archive parent is a symbolic link; refusing restore",
          sourcePath: move.sourcePath,
        },
      ]);
      expect(restore.restoredFiles).toEqual([]);
      expect(fs.existsSync(move.archivePath)).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects restores through a symlinked source directory",
    async () => {
      const store = createLegacyStore();
      const importReport = await runDoctorSessionSqlite({
        env: store.env,
        mode: "import",
        store: store.storePath,
      });
      const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
      const manifest = readMigrationManifest(manifestPath);
      const target = expectDefined(
        manifest.targets[0],
        "source-symlink manifest target test invariant",
      );
      const move = expectDefined(
        target.plannedMoves.find((candidate) => candidate.kind === "transcript"),
        "source-symlink transcript move test invariant",
      );
      target.plannedMoves = [move];
      target.completedMoves = [move];
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      const relocatedSessionDir = path.join(store.tempDir, "relocated-sessions");
      fs.renameSync(store.sessionDir, relocatedSessionDir);
      fs.symlinkSync(relocatedSessionDir, store.sessionDir);

      const restore = restoreSessionSqliteMigrationRun({
        manifestPath,
        trustedTargets: [trustedMigrationTarget(store)],
      });

      expect(restore.conflicts).toEqual([
        {
          archivePath: move.archivePath,
          reason: "source or archive parent is a symbolic link; refusing restore",
          sourcePath: move.sourcePath,
        },
      ]);
      expect(restore.restoredFiles).toEqual([]);
      expect(fs.existsSync(move.archivePath)).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects restores through a symlinked archive directory",
    async () => {
      const store = createLegacyStore();
      const importReport = await runDoctorSessionSqlite({
        env: store.env,
        mode: "import",
        store: store.storePath,
      });
      const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
      const manifest = readMigrationManifest(manifestPath);
      const target = expectDefined(
        manifest.targets[0],
        "archive-symlink manifest target test invariant",
      );
      const move = expectDefined(
        target.plannedMoves.find((candidate) => candidate.kind === "transcript"),
        "archive-symlink transcript move test invariant",
      );
      target.plannedMoves = [move];
      target.completedMoves = [move];
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      const archiveDir = path.dirname(move.archivePath);
      const relocatedArchiveDir = path.join(store.tempDir, "relocated-archive");
      fs.renameSync(archiveDir, relocatedArchiveDir);
      fs.symlinkSync(relocatedArchiveDir, archiveDir);

      const restore = restoreSessionSqliteMigrationRun({
        manifestPath,
        trustedTargets: [trustedMigrationTarget(store)],
      });

      expect(restore.conflicts).toEqual([
        {
          archivePath: move.archivePath,
          reason: "source or archive parent is a symbolic link; refusing restore",
          sourcePath: move.sourcePath,
        },
      ]);
      expect(restore.restoredFiles).toEqual([]);
      expect(fs.existsSync(move.archivePath)).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")("rejects symlinked archive entries", async () => {
    const store = createLegacyStore();
    const importReport = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
    const manifest = readMigrationManifest(manifestPath);
    const target = expectDefined(
      manifest.targets[0],
      "archive-entry manifest target test invariant",
    );
    const move = expectDefined(
      target.plannedMoves.find((candidate) => candidate.kind === "transcript"),
      "archive-entry transcript move test invariant",
    );
    target.plannedMoves = [move];
    target.completedMoves = [move];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const outsidePath = path.join(store.tempDir, "outside-payload.jsonl");
    fs.writeFileSync(outsidePath, '{"type":"outside"}\n', { mode: 0o600 });
    fs.rmSync(move.archivePath);
    fs.symlinkSync(outsidePath, move.archivePath);

    const restore = restoreSessionSqliteMigrationRun({
      manifestPath,
      trustedTargets: [trustedMigrationTarget(store)],
    });

    expect(restore.conflicts).toEqual([
      {
        archivePath: move.archivePath,
        reason: "archive is not a regular file; refusing restore",
        sourcePath: move.sourcePath,
      },
    ]);
    expect(restore.restoredFiles).toEqual([]);
    expect(fs.existsSync(move.sourcePath)).toBe(false);
    expect(fs.existsSync(outsidePath)).toBe(true);
  });

  it("treats repeated restore as idempotent when files are already restored", async () => {
    const store = createLegacyStore();
    const importReport = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const manifest = readMigrationManifest(importReport.migrationRun?.manifestPath);
    const sourcePaths = manifest.targets[0]?.plannedMoves.map((move) => move.sourcePath) ?? [];
    await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {},
      env: store.env,
      mode: "restore",
    });

    const secondRestore = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {},
      env: store.env,
      mode: "restore",
    });

    expect(secondRestore.totals.issues).toBe(0);
    expect(secondRestore.targets[0]?.restore?.restoredFiles).toEqual([]);
    expect(secondRestore.targets[0]?.restore?.skippedFiles).toEqual(
      expect.arrayContaining(sourcePaths),
    );
  });

  it("does not restore unrelated manifests for an unmatched explicit store selector", async () => {
    const store = createLegacyStore();
    await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });

    const restore = await runDoctorSessionSqlite({
      env: store.env,
      mode: "restore",
      store: path.join(store.tempDir, "missing", "sessions.json"),
    });

    expect(restore.targets[0]?.restore?.manifestPaths).toEqual([]);
    expect(restore.targets[0]?.restore?.restoredFiles).toEqual([]);
    expect(fs.existsSync(store.transcriptPath)).toBe(false);
  });

  it("reports restore conflicts without overwriting existing files", async () => {
    const store = createLegacyStore();
    const transcriptPath = canonicalTestPath(store.transcriptPath);
    await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    fs.writeFileSync(store.transcriptPath, '{"type":"event","id":"new"}\n', { mode: 0o600 });

    const restore = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {},
      env: store.env,
      mode: "restore",
    });

    expect(restore.totals.issues).toBe(1);
    expect(restore.targets[0]?.restore?.conflicts[0]).toMatchObject({
      reason: "source and archive both exist; refusing to overwrite source",
      sourcePath: transcriptPath,
    });
    expect(fs.readFileSync(store.transcriptPath, "utf-8")).toBe('{"type":"event","id":"new"}\n');
  });

  it("recovers the latest failed migration run and prepares a sanitized GitHub issue", async () => {
    const store = createLegacyStore({ agentDirName: "token=supersecret" });
    const importReport = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
    const manifest = readMigrationManifest(manifestPath);
    manifest.failedAt = "2030-01-01T00:00:00.000Z";
    expectDefined(manifest.targets[0], "manifest.targets[0] test invariant").issues = [
      {
        code: "startup_failure",
        message: `token=supersecret startup migration failed for agent:main:main at ${store.storePath} and ${process.env.HOME ?? "/Users/example"}/private/openclaw.json`,
        sessionKey: "agent:main:main",
      },
    ];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    writeFailedManifest(store, "older-failed.json", "2000-01-01T00:00:00.000Z");

    const recover = await runDoctorSessionSqlite({
      cfg: {},
      env: store.env,
      mode: "recover",
    });

    expect(recover.mode).toBe("recover");
    expect(recover.totals.issues).toBe(0);
    expect(recover.migrationRun?.manifestPath).toBe(manifestPath);
    expect(recover.targets[0]?.restore?.manifestPaths).toEqual([manifestPath]);
    expect(recover.targets[0]?.restore?.restoredFiles).toEqual(
      expect.arrayContaining(canonicalTestPaths([store.transcriptPath, store.trajectoryPath])),
    );
    expect(fs.existsSync(store.transcriptPath)).toBe(true);
    expect(recover.supportIssue?.title).toContain(manifest.runId);
    expect(recover.supportIssue?.body).toContain("startup_failure");
    expect(recover.supportIssue?.body).not.toContain("agent:main:main");
    expect(recover.supportIssue?.body).not.toContain("supersecret");
    expect(recover.supportIssue?.body).not.toContain(store.storePath);
    if (process.env.HOME) {
      expect(recover.supportIssue?.body).not.toContain(process.env.HOME);
    }
    expect(recover.supportIssue?.url).toContain("github.com/openclaw/openclaw/issues/new");
  });

  it("keeps truncated GitHub issue bodies on a valid UTF-16 boundary", () => {
    const store = createLegacyStore();
    const manifestPath = path.join(store.tempDir, "failed-migration.json");
    const unpairedSurrogate =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
    const writeManifest = (messages: string[], targetCount = 1) => {
      const manifest: SessionSqliteMigrationManifest = {
        failedAt: "2030-01-01T00:00:00.000Z",
        manifestVersion: 2,
        openClawVersion: "test",
        runId: "utf16-boundary",
        startedAt: "2030-01-01T00:00:00.000Z",
        targets: Array.from({ length: targetCount }, (_, index) => {
          const targetMessages = index === targetCount - 1 ? messages : ["x".repeat(500)];
          return {
            agentId:
              targetCount === 1
                ? "agent-with-long-name-".repeat(10)
                : `agent-${index}-${"long-name-".repeat(10)}`,
            completedMoves: [],
            issues: targetMessages.map((message) => ({ code: "startup_failure", message })),
            plannedMoves: [],
            sqlitePath: path.join(store.tempDir, "openclaw-agent.sqlite"),
            storePath: store.storePath,
            validationBeforeArchive: "failed",
          };
        }),
      };
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    };

    writeManifest([`${"x".repeat(499)}🎉tail`]);
    const fieldIssue = createSessionSqliteMigrationFailureIssue(manifestPath);
    expect(fieldIssue?.body).not.toMatch(unpairedSurrogate);
    expect(new URL(fieldIssue?.url ?? "").searchParams.get("body")).not.toContain("�");

    const baseMessages = Array.from({ length: 9 }, () => "x".repeat(500));
    writeManifest([...baseMessages, "MESSAGE_START"]);
    const probe = createSessionSqliteMigrationFailureIssue(manifestPath);
    const messageOffset = probe?.body.indexOf("MESSAGE_START") ?? -1;
    expect(5_999 - messageOffset).toBeLessThan(500);

    writeManifest([...baseMessages, `${"x".repeat(5_999 - messageOffset)}🎉tail`]);
    const issue = createSessionSqliteMigrationFailureIssue(manifestPath);
    expect(issue?.body).toContain("🎉tail");
    const urlBody = new URL(issue?.url ?? "").searchParams.get("body");
    expect(urlBody).not.toContain("�");
    expect(urlBody).toContain("truncated for URL");

    let bodyTargetCount = 0;
    let bodyMessageOffset = -1;
    for (let count = 1; count < 50; count += 1) {
      writeManifest(["BODY_START"], count);
      const candidateIssue = createSessionSqliteMigrationFailureIssue(manifestPath);
      const candidateOffset = candidateIssue?.body.indexOf("BODY_START") ?? -1;
      if (candidateOffset < 0) {
        break;
      }
      bodyTargetCount = count;
      bodyMessageOffset = candidateOffset;
    }
    expect(bodyMessageOffset).toBeGreaterThanOrEqual(0);
    expect(19_999 - bodyMessageOffset).toBeLessThan(600);

    writeManifest([`${"x".repeat(19_999 - bodyMessageOffset)}🎉tail`], bodyTargetCount);
    const bodyIssue = createSessionSqliteMigrationFailureIssue(manifestPath);
    expect(bodyIssue?.body).not.toMatch(unpairedSurrogate);
  });

  it("recovers only manifests matching an explicit store selector", async () => {
    const store = createLegacyStore();
    const importReport = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
    const manifest = readMigrationManifest(manifestPath);
    manifest.failedAt = "2030-01-01T00:00:00.000Z";
    expectDefined(manifest.targets[0], "manifest.targets[0] test invariant").issues = [
      { code: "startup_failure", message: "selected store failed after archive" },
    ];
    manifest.targets.push({
      agentId: "other",
      completedMoves: [],
      issues: [{ code: "unselected_failure", message: "unselected target should stay private" }],
      plannedMoves: [],
      sqlitePath: path.join(store.tempDir, "other.sqlite"),
      storePath: path.join(store.tempDir, "other", "sessions.json"),
      validationBeforeArchive: "failed",
    });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    writeFailedManifest(store, "newer-unselected.json", "2040-01-01T00:00:00.000Z", {
      agentId: "other",
      storePath: path.join(store.tempDir, "other", "sessions.json"),
    });

    const recover = await runDoctorSessionSqlite({
      cfg: {},
      env: store.env,
      mode: "recover",
      store: store.storePath,
    });

    expect(recover.migrationRun?.manifestPath).toBe(manifestPath);
    expect(recover.targets[0]?.restore?.manifestPaths).toEqual([manifestPath]);
    expect(recover.supportIssue?.body).not.toContain("unselected_failure");
    expect(fs.existsSync(store.transcriptPath)).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "rejects symlink-backed legacy stores before migration",
    async () => {
      const store = createLegacyStore();
      const realStorePath = path.join(store.tempDir, "real-sessions.json");
      fs.renameSync(store.storePath, realStorePath);
      fs.symlinkSync(realStorePath, store.storePath);

      await expect(
        runDoctorSessionSqlite({
          env: store.env,
          mode: "import",
          store: store.storePath,
        }),
      ).rejects.toThrow("Refusing session SQLite migration through symbolic link");

      expect(fs.lstatSync(store.storePath).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(realStorePath)).toBe(true);
      expect(fs.existsSync(store.transcriptPath)).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects symlink-backed archive directories before migration",
    async () => {
      const store = createLegacyStore();
      const archiveDir = path.join(path.dirname(store.sessionDir), "session-sqlite-import-archive");
      const outsideArchiveDir = path.join(store.tempDir, "outside-archive");
      fs.mkdirSync(outsideArchiveDir, { recursive: true });
      fs.symlinkSync(outsideArchiveDir, archiveDir);

      await expect(
        runDoctorSessionSqlite({
          env: store.env,
          mode: "import",
          store: store.storePath,
        }),
      ).rejects.toThrow("Refusing session SQLite migration through symbolic link");

      expect(fs.existsSync(store.storePath)).toBe(true);
      expect(fs.existsSync(store.transcriptPath)).toBe(true);
      expect(fs.readdirSync(outsideArchiveDir)).toEqual([]);
    },
  );

  it("imports aliases that share one legacy transcript before archiving it", async () => {
    const store = createLegacyStore();
    const legacyStore = JSON.parse(fs.readFileSync(store.storePath, "utf-8")) as Record<
      string,
      unknown
    >;
    legacyStore["agent:main:alias"] = legacyStore["agent:main:main"];
    fs.writeFileSync(store.storePath, `${JSON.stringify(legacyStore, null, 2)}\n`, { mode: 0o600 });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });

    expect(report.totals).toMatchObject({
      archivedTranscriptFiles: 2,
      importedEntries: 2,
      importedTranscriptEvents: 2,
      issues: 0,
      sqliteEntries: 2,
    });
    expect(fs.existsSync(store.transcriptPath)).toBe(false);
    expect(
      loadExactSqliteSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      })?.entry.sessionId,
    ).toBe("session-1");
    expect(
      loadExactSqliteSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:alias",
        storePath: store.storePath,
      })?.entry.sessionId,
    ).toBe("session-1");
  });

  it("leaves legacy transcript symlinks in place instead of archiving them", async () => {
    const store = createLegacyStore();
    const outsideTranscriptPath = path.join(store.tempDir, "outside-session-1.jsonl");
    fs.renameSync(store.transcriptPath, outsideTranscriptPath);
    fs.symlinkSync(outsideTranscriptPath, store.transcriptPath);

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });

    expect(report.targets[0]?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: expect.stringMatching(/archive_failed$/),
        }),
      ]),
    );
    expect(report.targets[0]?.archivedTranscriptFiles).toEqual([]);
    expect(fs.existsSync(outsideTranscriptPath)).toBe(true);
    expect(fs.lstatSync(store.transcriptPath).isSymbolicLink()).toBe(true);
  });

  it("imports explicit stores into the agent database owned by the path", async () => {
    const store = createLegacyStore({ agentDirName: "codex-proof" });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });

    expect(report.targets[0]?.agentId).toBe("codex-proof");
    expect(report.totals).toMatchObject({
      importedEntries: 1,
      importedTranscriptEvents: 2,
      issues: 0,
      sqliteEntries: 1,
    });
    expect(
      loadSqliteTranscriptEventsSync({
        agentId: "codex-proof",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }),
    ).toHaveLength(2);
  });

  it("imports legacy entries even when their transcript sidecar is missing", async () => {
    const store = createLegacyStore();
    fs.rmSync(store.transcriptPath);

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });

    expect(report.totals).toMatchObject({
      importedEntries: 1,
      importedTranscriptEvents: 0,
      issues: 1,
      sqliteEntries: 1,
    });
    expect(report.targets[0]?.issues[0]).toMatchObject({
      code: "transcript_missing",
      sessionKey: "agent:main:main",
    });
    expect(
      loadExactSqliteSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      })?.entry.sessionId,
    ).toBe("session-1");
    expect(
      loadSqliteTranscriptEventsSync({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }),
    ).toEqual([]);
  });

  it("keeps a shared legacy store intact when importing only one agent", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-session-sqlite-"));
    try {
      const stateDir = path.join(tempDir, "state");
      const sessionDir = path.join(tempDir, "shared-session-store");
      const storePath = path.join(sessionDir, "sessions.json");
      const mainTranscriptPath = path.join(sessionDir, "main-session.jsonl");
      const workTranscriptPath = path.join(sessionDir, "work-session.jsonl");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        storePath,
        JSON.stringify({
          "agent:main:main": {
            sessionFile: "main-session.jsonl",
            sessionId: "main-session",
            updatedAt: 20,
          },
          "agent:work:main": {
            sessionFile: "work-session.jsonl",
            sessionId: "work-session",
            updatedAt: 30,
          },
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(mainTranscriptPath, '{"type":"session","sessionId":"main-session"}\n');
      fs.writeFileSync(workTranscriptPath, '{"type":"session","sessionId":"work-session"}\n');

      const report = await runDoctorSessionSqlite({
        agent: "main",
        cfg: {
          agents: { list: [{ default: true, id: "main" }, { id: "work" }] },
          session: { store: storePath },
        },
        env,
        mode: "import",
      });

      expect(report.totals).toMatchObject({
        archivedLegacyStoreFiles: 0,
        archivedTranscriptFiles: 0,
        importedEntries: 1,
        issues: 0,
      });
      expect(fs.existsSync(storePath)).toBe(true);
      expect(fs.existsSync(mainTranscriptPath)).toBe(true);
      expect(fs.existsSync(workTranscriptPath)).toBe(true);
      expect(
        loadExactSqliteSessionEntry({
          agentId: "main",
          sessionKey: "agent:main:main",
          storePath,
        })?.entry.sessionId,
      ).toBe("main-session");
      expect(
        loadExactSqliteSessionEntry({
          agentId: "work",
          sessionKey: "agent:work:main",
          storePath,
        }),
      ).toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("imports shared custom stores into per-agent SQLite targets", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-session-sqlite-"));
    try {
      const stateDir = path.join(tempDir, "state");
      const sessionDir = path.join(tempDir, "shared-session-store");
      const storePath = path.join(sessionDir, "sessions.json");
      const mainTranscriptPath = path.join(sessionDir, "main-session.jsonl");
      const workTranscriptPath = path.join(sessionDir, "work-session.jsonl");
      const orphanTranscriptPath = path.join(sessionDir, "orphan.jsonl");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        storePath,
        JSON.stringify(
          {
            "agent:main:main": {
              sessionFile: "main-session.jsonl",
              sessionId: "main-session",
              updatedAt: 20,
            },
            "agent:work:main": {
              sessionFile: "work-session.jsonl",
              sessionId: "work-session",
              updatedAt: 30,
            },
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      fs.writeFileSync(mainTranscriptPath, '{"type":"session","sessionId":"main-session"}\n', {
        mode: 0o600,
      });
      fs.writeFileSync(workTranscriptPath, '{"type":"session","sessionId":"work-session"}\n', {
        mode: 0o600,
      });
      fs.writeFileSync(orphanTranscriptPath, '{"type":"event","id":"orphan"}\n', { mode: 0o600 });

      const report = await runDoctorSessionSqlite({
        allAgents: true,
        cfg: {
          agents: { list: [{ default: true, id: "main" }, { id: "work" }] },
          session: { store: storePath },
        },
        env,
        mode: "import",
      });

      expect(report.targets.map((target) => target.agentId)).toEqual(["main", "work"]);
      expect(report.totals).toMatchObject({
        archivedLegacyStoreFiles: 1,
        archivedTranscriptFiles: 2,
        archivedUnreferencedJsonlFiles: 1,
        importedEntries: 2,
        importedTranscriptEvents: 2,
        issues: 0,
        sqliteEntries: 2,
      });
      const manifest = readMigrationManifest(report.migrationRun?.manifestPath);
      for (const target of manifest.targets) {
        expect(target.completedMoves.some((move) => move.kind === "legacy-store")).toBe(true);
      }
      expect(
        loadExactSqliteSessionEntry({
          agentId: "main",
          sessionKey: "agent:main:main",
          storePath,
        })?.entry.sessionId,
      ).toBe("main-session");
      expect(
        loadExactSqliteSessionEntry({
          agentId: "work",
          sessionKey: "agent:work:main",
          storePath,
        })?.entry.sessionId,
      ).toBe("work-session");
      expect(fs.existsSync(mainTranscriptPath)).toBe(false);
      expect(fs.existsSync(workTranscriptPath)).toBe(false);
      expect(fs.existsSync(orphanTranscriptPath)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports active JSONL files left beside SQLite-backed sessions", async () => {
    const store = createLegacyStore();

    await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    fs.writeFileSync(store.transcriptPath, '{"type":"event","id":"heartbeat"}\n', {
      mode: 0o600,
    });
    await upsertSqliteSessionEntry(
      {
        agentId: "main",
        env: store.env,
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      },
      {
        sessionFile: "session-1.jsonl",
        sessionId: "session-1",
        updatedAt: 3000,
      },
    );

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "inspect",
      store: store.storePath,
    });

    expect(report.totals.issues).toBe(1);
    expect(report.targets[0]?.issues[0]).toMatchObject({
      code: "active_sqlite_transcript_jsonl",
      sessionKey: "agent:main:main",
    });
    expect(report.targets[0]?.issues[0]?.message).toContain("session-1.jsonl");
  });

  it("reports active JSONL scan failures without aborting inspect", async () => {
    const store = createLegacyStore();
    const sqlitePath = path.join(
      store.stateDir,
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    fs.writeFileSync(sqlitePath, "not a sqlite database\n", { mode: 0o600 });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "inspect",
      store: store.storePath,
    });

    expect(report.totals.issues).toBe(2);
    expect(report.targets[0]?.issues.map((issue) => issue.code)).toEqual([
      "sqlite_corrupt",
      "sqlite_active_transcript_scan_failed",
    ]);
  });

  it("moves corrupt SQLite database files aside during recovery", async () => {
    const store = createLegacyStore();
    const sqlitePath = path.join(
      store.stateDir,
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    fs.writeFileSync(sqlitePath, "not a sqlite database\n", { mode: 0o600 });
    fs.writeFileSync(`${sqlitePath}-wal`, "wal", { mode: 0o600 });
    fs.writeFileSync(`${sqlitePath}-shm`, "shm", { mode: 0o600 });
    fs.writeFileSync(`${sqlitePath}-journal`, "journal", { mode: 0o600 });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "recover",
      store: store.storePath,
    });

    expect(report.totals.issues).toBe(0);
    expect(report.targets[0]?.corruptRecovery?.movedFiles).toHaveLength(4);
    expect(report.targets[0]?.corruptRecovery?.skippedFiles).toEqual([]);
    for (const candidate of resolveSqliteDatabaseFilePaths(sqlitePath)) {
      expect(fs.existsSync(candidate)).toBe(false);
      expect(
        report.targets[0]?.corruptRecovery?.movedFiles.some((filePath) =>
          filePath.startsWith(`${candidate}.corrupt-`),
        ),
      ).toBe(true);
    }
  });

  it.skipIf(process.platform === "win32")(
    "recovers owner-readable corrupt SQLite database files",
    async () => {
      const store = createLegacyStore();
      const sqlitePath = path.join(
        store.stateDir,
        "agents",
        "main",
        "agent",
        "openclaw-agent.sqlite",
      );
      fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
      fs.writeFileSync(sqlitePath, "not a sqlite database\n", { mode: 0o400 });

      const report = await runDoctorSessionSqlite({
        env: store.env,
        mode: "recover",
        store: store.storePath,
      });

      expect(report.totals.issues).toBe(0);
      expect(report.targets[0]?.corruptRecovery?.movedFiles).toEqual([
        expect.stringMatching(/openclaw-agent\.sqlite\.corrupt-/u),
      ]);
      expect(fs.existsSync(sqlitePath)).toBe(false);
    },
  );

  it("moves orphaned SQLite sidecars aside during recovery", async () => {
    const store = createLegacyStore();
    const sqlitePath = path.join(
      store.stateDir,
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    fs.writeFileSync(`${sqlitePath}-wal`, "wal", { mode: 0o600 });
    fs.writeFileSync(`${sqlitePath}-journal`, "journal", { mode: 0o600 });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "recover",
      store: store.storePath,
    });

    expect(report.totals.issues).toBe(0);
    expect(report.targets[0]?.corruptRecovery?.movedFiles).toHaveLength(2);
    expect(report.targets[0]?.corruptRecovery?.skippedFiles).toEqual([
      sqlitePath,
      `${sqlitePath}-shm`,
    ]);
    expect(fs.existsSync(`${sqlitePath}-wal`)).toBe(false);
    expect(fs.existsSync(`${sqlitePath}-journal`)).toBe(false);
  });

  it("rolls back every completed corrupt-file move when a later rename fails", async () => {
    const store = createLegacyStore();
    const sqlitePath = path.join(
      store.stateDir,
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const expectedContents = new Map<string, string>();
    for (const [candidate, contents] of [
      [sqlitePath, "not a sqlite database\n"],
      [`${sqlitePath}-wal`, "wal"],
      [`${sqlitePath}-shm`, "shm"],
      [`${sqlitePath}-journal`, "journal"],
    ] as const) {
      fs.writeFileSync(candidate, contents, { mode: 0o600 });
      expectedContents.set(candidate, contents);
    }
    const renameSync = fs.renameSync.bind(fs);
    let renameCalls = 0;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      renameCalls += 1;
      if (renameCalls === 2) {
        throw new Error("forced corrupt recovery rename failure");
      }
      renameSync(source, destination);
    });

    let report: Awaited<ReturnType<typeof runDoctorSessionSqlite>> | undefined;
    try {
      report = await runDoctorSessionSqlite({
        env: store.env,
        mode: "recover",
        store: store.storePath,
      });
    } finally {
      renameSpy.mockRestore();
    }

    expect(report?.totals.issues).toBe(1);
    expect(report?.targets[0]?.corruptRecovery).toBeUndefined();
    expect(report?.targets[0]?.issues[0]).toMatchObject({
      code: "sqlite_corrupt_recovery_failed",
      message: expect.stringContaining("forced corrupt recovery rename failure"),
    });
    for (const [candidate, contents] of expectedContents) {
      expect(fs.readFileSync(candidate, "utf8")).toBe(contents);
    }
    expect(
      fs.readdirSync(path.dirname(sqlitePath)).filter((entry) => entry.includes(".corrupt-")),
    ).toEqual([]);
  });

  it("does not move SQLite paths aside for non-corruption recovery inspection failures", async () => {
    const store = createLegacyStore();
    const sqlitePath = path.join(
      store.stateDir,
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    fs.mkdirSync(sqlitePath, { recursive: true });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "recover",
      store: store.storePath,
    });

    expect(report.totals.issues).toBe(1);
    expect(report.targets[0]?.issues[0]?.code).toBe("sqlite_recovery_inspect_failed");
    expect(report.targets[0]?.corruptRecovery).toBeUndefined();
    expect(fs.statSync(sqlitePath).isDirectory()).toBe(true);
  });

  it("reports SQLite loader failures without aborting recovery", async () => {
    const store = createLegacyStore();
    const sqlitePath = path.join(
      store.stateDir,
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    fs.writeFileSync(sqlitePath, "not a sqlite database\n", { mode: 0o600 });
    const requireSqlite = vi.spyOn(nodeSqlite, "requireNodeSqlite").mockImplementationOnce(() => {
      throw new Error("node:sqlite unavailable");
    });

    let report: Awaited<ReturnType<typeof runDoctorSessionSqlite>> | undefined;
    try {
      report = await runDoctorSessionSqlite({
        env: store.env,
        mode: "recover",
        store: store.storePath,
      });
    } finally {
      requireSqlite.mockRestore();
    }

    expect(report?.totals.issues).toBe(1);
    expect(report?.targets[0]?.issues[0]).toMatchObject({
      code: "sqlite_recovery_inspect_failed",
      message: expect.stringContaining("node:sqlite unavailable"),
    });
    expect(report?.targets[0]?.corruptRecovery).toBeUndefined();
    expect(fs.existsSync(sqlitePath)).toBe(true);
  });

  it("does not truncate existing SQLite transcript rows when re-importing a duplicate fragment", async () => {
    const store = createLegacyStore({
      transcriptLines: [
        '{"type":"session","sessionId":"session-1"}',
        '{"type":"message","id":"msg-1","message":{"role":"user","content":"first"}}',
        '{"type":"message","id":"msg-2","message":{"role":"assistant","content":"second"}}',
      ],
    });

    await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    fs.writeFileSync(
      store.transcriptPath,
      '{"type":"message","id":"msg-2","message":{"role":"assistant","content":"second"}}\n',
      { mode: 0o600 },
    );
    fs.writeFileSync(store.trajectoryPath, `${JSON.stringify({ type: "trajectory" })}\n`, {
      mode: 0o600,
    });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });

    expect(report.totals).toMatchObject({
      archivedTranscriptFiles: 0,
      importedEntries: 0,
      importedTranscriptEvents: 0,
      issues: 0,
    });
    expect(
      loadSqliteTranscriptEventsSync({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }),
    ).toHaveLength(3);
  });

  it("reports custom explicit store sqlite paths beside the store", async () => {
    const store = createLegacyStore({ customStore: true });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });

    expect(report.targets[0]?.sqlitePath).toBe(
      path.join(store.sessionDir, "openclaw-agent.sqlite"),
    );
    expect(
      fs.existsSync(
        expectDefined(
          report.targets[0]?.sqlitePath,
          "report.targets[0]?.sqlitePath test invariant",
        ),
      ),
    ).toBe(true);
    expect(
      loadSqliteTranscriptEventsSync({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }),
    ).toHaveLength(2);
  });

  it("imports valid transcript rows when only the final JSONL line is crash-truncated", async () => {
    const store = createLegacyStore();
    fs.writeFileSync(
      store.transcriptPath,
      '{"type":"session","sessionId":"session-1"}\n{"type":"message"',
      { mode: 0o600 },
    );

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });

    expect(report.totals).toMatchObject({
      importedEntries: 1,
      importedTranscriptEvents: 1,
      issues: 0,
      sqliteEntries: 1,
    });
    expect(
      loadSqliteTranscriptEventsSync({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }),
    ).toHaveLength(1);
    expect(fs.existsSync(store.transcriptPath)).toBe(false);
  });

  it("reports malformed transcripts while importing the session entry", async () => {
    const store = createLegacyStore({
      agentDirName: "token=supersecret",
      transcriptLines: ['{"type":"session","sessionId":"session-1"}', "{bad"],
    });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const inspect = await runDoctorSessionSqlite({
      env: store.env,
      mode: "inspect",
      store: store.storePath,
    });

    expect(report.totals.issues).toBe(1);
    expect(report.totals).toMatchObject({
      archivedTranscriptFiles: 2,
      archivedUnreferencedJsonlFiles: 1,
      importedEntries: 1,
      importedTranscriptEvents: 1,
      sqliteEntries: 1,
      unreferencedJsonlFiles: 0,
    });
    expect(report.targets[0]?.issues[0]?.code).toBe("transcript_malformed");
    expect(fs.existsSync(store.transcriptPath)).toBe(false);
    expect(fs.existsSync(store.unreferencedJsonlPath)).toBe(false);
    expect(inspect.totals.sqliteEntries).toBe(1);
    expect(
      loadSqliteTranscriptEventsSync({
        agentId: "token-supersecret",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }),
    ).toHaveLength(1);
    const manifest = readMigrationManifest(report.migrationRun?.manifestPath);
    expect(manifest.targets[0]?.completedMoves.some((move) => move.kind === "transcript")).toBe(
      true,
    );
    expect(
      manifest.targets[0]?.completedMoves.some((move) => move.kind === "unreferenced-jsonl"),
    ).toBe(true);
    expect(report.migrationRun?.failureReportMarkdownPath).toBeTruthy();
    const failureReport = fs.readFileSync(
      report.migrationRun?.failureReportMarkdownPath ?? "",
      "utf-8",
    );
    expect(failureReport).toContain("transcript_malformed");
    expect(failureReport).toContain("openclaw doctor --session-sqlite recover --github-issue");
    expect(failureReport).not.toContain("supersecret");
  });

  it("reports malformed selected legacy transcripts during validation", async () => {
    const store = createLegacyStore({ transcriptLines: ['{"type":"session"}', "{bad"] });
    await upsertSqliteSessionEntry(
      {
        agentId: "main",
        env: store.env,
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      },
      { sessionId: "session-1", updatedAt: 2000 },
    );

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "validate",
      store: store.storePath,
    });

    expect(report.totals).toMatchObject({
      issues: 2,
      sqliteEntries: 1,
      validatedEntries: 1,
      validatedTranscriptEvents: 0,
    });
    expect(report.targets[0]?.issues[0]).toMatchObject({
      code: "transcript_malformed",
      sessionKey: "agent:main:main",
    });
  });
});

async function createImportedStoreForCompaction(): Promise<{
  sqlitePath: string;
  store: TestStore;
}> {
  const store = createLegacyStore();
  const report = await runDoctorSessionSqlite({
    env: store.env,
    mode: "import",
    store: store.storePath,
  });
  const sqlitePath = report.targets[0]?.sqlitePath;
  if (!sqlitePath) {
    throw new Error("expected imported agent SQLite path");
  }
  closeOpenClawAgentDatabasesForTest();
  return { sqlitePath, store };
}

// Build the physical v1 layout directly so the doctor path, not the runtime
// opener, owns the upgrade. Empty session tables preserve the dormant-agent
// reproduction: import has no rows to open before its compact step.
function createHistoricalV1AgentDatabase(params: {
  agentId: string;
  env: NodeJS.ProcessEnv;
}): string {
  const sqlitePath = resolveOpenClawAgentSqlitePath(params);
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const sqlite = nodeSqlite.requireNodeSqlite();
  const database = new sqlite.DatabaseSync(sqlitePath);
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
      CREATE TABLE sessions (
        session_id TEXT NOT NULL PRIMARY KEY,
        session_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE session_entries (
        session_key TEXT NOT NULL PRIMARY KEY,
        session_id TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      CREATE TABLE memory_index_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL
      );
      INSERT INTO memory_index_state (id, revision) VALUES (1, 1);
      CREATE TABLE memory_index_sources (
        source_kind TEXT NOT NULL DEFAULT 'memory',
        source_key TEXT NOT NULL,
        path TEXT,
        session_id TEXT,
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY (source_kind, source_key),
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      CREATE TABLE memory_index_chunks (
        id TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL DEFAULT 'memory',
        source_key TEXT NOT NULL,
        path TEXT NOT NULL,
        session_id TEXT,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        hash TEXT NOT NULL,
        model TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB NOT NULL,
        embedding_dims INTEGER,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (source_kind, source_key)
          REFERENCES memory_index_sources(source_kind, source_key) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      PRAGMA user_version = 1;
    `);
    database
      .prepare(
        `
          INSERT INTO schema_meta
            (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
          VALUES ('primary', 'agent', 1, ?, NULL, 1, 1)
        `,
      )
      .run(params.agentId);
  } finally {
    database.close();
  }
  return sqlitePath;
}

function createUnsafeIndexDrift(sqlitePath: string): void {
  const sqlite = nodeSqlite.requireNodeSqlite();
  const database = new sqlite.DatabaseSync(sqlitePath);
  try {
    database.exec(`
      CREATE TABLE unsafe_session_index_records (
        id INTEGER PRIMARY KEY,
        indexed_value TEXT NOT NULL,
        alternate_value TEXT NOT NULL
      );
      CREATE INDEX unsafe_session_index
      ON unsafe_session_index_records(indexed_value);
      INSERT INTO unsafe_session_index_records (indexed_value, alternate_value)
      VALUES ('alpha', 'zeta'), ('beta', 'eta'), ('gamma', 'theta');
    `);
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare(
        "UPDATE sqlite_schema SET sql = 'CREATE INDEX unsafe_session_index ON unsafe_session_index_records(alternate_value)' WHERE name = 'unsafe_session_index'",
      )
      .run();
    database.exec("PRAGMA writable_schema = OFF;");
    const schemaVersionRow = database.prepare("PRAGMA schema_version;").get() as
      | Record<string, unknown>
      | undefined;
    const schemaVersion = Number(
      schemaVersionRow?.schema_version ??
        (schemaVersionRow ? Object.values(schemaVersionRow)[0] : undefined),
    );
    database.exec(`PRAGMA schema_version = ${schemaVersion + 1};`);
  } finally {
    database.close();
  }
}

function createLegacyStore(
  params: {
    agentDirName?: string;
    customStore?: boolean;
    entryOverrides?: Record<string, unknown>;
    tempRoot?: string;
    transcriptLines?: string[];
  } = {},
): TestStore {
  const tempDir = autoCleanupTempDirs.make("openclaw-doctor-session-sqlite-", params.tempRoot);
  const stateDir = path.join(tempDir, "state");
  const configPath = path.join(tempDir, "openclaw.json");
  const sessionDir = params.customStore
    ? path.join(tempDir, "legacy-session-store")
    : path.join(stateDir, "agents", params.agentDirName ?? "main", "sessions");
  const storePath = path.join(sessionDir, "sessions.json");
  const transcriptPath = path.join(sessionDir, "session-1.jsonl");
  const trajectoryPath = path.join(sessionDir, "session-1.trajectory.jsonl");
  const unreferencedJsonlPath = path.join(sessionDir, "orphan.jsonl");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(configPath, "{}\n", { mode: 0o600 });
  fs.writeFileSync(
    storePath,
    JSON.stringify(
      {
        "agent:main:main": {
          channel: "cli",
          chatType: "direct",
          sessionFile: "session-1.jsonl",
          sessionId: "session-1",
          sessionStartedAt: 1000,
          updatedAt: 2000,
          ...params.entryOverrides,
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    transcriptPath,
    `${(params.transcriptLines ?? ['{"type":"session","sessionId":"session-1"}', '{"type":"event","id":"evt-1"}']).join("\n")}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(trajectoryPath, `${JSON.stringify({ type: "trajectory" })}\n`, {
    mode: 0o600,
  });
  fs.writeFileSync(unreferencedJsonlPath, '{"type":"event"}\n', {
    mode: 0o600,
  });
  const env = {
    ...process.env,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
  };
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  return {
    configPath,
    env,
    sessionDir,
    stateDir,
    storePath,
    tempDir,
    unreferencedJsonlPath,
    trajectoryPath,
    transcriptPath,
  };
}

function readMigrationManifest(manifestPath: string | undefined): SessionSqliteMigrationManifest {
  if (!manifestPath) {
    throw new Error("expected migration manifest path");
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as SessionSqliteMigrationManifest;
}

function requireMigrationManifestPath(manifestPath: string | undefined): string {
  if (!manifestPath) {
    throw new Error("expected migration manifest path");
  }
  return manifestPath;
}

function trustedMigrationTarget(store: TestStore) {
  const target = { agentId: "main", storePath: store.storePath };
  return {
    ...target,
    sqlitePath: resolveTargetSqlitePath(target),
  };
}

function writeFailedManifest(
  store: TestStore,
  fileName: string,
  failedAt: string,
  target: { agentId?: string; storePath?: string } = {},
): void {
  const runsDir = path.join(store.stateDir, "session-sqlite-migration-runs");
  fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(runsDir, fileName),
    `${JSON.stringify(
      {
        failedAt,
        manifestVersion: 1,
        openClawVersion: "test",
        runId: path.basename(fileName, ".json"),
        startedAt: failedAt,
        targets: [
          {
            agentId: target.agentId ?? "older",
            completedMoves: [],
            issues: [{ code: "older_failure", message: "older failure" }],
            plannedMoves: [],
            sqlitePath: path.join(store.tempDir, "older.sqlite"),
            storePath: target.storePath ?? path.join(store.tempDir, "older-sessions.json"),
            validationBeforeArchive: "failed",
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

function canonicalTestPaths(paths: string[]): string[] {
  return paths.map((filePath) => canonicalTestPath(filePath)).toSorted();
}

function canonicalTestPath(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function restoreEnvValue(key: keyof NodeJS.ProcessEnv, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
