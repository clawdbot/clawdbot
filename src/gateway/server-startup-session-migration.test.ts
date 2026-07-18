/**
 * Gateway startup session migration tests.
 */
import { describe, expect, it, vi } from "vitest";
import { runStartupSessionMigration } from "./server-startup-session-migration.js";

type StartupMigrationDeps = NonNullable<Parameters<typeof runStartupSessionMigration>[0]["deps"]>;
type MigrateSessionKeys = NonNullable<StartupMigrationDeps["migrateOrphanedSessionKeys"]>;
type ResolveStoreTargets = NonNullable<
  StartupMigrationDeps["resolveAllAgentSessionStoreTargetsSync"]
>;
type SweepStoreTemps = NonNullable<StartupMigrationDeps["sweepOrphanSessionStoreTemps"]>;
type RunDoctorSessionSqlite = NonNullable<StartupMigrationDeps["runDoctorSessionSqlite"]>;
type ReconcileSessionTranscriptIndexes = NonNullable<
  StartupMigrationDeps["reconcileSessionTranscriptIndexes"]
>;

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function makeCfg() {
  return { agents: { defaults: {} }, session: {} } as Parameters<
    typeof runStartupSessionMigration
  >[0]["cfg"];
}

// Every test injects store-target and sweep mocks so startup never scans the
// real filesystem, and a SQLite import mock so startup never runs real doctor.
function makeDeps(
  migrate: MigrateSessionKeys,
  removedFiles = 0,
  runDoctorSessionSqlite: RunDoctorSessionSqlite = makeSessionSqliteImport(),
  reconcileSessionTranscriptIndexes: ReconcileSessionTranscriptIndexes = vi
    .fn<ReconcileSessionTranscriptIndexes>()
    .mockResolvedValue({ reconciledSessions: 0 }),
) {
  return {
    migrateOrphanedSessionKeys: migrate,
    resolveAllAgentSessionStoreTargetsSync: vi.fn<ResolveStoreTargets>().mockReturnValue([
      { agentId: "main", storePath: "/tmp/main/sessions.json" },
      { agentId: "ops", storePath: "/tmp/ops/sessions.json" },
    ]),
    sweepOrphanSessionStoreTemps: vi
      .fn<SweepStoreTemps>()
      .mockResolvedValueOnce(removedFiles)
      .mockResolvedValue(0),
    runDoctorSessionSqlite,
    reconcileSessionTranscriptIndexes,
  };
}

function firstLogMessage(log: ReturnType<typeof vi.fn>, label: string): string {
  const [message] = log.mock.calls[0] ?? [];
  if (typeof message !== "string") {
    throw new Error(`expected ${label} message`);
  }
  return message;
}

function makeSessionSqliteImport(
  report: Partial<Awaited<ReturnType<RunDoctorSessionSqlite>>> = {},
): RunDoctorSessionSqlite {
  return vi.fn().mockResolvedValue({
    mode: "import",
    targets: [],
    totals: {
      archivedTranscriptFiles: 0,
      archivedUnreferencedJsonlFiles: 0,
      importedEntries: 0,
      importedTranscriptEvents: 0,
      issues: 0,
      legacyEntries: 0,
      sqliteEntries: 0,
      targets: 0,
      unreferencedJsonlFiles: 0,
      validatedEntries: 0,
      validatedTranscriptEvents: 0,
    },
    ...report,
  });
}

