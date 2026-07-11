// Doctor session SQLite tests exercise real temp stores and per-agent SQLite files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadExactSqliteSessionEntry,
  loadSqliteTranscriptEventsSync,
  upsertSqliteSessionEntry,
} from "../config/sessions/session-accessor.sqlite.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as replaceFile from "../infra/replace-file.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { SessionSqliteMigrationManifest } from "./doctor-session-sqlite-migration-run.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";

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
    const archivedUnreferencedPath = firstImport.targets[0]?.archivedUnreferencedJsonlFiles[0];
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
    const sqlite = requireNodeSqlite();
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

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const manifest = readMigrationManifest(report.migrationRun?.manifestPath);
    const target = manifest.targets[0];

    expect(report.migrationRun?.runId).toBe(manifest.runId);
    expect(target).toMatchObject({
      agentId: "main",
      storePath: store.storePath,
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

  it("restores planned moves when a crash prevented completed move recording", async () => {
    const store = createLegacyStore();
    const importReport = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
    const manifest = readMigrationManifest(manifestPath);
    manifest.targets[0].completedMoves = [];
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
    manifest.targets[0].issues = [
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
    manifest.targets[0].issues = [
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

  it("archives a legacy transcript symlink without moving the symlink target", async () => {
    const store = createLegacyStore();
    const outsideTranscriptPath = path.join(store.tempDir, "outside-session-1.jsonl");
    fs.renameSync(store.transcriptPath, outsideTranscriptPath);
    fs.symlinkSync(outsideTranscriptPath, store.transcriptPath);

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });

    const archivedTranscriptPath = report.targets[0]?.archivedTranscriptFiles.find((filePath) =>
      filePath.includes("session-1.jsonl"),
    );
    expect(archivedTranscriptPath).toBeTruthy();
    expect(fs.existsSync(outsideTranscriptPath)).toBe(true);
    expect(fs.existsSync(store.transcriptPath)).toBe(false);
    expect(fs.lstatSync(archivedTranscriptPath ?? "").isSymbolicLink()).toBe(true);
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

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "recover",
      store: store.storePath,
    });

    expect(report.totals.issues).toBe(0);
    expect(report.targets[0]?.corruptRecovery?.movedFiles.length).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(sqlitePath)).toBe(false);
    expect(fs.existsSync(`${sqlitePath}-wal`)).toBe(false);
    expect(fs.existsSync(`${sqlitePath}-shm`)).toBe(false);
    expect(
      report.targets[0]?.corruptRecovery?.movedFiles.every((filePath) =>
        filePath.includes(".corrupt-"),
      ),
    ).toBe(true);
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
    expect(fs.existsSync(report.targets[0]?.sqlitePath)).toBe(true);
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

function createLegacyStore(
  params: {
    agentDirName?: string;
    customStore?: boolean;
    entryOverrides?: Record<string, unknown>;
    transcriptLines?: string[];
  } = {},
): TestStore {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-session-sqlite-"));
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