describe("runStartupSessionMigration", () => {
  it("logs changes when orphaned keys are canonicalized", async () => {
    const log = makeLog();
    const migrate = vi.fn<MigrateSessionKeys>().mockResolvedValue({
      changes: ["Canonicalized 2 orphaned session key(s) in /tmp/store.json"],
      warnings: [],
    });
    await runStartupSessionMigration({
      cfg: makeCfg(),
      log,
      deps: makeDeps(migrate),
    });
    expect(migrate).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledOnce();
    expect(firstLogMessage(log.info, "startup migration info")).toContain(
      "canonicalized orphaned session keys",
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("logs warnings from migration", async () => {
    const log = makeLog();
    const migrate = vi.fn<MigrateSessionKeys>().mockResolvedValue({
      changes: [],
      warnings: ["Could not read /bad/path: ENOENT"],
    });
    await runStartupSessionMigration({
      cfg: makeCfg(),
      log,
      deps: makeDeps(migrate),
    });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledOnce();
    expect(firstLogMessage(log.warn, "startup migration warning")).toContain(
      "session key migration warnings",
    );
  });

  it("sweeps each discovered store and logs removed temp files", async () => {
    const log = makeLog();
    const migrate = vi.fn<MigrateSessionKeys>().mockResolvedValue({ changes: [], warnings: [] });
    const deps = makeDeps(migrate, 3);
    await runStartupSessionMigration({
      cfg: makeCfg(),
      log,
      deps,
    });
    expect(deps.sweepOrphanSessionStoreTemps).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith("session: removed 3 stale session store temp file(s)");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("catches and logs migration errors without throwing", async () => {
    const log = makeLog();
    const migrate = vi.fn<MigrateSessionKeys>().mockRejectedValue(new Error("disk full"));
    await runStartupSessionMigration({
      cfg: makeCfg(),
      log,
      deps: makeDeps(migrate),
    });
    expect(log.warn).toHaveBeenCalledOnce();
    const warning = firstLogMessage(log.warn, "startup migration failure warning");
    expect(warning).toContain("migration failed during startup");
    expect(warning).toContain("disk full");
  });

  it("isolates temp-cleanup discovery failures from startup", async () => {
    const log = makeLog();
    const migrate = vi.fn<MigrateSessionKeys>().mockResolvedValue({ changes: [], warnings: [] });
    const deps = makeDeps(migrate);
    deps.resolveAllAgentSessionStoreTargetsSync.mockImplementation(() => {
      throw new Error("permission denied");
    });

    await runStartupSessionMigration({ cfg: makeCfg(), log, deps });

    expect(log.warn).toHaveBeenCalledOnce();
    const warning = firstLogMessage(log.warn, "startup cleanup failure warning");
    expect(warning).toContain("temp cleanup failed during startup");
    expect(warning).toContain("permission denied");
  });

  it("imports legacy session metadata and transcripts into SQLite during startup", async () => {
    const log = makeLog();
    const cfg = makeCfg();
    const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" };
    const migrate = vi.fn<MigrateSessionKeys>().mockResolvedValue({ changes: [], warnings: [] });
    const runDoctorSessionSqlite = makeSessionSqliteImport({
      totals: {
        archivedTranscriptFiles: 2,
        archivedUnreferencedJsonlFiles: 1,
        importedEntries: 3,
        importedTranscriptEvents: 9,
        issues: 0,
        legacyEntries: 3,
        sqliteEntries: 3,
        targets: 1,
        unreferencedJsonlFiles: 0,
        validatedEntries: 0,
        validatedTranscriptEvents: 0,
      },
    });

    await runStartupSessionMigration({
      cfg,
      env,
      log,
      deps: makeDeps(migrate, 0, runDoctorSessionSqlite),
    });

    expect(runDoctorSessionSqlite).toHaveBeenCalledWith({
      allAgents: true,
      cfg,
      env,
      mode: "import",
    });
    expect(firstLogMessage(log.info, "sqlite import info")).toContain(
      "session: imported legacy session metadata/transcripts into SQLite",
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("reconciles configured agent transcript projections before startup completes", async () => {
    const log = makeLog();
    const migrate = vi.fn<MigrateSessionKeys>().mockResolvedValue({ changes: [], warnings: [] });
    const reconcile = vi
      .fn<ReconcileSessionTranscriptIndexes>()
      .mockResolvedValueOnce({ reconciledSessions: 2 })
      .mockResolvedValueOnce({ reconciledSessions: 1 });
    const cfg = {
      agents: { defaults: {}, list: [{ id: "main" }, { id: "ops" }] },
      session: {},
    } as Parameters<typeof runStartupSessionMigration>[0]["cfg"];

    await runStartupSessionMigration({
      cfg,
      log,
      deps: makeDeps(migrate, 0, makeSessionSqliteImport(), reconcile),
    });

    expect(reconcile).toHaveBeenNthCalledWith(1, { agentId: "main" });
    expect(reconcile).toHaveBeenNthCalledWith(2, { agentId: "ops" });
    expect(log.info).toHaveBeenCalledWith(
      "session: rebuilt 3 transcript projection(s) before serving history",
    );
  });

  it("warns without blocking when hot legacy session SQLite import reports legacy file issues", async () => {
    const log = makeLog();
    const migrate = vi.fn<MigrateSessionKeys>().mockResolvedValue({ changes: [], warnings: [] });
    const runDoctorSessionSqlite = makeSessionSqliteImport({
      targets: [
        {
          agentId: "main",
          archivedTranscriptFiles: [],
          archivedUnreferencedJsonlFiles: [],
          importedEntries: 0,
          importedTranscriptEvents: 0,
          issues: [
            {
              code: "transcript_malformed",
              message: "/tmp/bad.jsonl: SyntaxError",
              sessionKey: "agent:main:main",
            },
          ],
          legacyEntries: 1,
          referencedTranscriptFiles: 1,
          sqliteEntries: 0,
          sqlitePath: "/tmp/openclaw-agent.sqlite",
          storePath: "/tmp/sessions.json",
          unreferencedJsonlFiles: [],
          validatedEntries: 0,
          validatedTranscriptEvents: 0,
        },
      ],
      totals: {
        archivedTranscriptFiles: 0,
        archivedUnreferencedJsonlFiles: 0,
        importedEntries: 0,
        importedTranscriptEvents: 0,
        issues: 1,
        legacyEntries: 1,
        sqliteEntries: 0,
        targets: 1,
        unreferencedJsonlFiles: 0,
        validatedEntries: 0,
        validatedTranscriptEvents: 0,
      },
    });

    await runStartupSessionMigration({
      cfg: makeCfg(),
      log,
      deps: makeDeps(migrate, 0, runDoctorSessionSqlite),
    });

    expect(firstLogMessage(log.warn, "malformed transcript warning")).toContain(
      "session SQLite migration warnings",
    );
  });

  it("classifies corrupt SQLite startup failures with recovery guidance", async () => {
    const log = makeLog();
    const migrate = vi.fn<MigrateSessionKeys>().mockResolvedValue({ changes: [], warnings: [] });
    const runDoctorSessionSqlite = vi.fn().mockRejectedValue(new Error("file is not a database"));

    await expect(
      runStartupSessionMigration({
        cfg: makeCfg(),
        log,
        deps: makeDeps(migrate, 0, runDoctorSessionSqlite),
      }),
    ).rejects.toThrow("openclaw doctor --session-sqlite recover --session-sqlite-all-agents");
  });

  it("auto-restores the current failed session SQLite migration run after files moved", async () => {
    const log = makeLog();
    const migrate = vi.fn<MigrateSessionKeys>().mockResolvedValue({ changes: [], warnings: [] });
    const restoreSessionSqliteMigrationRun = vi.fn(() => ({
      conflicts: [],
      manifestPaths: ["/tmp/run.json"],
      restoredFiles: ["/tmp/session.jsonl"],
      skippedFiles: [],
    }));
    const writeSessionSqliteMigrationFailureReports = vi.fn(() => ({
      jsonPath: "/tmp/run.failure.json",
      markdownPath: "/tmp/run.failure.md",
    }));
    const runDoctorSessionSqlite = makeSessionSqliteImport({
      migrationRun: {
        manifestPath: "/tmp/run.json",
        runId: "run",
      },
      targets: [
        {
          agentId: "main",
          archivedTranscriptFiles: ["/tmp/archive/session.jsonl"],
          archivedUnreferencedJsonlFiles: [],
          importedEntries: 1,
          importedTranscriptEvents: 1,
          issues: [
            {
              code: "active_sqlite_transcript_jsonl",
              message: "active file remained",
              sessionKey: "agent:main:main",
            },
          ],
          legacyEntries: 1,
          referencedTranscriptFiles: 1,
          sqliteEntries: 1,
          sqlitePath: "/tmp/openclaw-agent.sqlite",
          storePath: "/tmp/sessions.json",
          unreferencedJsonlFiles: [],
          validatedEntries: 1,
          validatedTranscriptEvents: 1,
        },
      ],
      totals: {
        archivedTranscriptFiles: 1,
        archivedUnreferencedJsonlFiles: 0,
        importedEntries: 1,
        importedTranscriptEvents: 1,
        issues: 1,
        legacyEntries: 1,
        sqliteEntries: 1,
        targets: 1,
        unreferencedJsonlFiles: 0,
        validatedEntries: 1,
        validatedTranscriptEvents: 1,
      },
    });

    await expect(
      runStartupSessionMigration({
        cfg: makeCfg(),
        log,
        deps: {
          ...makeDeps(migrate, 0, runDoctorSessionSqlite),
          restoreSessionSqliteMigrationRun,
          writeSessionSqliteMigrationFailureReports,
        },
      }),
    ).rejects.toThrow("Failure report: /tmp/run.failure.md");

    expect(restoreSessionSqliteMigrationRun).toHaveBeenCalledWith({
      manifestPath: "/tmp/run.json",
      trustedTargets: [
        {
          agentId: "main",
          sqlitePath: "/tmp/openclaw-agent.sqlite",
          storePath: "/tmp/sessions.json",
        },
      ],
    });
    expect(writeSessionSqliteMigrationFailureReports).toHaveBeenCalledWith("/tmp/run.json", {
      reason: "startup blocked on 1 session SQLite issue(s)",
    });
    expect(firstLogMessage(log.warn, "startup restore warning")).toContain("restored=1");
  });

  it("warns without blocking when a legacy transcript sidecar is missing", async () => {
    const log = makeLog();
    const migrate = vi.fn<MigrateSessionKeys>().mockResolvedValue({ changes: [], warnings: [] });
    const runDoctorSessionSqlite = makeSessionSqliteImport({
      targets: [
        {
          agentId: "main",
          archivedTranscriptFiles: [],
          archivedUnreferencedJsonlFiles: [],
          importedEntries: 1,
          importedTranscriptEvents: 0,
          issues: [
            {
              code: "transcript_missing",
              message: "Transcript file is missing: /tmp/missing.jsonl",
              sessionKey: "agent:main:main",
            },
          ],
          legacyEntries: 1,
          referencedTranscriptFiles: 1,
          sqliteEntries: 1,
          sqlitePath: "/tmp/openclaw-agent.sqlite",
          storePath: "/tmp/sessions.json",
          unreferencedJsonlFiles: [],
          validatedEntries: 0,
          validatedTranscriptEvents: 0,
        },
      ],
      totals: {
        archivedTranscriptFiles: 0,
        archivedUnreferencedJsonlFiles: 0,
        importedEntries: 1,
        importedTranscriptEvents: 0,
        issues: 1,
        legacyEntries: 1,
        sqliteEntries: 1,
        targets: 1,
        unreferencedJsonlFiles: 0,
        validatedEntries: 0,
        validatedTranscriptEvents: 0,
      },
    });

    await runStartupSessionMigration({
      cfg: makeCfg(),
      log,
      deps: makeDeps(migrate, 0, runDoctorSessionSqlite),
    });

    expect(firstLogMessage(log.warn, "missing transcript warning")).toContain(
      "session SQLite migration warnings",
    );
  });

  it("warns without blocking when only stale archive-tier JSONL archival fails", async () => {
    const log = makeLog();
    const migrate = vi.fn<MigrateSessionKeys>().mockResolvedValue({ changes: [], warnings: [] });
    const runDoctorSessionSqlite = makeSessionSqliteImport({
      targets: [
        {
          agentId: "main",
          archivedTranscriptFiles: [],
          archivedUnreferencedJsonlFiles: [],
          importedEntries: 1,
          importedTranscriptEvents: 1,
          issues: [
            {
              code: "unreferenced_jsonl_archive_failed",
              message: "/tmp/orphan.jsonl: permission denied",
            },
          ],
          legacyEntries: 1,
          referencedTranscriptFiles: 1,
          sqliteEntries: 1,
          sqlitePath: "/tmp/openclaw-agent.sqlite",
          storePath: "/tmp/sessions.json",
          unreferencedJsonlFiles: ["/tmp/orphan.jsonl"],
          validatedEntries: 0,
          validatedTranscriptEvents: 0,
        },
      ],
      totals: {
        archivedTranscriptFiles: 0,
        archivedUnreferencedJsonlFiles: 0,
        importedEntries: 1,
        importedTranscriptEvents: 1,
        issues: 1,
        legacyEntries: 1,
        sqliteEntries: 1,
        targets: 1,
        unreferencedJsonlFiles: 1,
        validatedEntries: 0,
        validatedTranscriptEvents: 0,
      },
    });

    await runStartupSessionMigration({
      cfg: makeCfg(),
      log,
      deps: makeDeps(migrate, 0, runDoctorSessionSqlite),
    });

    expect(firstLogMessage(log.warn, "archive-tier warning")).toContain(
      "session SQLite migration warnings",
    );
  });
});
