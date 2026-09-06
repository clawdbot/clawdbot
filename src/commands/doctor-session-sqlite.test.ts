// Doctor session SQLite tests exercise real temp stores and per-agent SQLite files.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "../agents/sessions/session-manager.js";
import {
  loadExactSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  readSessionTranscriptHistoryEvents,
  readSessionTranscriptHistoryEventById,
  readSessionTranscriptHistoryEventCount,
  readSessionTranscriptHistoryEventPage,
} from "../config/sessions/session-accessor.sqlite-history-events.js";
import { importSqliteSessionRows } from "../config/sessions/session-accessor.sqlite-import.js";
import {
  loadTranscriptEventsSync,
  readTranscriptStatsSync,
} from "../config/sessions/session-accessor.sqlite-read.js";
import * as directoryDurability from "../infra/directory-durability.js";
import { prepareGithubIssue } from "../infra/github-issue.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import * as replaceFile from "../infra/replace-file.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { ExitError } from "../runtime.js";
import {
  AGENT_DATABASE_MAINTENANCE_LEASE,
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "../state/openclaw-agent-db-lease.js";
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
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { sessionDeliveryRoute } from "../utils/delivery-context.shared.js";
import * as migrationArtifact from "./doctor-session-sqlite-artifact.js";
import {
  claimSessionSqliteMigrationGithubIssue,
  clearSessionSqliteMigrationGithubIssueClaim,
  createSessionSqliteMigrationFailureIssue,
  writeSessionSqliteMigrationFailureReports,
} from "./doctor-session-sqlite-failure.js";
import * as migrationRun from "./doctor-session-sqlite-migration-run.js";
import {
  assertSafeSessionSqliteMigrationMove,
  createSessionSqliteMigrationRun,
  writeSessionSqliteMigrationManifest,
  type ActiveSessionSqliteMigrationRun,
} from "./doctor-session-sqlite-migration-run.js";
import * as sqliteReaders from "./doctor-session-sqlite-readers.js";
import {
  createTranscriptEventReader,
  readOnlySqliteValidationSnapshot,
  resolveTargetSqlitePath,
} from "./doctor-session-sqlite-readers.js";
import { recoverDoctorSessionSqliteTargets } from "./doctor-session-sqlite-recover-report.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { restoreSessionSqliteMigrationRun } from "./doctor-session-sqlite-restore.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import { createDoctorSessionSqliteTargetReport } from "./doctor-session-sqlite-types.js";
import { runDoctorSessionSqlite, type DoctorSessionSqliteReport } from "./doctor-session-sqlite.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";
import { doctorCommand } from "./doctor.js";

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
// Vitest canonicalizes TMPDIR; alias coverage needs the platform's /tmp path.
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
  it.each(
    [
      { reference: "explicit", sessionFile: "session-1.jsonl" },
      { reference: "default", sessionFile: undefined },
      { reference: "relocated", sessionFile: "/previous-machine/relocated-original.jsonl" },
      {
        reference: "canonical-relocated",
        sessionFile: "/previous-machine/.openclaw/agents/main/sessions/relocated-original.jsonl",
      },
    ].flatMap(({ reference, sessionFile }) =>
      ([1, 2, 3] as const).map((version) => ({ reference, sessionFile, version })),
    ),
  )(
    "preserves index dependencies across an interrupted import retry ($reference, v$version)",
    async ({ sessionFile, version }) => {
      const store = createLegacyStore({
        entryOverrides: { sessionFile },
        transcriptLines: [
          '{"type":"session","id":"session-1","version":3}',
          '{"type":"message","id":"one","parentId":null,"message":{"role":"user","content":"retained retry history"}}',
        ],
      });
      const transcriptPath = path.join(
        store.sessionDir,
        path.basename(sessionFile ?? store.transcriptPath),
      );
      if (transcriptPath !== store.transcriptPath) {
        fs.renameSync(store.transcriptPath, transcriptPath);
      }
      const indexBytes = fs.readFileSync(store.storePath);
      const transcriptBytes = fs.readFileSync(transcriptPath);
      let interruptedManifestPath: string | undefined;
      const spy = vi
        .spyOn(migrationRun, "recordCompletedMigrationMoves")
        .mockImplementationOnce((run) => {
          interruptedManifestPath = run?.manifestPath;
          throw new Error("interrupted after transcript publication");
        });
      try {
        await expect(
          runDoctorSessionSqlite({
            env: store.env,
            store: store.storePath,
            mode: "import",
          }),
        ).rejects.toThrow("interrupted after transcript publication");
      } finally {
        spy.mockRestore();
      }
      expect(readMigrationManifest(interruptedManifestPath).completedAt).toBeUndefined();
      expect(fs.existsSync(transcriptPath)).toBe(false);
      expect(fs.readFileSync(store.storePath)).toEqual(indexBytes);
      const retried = await runDoctorSessionSqlite({
        env: store.env,
        store: store.storePath,
        mode: "import",
      });
      expect(retried.targets.flatMap((target) => target.issues)).toEqual([]);
      expect(
        migrationRun.readSessionSqliteMigrationManifest(
          requireMigrationManifestPath(retried.migrationRun?.manifestPath),
        ),
      ).toBeDefined();
      if (version !== 3) {
        for (const runPath of [interruptedManifestPath, retried.migrationRun?.manifestPath]) {
          const manifestPath = requireMigrationManifestPath(runPath);
          const historical = readMigrationManifest(manifestPath);
          historical.manifestVersion = version;
          for (const target of historical.targets) {
            for (const move of [...target.plannedMoves, ...target.completedMoves]) {
              delete move.artifact;
            }
          }
          fs.writeFileSync(manifestPath, JSON.stringify(historical));
        }
      }
      closeOpenClawAgentDatabasesForTest();
      const retired = await retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      const manifest = readMigrationManifest(retried.migrationRun?.manifestPath);
      const indexMove = expectDefined(
        manifest.targets[0]?.completedMoves.find((move) => move.kind === "legacy-store"),
        "retry must publish the index",
      );
      expect(fs.existsSync(indexMove.archivePath)).toBe(true);
      expect(retired.totals.removedFiles).toBe(0);
      const restored = await runDoctorSessionSqlite({
        env: store.env,
        store: store.storePath,
        mode: "restore",
      });
      expect(restored.targets.flatMap((target) => target.issues)).toEqual([]);
      expect(fs.readFileSync(store.storePath)).toEqual(indexBytes);
      expect(fs.readFileSync(transcriptPath)).toEqual(transcriptBytes);
      await runDoctorSessionSqlite({ env: store.env, store: store.storePath, mode: "import" });
      closeOpenClawAgentDatabasesForTest();
      const completed = await retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      expect(completed.totals.removedFiles).toBe(2);
    },
  );

  it.each([
    { kind: "transcript", reverse: false },
    { kind: "transcript", reverse: true },
    { kind: "index", reverse: false },
    { kind: "index", reverse: true },
  ])(
    "retains remaining recovery when an admitted $kind disappears (reverse=$reverse)",
    async ({ kind, reverse }) => {
      const { cfg, env, indexes, transcriptPath } = createSharedRecoveryFixture({
        separateIndexes: true,
        reverse,
      });
      const mainIndexPath = path.join(path.dirname(transcriptPath), "main.json");
      const siblingPath = path.join(path.dirname(transcriptPath), "main-private.jsonl");
      const mainIndex = JSON.parse(fs.readFileSync(mainIndexPath, "utf8"));
      mainIndex["agent:main:private"] = {
        sessionId: "main-private",
        sessionFile: "main-private.jsonl",
        updatedAt: 30,
      };
      fs.writeFileSync(mainIndexPath, JSON.stringify(mainIndex));
      fs.writeFileSync(siblingPath, '{"type":"session","id":"main-private","version":3}\n');
      const lastOwner = reverse ? "main" : "work";
      const lostPath =
        kind === "transcript"
          ? transcriptPath
          : path.join(path.dirname(transcriptPath), `${lastOwner}.json`);
      const originals = [...indexes, siblingPath, transcriptPath]
        .filter((file) => file !== lostPath)
        .map((file) => ({ file, bytes: fs.readFileSync(file) }));
      const snapshot = sqliteReaders.readOnlySqliteValidationSnapshot;
      let disappeared = false;
      const spy = vi
        .spyOn(sqliteReaders, "readOnlySqliteValidationSnapshot")
        .mockImplementation((target) => {
          const result = snapshot(target);
          if (
            !disappeared &&
            target.agentId === lastOwner &&
            result.ok &&
            result.snapshot.sessionIdsBySessionKey.has(`agent:${lastOwner}:main`)
          ) {
            // Both owners committed the source; lose recovery input before archival.
            fs.unlinkSync(lostPath);
            disappeared = true;
          }
          return result;
        });
      let imported;
      try {
        imported = await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "import" });
      } finally {
        spy.mockRestore();
      }
      expect(disappeared).toBe(true);
      closeOpenClawAgentDatabasesForTest();
      const retired = await retireSessionSqliteRecovery({
        env,
        preview: inspectSessionSqliteRecovery({ cfg, env }),
        readConfig: async () => cfg,
        confirm: async () => true,
      });
      const manifest = readMigrationManifest(imported.migrationRun?.manifestPath);
      for (const original of originals) {
        const locations = [
          original.file,
          ...manifest.targets.flatMap((target) =>
            target.plannedMoves
              .filter((move) => move.sourcePath === original.file)
              .map((move) => move.archivePath),
          ),
        ];
        expect(
          locations.filter((file) => fs.existsSync(file)).map((file) => fs.readFileSync(file)),
        ).toContainEqual(original.bytes);
      }
      expect(retired.totals.removedFiles).toBe(2);
      const affectedOwners = imported.targets.filter((target) =>
        kind === "transcript" ? indexes.includes(target.storePath) : target.agentId === lastOwner,
      );
      const code =
        kind === "transcript" ? "transcript_archive_failed" : "legacy_store_archive_failed";
      for (const owner of affectedOwners) {
        expect(owner.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
      }
    },
  );

  it.each([false, true])(
    "restores every shared-owner publication before reimport and retirement (separate=%s)",
    async (separateIndexes) => {
      const { cfg, env, indexes, transcriptPath } = createSharedRecoveryFixture({
        separateIndexes,
        reverse: false,
      });
      const originals = [transcriptPath, ...indexes].map((file) => ({
        file,
        bytes: fs.readFileSync(file),
      }));
      const imported = await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "import" });
      expect(imported.targets.flatMap((target) => target.issues)).toEqual([]);
      const restored = await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "restore" });
      expect(restored.targets.flatMap((target) => target.issues)).toEqual([]);
      for (const original of originals) {
        expect(fs.existsSync(original.file)).toBe(true);
        expect(fs.readFileSync(original.file)).toEqual(original.bytes);
      }
      const reimported = await runDoctorSessionSqlite({
        cfg,
        env,
        allAgents: true,
        mode: "import",
      });
      expect(reimported.targets.flatMap((target) => target.issues)).toEqual([]);
      closeOpenClawAgentDatabasesForTest();
      const retired = await retireSessionSqliteRecovery({
        env,
        preview: inspectSessionSqliteRecovery({ cfg, env }),
        readConfig: async () => cfg,
        confirm: async () => true,
      });
      expect(retired.totals.removedFiles).toBe(separateIndexes ? 5 : 4);
    },
  );

  it.each(["shared", "distinct", "unreadable", "invalid-entry"] as const)(
    "retains known unselected index recovery (%s)",
    async (coverage) => {
      const { cfg, env, indexes, transcriptPath } = createSharedRecoveryFixture({
        separateIndexes: true,
        reverse: false,
        sharedTranscript: coverage !== "distinct",
      });
      const workIndex = indexes[1]!;
      const siblingSource = path.join(path.dirname(transcriptPath), "main-private.jsonl");
      const mainIndex = JSON.parse(fs.readFileSync(indexes[0]!, "utf8"));
      mainIndex["agent:main:private"] = {
        sessionId: "main-private",
        sessionFile: "main-private.jsonl",
        updatedAt: 30,
      };
      fs.writeFileSync(indexes[0]!, JSON.stringify(mainIndex));
      fs.writeFileSync(siblingSource, '{"type":"session","id":"main-private","version":3}\n');
      const workSource =
        coverage === "distinct"
          ? path.join(path.dirname(transcriptPath), "work-session.jsonl")
          : transcriptPath;
      if (coverage === "unreadable") {
        fs.writeFileSync(workIndex, "{broken");
      }
      if (coverage === "invalid-entry") {
        fs.writeFileSync(
          workIndex,
          JSON.stringify({ "agent:work:main": { sessionFile: "main-session.jsonl" } }),
        );
      }
      const original = fs.readFileSync(workSource);
      const indexBytes = fs.readFileSync(workIndex);
      const report = await runDoctorSessionSqlite({ cfg, env, agent: "main", mode: "import" });
      closeOpenClawAgentDatabasesForTest();
      const cleanup = await retireSessionSqliteRecovery({
        env,
        preview: inspectSessionSqliteRecovery({ cfg, env }),
        readConfig: async () => cfg,
        confirm: async () => true,
      });
      expect(fs.existsSync(workSource)).toBe(true);
      expect(fs.readFileSync(workSource)).toEqual(original);
      expect(fs.readFileSync(workIndex)).toEqual(indexBytes);
      expect(cleanup.totals.removedFiles).toBe(coverage === "distinct" ? 3 : 0);
      if (coverage !== "distinct") {
        expect(report.targets[0]?.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "transcript_archive_deferred" }),
          ]),
        );
      }
      expect(report.targets[0]?.archivedUnreferencedJsonlFiles).toEqual([]);
      // Keep the whole retained index usable; a direct retry must not orphan an earlier archive.
      if (coverage !== "distinct") {
        expect(fs.existsSync(siblingSource)).toBe(true);
      }
      if (coverage === "shared") {
        const retry = await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "import" });
        expect(retry.targets.flatMap((target) => target.issues)).toEqual([]);
        closeOpenClawAgentDatabasesForTest();
        const retired = await retireSessionSqliteRecovery({
          env,
          preview: inspectSessionSqliteRecovery({ cfg, env }),
          readConfig: async () => cfg,
          confirm: async () => true,
        });
        const current = readMigrationManifest(retry.migrationRun?.manifestPath);
        for (const move of current.targets
          .flatMap((target) => target.completedMoves)
          .filter(
            (plannedMove) =>
              plannedMove.kind === "transcript" || plannedMove.kind === "legacy-store",
          )) {
          expect(retired.artifacts.find((item) => item.path === move.archivePath)?.outcome).toBe(
            "removed",
          );
        }
      }
    },
  );

  it.each([
    { separateIndexes: false, reverse: false },
    { separateIndexes: false, reverse: true },
    { separateIndexes: true, reverse: false },
    { separateIndexes: true, reverse: true },
  ])(
    "retains shared recovery through cleanup when one owner fails (separate=$separateIndexes, reverse=$reverse)",
    async ({ separateIndexes, reverse }) => {
      const fixture = createSharedRecoveryFixture({ separateIndexes, reverse });
      const { cfg, env, transcriptPath, indexes, independent } = fixture;
      const original = fs.readFileSync(transcriptPath);
      const snapshot = sqliteReaders.readOnlySqliteValidationSnapshot;
      let injected = false;
      const spy = vi
        .spyOn(sqliteReaders, "readOnlySqliteValidationSnapshot")
        .mockImplementation((target) => {
          const result = snapshot(target);
          if (
            target.agentId === "work" &&
            result.ok &&
            result.snapshot.sessionIdsBySessionKey.has("agent:work:main")
          ) {
            injected = true;
            return { ok: false, error: new Error("injected validation read failure") };
          }
          return result;
        });
      let report;
      try {
        report = await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "import" });
      } finally {
        spy.mockRestore();
      }
      expect(injected).toBe(true);
      expect(
        report.targets
          .filter((target) => indexes.includes(target.storePath))
          .map((target) => target.agentId),
      ).toEqual(reverse ? ["work", "main"] : ["main", "work"]);
      const manifest = readMigrationManifest(report.migrationRun?.manifestPath);
      expect(
        manifest.targets.find((target) => target.agentId === "work")?.validationBeforeArchive,
      ).toBe("failed");
      closeOpenClawAgentDatabasesForTest();
      const cleanup = await retireSessionSqliteRecovery({
        env,
        preview: inspectSessionSqliteRecovery({ cfg, env }),
        readConfig: async () => cfg,
        confirm: async () => true,
      });
      const originalLocations = [
        transcriptPath,
        ...manifest.targets.flatMap((target) =>
          target.plannedMoves
            .filter((move) => move.sourcePath === transcriptPath)
            .map((move) => move.archivePath),
        ),
      ];
      expect(
        originalLocations
          .filter((file) => fs.existsSync(file))
          .map((file) => fs.readFileSync(file)),
      ).toContainEqual(original);
      const independentMoves = manifest.targets.find(
        (target) => target.storePath === independent.storePath,
      )!.completedMoves;
      expect(
        independentMoves
          .filter((move) => move.kind === "transcript" || move.kind === "legacy-store")
          .every((move) =>
            cleanup.artifacts.some(
              (item) => item.path === move.archivePath && item.outcome === "removed",
            ),
          ),
      ).toBe(true);
      // Recovery and retry must remain usable with the failed owner's original index and bytes.
      await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "restore" });
      expect(fs.readFileSync(transcriptPath)).toEqual(original);
      expect(indexes.every((index) => fs.existsSync(index))).toBe(true);
      const retried = await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "import" });
      expect(retried.targets.flatMap((target) => target.issues)).toEqual([]);
      closeOpenClawAgentDatabasesForTest();
      const retired = await retireSessionSqliteRecovery({
        env,
        preview: inspectSessionSqliteRecovery({ cfg, env }),
        readConfig: async () => cfg,
        confirm: async () => true,
      });
      const latest = readMigrationManifest(retried.migrationRun?.manifestPath);
      for (const move of latest.targets.flatMap((target) => target.completedMoves)) {
        expect(retired.artifacts.find((item) => item.path === move.archivePath)?.outcome).toBe(
          "removed",
        );
      }
    },
  );

  it.each([false, true])(
    "plans separate indexes before sweeping sibling transcripts (reverse=%s)",
    async (reverse) => {
      const { cfg, env, indexes, transcriptPath } = createSharedRecoveryFixture({
        separateIndexes: true,
        reverse,
        sharedTranscript: false,
      });
      const report = await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "import" });
      expect(report.targets.flatMap((target) => target.issues)).toEqual([]);
      expect(
        report.targets
          .filter((target) => indexes.includes(target.storePath))
          .map((target) => target.agentId),
      ).toEqual(reverse ? ["work", "main"] : ["main", "work"]);
      const manifest = readMigrationManifest(report.migrationRun?.manifestPath);
      for (const target of manifest.targets.filter((candidate) =>
        indexes.includes(candidate.storePath),
      )) {
        const expectedSource = path.join(
          path.dirname(transcriptPath),
          `${target.agentId}-session.jsonl`,
        );
        expect(target.completedMoves).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "transcript", sourcePath: expectedSource }),
          ]),
        );
      }
      closeOpenClawAgentDatabasesForTest();
      const retired = await retireSessionSqliteRecovery({
        env,
        preview: inspectSessionSqliteRecovery({ cfg, env }),
        readConfig: async () => cfg,
        confirm: async () => true,
      });
      expect(retired.totals.removedFiles).toBe(6);
    },
  );

  it.each(["transcript", "legacy-store"] as const)(
    "retains unique %s bytes changed at archival identity capture",
    async (kind) => {
      const { store } = await createVerifiedRecoveryStore();
      await runDoctorSessionSqlite({ env: store.env, mode: "restore", store: store.storePath });
      const source = kind === "transcript" ? store.transcriptPath : store.storePath;
      const replacement =
        kind === "transcript"
          ? fs.readFileSync(source, "utf8") +
            JSON.stringify({
              type: "custom",
              id: "unique",
              customType: "late",
              data: "never imported",
            }) +
            "\n"
          : JSON.stringify({ "agent:main:unique": { sessionId: "unique", updatedAt: 9000 } });
      const readIdentity = migrationArtifact.readMigrationArtifactIdentity;
      let captures = 0;
      let injected = false;
      const spy = vi
        .spyOn(migrationArtifact, "readMigrationArtifactIdentity")
        .mockImplementation((file, ...args) => {
          if (file === source && ++captures === (kind === "transcript" ? 1 : 2)) {
            // Transcript: replace just before identity capture. Index: replace after the verified
            // identity is returned, before the publication owner plans the archive.
            if (kind === "legacy-store") {
              const identity = readIdentity(file, ...args);
              fs.writeFileSync(file, replacement);
              injected = true;
              return identity;
            }
            fs.unlinkSync(file);
            fs.writeFileSync(file, replacement);
            injected = true;
          }
          return readIdentity(file, ...args);
        });
      let imported;
      try {
        imported = await runDoctorSessionSqlite({
          env: store.env,
          mode: "import",
          store: store.storePath,
        });
      } finally {
        spy.mockRestore();
      }
      expect(injected).toBe(true);
      expect(fs.existsSync(source)).toBe(true);
      expect(fs.readFileSync(source, "utf8")).toBe(replacement);
      expect(
        imported.targets[0]?.issues.some(
          (issue) =>
            issue.code ===
            (kind === "transcript" ? "transcript_archive_failed" : "legacy_store_archive_failed"),
        ),
      ).toBe(true);
      closeOpenClawAgentDatabasesForTest();
      const cleanup = await retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      expect(cleanup.artifacts.filter((item) => item.outcome === "removed")).toEqual([]);
      expect(fs.readFileSync(source, "utf8")).toBe(replacement);
      expect(
        JSON.stringify(
          loadTranscriptEventsSync({
            agentId: "main",
            storePath: store.storePath,
            sessionId: "session-1",
          }),
        ),
      ).not.toContain("never imported");
    },
  );

  it.each([1, 2] as const)(
    "retains historical v%s index and sibling history after partial adoption",
    async (version) => {
      const store = createLegacyStore({
        transcriptLines: [
          JSON.stringify({ type: "session", id: "session-1", version: 3 }),
          JSON.stringify({
            type: "message",
            id: "one",
            parentId: null,
            message: { role: "user", content: "original" },
          }),
        ],
      });
      const index = JSON.parse(fs.readFileSync(store.storePath, "utf8"));
      const siblingSource = path.join(store.sessionDir, "second.jsonl");
      index["agent:main:second"] = {
        sessionId: "second",
        updatedAt: 2000,
        sessionFile: "second.jsonl",
      };
      fs.writeFileSync(store.storePath, JSON.stringify(index));
      fs.writeFileSync(
        siblingSource,
        JSON.stringify({ type: "session", id: "second", version: 3 }) + "\n",
      );
      const imported = await runDoctorSessionSqlite({
        env: store.env,
        mode: "import",
        store: store.storePath,
      });
      expect(imported.targets[0]?.issues).toEqual([]);
      const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
      const manifest = readMigrationManifest(manifestPath);
      const target = manifest.targets[0]!;
      const indexMove = target.plannedMoves.find((move) => move.kind === "legacy-store")!;
      const archivePath = target.plannedMoves.find(
        (move) => move.sourcePath === store.transcriptPath,
      )!.archivePath;
      const siblingArchive = target.plannedMoves.find(
        (move) => move.sourcePath === siblingSource,
      )!.archivePath;
      manifest.manifestVersion = version;
      for (const move of [...target.plannedMoves, ...target.completedMoves]) {
        delete move.artifact;
      }
      fs.appendFileSync(
        archivePath,
        JSON.stringify({ type: "future_event", id: "unknown", payload: "unique original" }) + "\n",
      );
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      closeOpenClawAgentDatabasesForTest();
      const originals = [indexMove.archivePath, archivePath, siblingArchive].map((file) => ({
        file,
        bytes: fs.readFileSync(file),
      }));
      const result = await retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      for (const original of originals) {
        expect(result.artifacts.find((item) => item.path === original.file)?.outcome).toBe(
          "protected",
        );
        expect(fs.readFileSync(original.file)).toEqual(original.bytes);
      }
      expect(result.totals.removedFiles).toBe(0);
    },
  );

  it("retires a successful reimport generation after restore consumed its predecessor", async () => {
    const { store } = await createVerifiedRecoveryStore();
    await runDoctorSessionSqlite({ env: store.env, mode: "restore", store: store.storePath });
    const reimported = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    expect(reimported.targets[0]?.issues).toEqual([]);
    closeOpenClawAgentDatabasesForTest();
    const result = await retireSessionSqliteRecovery({
      env: store.env,
      preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
      readConfig: async () => ({}),
      confirm: async () => true,
    });
    expect(result.status).toBe("complete");
    expect(result.totals.removedFiles).toBe(2);
    const current = readMigrationManifest(reimported.migrationRun?.manifestPath);
    for (const move of current.targets[0]!.plannedMoves.filter(
      (item) => item.kind === "transcript" || item.kind === "legacy-store",
    )) {
      expect(move.artifact?.disposal.state).toBe("disposed");
    }
  });

  it.each([
    { kind: "transcript", mode: "import", entry: "inner" },
    { kind: "legacy-store", mode: "import", entry: "inner" },
    { kind: "transcript", mode: "restore", entry: "inner" },
    { kind: "legacy-store", mode: "restore", entry: "inner" },
    { kind: "transcript", mode: "import", entry: "public" },
    { kind: "legacy-store", mode: "import", entry: "public" },
    { kind: "transcript", mode: "restore", entry: "public" },
    { kind: "legacy-store", mode: "restore", entry: "public" },
  ] as const)(
    "recovers interrupted $kind publication through $entry $mode",
    async ({ kind, mode, entry }) => {
      const { store } = await createVerifiedRecoveryStore();
      await runDoctorSessionSqlite({ env: store.env, mode: "restore", store: store.storePath });
      const source = kind === "transcript" ? store.transcriptPath : store.storePath;
      const original = fs.readFileSync(source);
      const token = "sk-abcdefghijklmnopqrstuv";
      const unlink = fs.unlinkSync;
      let injected = false;
      const spy = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
        if (!injected && file === source) {
          injected = true;
          throw new Error(
            `injected interruption before source unlink: Authorization: Bearer ${token}`,
          );
        }
        return unlink(file);
      });
      let interrupted;
      try {
        interrupted = await runDoctorSessionSqlite({
          env: store.env,
          mode: "import",
          store: store.storePath,
        });
      } finally {
        spy.mockRestore();
      }
      expect(injected).toBe(true);
      const manifestPath = requireMigrationManifestPath(interrupted.migrationRun?.manifestPath);
      const move = readMigrationManifest(manifestPath).targets[0]!.plannedMoves.find(
        (item) => item.sourcePath === source,
      )!;
      const issueCode =
        kind === "transcript" ? "transcript_archive_failed" : "legacy_store_archive_failed";
      const issue = interrupted.targets[0]?.issues.find((item) => item.code === issueCode);
      expect(issue?.message).toContain("injected interruption before source unlink");
      expect(issue?.message).not.toContain(token);
      expect(fs.readFileSync(source)).toEqual(original);
      expect(fs.statSync(source).nlink).toBe(2);
      expect(fs.statSync(source).ino).toBe(fs.statSync(move.archivePath).ino);
      if (entry === "public") {
        const runtime = {
          log: vi.fn(),
          error: vi.fn(),
          exit: vi.fn((code: number): never => {
            throw new ExitError(code);
          }),
        };
        await expect(
          doctorCommand(runtime, {
            sessionSqlite: mode,
            sessionSqliteStore: store.storePath,
            json: true,
          }),
        ).rejects.toMatchObject({ code: 0 });
      } else {
        const recovered = await runDoctorSessionSqlite({
          env: store.env,
          mode,
          store: store.storePath,
        });
        expect(recovered.targets[0]?.issues).toEqual([]);
      }
      expect(readMigrationManifest(manifestPath).restore?.consumedArchives).toContain(
        move.archivePath,
      );
      expect(fs.existsSync(move.archivePath)).toBe(false);
      if (mode === "restore") {
        expect(fs.statSync(source).nlink).toBe(1);
        expect(fs.readFileSync(source)).toEqual(original);
        const reimport = await runDoctorSessionSqlite({
          env: store.env,
          mode: "import",
          store: store.storePath,
        });
        expect(reimport.targets[0]?.issues).toEqual([]);
      }
      closeOpenClawAgentDatabasesForTest();
      const cleanup = await retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      expect(cleanup.status).toBe("complete");
      expect(cleanup.totals.removedFiles).toBe(2);
    },
  );

  it.each(["mismatch", "third-link"] as const)(
    "refuses public recovery of a recorded publication with %s",
    async (fault) => {
      const { store, imported } = await createVerifiedRecoveryStore();
      const manifest = readMigrationManifest(imported.migrationRun?.manifestPath);
      const move = manifest.targets[0]!.plannedMoves.find((item) => item.kind === "legacy-store")!;
      fs.linkSync(move.archivePath, move.sourcePath);
      const third = path.join(store.sessionDir, "unexpected-alias");
      if (fault === "third-link") {
        fs.linkSync(move.sourcePath, third);
      } else {
        fs.writeFileSync(move.sourcePath, "different bytes on the same inode");
      }
      const before = fs.readFileSync(move.sourcePath);
      for (const mode of ["import", "restore"] as const) {
        const runtime = {
          log: vi.fn(),
          error: vi.fn(),
          exit: vi.fn((code: number): never => {
            throw new ExitError(code);
          }),
        };
        await expect(
          doctorCommand(runtime, {
            sessionSqlite: mode,
            sessionSqliteStore: store.storePath,
            json: true,
          }),
        ).rejects.toThrow(/hard-linked|publication paths changed/);
        expect(fs.readFileSync(move.sourcePath)).toEqual(before);
        expect(fs.readFileSync(move.archivePath)).toEqual(before);
        expect(fs.statSync(move.sourcePath).nlink).toBe(fault === "third-link" ? 3 : 2);
      }
    },
  );

  it.each([1, 2] as const)(
    "adopts only complete historical v%s recovery evidence",
    async (version) => {
      const { store, imported, archivePath } = await createVerifiedRecoveryStore([
        JSON.stringify({ type: "session", id: "session-1", version: 1 }),
        JSON.stringify({ type: "message", message: { role: "user", content: "legacy IDs" } }),
      ]);
      const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
      const manifest = readMigrationManifest(manifestPath);
      manifest.manifestVersion = version;
      for (const target of manifest.targets) {
        for (const move of [...target.plannedMoves, ...target.completedMoves]) {
          delete move.artifact;
        }
      }
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
      expect(preview.artifacts.find((item) => item.path === archivePath)?.outcome).toBe(
        "verification-required",
      );
      const result = await retireSessionSqliteRecovery({
        env: store.env,
        preview,
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      expect(result.artifacts.find((item) => item.path === archivePath)?.outcome).toBe("removed");
      expect(result.artifacts.filter((item) => item.outcome === "protected")).toHaveLength(2);
    },
  );

  it("preserves a support receipt version while adopting recovery evidence", async () => {
    const { store, imported, archivePath } = await createVerifiedRecoveryStore([
      JSON.stringify({ type: "session", id: "session-1", version: 1 }),
      JSON.stringify({ type: "message", message: { role: "user", content: "legacy IDs" } }),
    ]);
    const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
    const manifest = readMigrationManifest(manifestPath);
    const jsonPath = manifestPath.replace(/\.json$/u, ".failure.json");
    const markdownPath = manifestPath.replace(/\.json$/u, ".failure.md");
    manifest.failureReports = { jsonPath, markdownPath };
    for (const target of manifest.targets) {
      for (const move of [...target.plannedMoves, ...target.completedMoves]) {
        delete move.artifact;
      }
    }
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(markdownPath, "sanitized report\n", { mode: 0o600 });
    const { marker, title } = prepareGithubIssue(
      expectDefined(createSessionSqliteMigrationFailureIssue(manifestPath), "adoption report"),
    );
    const issue = { marker, title };
    expect(
      claimSessionSqliteMigrationGithubIssue(manifestPath, issue, { assertCurrent: vi.fn() }),
    ).toMatchObject({ status: "claimed" });
    const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
    expect(preview.artifacts.find((item) => item.path === archivePath)?.outcome).toBe(
      "verification-required",
    );

    await retireSessionSqliteRecovery({
      env: store.env,
      preview,
      readConfig: async () => ({}),
      confirm: async () => true,
    });

    expect(readMigrationManifest(manifestPath)).toMatchObject({
      failureReports: { githubIssue: { ...issue, status: "attempted" } },
      manifestVersion: 4,
    });
  });

  it.each([
    { name: "invalid message", rows: [{ type: "message", id: "bad", message: {} }] },
    { name: "unknown event", rows: [{ type: "future_event", id: "unknown", payload: "unique" }] },
    {
      name: "duplicate divergent ID",
      rows: [
        {
          type: "message",
          id: "duplicate",
          parentId: null,
          message: { role: "user", content: "first" },
        },
        {
          type: "message",
          id: "duplicate",
          parentId: null,
          message: { role: "user", content: "unique second" },
        },
      ],
    },
    {
      name: "missing ancestor",
      rows: [
        {
          type: "message",
          id: "child",
          parentId: "missing",
          message: { role: "user", content: "history" },
        },
      ],
    },
  ])("protects $name and its recovery index", async ({ rows, name }) => {
    const store = createLegacyStore({
      transcriptLines: [
        JSON.stringify({ type: "session", id: "session-1", version: 3 }),
        ...rows.map((row) => JSON.stringify(row)),
      ],
    });
    const original = fs.readFileSync(store.transcriptPath);
    const imported = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const move = readMigrationManifest(
      imported.migrationRun?.manifestPath,
    ).targets[0]!.completedMoves.find((item) => item.kind === "transcript");
    if (name === "duplicate divergent ID") {
      expect(move).toBeUndefined();
      expect(imported.targets[0]?.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "sqlite_transcript_count_mismatch" }),
        ]),
      );
    } else {
      expect(move).toBeDefined();
    }
    closeOpenClawAgentDatabasesForTest();
    const result = await retireSessionSqliteRecovery({
      env: store.env,
      preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
      readConfig: async () => ({}),
      confirm: async () => true,
    });
    expect(result.totals.removedFiles).toBe(0);
    if (move) {
      expect(result.artifacts.find((item) => item.path === move.archivePath)?.outcome).toBe(
        "protected",
      );
    }
    expect(fs.readFileSync(move?.archivePath ?? store.transcriptPath)).toEqual(original);
  });

  it("archives identical indexed and leaf replays after normalized history verification", async () => {
    const repeatedMessage = {
      type: "message",
      id: "reply",
      parentId: "root",
      message: { role: "assistant", content: "same replay" },
    };
    const repeatedLeaf = {
      type: "leaf",
      id: "selection",
      parentId: "reply",
      targetId: "reply",
    };
    const store = createLegacyStore({
      transcriptLines: [
        JSON.stringify({ type: "session", id: "session-1", version: 3 }),
        JSON.stringify({
          type: "message",
          id: "root",
          parentId: null,
          message: { role: "user", content: "root" },
        }),
        JSON.stringify(repeatedMessage),
        JSON.stringify(repeatedMessage),
        JSON.stringify(repeatedLeaf),
        JSON.stringify(repeatedLeaf),
      ],
    });

    const imported = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });

    expect(imported.targets[0]?.issues).toEqual([]);
    const move = readMigrationManifest(
      imported.migrationRun?.manifestPath,
    ).targets[0]!.completedMoves.find((item) => item.kind === "transcript");
    expect(move).toBeDefined();
    expect(fs.existsSync(store.transcriptPath)).toBe(false);
    expect(
      loadTranscriptEventsSync({
        agentId: "main",
        env: store.env,
        sessionId: "session-1",
      }).map((event) => (event as { id?: string }).id),
    ).toEqual(["session-1", "root", "reply", "selection"]);

    const scope = { agentId: "main", env: store.env, sessionId: "session-1" };
    const history = readSessionTranscriptHistoryEvents(scope);
    expect(history.map((row) => (row.event as { id?: string }).id)).toEqual(["root", "reply"]);
    expect(readSessionTranscriptHistoryEventCount(scope)).toBe(2);
    expect(
      readSessionTranscriptHistoryEventPage(scope, { maxMessages: 1, offset: 0 }),
    ).toMatchObject({
      activeLeafEntryId: "reply",
      totalMessages: 2,
      events: [expect.objectContaining({ event: expect.objectContaining({ id: "reply" }) })],
    });
    expect(readSessionTranscriptHistoryEventById(scope, "reply")).toMatchObject({
      event: expect.objectContaining({ id: "reply" }),
    });
  });

  it("retains complete recovery when durable transcript verification is short", async () => {
    const store = createLegacyStore({
      transcriptLines: [
        JSON.stringify({ type: "session", id: "session-1", version: 3 }),
        JSON.stringify({
          type: "message",
          id: "root",
          parentId: null,
          message: { role: "user", content: "root" },
        }),
      ],
    });
    const snapshot = sqliteReaders.readOnlySqliteValidationSnapshot;
    const spy = vi
      .spyOn(sqliteReaders, "readOnlySqliteValidationSnapshot")
      .mockImplementation((target) => {
        const result = snapshot(target);
        if (!result.ok) {
          return result;
        }
        const counts = new Map(result.snapshot.transcriptEventCountsBySessionId);
        counts.set("session-1", 1);
        return {
          ok: true,
          snapshot: { ...result.snapshot, transcriptEventCountsBySessionId: counts },
        };
      });
    let imported;
    try {
      imported = await runDoctorSessionSqlite({
        env: store.env,
        mode: "import",
        store: store.storePath,
      });
    } finally {
      spy.mockRestore();
    }

    expect(imported.targets[0]?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "sqlite_transcript_count_mismatch" }),
      ]),
    );
    expect(fs.existsSync(store.transcriptPath)).toBe(true);
    expect(
      readMigrationManifest(imported.migrationRun?.manifestPath).targets[0]?.completedMoves.some(
        (item) => item.kind === "transcript",
      ),
    ).toBe(false);
  });

  it.each([
    {
      name: "identical",
      repeated: { role: "assistant", content: "same replay" },
      archived: true,
    },
    {
      name: "divergent",
      repeated: { role: "assistant", content: "different replay" },
      archived: false,
    },
  ])(
    "handles a $name replay against an existing destination and retry",
    async ({ repeated, archived }) => {
      const first = {
        type: "message",
        id: "reply",
        parentId: "root",
        message: { role: "assistant", content: "same replay" },
      };
      const sourceEvents = [
        { type: "session", id: "session-1", version: 3 },
        {
          type: "message",
          id: "root",
          parentId: null,
          message: { role: "user", content: "root" },
        },
        first,
        { ...first, message: repeated },
      ];
      const store = createLegacyStore({
        transcriptLines: sourceEvents.map((event) => JSON.stringify(event)),
      });
      await importSqliteSessionRows({
        agentId: "main",
        env: store.env,
        sessionKey: "agent:main:main",
        storePath: store.storePath,
        entry: { sessionId: "session-1", updatedAt: 1000 },
        readTranscriptEvents: (append) => sourceEvents.slice(0, 3).forEach(append),
      });

      const run = () =>
        runDoctorSessionSqlite({
          env: store.env,
          mode: "import",
          store: store.storePath,
        });
      const imported = await run();
      expect(fs.existsSync(store.transcriptPath)).toBe(!archived);
      expect(
        readMigrationManifest(imported.migrationRun?.manifestPath).targets[0]?.completedMoves.some(
          (item) => item.kind === "transcript",
        ),
      ).toBe(archived);
      expect(
        imported.targets[0]?.issues.some(
          (issue) => issue.code === "sqlite_transcript_count_mismatch",
        ),
      ).toBe(!archived);
      expect(
        loadTranscriptEventsSync({
          agentId: "main",
          env: store.env,
          sessionId: "session-1",
        }).map((event) => (event as { id?: string }).id),
      ).toEqual(["session-1", "root", "reply"]);

      if (!archived) {
        const retried = await run();
        expect(
          retried.targets[0]?.issues.some(
            (issue) => issue.code === "sqlite_transcript_count_mismatch",
          ),
        ).toBe(true);
        expect(fs.existsSync(store.transcriptPath)).toBe(true);
      }
    },
  );

  it("retains a recreated archive while resuming an interrupted unlink", async () => {
    const { store, archivePath } = await createVerifiedRecoveryStore();
    const unlink = fs.unlinkSync;
    const spy = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
      if (String(file).includes(".cleanup-")) {
        throw new Error("injected unlink");
      }
      return unlink(file);
    });
    const invoke = () =>
      retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => true,
      });
    try {
      expect((await invoke()).status).toBe("blocked");
    } finally {
      spy.mockRestore();
    }
    fs.writeFileSync(archivePath, "replacement after interrupted cleanup");
    const resumed = await invoke();
    expect(resumed.status).toBe("blocked");
    expect(fs.readFileSync(archivePath, "utf8")).toBe("replacement after interrupted cleanup");
    expect(
      resumed.artifacts.find((item) => item.path === archivePath)?.removedBytes,
    ).toBeUndefined();
  });

  it.each(["intent", "intent-sync", "claim", "unlink", "unlink-later", "receipt"])(
    "resumes retirement after a %s failure without overclaiming removed bytes",
    async (phase) => {
      const { store, imported, archivePath } = await createVerifiedRecoveryStore();
      const manifestDir = path.dirname(
        requireMigrationManifestPath(imported.migrationRun?.manifestPath),
      );
      const original = fs.readFileSync(archivePath);
      let injected = false;
      let claimUnlinks = 0;
      const write = replaceFile.replaceFileAtomicSync;
      const unlink = fs.unlinkSync;
      const fsync = fs.fsyncSync;
      const syncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        if (!injected && phase === "intent-sync" && isDirectoryDescriptor(fd, manifestDir)) {
          injected = true;
          throw new Error("injected intent-sync");
        }
        fsync(fd);
      });
      const writeSpy = vi
        .spyOn(replaceFile, "replaceFileAtomicSync")
        .mockImplementation((options) => {
          const text = String(options.content);
          const shouldFail =
            phase === "intent"
              ? text.includes('"pending-disposal"')
              : phase === "receipt" && text.includes('"disposed"');
          if (!injected && shouldFail) {
            injected = true;
            throw new Error(`injected ${phase}`);
          }
          return write(options);
        });
      const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
        if (String(file).includes(".cleanup-")) {
          claimUnlinks += 1;
        }
        if (
          !injected &&
          ((phase === "unlink" && String(file).includes(".cleanup-")) ||
            (phase === "unlink-later" && claimUnlinks === 2) ||
            (phase === "claim" && String(file) === archivePath))
        ) {
          injected = true;
          throw new Error(`injected ${phase}`);
        }
        return unlink(file);
      });
      const invoke = () =>
        retireSessionSqliteRecovery({
          env: store.env,
          preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
          readConfig: async () => ({}),
          confirm: async () => true,
        });
      try {
        if (phase === "intent" || phase === "intent-sync") {
          await expect(invoke()).rejects.toThrow(`injected ${phase}`);
          expect(fs.readFileSync(archivePath)).toEqual(original);
        } else {
          const first = await invoke();
          expect(first.status).toBe("blocked");
          if (phase === "unlink-later") {
            expect(first.totals.removedFiles).toBe(1);
          }
          if (phase === "receipt") {
            expect(first.artifacts.find((item) => item.path === archivePath)?.removedBytes).toBe(
              original.length,
            );
          }
        }
      } finally {
        writeSpy.mockRestore();
        unlinkSpy.mockRestore();
        syncSpy.mockRestore();
      }
      expect(injected).toBe(true);
      const resumed = await invoke();
      expect(resumed.status).toBe("complete");
      expect(fs.existsSync(archivePath)).toBe(false);
      if (phase === "receipt") {
        expect(resumed.totals.removedBytes).toBe(0);
      }
    },
  );

  it.each([
    { platform: "win32", syncFailure: "unsupported", retires: true },
    { platform: "linux", syncFailure: "unsupported", retires: false },
    { platform: "win32", syncFailure: "EIO", retires: false },
  ] as const)(
    "applies the manifest directory-sync policy for $platform $syncFailure",
    async ({ platform, syncFailure, retires }) => {
      const { store, imported, archivePath } = await createVerifiedRecoveryStore();
      const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
      const original = fs.readFileSync(archivePath);
      const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
      const fsync = fs.fsyncSync;
      const failureCode =
        syncFailure === "EIO" ? "EIO" : platform === "win32" ? "EPERM" : "ENOTSUP";
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const syncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        if (!isDirectoryDescriptor(fd, path.dirname(manifestPath))) {
          return fsync(fd);
        }
        // Assert the persisted intent at the commit boundary, before any original moves.
        const manifest = readMigrationManifest(manifestPath);
        if (fs.existsSync(archivePath)) {
          expect(
            manifest.targets[0]?.completedMoves.find((move) => move.archivePath === archivePath)
              ?.artifact?.disposal.state,
          ).toBe("pending-disposal");
          expect(fs.readFileSync(archivePath)).toEqual(original);
        }
        throw Object.assign(new Error(`injected manifest ${failureCode}`), { code: failureCode });
      });
      try {
        const cleanup = retireSessionSqliteRecovery({
          env: store.env,
          preview,
          readConfig: async () => ({}),
          confirm: async () => true,
        });
        if (retires) {
          const result = await cleanup;
          expect(result.status).toBe("complete");
          expect(result.artifacts.find((item) => item.path === archivePath)).toMatchObject({
            outcome: "removed",
            removedBytes: original.length,
          });
          expect(fs.existsSync(archivePath)).toBe(false);
          expect(
            readMigrationManifest(manifestPath).targets[0]?.completedMoves.find(
              (move) => move.archivePath === archivePath,
            )?.artifact?.disposal.state,
          ).toBe("disposed");
        } else {
          await expect(cleanup).rejects.toThrow(`injected manifest ${failureCode}`);
          expect(fs.readFileSync(archivePath)).toEqual(original);
        }
      } finally {
        syncSpy.mockRestore();
        platformSpy.mockRestore();
      }
    },
  );

  it("refuses new recovery references introduced during confirmation", async () => {
    const { store, imported, archivePath } = await createVerifiedRecoveryStore();
    const manifest = readMigrationManifest(
      requireMigrationManifestPath(imported.migrationRun?.manifestPath),
    );
    const original = fs.readFileSync(archivePath);
    await expect(
      retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => {
          const added = createSessionSqliteMigrationRun(store.env, []);
          added.manifest.targets = manifest.targets;
          added.manifest.completedAt = manifest.completedAt;
          writeSessionSqliteMigrationManifest(added);
          return true;
        },
      }),
    ).rejects.toThrow(/selection changed/i);
    expect(fs.readFileSync(archivePath)).toEqual(original);
  });

  it.each([false, true])(
    "blocks a replaced recovery original during preview (same size: %s)",
    async (sameSize) => {
      const { store, archivePath } = await createVerifiedRecoveryStore();
      const original = fs.readFileSync(archivePath);
      fs.renameSync(archivePath, path.join(store.tempDir, "parked-original"));
      const replacement = Buffer.alloc(sameSize ? original.length : 7, "x");
      fs.writeFileSync(archivePath, replacement);

      const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
      expect(preview.artifacts.find((artifact) => artifact.path === archivePath)).toMatchObject({
        outcome: "blocked",
        reason: "artifact-metadata-changed",
      });
      const result = await retireSessionSqliteRecovery({
        env: store.env,
        preview,
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      expect(result.status).toBe("blocked");
      expect(result.totals.removedBytes).toBe(0);
      expect(fs.readFileSync(archivePath)).toEqual(replacement);
    },
  );

  it.each(["replacement", "symlink", "hardlink"])(
    "refuses a destination database %s introduced during confirmation",
    async (kind) => {
      const { store, imported, archivePath } = await createVerifiedRecoveryStore();
      const databasePath = imported.targets[0]!.sqlitePath;
      const saved = path.join(store.tempDir, "saved-destination.sqlite");
      const original = fs.readFileSync(archivePath);
      await expect(
        retireSessionSqliteRecovery({
          env: store.env,
          preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
          readConfig: async () => ({}),
          confirm: async () => {
            if (kind === "hardlink") {
              fs.linkSync(databasePath, saved);
            } else {
              fs.renameSync(databasePath, saved);
              if (kind === "symlink") {
                fs.symlinkSync(saved, databasePath);
              } else {
                fs.copyFileSync(saved, databasePath);
              }
            }
            return true;
          },
        }),
      ).rejects.toThrow(/destination|symbolic|hard.link/i);
      expect(fs.readFileSync(archivePath)).toEqual(original);
    },
  );

  it.each(
    ["transcript", "legacy-store"].flatMap((artifactKind) =>
      ["replacement", "symlink", "hardlink", "same-size edit"].map((change) => ({
        artifactKind,
        change,
      })),
    ),
  )(
    "preserves every recovery dependency after a $artifactKind $change during confirmation",
    async ({ artifactKind, change }) => {
      const { store, imported } = await createVerifiedRecoveryStore();
      const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
      const manifestBefore = fs.readFileSync(manifestPath);
      const moves = readMigrationManifest(manifestPath).targets[0]!.completedMoves;
      const archivePath = expectDefined(
        moves.find((move) => move.kind === artifactKind),
        "confirmation mutation archive",
      ).archivePath;
      const retained = moves
        .filter((move) => move.archivePath !== archivePath)
        .map((move) => ({ path: move.archivePath, contents: fs.readFileSync(move.archivePath) }));
      const replacement = path.join(store.tempDir, "replacement");
      fs.writeFileSync(replacement, "unrelated bytes");
      await expect(
        retireSessionSqliteRecovery({
          env: store.env,
          preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
          readConfig: async () => ({}),
          confirm: async () => {
            if (change === "hardlink") {
              fs.linkSync(archivePath, path.join(store.tempDir, "alias"));
            } else if (change === "same-size edit") {
              const contents = fs.readFileSync(archivePath);
              contents[0] = 0x78;
              fs.writeFileSync(archivePath, contents);
            } else {
              fs.unlinkSync(archivePath);
              if (change === "symlink") {
                fs.symlinkSync(replacement, archivePath);
              } else {
                fs.writeFileSync(archivePath, "replacement original");
              }
            }
            return true;
          },
        }),
      ).rejects.toThrow(/selection changed|artifact/i);
      expect(fs.existsSync(archivePath)).toBe(true);
      expect(fs.readFileSync(replacement, "utf8")).toBe("unrelated bytes");
      expect(fs.readFileSync(manifestPath)).toEqual(manifestBefore);
      for (const artifact of retained) {
        expect(fs.readFileSync(artifact.path)).toEqual(artifact.contents);
      }
    },
  );

  it.each(
    ["in-place edit", "truncation", "WAL commit"].flatMap((change) =>
      ["confirmation", "publication", "unlink-intent"].map((phase) => ({ change, phase })),
    ),
  )("retains originals after destination $change during $phase", async ({ change, phase }) => {
    const { store, imported } = await createVerifiedRecoveryStore();
    const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
    const target = readMigrationManifest(manifestPath).targets[0]!;
    const originals = target.completedMoves.map((move) => fs.readFileSync(move.archivePath));
    const databasePath = target.sqlitePath;
    let writer: DatabaseSync | undefined;
    let injected = false;
    const mutate = () => {
      injected = true;
      const before = fs.statSync(databasePath, { bigint: true });
      if (change === "WAL commit") {
        const databaseBefore = fs.readFileSync(databasePath);
        writer = nodeSqlite.openNodeSqliteDatabase(databasePath);
        writer.exec("DELETE FROM transcript_events");
        expect(fs.readFileSync(databasePath)).toEqual(databaseBefore);
        expect(fs.statSync(`${databasePath}-wal`).size).toBeGreaterThan(32);
      } else if (change === "truncation") {
        fs.truncateSync(databasePath, 0);
      } else {
        const bytes = fs.readFileSync(databasePath);
        bytes[0] = 0;
        fs.writeFileSync(databasePath, bytes);
        fs.utimesSync(databasePath, before.atime, before.mtime);
        expect(fs.statSync(databasePath).size).toBe(bytes.length);
      }
      expect(fs.statSync(databasePath, { bigint: true }).ino).toBe(before.ino);
    };
    const mutateAfterSync = (directory: string) => {
      if (injected || phase === "confirmation") {
        return;
      }
      const moves = readMigrationManifest(manifestPath).targets[0]!.completedMoves;
      const atUnlink = moves.some(
        (move) =>
          move.artifact?.disposal.state === "pending-disposal" &&
          move.artifact.disposal.phase === "unlink-pending",
      );
      if (
        (phase === "publication" &&
          directory === path.dirname(target.completedMoves[0]!.archivePath)) ||
        (phase === "unlink-intent" && directory === path.dirname(manifestPath) && atUnlink)
      ) {
        mutate();
      }
    };
    const restoreSync = observeRecoveryDirectorySync(path.dirname(manifestPath), mutateAfterSync);
    try {
      const cleanup = retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => {
          if (phase === "confirmation") {
            mutate();
          }
          return true;
        },
      });
      if (phase === "confirmation") {
        await expect(cleanup).rejects.toThrow(/destination/i);
      } else {
        const result = await cleanup;
        expect(result.status).toBe("blocked");
        expect(result.totals.removedFiles).toBe(0);
      }
      expect(injected).toBe(true);
      for (const [index, move] of readMigrationManifest(
        manifestPath,
      ).targets[0]!.completedMoves.entries()) {
        const disposal = move.artifact!.disposal;
        expect(disposal.state).not.toBe("disposed");
        const retainedPath = fs.existsSync(move.archivePath)
          ? move.archivePath
          : disposal.state === "pending-disposal"
            ? disposal.claimPath
            : move.archivePath;
        expect(fs.readFileSync(retainedPath)).toEqual(originals[index]);
      }
    } finally {
      restoreSync();
      writer?.close();
    }
  });

  it.each(["intent-sync", "publication", "unlink-intent"])(
    "preserves connected originals when a later transcript changes during %s",
    async (phase) => {
      const store = createLegacyStore({
        transcriptLines: [JSON.stringify({ type: "session", id: "session-1", version: 3 })],
      });
      const sibling = path.join(store.sessionDir, "second.jsonl");
      fs.writeFileSync(
        sibling,
        JSON.stringify({ type: "session", id: "second", version: 3 }) + "\n",
      );
      const index = JSON.parse(fs.readFileSync(store.storePath, "utf8"));
      index["agent:main:second"] = {
        sessionId: "second",
        updatedAt: 2000,
        sessionFile: "second.jsonl",
      };
      fs.writeFileSync(store.storePath, JSON.stringify(index));
      const imported = await runDoctorSessionSqlite({
        env: store.env,
        mode: "import",
        store: store.storePath,
      });
      expect(imported.targets[0]?.issues).toEqual([]);
      closeOpenClawAgentDatabasesForTest();
      const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
      const target = readMigrationManifest(manifestPath).targets[0]!;
      const changed = expectDefined(
        target.completedMoves.find((move) => move.sourcePath === sibling),
        "later transcript",
      );
      const originals = new Map(
        target.completedMoves.map((move) => [move.archivePath, fs.readFileSync(move.archivePath)]),
      );
      let injected = false;
      const mutateAfterSync = (directory: string) => {
        const moves = readMigrationManifest(manifestPath).targets[0]!.completedMoves;
        const atUnlink = moves.some(
          (move) =>
            move.artifact?.disposal.state === "pending-disposal" &&
            move.artifact.disposal.phase === "unlink-pending",
        );
        if (
          !injected &&
          ((phase === "intent-sync" && directory === path.dirname(manifestPath) && !atUnlink) ||
            (phase === "publication" && directory === path.dirname(changed.archivePath)) ||
            (phase === "unlink-intent" && directory === path.dirname(manifestPath) && atUnlink))
        ) {
          injected = true;
          const move = expectDefined(
            moves.find((mappedMove) => mappedMove.archivePath === changed.archivePath),
            "changed transcript receipt",
          );
          const disposal = move.artifact!.disposal;
          const file = fs.existsSync(move.archivePath)
            ? move.archivePath
            : disposal.state === "pending-disposal"
              ? disposal.claimPath
              : move.archivePath;
          fs.appendFileSync(file, "unique late history\n");
          originals.set(move.archivePath, fs.readFileSync(file));
        }
      };
      const restoreSync = observeRecoveryDirectorySync(path.dirname(manifestPath), mutateAfterSync);
      const invoke = () =>
        retireSessionSqliteRecovery({
          env: store.env,
          preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
          readConfig: async () => ({}),
          confirm: async () => true,
        });
      try {
        const result = await invoke();
        expect(injected).toBe(true);
        expect(result.status).toBe("blocked");
        expect(result.totals.removedFiles).toBe(0);
      } finally {
        restoreSync();
      }
      expect((await invoke()).totals.removedFiles).toBe(0);
      for (const move of readMigrationManifest(manifestPath).targets[0]!.completedMoves) {
        const disposal = move.artifact!.disposal;
        expect(disposal.state).not.toBe("disposed");
        const file = fs.existsSync(move.archivePath)
          ? move.archivePath
          : disposal.state === "pending-disposal"
            ? disposal.claimPath
            : move.archivePath;
        expect(fs.readFileSync(file)).toEqual(originals.get(move.archivePath));
      }
    },
  );

  it("refuses retirement while a peer maintenance operation holds the selected state", async () => {
    const { store } = await createVerifiedRecoveryStore();
    const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
    const confirm = vi.fn(async () => true);
    await withDoctorSqliteMaintenanceLock({
      env: store.env,
      operation: "fixture import",
      run: async () => {
        await expect(
          retireSessionSqliteRecovery({
            env: store.env,
            preview,
            readConfig: async () => ({}),
            confirm,
          }),
        ).rejects.toThrow("Gateway or another SQLite maintenance");
      },
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("protects originals already consumed by restore without reporting unexplained loss", async () => {
    const { store, archivePath } = await createVerifiedRecoveryStore();
    const restored = await runDoctorSessionSqlite({
      env: store.env,
      mode: "restore",
      store: store.storePath,
    });
    expect(restored.targets[0]?.restore?.restoredFiles).toContain(store.transcriptPath);
    const original = fs.readFileSync(store.transcriptPath);
    const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
    expect(preview.artifacts.find((item) => item.path === archivePath)).toMatchObject({
      outcome: "protected",
      reason: "archive-consumed-by-restore",
    });
    const cleanup = await retireSessionSqliteRecovery({
      env: store.env,
      preview,
      readConfig: async () => ({}),
      confirm: async () => true,
    });
    expect(cleanup.status).toBe("complete");
    expect(cleanup.totals.removedFiles).toBe(0);
    expect(fs.readFileSync(store.transcriptPath)).toEqual(original);
  });

  it("resumes shared cross-manifest disposal after only one terminal receipt is durable", async () => {
    const { store, imported, archivePath } = await createVerifiedRecoveryStore();
    const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
    const original = readMigrationManifest(manifestPath);
    const duplicate = createSessionSqliteMigrationRun(store.env, original.targets);
    duplicate.manifest.targets = structuredClone(original.targets);
    duplicate.manifest.completedAt = original.completedAt;
    writeSessionSqliteMigrationManifest(duplicate);
    const write = replaceFile.replaceFileAtomicSync;
    let injected = false;
    const spy = vi.spyOn(replaceFile, "replaceFileAtomicSync").mockImplementation((options) => {
      if (
        !injected &&
        options.filePath === manifestPath &&
        String(options.content).includes('"disposed"')
      ) {
        injected = true;
        const other = readMigrationManifest(duplicate.manifestPath);
        expect(
          other.targets[0]?.plannedMoves.find((move) => move.archivePath === archivePath)?.artifact
            ?.disposal.state,
        ).toBe("disposed");
        throw new Error("injected shared receipt");
      }
      return write(options);
    });
    const invoke = () =>
      retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => true,
      });
    try {
      expect((await invoke()).status).toBe("blocked");
    } finally {
      spy.mockRestore();
    }
    expect(injected).toBe(true);
    expect((await invoke()).status).toBe("complete");
    for (const file of [manifestPath, duplicate.manifestPath]) {
      const receipt = readMigrationManifest(file).targets[0]!.plannedMoves.find(
        (move) => move.archivePath === archivePath,
      );
      expect(receipt?.artifact?.disposal.state).toBe("disposed");
    }
  });

  it("retires verified exact originals while preserving current SQLite and unknown archives", async () => {
    const store = createLegacyStore({
      transcriptLines: [
        JSON.stringify({ type: "session", id: "session-1", version: 3 }),
        JSON.stringify({
          type: "message",
          id: "original-only",
          parentId: null,
          message: {
            role: "user",
            content:
              "hello\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nretired context\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
          },
        }),
        JSON.stringify({
          type: "message",
          id: "user-1",
          parentId: null,
          message: { role: "user", content: "hello" },
        }),
        JSON.stringify({
          type: "message",
          id: "reply-1",
          parentId: "user-1",
          message: { role: "assistant", provider: "openai-codex", content: "hello back" },
        }),
      ],
    });
    const original = fs.readFileSync(store.transcriptPath);
    const imported = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    expect(imported.targets[0]?.issues).toEqual([]);
    const manifest = readMigrationManifest(imported.migrationRun?.manifestPath);
    const originalMove = manifest.targets[0]!.completedMoves.find(
      (move) => move.kind === "transcript",
    )!;
    expect(fs.readFileSync(originalMove.archivePath)).toEqual(original);
    expect(originalMove.artifact?.classification).toBe("repair-original");
    expect(
      loadTranscriptEventsSync({
        agentId: "main",
        storePath: store.storePath,
        sessionId: "session-1",
      }),
    ).toEqual(["session-1", "user-1", "reply-1"].map((id) => expect.objectContaining({ id })));
    const manager = SessionManager.open(
      {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      },
      store.tempDir,
    );
    manager.appendMessage({
      role: "user",
      content: "history written after the upgrade",
      timestamp: Date.now(),
    });
    closeOpenClawAgentDatabasesForTest();
    const sqlitePath = imported.targets[0]!.sqlitePath;
    const databaseBefore = fs.readFileSync(sqlitePath);
    expect(fs.existsSync(`${sqlitePath}-wal`)).toBe(false);
    expect(fs.existsSync(`${sqlitePath}-shm`)).toBe(false);
    const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
    expect(preview.artifacts.find((item) => item.path === originalMove.archivePath)?.outcome).toBe(
      "candidate",
    );
    const cleanup = await retireSessionSqliteRecovery({
      env: store.env,
      preview,
      readConfig: async () => ({}),
      confirm: async () => {
        // The actual read-only owner inspection creates these sidecars before confirmation.
        expect(fs.existsSync(`${sqlitePath}-wal`)).toBe(true);
        expect(fs.existsSync(`${sqlitePath}-shm`)).toBe(true);
        return true;
      },
    });
    expect(cleanup.status).toBe("complete");
    expect(cleanup.totals.removedFiles).toBe(2);
    expect(cleanup.totals.removedBytes).toBeGreaterThan(original.length);
    expect(fs.existsSync(originalMove.archivePath)).toBe(false);
    expect(fs.readFileSync(sqlitePath)).toEqual(databaseBefore);
    expect(cleanup.artifacts.filter((item) => item.outcome === "protected")).toHaveLength(2);
    const retry = await retireSessionSqliteRecovery({
      env: store.env,
      preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
      readConfig: async () => ({}),
      confirm: async () => true,
    });
    expect(retry.totals.removedBytes).toBe(0);
    const restored = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {},
      env: store.env,
      mode: "restore",
    });
    expect(
      restored.targets[0]?.restore?.conflicts.some((item) =>
        item.reason.includes("intentionally disposed"),
      ),
    ).toBe(true);
  });

  it("retains archived source mappings after more than 50 successful migration runs", async () => {
    const store = createLegacyStore();
    const original = fs.readFileSync(store.transcriptPath);
    const imported = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
    const manifest = readMigrationManifest(manifestPath);
    const archive = manifest.targets[0]!.completedMoves.find((move) => move.kind === "transcript")!;
    // Real run creation owns retention. Later payload-free successes must not erase rollback maps.
    for (let index = 0; index < 52; index += 1) {
      const run = createSessionSqliteMigrationRun(store.env, [trustedMigrationTarget(store)]);
      run.manifest.completedAt = new Date(Date.now() + index + 1).toISOString();
      writeSessionSqliteMigrationManifest(run);
    }
    expect(fs.readFileSync(archive.archivePath)).toEqual(original);
    const restored = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {},
      env: store.env,
      mode: "restore",
    });
    expect(restored.targets[0]?.restore?.manifestPaths).toContain(manifestPath);
    expect(fs.readFileSync(store.transcriptPath)).toEqual(original);
  });

  it("uses the requested agent as the owner for explicit-store maintenance", async () => {
    const stateDir = autoCleanupTempDirs.make("openclaw-doctor-explicit-ops-");
    const storePath = path.join(stateDir, "shared", "sessions.json");
    const report = await runDoctorSessionSqlite({
      agent: "ops",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      mode: "inspect",
      store: storePath,
    });

    expect(report.targets).toHaveLength(1);
    expect(report.targets[0]).toMatchObject({ agentId: "ops", storePath });
  });

  it("reads populated v13 session_entries before migration", () => {
    const stateDir = autoCleanupTempDirs.make("openclaw-doctor-v13-reader-");
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const target = { agentId: "main", storePath };
    const sqlitePath = resolveTargetSqlitePath(target);
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const sqlite = nodeSqlite.requireNodeSqlite();
    const database = new sqlite.DatabaseSync(sqlitePath);
    try {
      database.exec(`
        CREATE TABLE session_entries (
          session_key TEXT NOT NULL PRIMARY KEY,
          session_id TEXT NOT NULL,
          entry_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO session_entries (session_key, session_id, entry_json, updated_at)
        VALUES (
          'agent:main:v13-reader',
          'v13-reader-session',
          '{"sessionId":"v13-reader-session","updatedAt":13}',
          13
        );
        PRAGMA user_version = 13;
      `);
    } finally {
      database.close();
    }

    expect(readOnlySqliteValidationSnapshot(target)).toEqual({
      ok: true,
      snapshot: {
        sessionIdsBySessionKey: new Map([["agent:main:v13-reader", "v13-reader-session"]]),
        transcriptEventCountsBySessionId: new Map(),
      },
    });
  });

  it("excludes v14 transcript-only nodes from doctor entry reads", () => {
    const stateDir = autoCleanupTempDirs.make("openclaw-doctor-v14-reader-");
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const target = { agentId: "main", storePath };
    const sqlitePath = resolveTargetSqlitePath(target);
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const sqlite = nodeSqlite.requireNodeSqlite();
    const database = new sqlite.DatabaseSync(sqlitePath);
    try {
      database.exec(`
        CREATE TABLE session_nodes (
          session_key TEXT NOT NULL PRIMARY KEY,
          current_session_id TEXT NOT NULL,
          entry_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO session_nodes VALUES
          ('agent:main:transcript-only', 'transcript-only-session', '{}', 14),
          ('agent:main:v14-reader', 'v14-reader-session',
           '{"sessionId":"v14-reader-session","updatedAt":14}', 14);
        PRAGMA user_version = 14;
      `);
    } finally {
      database.close();
    }

    expect(readOnlySqliteValidationSnapshot(target)).toEqual({
      ok: true,
      snapshot: {
        sessionIdsBySessionKey: new Map([["agent:main:v14-reader", "v14-reader-session"]]),
        transcriptEventCountsBySessionId: new Map(),
      },
    });
  });

  it("reads compact promoted validation identities without parsing large entry JSON", () => {
    const stateDir = autoCleanupTempDirs.make("openclaw-doctor-compact-validation-");
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const target = { agentId: "main", storePath };
    const sqlitePath = resolveTargetSqlitePath(target);
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const sqlite = nodeSqlite.requireNodeSqlite();
    const database = new sqlite.DatabaseSync(sqlitePath);
    const payload = "x".repeat(2 * 1024 * 1024);
    const entryJson = JSON.stringify({
      payload,
      sessionId: "embedded-stale-id",
      updatedAt: 17,
    });
    try {
      database.exec(`
        CREATE TABLE session_nodes (
          session_key TEXT NOT NULL PRIMARY KEY,
          current_session_id TEXT NOT NULL,
          entry_json TEXT NOT NULL,
          entry_valid INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE transcript_events (
          session_id TEXT NOT NULL,
          event_json TEXT NOT NULL
        );
      `);
      database
        .prepare("INSERT INTO session_nodes VALUES (?, ?, ?, 1, 17)")
        .run("agent:main:compact", "promoted-session-id", entryJson);
      database
        .prepare("INSERT INTO transcript_events VALUES (?, '{}'), (?, '{}')")
        .run("promoted-session-id", "promoted-session-id");
    } finally {
      database.close();
    }
    const parseSpy = vi.spyOn(JSON, "parse");
    try {
      expect(readOnlySqliteValidationSnapshot(target)).toEqual({
        ok: true,
        snapshot: {
          sessionIdsBySessionKey: new Map([["agent:main:compact", "promoted-session-id"]]),
          transcriptEventCountsBySessionId: new Map([["promoted-session-id", 2]]),
        },
      });
      expect(parseSpy.mock.calls.some(([value]) => value === entryJson)).toBe(false);
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("imports zero legacy records without parsing canonical entry JSON", async () => {
    const stateDir = autoCleanupTempDirs.make("openclaw-doctor-empty-import-");
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, "{}\n", { mode: 0o600 });
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const entryJson = JSON.stringify({
      payload: "empty-import-sentinel".repeat(64 * 1024),
      sessionId: "canonical-only-session",
      updatedAt: 19,
    });
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run("agent:main:main", "canonical-only-session", entryJson, 19);
    database.db.prepare("UPDATE session_nodes SET entry_valid = 1").run();
    const sqlitePath = database.path;
    closeOpenClawAgentDatabasesForTest();
    const parseSpy = vi.spyOn(JSON, "parse");
    try {
      const report = await runDoctorSessionSqlite({ env, mode: "import", store: storePath });
      expect(report.totals).toMatchObject({
        importedEntries: 0,
        issues: 0,
        legacyEntries: 0,
        sqliteEntries: 1,
      });
      expect(parseSpy.mock.calls.some(([value]) => value === entryJson)).toBe(false);
    } finally {
      parseSpy.mockRestore();
    }
    const verifier = new (nodeSqlite.requireNodeSqlite().DatabaseSync)(sqlitePath, {
      readOnly: true,
    });
    try {
      expect(verifier.prepare("SELECT entry_json FROM session_nodes").get()).toEqual({
        entry_json: entryJson,
      });
    } finally {
      verifier.close();
    }
  });

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

  it("reports store_unreadable instead of crashing when the store stat fails", async () => {
    const store = createLegacyStore();
    // Replace the sessions directory with a regular file so statSync on the
    // store path throws ENOTDIR (non-ENOENT errors bypass throwIfNoEntry).
    fs.rmSync(store.sessionDir, { force: true, recursive: true });
    fs.writeFileSync(store.sessionDir, "not a directory\n", { mode: 0o600 });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "inspect",
      store: store.storePath,
    });

    expect(report.targets[0]?.issues).toEqual([
      expect.objectContaining({ code: "store_unreadable" }),
    ]);
  });

  it("reports store_unreadable for a non-regular store path", async () => {
    const store = createLegacyStore();

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "inspect",
      store: store.sessionDir,
    });

    expect(report.targets[0]?.issues).toEqual([
      expect.objectContaining({
        code: "store_unreadable",
        message: expect.stringContaining("not a regular file"),
      }),
    ]);
  });

  it("inspects SQLite-only all-agent targets without requiring a legacy store", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-session-sqlite-"));
    try {
      const stateDir = path.join(tempDir, "state");
      const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      await upsertSessionEntryCore(
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
          .prepare("PRAGMA table_info(session_windows)")
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
    const stateDir = path.join(tempDir, "token=supersecret", "state");
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
    const manifest = readMigrationManifest(report.migrationRun?.manifestPath);
    expect(manifest.failedAt).toBeTruthy();
    expect(manifest.failureReports).toBeDefined();
    const failureReportPath = expectDefined(
      report.migrationRun?.failureReportMarkdownPath,
      "blocking migration failure report path",
    );
    const failureReport = fs.readFileSync(failureReportPath, "utf-8");
    expect(failureReport).toContain("sqlite_compact_failed");
    expect(failureReport).toContain("openclaw doctor --session-sqlite recover --github-issue");
    expect(failureReport).not.toContain("supersecret");
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

  it("repairs legacy transcript and route shapes at the import boundary", async () => {
    const store = createLegacyStore({
      entryOverrides: {
        route: "stale-custom-slot",
        deliveryContext: { channel: "telegram", to: "123" },
      },
      transcriptLines: [
        '{"type":"session","sessionId":"session-1"}',
        '{"type":"plugin_state","id":"opaque-1","payload":{"keep":"exact"}}',
        '{"type":"message","id":"m1","parentId":null,"message":{"role":"assistant","content":"legacy string"}}',
        '{"type":"compaction","summary":"legacy summary","firstKeptEntryIndex":2,"tokensBefore":42}',
      ],
    });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });

    expect(report.totals).toMatchObject({ importedEntries: 1, issues: 0 });
    const imported = loadExactSessionEntry({
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath: store.storePath,
    });
    // The SQLite runtime does no read repair, so import must store canonical shapes.
    expect(typeof sessionDeliveryRoute(imported?.entry)).not.toBe("string");
    const events = loadTranscriptEventsSync({
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath: store.storePath,
    });
    const message = events.find((event) => (event as { type?: string }).type === "message") as {
      id?: string;
      message?: { content?: unknown };
    };
    const compaction = events.find(
      (event) => (event as { type?: string }).type === "compaction",
    ) as { firstKeptEntryId?: string; parentId?: string };
    expect(events[0]).toMatchObject({
      id: "session-1",
      type: "session",
      version: CURRENT_SESSION_VERSION,
    });
    expect(events[0]).not.toHaveProperty("sessionId");
    expect(events[1]).toEqual({
      id: "opaque-1",
      payload: { keep: "exact" },
      type: "plugin_state",
    });
    expect(message?.message?.content).toEqual([{ type: "text", text: "legacy string" }]);
    expect(compaction).toMatchObject({
      firstKeptEntryId: message.id,
      parentId: message.id,
    });
    const manager = SessionManager.open(
      {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      },
      store.tempDir,
    );
    expect(
      manager.appendMessage({
        content: "post-import message",
        role: "user",
        timestamp: Date.now(),
      }),
    ).toEqual(expect.any(String));
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
            "SELECT session_id, length(generation) AS generation_length FROM transcript_rewrite_watermarks",
          )
          .all(),
      ).toEqual([{ generation_length: 32, session_id: "session-1" }]);
    } finally {
      migrated.close();
    }
  });

  it("aborts import when the legacy transcript changes between passes", () => {
    const store = createLegacyStore();
    const realStatSync = fs.statSync.bind(fs);
    let fingerprintReads = 0;
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation(((candidate, options) => {
      const stat = realStatSync(candidate, options as never);
      if (
        path.resolve(String(candidate)) === path.resolve(store.transcriptPath) &&
        (options as { bigint?: boolean } | undefined)?.bigint === true
      ) {
        fingerprintReads += 1;
        if (fingerprintReads === 2) {
          fs.appendFileSync(store.transcriptPath, '{"type":"custom","customType":"late"}\n');
        }
      }
      return stat;
    }) as typeof fs.statSync);

    try {
      const events: unknown[] = [];
      expect(() =>
        createTranscriptEventReader(
          store.transcriptPath,
          "session-1",
        )((event) => {
          events.push(event);
        }),
      ).toThrow(/stop active session writers and rerun `openclaw doctor --fix`/);
      expect(events).toEqual([]);
    } finally {
      statSpy.mockRestore();
    }
  });

  it("aborts a batch when a prepared transcript changes before import", async () => {
    const store = createLegacyStore();
    const realStatSync = fs.statSync.bind(fs);
    let changed = false;
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation(((candidate, options) => {
      const stat = realStatSync(candidate, options as never);
      if (
        !changed &&
        path.resolve(String(candidate)) === path.resolve(store.transcriptPath) &&
        !(options as { bigint?: boolean } | undefined)?.bigint
      ) {
        changed = true;
        fs.appendFileSync(store.transcriptPath, '{"type":"custom","customType":"late"}\n');
      }
      return stat;
    }) as typeof fs.statSync);

    try {
      await expect(
        runDoctorSessionSqlite({ env: store.env, mode: "import", store: store.storePath }),
      ).rejects.toThrow(/stop active session writers and rerun `openclaw doctor --fix`/);
      expect(fs.existsSync(store.transcriptPath)).toBe(true);
    } finally {
      statSpy.mockRestore();
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
      readTranscriptStatsSync({
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
    await upsertSessionEntryCore(
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
      loadExactSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      })?.entry,
    ).toMatchObject({
      agentHarnessId: "codex",
      lifecycleRevision: "rev-1",
      sessionId: "session-1",
    });
  });

  it.each([true, false])(
    "preserves required=%s creation provenance when importing an older legacy row",
    async (required) => {
      const legacyStamp = {
        createdActor: { id: "profile-legacy", type: "human" as const },
        createdAt: 1000,
        createdVia: "channel" as const,
      };
      const authoritativeStamp = {
        createdActor: {
          id: "profile-protected",
          type: "human" as const,
          source: "profile" as const,
        },
        createdAt: 1500,
        createdVia: "operator" as const,
        ...(required ? { sandbox: "required" as const } : {}),
      };
      const store = createLegacyStore({ entryOverrides: legacyStamp });
      const scope = {
        agentId: "main",
        env: store.env,
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      };
      await upsertSessionEntryCore(scope, {
        ...authoritativeStamp,
        sessionId: "session-1",
        updatedAt: 3000,
      });

      const report = await runDoctorSessionSqlite({
        env: store.env,
        mode: "import",
        store: store.storePath,
      });

      expect(report.totals).toMatchObject({ importedEntries: 1, issues: 0 });
      const imported = loadExactSessionEntry(scope)?.entry;
      expect(imported).toMatchObject({
        ...(required
          ? authoritativeStamp
          : {
              ...legacyStamp,
              createdActor: { ...legacyStamp.createdActor, source: "channel" },
            }),
        sessionId: "session-1",
      });
      if (!required) {
        expect(imported).not.toHaveProperty("sandbox");
      }
    },
  );

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
      loadExactSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      })?.entry,
    ).not.toHaveProperty("sessionFile");
    expect(
      loadTranscriptEventsSync({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }),
    ).toHaveLength(2);
  });

  it("archives legacy stores with valid sessions and invalid cron stubs without failing", async () => {
    const store = createLegacyStore();
    const legacyStore = JSON.parse(fs.readFileSync(store.storePath, "utf-8")) as Record<
      string,
      unknown
    >;
    const cronStubKey = "agent:main:cron:legacy-stub";
    legacyStore[cronStubKey] = { updatedAt: 1500 };
    fs.writeFileSync(store.storePath, `${JSON.stringify(legacyStore, null, 2)}\n`, { mode: 0o600 });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });

    expect(report.totals).toMatchObject({
      archivedLegacyStoreFiles: 1,
      importedEntries: 1,
      importedTranscriptEvents: 2,
      issues: 1,
      sqliteEntries: 1,
    });
    expect(report.targets[0]?.issues).toEqual([
      {
        code: "entry_invalid",
        message: "Session entry is missing a valid sessionId.",
        sessionKey: cronStubKey,
      },
    ]);
    const archivedStorePath = expectDefined(
      report.targets[0]?.archivedLegacyStoreFiles?.[0],
      "archived legacy store path",
    );
    expect(fs.existsSync(store.storePath)).toBe(false);
    expect(fs.existsSync(archivedStorePath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(archivedStorePath, "utf-8"))).toMatchObject({
      [cronStubKey]: { updatedAt: 1500 },
    });

    const manifest = readMigrationManifest(report.migrationRun?.manifestPath);
    expect(manifest.failedAt).toBeUndefined();
    expect(manifest.failureReports).toBeUndefined();
    expect(manifest.targets[0]).toMatchObject({
      issues: [expect.objectContaining({ code: "entry_invalid", sessionKey: cronStubKey })],
      validationBeforeArchive: "passed",
    });
    expect(report.migrationRun?.failureReportJsonPath).toBeUndefined();
    expect(report.migrationRun?.failureReportMarkdownPath).toBeUndefined();
    expect(fs.existsSync(store.unreferencedJsonlPath)).toBe(true);
    expect(
      manifest.targets[0]!.completedMoves.every(
        (move) => move.artifact?.classification === "protected",
      ),
    ).toBe(true);
    closeOpenClawAgentDatabasesForTest();
    const cleanup = await retireSessionSqliteRecovery({
      env: store.env,
      preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
      readConfig: async () => ({}),
      confirm: async () => true,
    });
    expect(cleanup.totals.removedFiles).toBe(0);
    expect(fs.existsSync(archivedStorePath)).toBe(true);
  });

  it.each(["NONE", "FULL", "INCREMENTAL"] as const)(
    "finalizes imports from auto_vacuum=%s without unnecessary repacking",
    async (autoVacuum) => {
      const { sqlitePath, store } = await createImportedStoreForCompaction();
      fs.writeFileSync(store.storePath, "{}\n");
      const database = nodeSqlite.openNodeSqliteDatabase(sqlitePath);
      let freelistBefore: number;
      try {
        database.exec(`PRAGMA auto_vacuum = ${autoVacuum}; VACUUM;
          CREATE TABLE cleanup_payload (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
          CREATE TABLE cleanup_discard (body BLOB);
          BEGIN;`);
        const insert = database.prepare("INSERT INTO cleanup_payload VALUES (?, ?)");
        for (let index = 0; index < 1000; index++) {
          insert.run(index, "x".repeat(1000));
        }
        // Keep partially filled pages as well as completely freed pages: only full
        // compaction should repack the former when pointer maps already exist.
        database.exec(`COMMIT; UPDATE cleanup_payload SET body = 'keep';
          INSERT INTO cleanup_discard VALUES (zeroblob(1048576));
          DELETE FROM cleanup_discard; PRAGMA wal_checkpoint(TRUNCATE);`);
        freelistBefore = Number(database.prepare("PRAGMA freelist_count").get()?.freelist_count);
      } finally {
        database.close();
      }
      const imported = await runDoctorSessionSqlite({
        env: store.env,
        mode: "import",
        store: store.storePath,
      });
      expect(imported.totals.issues).toBe(0);
      const cleanup = expectDefined(imported.targets[0]?.compact, "import cleanup");
      expect(cleanup.freelistAfterPages).toBe(0);
      if (autoVacuum !== "FULL") {
        expect(freelistBefore).toBeGreaterThan(0);
        expect(cleanup.reclaimedBytes).toBeGreaterThan(0);
      }
      const compacted = await runDoctorSessionSqlite({
        env: store.env,
        mode: "compact",
        store: store.storePath,
      });
      expect(compacted.totals.issues).toBe(0);
      const packed = expectDefined(compacted.targets[0]?.compact, "explicit compaction");
      if (autoVacuum === "NONE") {
        expect(packed.dbSizeAfterBytes).toBe(cleanup.dbSizeAfterBytes);
      } else {
        expect(packed.dbSizeAfterBytes).toBeLessThan(cleanup.dbSizeAfterBytes);
      }
      const after = nodeSqlite.openNodeSqliteDatabase(sqlitePath, { readOnly: true });
      try {
        expect(after.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });
        expect(after.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(after.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(after.prepare("SELECT id, body FROM cleanup_payload ORDER BY id").all()).toEqual(
          Array.from({ length: 1000 }, (_, id) => ({ id, body: "keep" })),
        );
      } finally {
        after.close();
      }
    },
  );

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

  it.skipIf(process.platform === "win32")(
    "allows hard-linked legacy stores during SQLite compaction",
    async () => {
      const { store } = await createImportedStoreForCompaction();
      const externalStorePath = path.join(store.tempDir, "external-sessions.json");
      fs.writeFileSync(store.storePath, "{}\n", { mode: 0o600 });
      fs.linkSync(store.storePath, externalStorePath);

      const report = await runDoctorSessionSqlite({
        env: store.env,
        mode: "compact",
        store: store.storePath,
      });

      expect(report.totals.issues).toBe(0);
      expect(fs.statSync(externalStorePath).nlink).toBe(2);
      expect(fs.readFileSync(externalStorePath, "utf8")).toBe("{}\n");
    },
  );

  it("preserves the typed maintenance cause when import finalization fails", async () => {
    const store = createLegacyStore();
    fs.writeFileSync(store.storePath, "{}\n");
    openOpenClawAgentDatabase({ agentId: "main", env: store.env });
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    const openDatabase = nodeSqlite.openNodeSqliteDatabase;
    const sharedPath = resolveOpenClawStateSqlitePath(store.env);
    const spy = vi
      .spyOn(nodeSqlite, "openNodeSqliteDatabase")
      .mockImplementation((file, options) => {
        if (file === sharedPath && !options?.readOnly) {
          throw Object.assign(new Error("fixture lease storage failure"), { code: "SQLITE_IOERR" });
        }
        return openDatabase(file, options);
      });
    try {
      const report = await runDoctorSessionSqlite({
        env: store.env,
        mode: "import",
        store: store.storePath,
      });
      expect(report.targets[0]?.issues).toContainEqual(
        expect.objectContaining({
          code: "sqlite_compact_failed",
          message: expect.stringContaining("fixture lease storage failure | SQLITE_IOERR"),
        }),
      );
      expect(fs.readFileSync(store.storePath, "utf8")).toBe("{}\n");
      const failureReportPath = expectDefined(
        report.migrationRun?.failureReportMarkdownPath,
        "failure report",
      );
      expect(fs.readFileSync(failureReportPath, "utf8")).toContain(
        "fixture lease storage failure | SQLITE_IOERR",
      );
    } finally {
      spy.mockRestore();
    }
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

      await expect(
        runDoctorSessionSqlite({
          env: store.env,
          mode: "compact",
          store: store.storePath,
        }),
      ).rejects.toThrow(/Cannot run session SQLite compact.*symbolic-link path/iu);
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

  it.each([false, true])(
    "compacts and repairs canonical indexes in place (shared store: %s)",
    async (shared) => {
      const { sqlitePath, store } = await createImportedStoreForCompaction(shared);
      const selection = {
        env: store.env,
        store: store.storePath,
        ...(shared ? { agent: "beta" } : {}),
      };
      const compact = await runDoctorSessionSqlite({ ...selection, mode: "compact" });
      expect(compact.totals.issues).toBe(0);
      expect(compact.targets[0]?.compact?.skipped).toBe(false);
      createCanonicalCacheIndexDrift(sqlitePath);
      expect(
        recordOpenClawDatabaseQuarantine({
          env: store.env,
          kind: "agent",
          path: sqlitePath,
          reason: "canonical cache index drift",
        }),
      ).toBe(true);

      const report = await runDoctorSessionSqlite({
        ...selection,
        mode: "recover",
      });

      expect(report.totals.issues).toBe(0);
      expect(report.targets[0]?.corruptRecovery).toBeUndefined();
      expect(fs.existsSync(sqlitePath)).toBe(true);
      expect(readOpenClawDatabaseQuarantine(sqlitePath, { env: store.env })).toBeUndefined();

      const sqlite = nodeSqlite.requireNodeSqlite();
      const database = new sqlite.DatabaseSync(sqlitePath, { readOnly: true });
      try {
        expect(database.prepare("PRAGMA integrity_check").get()).toEqual({
          integrity_check: "ok",
        });
        expect(
          database
            .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND key = ?")
            .get("doctor", "canonical-index"),
        ).toEqual({ value_json: '{"ok":true}' });
      } finally {
        database.close();
      }
      expect(
        openOpenClawAgentDatabase({
          agentId: shared ? "alpha" : "main",
          env: store.env,
          path: sqlitePath,
        }).db.isOpen,
      ).toBe(true);
    },
  );

  it("fences quarantine clearing and later recovery targets after an awaited repair loses maintenance", async () => {
    const { sqlitePath, store } = await createImportedStoreForCompaction();
    createCanonicalCacheIndexDrift(sqlitePath);
    const laterPath = resolveOpenClawAgentSqlitePath({ agentId: "later", env: store.env });
    fs.mkdirSync(path.dirname(laterPath), { recursive: true });
    const laterBytes = Buffer.from("synthetic corrupt database\n");
    fs.writeFileSync(laterPath, laterBytes, { mode: 0o600 });
    for (const databasePath of [sqlitePath, laterPath]) {
      expect(
        recordOpenClawDatabaseQuarantine({
          env: store.env,
          kind: "agent",
          path: databasePath,
          reason: "synthetic recovery quarantine",
        }),
      ).toBe(true);
    }
    const quarantineBefore = [sqlitePath, laterPath].map((databasePath) =>
      readOpenClawDatabaseQuarantine(databasePath, { env: store.env }),
    );
    const agentDatabase = await import("../state/openclaw-agent-db.js");
    const migrate = agentDatabase.migrateOpenClawAgentDatabaseForMaintenance;
    let competingLeaseId: string | undefined;
    const repair = vi
      .spyOn(agentDatabase, "migrateOpenClawAgentDatabaseForMaintenance")
      .mockImplementationOnce(async (options, maintenance) => {
        await migrate(options, maintenance);
        // Lose the real owner at the caller's new await boundary, after native repair succeeds.
        const removed = openOpenClawStateDatabase({ env: store.env })
          .db.prepare("DELETE FROM state_leases WHERE scope = ? AND lease_key = ?")
          .run(AGENT_DATABASE_MAINTENANCE_LEASE.scope, AGENT_DATABASE_MAINTENANCE_LEASE.key);
        expect(removed.changes).toBe(1);
        competingLeaseId = claimOpenClawAgentDatabaseLease({
          agentId: "later",
          path: laterPath,
          env: store.env,
        });
      });
    try {
      await expect(
        recoverDoctorSessionSqliteTargets({
          env: store.env,
          options: { mode: "recover" },
          targets: [
            { agentId: "main", storePath: sqlitePath },
            { agentId: "later", storePath: laterPath },
          ],
          validateTarget: async () => {
            throw new Error("Expected direct recovery without a failed migration manifest");
          },
        }),
      ).rejects.toThrow(/maintenance lease.*was lost/iu);
      expect(competingLeaseId).toBeDefined();
      expect(
        [sqlitePath, laterPath].map((databasePath) =>
          readOpenClawDatabaseQuarantine(databasePath, { env: store.env }),
        ),
      ).toEqual(quarantineBefore);
      expect(fs.readFileSync(laterPath)).toEqual(laterBytes);
      expect(
        fs.readdirSync(path.dirname(laterPath)).some((name) => name.includes(".corrupt-")),
      ).toBe(false);
    } finally {
      repair.mockRestore();
      if (competingLeaseId) {
        releaseOpenClawAgentDatabaseLease(competingLeaseId, { env: store.env });
      }
    }
  });

  it.each(["newer schema", "mismatched older schema", "I/O error"] as const)(
    "keeps canonical-index repair failures in place after %s",
    async (failure) => {
      const { sqlitePath, store } = await createImportedStoreForCompaction();
      createCanonicalCacheIndexDrift(sqlitePath);
      if (failure !== "I/O error") {
        const version = failure === "newer schema" ? OPENCLAW_AGENT_SCHEMA_VERSION + 1 : 1;
        const database = new (nodeSqlite.requireNodeSqlite().DatabaseSync)(sqlitePath);
        try {
          database.exec(`PRAGMA user_version = ${version};`);
          database
            .prepare("UPDATE schema_meta SET schema_version = ? WHERE meta_key = 'primary'")
            .run(failure === "newer schema" ? version : 2);
        } finally {
          database.close();
        }
      }
      const before = fs.readFileSync(sqlitePath);
      const openDatabase = nodeSqlite.openNodeSqliteDatabase;
      const openSpy =
        failure === "I/O error"
          ? vi
              .spyOn(nodeSqlite, "openNodeSqliteDatabase")
              .mockImplementation((pathname, options) => {
                if (pathname === sqlitePath && options?.readOnly !== true) {
                  throw Object.assign(new Error("injected maintenance I/O failure"), {
                    code: "EIO",
                  });
                }
                return openDatabase(pathname, options);
              })
          : undefined;
      let report: Awaited<ReturnType<typeof runDoctorSessionSqlite>>;
      try {
        report = await runDoctorSessionSqlite({
          env: store.env,
          mode: "recover",
          store: store.storePath,
        });
      } finally {
        openSpy?.mockRestore();
      }
      expect(report.targets[0]?.issues).toMatchObject([{ code: "sqlite_recovery_inspect_failed" }]);
      expect(report.targets[0]?.corruptRecovery).toBeUndefined();
      expect(fs.readFileSync(sqlitePath)).toEqual(before);
      expect(
        fs.readdirSync(path.dirname(sqlitePath)).some((entry) => entry.includes(".corrupt-")),
      ).toBe(false);
    },
  );

  it("validates the trusted SQLite override when recovering a migration manifest", async () => {
    const store = createLegacyStore();
    const target = {
      agentId: "main",
      sqlitePath: path.join(store.stateDir, "migration-target.sqlite"),
      storePath: store.storePath,
    };
    await upsertSessionEntryCore(
      {
        agentId: target.agentId,
        env: store.env,
        sessionKey: "agent:main:main",
        storePath: target.sqlitePath,
      },
      { sessionId: "session-1", updatedAt: 1 },
    );
    const run = createSessionSqliteMigrationRun(store.env, [target]);
    const report = await recoverDoctorSessionSqliteTargets({
      env: store.env,
      options: { mode: "recover" },
      targets: [target],
      validateTarget: async (selected) => {
        const validation = readOnlySqliteValidationSnapshot(selected);
        if (!validation.ok) {
          throw validation.error;
        }
        return createDoctorSessionSqliteTargetReport({
          ...selected,
          sqlitePath: resolveTargetSqlitePath(selected),
          validatedEntries: validation.snapshot.sessionIdsBySessionKey.size,
        });
      },
    });
    expect(report.migrationRun?.manifestPath).toBe(run.manifestPath);
    expect(report.targets[0]?.sqlitePath).toBe(target.sqlitePath);
    expect(report.totals.validatedEntries).toBe(1);
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
    expect(
      recordOpenClawDatabaseQuarantine({
        env: store.env,
        kind: "agent",
        path: sqlitePath,
        reason: "stale secondary index",
      }),
    ).toBe(true);

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
    expect(readOpenClawDatabaseQuarantine(sqlitePath, { env: store.env })?.reason).toBe(
      "stale secondary index",
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
      loadExactSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      })?.entry,
    ).not.toHaveProperty("sessionFile");
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
    expect(manifest.manifestVersion).toBe(3);
    expect(target).toMatchObject({
      agentId: "main",
      storePath: expectedStorePath,
      validationBeforeArchive: "passed",
    });
    expect(target.completedMoves).toHaveLength(4);
    expect(target.plannedMoves.map((move) => path.basename(move.sourcePath)).toSorted()).toEqual([
      "orphan.jsonl",
      "session-1.jsonl",
      "session-1.trajectory.jsonl",
      "sessions.json",
    ]);
  });

  it("checkpoints bulk archive moves without per-file manifest rewrites", async () => {
    const store = createLegacyStore();
    const sessions = JSON.parse(fs.readFileSync(store.storePath, "utf-8")) as Record<
      string,
      Record<string, unknown>
    >;
    for (let index = 0; index < 64; index += 1) {
      const sessionId = `bulk-session-${index}`;
      const sessionFile = `${sessionId}.jsonl`;
      sessions[`agent:main:bulk:${index}`] = {
        channel: "cli",
        chatType: "direct",
        sessionFile,
        sessionId,
        updatedAt: 2000 + index,
      };
      fs.writeFileSync(
        path.join(store.sessionDir, sessionFile),
        `${JSON.stringify({ type: "session", sessionId })}\n`,
        { mode: 0o600 },
      );
      fs.writeFileSync(path.join(store.sessionDir, `orphan-${index}.jsonl`), "{}\n", {
        mode: 0o600,
      });
    }
    fs.writeFileSync(store.storePath, JSON.stringify(sessions, null, 2), { mode: 0o600 });
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
      const plannedTranscriptMoves =
        manifest.targets[0]?.plannedMoves.filter((move) => move.kind === "transcript") ?? [];

      expect(plannedUnreferencedMoves).toHaveLength(67);
      expect(new Set(plannedUnreferencedMoves.map((move) => move.archivePath)).size).toBe(67);
      expect(plannedTranscriptMoves).toHaveLength(65);
      expect(
        manifest.targets[0]?.completedMoves.filter((move) => move.kind === "unreferenced-jsonl"),
      ).toHaveLength(67);
      expect(
        manifest.targets[0]?.completedMoves.filter((move) => move.kind === "transcript"),
      ).toHaveLength(65);
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
    expect(restore.totals).not.toHaveProperty("archivedLegacyStoreFiles");
    expect(restore.totals).not.toHaveProperty("reclaimedBytes");
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

  it("restores the pre-migration session index when several manifests share one store", async () => {
    const store = createLegacyStore();
    const preMigrationIndex = fs.readFileSync(store.storePath, "utf-8");
    await runDoctorSessionSqlite({ env: store.env, mode: "import", store: store.storePath });
    const emptyArchivePaths: string[] = [];
    // Legacy writers recreate an empty index after a migration archived the real one, so later
    // runs archive that empty file. `persistLegacySessionStore` writes exactly these 3 bytes.
    for (let laterRun = 0; laterRun < 2; laterRun += 1) {
      // Run ids and archive names embed Date.now(), so keep the runs in distinct milliseconds.
      await new Promise((resolve) => {
        setTimeout(resolve, 2);
      });
      fs.writeFileSync(store.storePath, "{}\n", { mode: 0o600 });
      const importReport = await runDoctorSessionSqlite({
        env: store.env,
        mode: "import",
        store: store.storePath,
      });
      const manifest = readMigrationManifest(importReport.migrationRun?.manifestPath);
      emptyArchivePaths.push(
        expectDefined(
          manifest.targets[0]?.plannedMoves.find((move) => move.kind === "legacy-store"),
          "empty legacy archive move",
        ).archivePath,
      );
    }

    const restore = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {},
      env: store.env,
      mode: "restore",
    });

    expect(fs.readFileSync(store.storePath, "utf-8")).toBe(preMigrationIndex);
    expect(restore.targets[0]?.restore?.conflicts).toEqual([]);
    expect(restore.totals.issues).toBe(0);
    for (const archivePath of emptyArchivePaths) {
      expect(fs.readFileSync(archivePath, "utf-8")).toBe("{}\n");
    }
  });

  it("streams duplicate large transcript archives while selecting an identical restore", async () => {
    const transcriptLines = [
      JSON.stringify({ type: "session", id: "session-1", version: 3 }),
      JSON.stringify({
        type: "message",
        id: "large",
        parentId: null,
        message: { role: "user", content: "x".repeat(4 * 1024 * 1024) },
      }),
    ];
    const largeTranscript = `${transcriptLines.join("\n")}\n`;
    const store = createLegacyStore({ transcriptLines });
    const importReport = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const firstManifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
    const firstManifest = readMigrationManifest(firstManifestPath);
    const firstTarget = expectDefined(firstManifest.targets[0], "first migration target");
    const transcriptMove = expectDefined(
      firstTarget.plannedMoves.find((move) => move.kind === "transcript"),
      "transcript archive move",
    );
    const secondArchivePath = `${transcriptMove.archivePath}.duplicate`;
    fs.copyFileSync(transcriptMove.archivePath, secondArchivePath);
    const duplicateMove = {
      ...transcriptMove,
      archivePath: secondArchivePath,
      artifact: {
        ...expectDefined(transcriptMove.artifact, "original transcript identity"),
        identity: migrationArtifact.readMigrationArtifactIdentity(secondArchivePath),
      },
    };
    const duplicateManifest = structuredClone(firstManifest);
    duplicateManifest.runId = `${firstManifest.runId}-duplicate`;
    duplicateManifest.startedAt = new Date(Date.parse(firstManifest.startedAt) + 1).toISOString();
    duplicateManifest.targets = [
      {
        ...firstTarget,
        completedMoves: [duplicateMove],
        plannedMoves: [duplicateMove],
      },
    ];
    const duplicateManifestPath = path.join(
      path.dirname(firstManifestPath),
      `${duplicateManifest.runId}.json`,
    );
    fs.writeFileSync(duplicateManifestPath, `${JSON.stringify(duplicateManifest, null, 2)}\n`, {
      mode: 0o600,
    });

    const restore = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {},
      env: store.env,
      mode: "restore",
    });

    const restoreReport = expectDefined(
      restore.targets.find((target) => target.restore)?.restore,
      "aggregate restore report",
    );
    expect(restoreReport.conflicts).toEqual([]);
    expect(restore.totals.issues).toBe(0);
    expect(fs.statSync(store.transcriptPath).size).toBe(Buffer.byteLength(largeTranscript));
    expect(fs.readFileSync(store.transcriptPath, "utf-8")).toBe(largeTranscript);
    expect([transcriptMove.archivePath, secondArchivePath].filter(fs.existsSync)).toHaveLength(1);
  });

  it("fails closed when several manifests contain distinct nonempty session indexes", async () => {
    const store = createLegacyStore();
    const preMigrationIndex = fs.readFileSync(store.storePath, "utf-8");
    const firstImport = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const firstArchive = expectDefined(
      readMigrationManifest(firstImport.migrationRun?.manifestPath).targets[0]?.plannedMoves.find(
        (move) => move.kind === "legacy-store",
      ),
      "first legacy archive move",
    ).archivePath;
    await new Promise((resolve) => {
      setTimeout(resolve, 2);
    });
    // An older binary can still write real sessions to the legacy store after the migration.
    const laterIndex = `${JSON.stringify({ "agent:main:later": { channel: "cli", chatType: "direct", sessionFile: "session-2.jsonl", sessionId: "session-2", sessionStartedAt: 3000, updatedAt: 4000 } }, null, 2)}\n`;
    fs.writeFileSync(store.storePath, laterIndex, { mode: 0o600 });
    const secondImport = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const secondArchive = expectDefined(
      readMigrationManifest(secondImport.migrationRun?.manifestPath).targets[0]?.plannedMoves.find(
        (move) => move.kind === "legacy-store",
      ),
      "second legacy archive move",
    ).archivePath;

    const restore = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {},
      env: store.env,
      mode: "restore",
    });

    expect(fs.existsSync(store.storePath)).toBe(false);
    const restoreReport = expectDefined(
      restore.targets.find((target) => target.restore)?.restore,
      "aggregate restore report",
    );
    const storeConflicts = restoreReport.conflicts.filter((conflict) =>
      [firstArchive, secondArchive].includes(conflict.archivePath),
    );
    expect(storeConflicts).toHaveLength(2);
    expect(new Set(storeConflicts.map((conflict) => conflict.reason))).toEqual(
      new Set(["multiple distinct nonempty session indexes require explicit archive selection"]),
    );
    expect(fs.readFileSync(firstArchive, "utf-8")).toBe(preMigrationIndex);
    expect(fs.readFileSync(secondArchive, "utf-8")).toBe(laterIndex);
    expect(restore.totals.issues).toBeGreaterThan(0);
  });

  it("does not hide a missing original archive behind a later empty session index", async () => {
    const store = createLegacyStore();
    const firstImport = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const firstArchive = expectDefined(
      readMigrationManifest(firstImport.migrationRun?.manifestPath).targets[0]?.plannedMoves.find(
        (move) => move.kind === "legacy-store",
      ),
      "first legacy archive move",
    ).archivePath;
    fs.rmSync(firstArchive);
    await new Promise((resolve) => {
      setTimeout(resolve, 2);
    });
    fs.writeFileSync(store.storePath, "{}\n", { mode: 0o600 });
    const secondImport = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const secondArchive = expectDefined(
      readMigrationManifest(secondImport.migrationRun?.manifestPath).targets[0]?.plannedMoves.find(
        (move) => move.kind === "legacy-store",
      ),
      "second legacy archive move",
    ).archivePath;

    const restore = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {},
      env: store.env,
      mode: "restore",
    });

    expect(fs.existsSync(store.storePath)).toBe(false);
    expect(fs.readFileSync(secondArchive, "utf-8")).toBe("{}\n");
    const restoreReport = expectDefined(
      restore.targets.find((target) => target.restore)?.restore,
      "aggregate restore report",
    );
    const storeConflicts = restoreReport.conflicts.filter((conflict) =>
      [firstArchive, secondArchive].includes(conflict.archivePath),
    );
    expect(storeConflicts).toHaveLength(2);
    expect(storeConflicts.map((conflict) => conflict.reason)).toEqual(
      expect.arrayContaining([
        "archive is missing without a recorded prior restore; refusing another candidate",
        "another archive for this source is unavailable without prior restore evidence; refusing automatic selection",
      ]),
    );
  });

  it("does not replace an invalid original archive with a later empty session index", async () => {
    const store = createLegacyStore();
    const firstImport = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const firstArchive = expectDefined(
      readMigrationManifest(firstImport.migrationRun?.manifestPath).targets[0]?.plannedMoves.find(
        (move) => move.kind === "legacy-store",
      ),
      "first legacy archive move",
    ).archivePath;
    fs.writeFileSync(firstArchive, "{broken", { mode: 0o600 });
    await new Promise((resolve) => {
      setTimeout(resolve, 2);
    });
    fs.writeFileSync(store.storePath, "{}\n", { mode: 0o600 });
    const secondImport = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const secondArchive = expectDefined(
      readMigrationManifest(secondImport.migrationRun?.manifestPath).targets[0]?.plannedMoves.find(
        (move) => move.kind === "legacy-store",
      ),
      "second legacy archive move",
    ).archivePath;

    const restore = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {},
      env: store.env,
      mode: "restore",
    });

    expect(fs.existsSync(store.storePath)).toBe(false);
    expect(fs.readFileSync(firstArchive, "utf-8")).toBe("{broken");
    expect(fs.readFileSync(secondArchive, "utf-8")).toBe("{}\n");
    const restoreReport = expectDefined(
      restore.targets.find((target) => target.restore)?.restore,
      "aggregate restore report",
    );
    const storeConflicts = restoreReport.conflicts.filter((conflict) =>
      [firstArchive, secondArchive].includes(conflict.archivePath),
    );
    expect(storeConflicts).toHaveLength(2);
    expect(storeConflicts.map((conflict) => conflict.reason)).toEqual(
      expect.arrayContaining([
        "session index archive is not valid JSON; refusing automatic selection",
        "another archive for this source is unavailable without prior restore evidence; refusing automatic selection",
      ]),
    );
  });

  it("keeps restore clean when a later migration re-archived an already restored path", async () => {
    const store = createLegacyStore();
    const firstImport = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const firstManifestPath = requireMigrationManifestPath(firstImport.migrationRun?.manifestPath);
    const firstArchive = expectDefined(
      readMigrationManifest(firstManifestPath).targets[0]?.plannedMoves.find(
        (move) => move.kind === "legacy-store",
      ),
      "first legacy archive move",
    ).archivePath;
    await runDoctorSessionSqlite({ allAgents: true, cfg: {}, env: store.env, mode: "restore" });
    expect(readMigrationManifest(firstManifestPath).restore?.consumedArchives).toContain(
      firstArchive,
    );
    // Shipped manifests recorded only restored source paths. Exercise the additive-field upgrade
    // path instead of relying only on provenance written by this version.
    const shippedManifest = readMigrationManifest(firstManifestPath);
    if (shippedManifest.restore) {
      delete shippedManifest.restore.consumedArchives;
    }
    fs.writeFileSync(firstManifestPath, `${JSON.stringify(shippedManifest, null, 2)}\n`, {
      mode: 0o600,
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 2);
    });
    const secondImport = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });
    const secondManifestPath = requireMigrationManifestPath(
      secondImport.migrationRun?.manifestPath,
    );
    const secondArchive = expectDefined(
      readMigrationManifest(secondManifestPath).targets[0]?.plannedMoves.find(
        (move) => move.kind === "legacy-store",
      ),
      "second legacy archive move",
    ).archivePath;

    const restore = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {},
      env: store.env,
      mode: "restore",
    });

    // The first run's archives were consumed by the first restore, so only the second run can
    // reclaim these paths. The spent moves must not report as missing-archive failures.
    expect(restore.targets[0]?.restore?.conflicts).toEqual([]);
    expect(restore.totals.issues).toBe(0);
    expect(restore.targets[0]?.restore?.restoredFiles).toContain(
      canonicalTestPath(store.storePath),
    );
    expect(fs.readFileSync(store.storePath, "utf-8")).toContain("agent:main:main");
    expect(readMigrationManifest(firstManifestPath).restore?.consumedArchives).toContain(
      firstArchive,
    );
    expect(readMigrationManifest(secondManifestPath).restore?.consumedArchives).toContain(
      secondArchive,
    );
  });

  it("rejects malformed restore manifests without throwing", async () => {
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

    const restore = await restoreSessionSqliteMigrationRun({
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

    const restore = await restoreSessionSqliteMigrationRun({
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

    const restore = await restoreSessionSqliteMigrationRun({
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

      const restore = await restoreSessionSqliteMigrationRun({
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

  it.skipIf(!hasPlatformRootTempAlias)(
    "restores version 1 manifests written through a platform root alias",
    async () => {
      const store = createLegacyStore({ tempRoot: lexicalRootTempDir });
      const importReport = await runDoctorSessionSqlite({
        env: store.env,
        mode: "import",
        store: store.storePath,
      });
      const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
      const manifest = readMigrationManifest(manifestPath);
      const aliasPath = (filePath: string) =>
        path.join(lexicalRootTempDir, path.relative(realRootTempDir, filePath));
      manifest.manifestVersion = 1;
      for (const manifestTarget of manifest.targets) {
        for (const candidate of [
          ...manifestTarget.plannedMoves,
          ...manifestTarget.completedMoves,
        ]) {
          delete candidate.artifact;
        }
      }
      for (const target of manifest.targets) {
        target.sqlitePath = aliasPath(target.sqlitePath);
        target.storePath = aliasPath(target.storePath);
        for (const move of [...target.plannedMoves, ...target.completedMoves]) {
          move.archivePath = aliasPath(move.archivePath);
          move.sourcePath = aliasPath(move.sourcePath);
        }
      }
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

      const restore = await restoreSessionSqliteMigrationRun({
        manifestPath,
        trustedTargets: [trustedMigrationTarget(store)],
      });

      expect(restore.conflicts).toEqual([]);
      expect(restore.restoredFiles).toContain(canonicalTestPath(store.transcriptPath));
      expect(fs.existsSync(store.transcriptPath)).toBe(true);
    },
  );

  it.skipIf(!hasPlatformRootTempAlias)(
    "imports, previews, and restores a legacy store through a platform root alias",
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
      const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
      expect(preview.artifacts.some((artifact) => artifact.runs.length > 0)).toBe(true);

      const restored = await runDoctorSessionSqlite({
        env: store.env,
        mode: "restore",
        store: store.storePath,
      });
      expect(restored.targets[0]?.restore?.conflicts).toEqual([]);
      expect(fs.existsSync(store.transcriptPath)).toBe(true);
      expect(fs.existsSync(store.storePath)).toBe(true);
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
      for (const manifestTarget of manifest.targets) {
        for (const candidate of [
          ...manifestTarget.plannedMoves,
          ...manifestTarget.completedMoves,
        ]) {
          delete candidate.artifact;
        }
      }
      manifest.startedAt = "2999-01-01T00:00:00.000Z";
      target.plannedMoves = [move];
      target.completedMoves = [move];
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      const agentDir = path.dirname(store.sessionDir);
      const relocatedAgentDir = path.join(store.tempDir, "relocated-v1-agent");
      fs.renameSync(agentDir, relocatedAgentDir);
      fs.symlinkSync(relocatedAgentDir, agentDir);

      const restore = await restoreSessionSqliteMigrationRun({
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

      const restore = await restoreSessionSqliteMigrationRun({
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

      const restore = await restoreSessionSqliteMigrationRun({
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

      const restore = await restoreSessionSqliteMigrationRun({
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

    const restore = await restoreSessionSqliteMigrationRun({
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

  it.each(
    (
      [
        { version: 1, destination: "file" },
        { version: 2, destination: "file" },
        { version: 1, destination: "dangling-symlink" },
        { version: 2, destination: "dangling-symlink" },
      ] as const
    ).filter(({ destination }) => destination === "file" || process.platform !== "win32"),
  )(
    "preserves a late-created $destination during historical v$version restore without SQLite",
    async ({ version, destination }) => {
      const { store, manifestPath, manifest, archivePath } = createHistoricalRestoreStore(version);
      const original = fs.readFileSync(archivePath);
      const sourcePath = expectDefined(
        manifest.targets
          .flatMap((target) => target.plannedMoves)
          .find((move) => move.archivePath === archivePath),
        "transcript restore move",
      ).sourcePath;
      const competitorPath = path.join(store.tempDir, "competing-writer.jsonl");
      const competitorContent = "history written by a separate process\n";
      if (destination === "file") {
        fs.writeFileSync(competitorPath, competitorContent, { mode: 0o600 });
      }
      let competitorIdentity: fs.BigIntStats | undefined;
      const insertCompetitor = (from: fs.PathLike, to: fs.PathLike) => {
        if (competitorIdentity || String(from) !== archivePath || String(to) !== sourcePath) {
          return;
        }
        // Insert after every pathname guard, then forward the real publication syscall.
        execFileSync(
          process.execPath,
          [
            "-e",
            `const fs = require("node:fs");
             const [kind, candidate, target] = process.argv.slice(1);
             if (kind === "file") fs.copyFileSync(candidate, target, fs.constants.COPYFILE_EXCL);
             else fs.symlinkSync(candidate, target);`,
            destination,
            competitorPath,
            sourcePath,
          ],
          { timeout: 10_000 },
        );
        competitorIdentity = fs.lstatSync(sourcePath, { bigint: true });
      };
      const rename = fs.renameSync;
      const link = fsPromises.link;
      const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        insertCompetitor(from, to);
        return rename(from, to);
      });
      const linkSpy = vi.spyOn(fsPromises, "link").mockImplementation(async (from, to) => {
        insertCompetitor(from, to);
        return link(from, to);
      });
      let result: Awaited<ReturnType<typeof runPublicSessionSqlite>>;
      try {
        result = await runPublicSessionSqlite(store, "restore");
      } finally {
        renameSpy.mockRestore();
        linkSpy.mockRestore();
      }
      const created = expectDefined(competitorIdentity, "separate writer ran at publication");
      const retained = fs.lstatSync(sourcePath, { bigint: true });
      expect(retained.ino).toBe(created.ino);
      expect(retained.dev).toBe(created.dev);
      if (destination === "file") {
        expect(fs.readFileSync(sourcePath, "utf8")).toBe(competitorContent);
      } else {
        expect(retained.isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(sourcePath)).toBe(competitorPath);
        expect(fs.existsSync(competitorPath)).toBe(false);
      }
      expect(fs.readFileSync(archivePath)).toEqual(original);
      expect(result.exitCode).toBe(1);
      const restored = readMigrationManifest(manifestPath).restore;
      expect(restored?.conflicts).toEqual(
        expect.arrayContaining([expect.objectContaining({ archivePath, sourcePath })]),
      );
      expect(restored?.consumedArchives ?? []).not.toContain(archivePath);
      expect(restored?.restoredFiles ?? []).not.toContain(sourcePath);
      for (const target of manifest.targets) {
        expect(fs.existsSync(target.sqlitePath)).toBe(false);
      }
    },
  );

  it.each(
    ([1, 2] as const).flatMap((version) =>
      (["transcript", "legacy-store"] as const).map((kind) => ({ version, kind })),
    ),
  )(
    "rejects a changed historical v$version $kind before adopting restore metadata",
    async ({ version, kind }) => {
      const { store, manifestPath, manifest } = createHistoricalRestoreStore(version);
      const target = expectDefined(manifest.targets[0], "historical restore target");
      const move = expectDefined(
        target.plannedMoves.find((candidate) => candidate.kind === kind),
        "selected historical archive",
      );
      const original = fs.readFileSync(move.archivePath, "utf8");
      const changed = original.replace('"session-1"', '"session-2"');
      expect(changed).not.toBe(original);
      expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(original));
      const identity = fs.statSync(move.archivePath, { bigint: true });
      const duplicate = { ...move, archivePath: `${move.archivePath}.duplicate` };
      fs.copyFileSync(move.archivePath, duplicate.archivePath);
      target.plannedMoves.push(duplicate);
      target.completedMoves.push({ ...duplicate });
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });

      const close = fs.closeSync;
      let injected = false;
      const closeSpy = vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
        const opened = fs.fstatSync(fd, { bigint: true });
        close(fd);
        if (!injected && opened.dev === identity.dev && opened.ino === identity.ino) {
          // Change real bytes after the planner closes its verified descriptor, before adoption.
          injected = true;
          fs.writeFileSync(move.archivePath, changed);
        }
      });
      let result: Awaited<ReturnType<typeof runPublicSessionSqlite>>;
      try {
        result = await runPublicSessionSqlite(store, "restore");
      } finally {
        closeSpy.mockRestore();
      }
      expect(injected).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.report.targets[0]?.restore?.conflicts).toEqual([
        {
          archivePath: move.archivePath,
          sourcePath: move.sourcePath,
          reason: "archive changed after restore planning; refusing restore",
        },
      ]);
      expect(fs.existsSync(move.sourcePath)).toBe(false);
      expect(fs.readFileSync(move.archivePath, "utf8")).toBe(changed);
      expect(fs.statSync(move.archivePath, { bigint: true }).ino).toBe(identity.ino);
      expect(fs.readFileSync(duplicate.archivePath, "utf8")).toBe(original);
      const recorded = readMigrationManifest(manifestPath);
      expect(recorded.restore?.consumedArchives ?? []).not.toContain(move.archivePath);
      expect(recorded.restore?.restoredFiles ?? []).not.toContain(move.sourcePath);
      const recordedTarget = expectDefined(recorded.targets[0], "recorded historical target");
      for (const moves of [recordedTarget.plannedMoves, recordedTarget.completedMoves]) {
        const recordedMove = expectDefined(
          moves.find((item) => item.archivePath === move.archivePath),
          "recorded historical original",
        );
        expect(recordedMove.artifact).toBeUndefined();
      }
      expect(fs.existsSync(target.sqlitePath)).toBe(false);
    },
  );

  it.each(
    ([1, 2] as const).flatMap((version) =>
      (["restore", "recover"] as const).map((retryMode) => ({ version, retryMode })),
    ),
  )(
    "retries historical v$version restored-directory edge sync through $retryMode",
    async ({ version, retryMode }) => {
      const { store, manifestPath, manifest } = createHistoricalRestoreStore(version);
      const target = expectDefined(manifest.targets[0], "historical restore target");
      const originals = target.plannedMoves.map((move) => ({
        ...move,
        bytes: fs.readFileSync(move.archivePath),
        identity: fs.statSync(move.archivePath, { bigint: true }),
      }));
      if (retryMode === "recover") {
        manifest.failedAt = manifest.startedAt;
        fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
      }
      fs.rmdirSync(store.sessionDir);
      const sourceParent = path.dirname(store.sessionDir);
      const assertOriginalsRetained = () => {
        expect(readMigrationManifest(manifestPath).restore?.consumedArchives ?? []).toEqual([]);
        for (const original of originals) {
          expect(fs.readFileSync(original.archivePath)).toEqual(original.bytes);
          expect(fs.statSync(original.archivePath, { bigint: true }).ino).toBe(
            original.identity.ino,
          );
          if (fs.existsSync(original.sourcePath)) {
            expect(fs.readFileSync(original.sourcePath)).toEqual(original.bytes);
            expect(fs.statSync(original.sourcePath, { bigint: true }).ino).toBe(
              original.identity.ino,
            );
          }
        }
        for (const file of resolveSqliteDatabaseFilePaths(target.sqlitePath)) {
          expect(fs.existsSync(file)).toBe(false);
        }
      };
      const fsync = fs.fsyncSync;
      let edgeSyncAttempted = false;
      const syncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        if (isDirectoryDescriptor(fd, sourceParent)) {
          edgeSyncAttempted = true;
          throw Object.assign(new Error("injected restored-directory edge sync"), { code: "EIO" });
        }
        fsync(fd);
      });
      try {
        const first = await runPublicSessionSqlite(store, "restore");
        expect(edgeSyncAttempted).toBe(true);
        expect(first.exitCode).toBe(1);
        expect(first.report.targets[0]?.restore?.conflicts).toEqual(
          expect.arrayContaining(
            originals.map(({ archivePath, sourcePath }) =>
              expect.objectContaining({ archivePath, sourcePath }),
            ),
          ),
        );
        expect(fs.statSync(store.sessionDir).isDirectory()).toBe(true);
        assertOriginalsRetained();

        edgeSyncAttempted = false;
        await expect(runPublicSessionSqlite(store, retryMode)).rejects.toThrow(
          "injected restored-directory edge sync",
        );
        expect(edgeSyncAttempted).toBe(true);
        assertOriginalsRetained();
      } finally {
        syncSpy.mockRestore();
      }
      const resumed = await runPublicSessionSqlite(store, retryMode);
      expect(resumed.report.targets[0]?.restore?.conflicts).toEqual([]);
      const consumed = readMigrationManifest(manifestPath).restore?.consumedArchives;
      expect(consumed).toHaveLength(originals.length);
      expect(consumed).toEqual(expect.arrayContaining(originals.map((move) => move.archivePath)));
      for (const original of originals) {
        expect(fs.readFileSync(original.sourcePath)).toEqual(original.bytes);
        expect(fs.statSync(original.sourcePath, { bigint: true }).ino).toBe(original.identity.ino);
        expect(fs.existsSync(original.archivePath)).toBe(false);
      }
      for (const file of resolveSqliteDatabaseFilePaths(target.sqlitePath)) {
        expect(fs.existsSync(file)).toBe(false);
      }
    },
  );

  it.each(
    ([1, 2] as const).flatMap((version) =>
      (
        [
          { phase: "metadata-write", retryMode: "restore" },
          { phase: "metadata-sync", retryMode: "restore" },
          { phase: "target-sync", retryMode: "recover" },
          { phase: "receipt-write", retryMode: "restore" },
          { phase: "receipt-sync", retryMode: "recover" },
          { phase: "archive-unlink", retryMode: "restore" },
          { phase: "archive-sync", retryMode: "recover" },
        ] as const
      ).map(({ phase, retryMode }) => ({ version, phase, retryMode })),
    ),
  )(
    "resumes historical v$version index restore after $phase through $retryMode",
    async ({ version, phase, retryMode }) => {
      const { store, manifestPath, manifest } = createHistoricalRestoreStore(version);
      const target = expectDefined(manifest.targets[0], "historical restore target");
      const index = expectDefined(
        target.plannedMoves.find((move) => move.kind === "legacy-store"),
        "historical index original",
      );
      const originals = target.plannedMoves.map((move) => ({
        ...move,
        bytes: fs.readFileSync(move.archivePath),
        identity: fs.statSync(move.archivePath, { bigint: true }),
      }));
      const indexOriginal = expectDefined(
        originals.find((item) => item.kind === "legacy-store"),
        "historical index bytes",
      );
      if (retryMode === "recover") {
        manifest.failedAt = manifest.startedAt;
        fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
      }
      const manifestDir = path.dirname(manifestPath);
      const sourceDir = path.dirname(index.sourcePath);
      const archiveDir = path.dirname(index.archivePath);
      let injected = false;
      let replay = false;
      let failReplaySync = false;
      let replaySynced = false;
      let replayUnlinked = false;
      const hasReceipt = (candidate: SessionSqliteMigrationManifest) =>
        candidate.restore?.consumedArchives?.includes(index.archivePath) === true;
      const failManifestPhase = (
        candidate: SessionSqliteMigrationManifest,
        boundary: "write" | "sync",
      ) => {
        const recorded = candidate.targets
          .flatMap((item) => item.plannedMoves)
          .find((move) => move.archivePath === index.archivePath);
        const expectedPhase = hasReceipt(candidate)
          ? `receipt-${boundary}`
          : `metadata-${boundary}`;
        if (!injected && recorded?.artifact && phase === expectedPhase) {
          injected = true;
          throw new Error(`injected ${phase}`);
        }
      };
      const write = replaceFile.replaceFileAtomicSync;
      const writeSpy = vi
        .spyOn(replaceFile, "replaceFileAtomicSync")
        .mockImplementation((options) => {
          if (options.filePath === manifestPath) {
            failManifestPhase(
              JSON.parse(String(options.content)) as SessionSqliteMigrationManifest,
              "write",
            );
          }
          return write(options);
        });
      const fsync = fs.fsyncSync;
      const fsyncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        if (isDirectoryDescriptor(fd, manifestDir)) {
          failManifestPhase(readMigrationManifest(manifestPath), "sync");
        }
        fsync(fd);
      });
      const open = fsPromises.open;
      const restoreHandleSpies: Array<() => void> = [];
      const openSpy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (phase === "target-sync" && String(args[0]) === sourceDir) {
          const sync = handle.sync.bind(handle);
          const handleSpy = vi.spyOn(handle, "sync").mockImplementation(async () => {
            if (!injected && fs.existsSync(index.sourcePath) && fs.existsSync(index.archivePath)) {
              injected = true;
              throw Object.assign(new Error("injected target-sync"), { code: "EIO" });
            }
            return sync();
          });
          restoreHandleSpies.push(() => handleSpy.mockRestore());
        }
        return handle;
      });
      const sync = directoryDurability.syncDirectory;
      const syncSpy = vi
        .spyOn(directoryDurability, "syncDirectory")
        .mockImplementation(async (directory, options) => {
          const syncingPath = typeof directory === "string" ? directory : directory.path;
          if (replay && syncingPath === sourceDir) {
            if (failReplaySync) {
              throw new Error("injected replay target-sync");
            }
            const result = await sync(directory, options);
            replaySynced = true;
            return result;
          }
          if (
            !injected &&
            phase === "archive-sync" &&
            syncingPath === archiveDir &&
            !fs.existsSync(index.archivePath)
          ) {
            injected = true;
            throw new Error("injected archive-sync");
          }
          return sync(directory, options);
        });
      const unlink = fs.unlinkSync;
      const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
        if (String(file) === index.archivePath) {
          if (!injected && phase === "archive-unlink") {
            injected = true;
            throw new Error("injected archive-unlink");
          }
          if (replay) {
            expect(replaySynced).toBe(true);
            replayUnlinked = true;
          }
        }
        return unlink(file);
      });
      const copySpy = vi.spyOn(fs, "copyFileSync");
      const asyncCopySpy = vi.spyOn(fsPromises, "copyFile");
      try {
        const failed = await runPublicSessionSqlite(store, "restore");
        expect(injected).toBe(true);
        expect(failed.exitCode).toBe(1);
        expect(failed.report.targets[0]?.restore?.conflicts).toEqual(
          expect.arrayContaining([expect.objectContaining({ archivePath: index.archivePath })]),
        );
        const interrupted = readMigrationManifest(manifestPath);
        const consumedBeforeRetry = interrupted.restore?.consumedArchives ?? [];
        if (phase === "metadata-write" || phase === "metadata-sync") {
          expect(fs.existsSync(index.sourcePath)).toBe(false);
        } else {
          expect(fs.readFileSync(index.sourcePath)).toEqual(indexOriginal.bytes);
        }
        if (phase !== "archive-sync") {
          expect(fs.readFileSync(index.archivePath)).toEqual(indexOriginal.bytes);
        }
        if (phase === "archive-unlink" || phase === "archive-sync") {
          expect(consumedBeforeRetry).toContain(index.archivePath);
        }
        replay = fs.existsSync(index.sourcePath) && fs.existsSync(index.archivePath);
        if (phase === "target-sync") {
          failReplaySync = true;
          await expect(runPublicSessionSqlite(store, retryMode)).rejects.toThrow(
            "injected replay target-sync",
          );
          expect(fs.statSync(index.sourcePath).nlink).toBe(2);
          expect(fs.statSync(index.archivePath).ino).toBe(fs.statSync(index.sourcePath).ino);
          expect(replayUnlinked).toBe(false);
          failReplaySync = false;
        }
        const resumed = await runPublicSessionSqlite(store, retryMode);
        expect(resumed.report.targets[0]?.restore?.conflicts).toEqual([]);
        if (replay) {
          expect(replaySynced).toBe(true);
          expect(replayUnlinked).toBe(true);
        }
        replay = false;
        const settled = readMigrationManifest(manifestPath);
        expect(settled.manifestVersion).toBe(version);
        expect(settled.restore?.consumedArchives).toEqual(
          expect.arrayContaining(consumedBeforeRetry),
        );
        expect(settled.restore?.consumedArchives).toEqual(
          expect.arrayContaining(originals.map((item) => item.archivePath)),
        );
        for (const original of originals) {
          expect(fs.readFileSync(original.sourcePath)).toEqual(original.bytes);
          expect(fs.statSync(original.sourcePath, { bigint: true }).ino).toBe(
            original.identity.ino,
          );
          expect(fs.existsSync(original.archivePath)).toBe(false);
        }
        for (const file of resolveSqliteDatabaseFilePaths(target.sqlitePath)) {
          expect(fs.existsSync(file)).toBe(false);
        }
        expect(copySpy).not.toHaveBeenCalled();
        expect(asyncCopySpy).not.toHaveBeenCalled();
        expect((await runPublicSessionSqlite(store, "import")).report.totals.issues).toBe(0);
        expect(
          (await runPublicSessionSqlite(store, "restore")).report.targets[0]?.restore?.conflicts,
        ).toEqual([]);
        expect(readMigrationManifest(manifestPath).restore?.consumedArchives).toEqual(
          expect.arrayContaining(originals.map((item) => item.archivePath)),
        );
      } finally {
        writeSpy.mockRestore();
        fsyncSpy.mockRestore();
        openSpy.mockRestore();
        syncSpy.mockRestore();
        unlinkSpy.mockRestore();
        copySpy.mockRestore();
        asyncCopySpy.mockRestore();
        for (const restoreSpy of restoreHandleSpies) {
          restoreSpy();
        }
      }
    },
  );

  it.each([1, 2] as const)(
    "protects historical v%s restore metadata and its retained transcript dependency from cleanup",
    async (version) => {
      const { store, manifestPath, manifest, archivePath } = createHistoricalRestoreStore(version);
      const target = expectDefined(manifest.targets[0], "historical cleanup target");
      const index = expectDefined(
        target.plannedMoves.find((move) => move.kind === "legacy-store"),
        "historical index",
      );
      const indexIdentity = migrationArtifact.readMigrationArtifactIdentity(index.archivePath);
      const indexBytes = fs.readFileSync(index.archivePath);
      const transcriptBytes = fs.readFileSync(archivePath);
      fs.writeFileSync(store.transcriptPath, "new source history\n", { mode: 0o600 });
      const link = fsPromises.link;
      const linkSpy = vi.spyOn(fsPromises, "link").mockImplementation(async (from, to) => {
        if (String(from) === index.archivePath && String(to) === index.sourcePath) {
          throw Object.assign(new Error("injected unsupported hard link"), { code: "EXDEV" });
        }
        return link(from, to);
      });
      const copySpy = vi.spyOn(fs, "copyFileSync");
      const asyncCopySpy = vi.spyOn(fsPromises, "copyFile");
      try {
        const failed = await runPublicSessionSqlite(store, "restore");
        expect(failed.exitCode).toBe(1);
        expect(failed.report.targets[0]?.restore?.conflicts).toEqual(
          expect.arrayContaining([expect.objectContaining({ archivePath: index.archivePath })]),
        );
        expect(copySpy).not.toHaveBeenCalled();
        expect(asyncCopySpy).not.toHaveBeenCalled();
      } finally {
        linkSpy.mockRestore();
        copySpy.mockRestore();
        asyncCopySpy.mockRestore();
      }
      const recorded = readMigrationManifest(manifestPath);
      expect(recorded.manifestVersion).toBe(version);
      const indexMoves = [
        ...recorded.targets[0]!.plannedMoves,
        ...recorded.targets[0]!.completedMoves,
      ].filter((move) => move.archivePath === index.archivePath);
      expect(indexMoves).toHaveLength(2);
      for (const move of indexMoves) {
        expect(move.artifact).toMatchObject({
          classification: "protected",
          disposal: { state: "retained" },
          identity: indexIdentity,
          dependencies: [canonicalTestPath(store.transcriptPath)],
        });
      }
      const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
      expect(preview.artifacts.find((item) => item.path === index.archivePath)?.outcome).toBe(
        "protected",
      );
      expect(preview.artifacts.find((item) => item.path === archivePath)).toMatchObject({
        outcome: "protected",
        reason: "retained-recovery-dependency",
      });
      const cleanup = await retireSessionSqliteRecovery({
        env: store.env,
        preview,
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      expect(cleanup.totals.removedFiles).toBe(0);
      expect(fs.readFileSync(index.archivePath)).toEqual(indexBytes);
      expect(fs.readFileSync(archivePath)).toEqual(transcriptBytes);
      expect(fs.readFileSync(store.transcriptPath, "utf8")).toBe("new source history\n");
      expect(fs.existsSync(index.sourcePath)).toBe(false);
      expect(fs.existsSync(target.sqlitePath)).toBe(false);
    },
  );

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
    expect(recover.totals).not.toHaveProperty("archivedLegacyStoreFiles");
    expect(recover.totals).not.toHaveProperty("reclaimedBytes");
    expect(recover.targets[0]?.issues).toMatchObject([
      { code: "active_sqlite_transcript_jsonl", sessionKey: "agent:main:main" },
    ]);
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
    expect(recover.supportIssue).not.toHaveProperty("url");
  });

  it.each(["replaced", "missing"] as const)(
    "refuses a support claim when the saved report is %s during consent",
    (change) => {
      const store = createLegacyStore();
      writeFailedManifest(store, "consent-race.json", "2030-01-01T00:00:00.000Z");
      const manifestPath = path.join(
        store.stateDir,
        "session-sqlite-migration-runs",
        "consent-race.json",
      );
      const { markdownPath } = writeSessionSqliteMigrationFailureReports(manifestPath, {
        reason: "recovery before consent",
      });
      const approved = prepareGithubIssue(
        expectDefined(createSessionSqliteMigrationFailureIssue(manifestPath), "approved report"),
      );
      if (change === "replaced") {
        writeSessionSqliteMigrationFailureReports(manifestPath, {
          reason: "another recovery during consent",
        });
      } else {
        fs.unlinkSync(markdownPath);
      }
      const manifestBefore = fs.readFileSync(manifestPath);

      expect(
        claimSessionSqliteMigrationGithubIssue(manifestPath, approved, { assertCurrent: vi.fn() }),
      ).toBeUndefined();
      expect(fs.readFileSync(manifestPath)).toEqual(manifestBefore);
      if (change === "missing") {
        expect(createSessionSqliteMigrationFailureIssue(manifestPath)).toBeUndefined();
        expect(fs.existsSync(markdownPath)).toBe(false);
        return;
      }

      const current = prepareGithubIssue(
        expectDefined(createSessionSqliteMigrationFailureIssue(manifestPath), "current report"),
      );
      expect(current.marker).not.toBe(approved.marker);
      expect(
        claimSessionSqliteMigrationGithubIssue(manifestPath, current, { assertCurrent: vi.fn() }),
      ).toMatchObject({ issue: { marker: current.marker }, status: "claimed" });
      expect(readMigrationManifest(manifestPath).failureReports?.githubIssue?.marker).toBe(
        current.marker,
      );
    },
  );

  it.each([1, 2, 3] as const)(
    "persists one support issue receipt on a historical v%s manifest",
    (manifestVersion) => {
      const store = createLegacyStore();
      const manifestPath = path.join(store.tempDir, `historical-v${manifestVersion}.json`);
      const failureJsonPath = path.join(
        store.tempDir,
        `historical-v${manifestVersion}.failure.json`,
      );
      const failureMarkdownPath = path.join(
        store.tempDir,
        `historical-v${manifestVersion}.failure.md`,
      );
      const manifest: SessionSqliteMigrationManifest = {
        failedAt: "2030-01-01T00:00:00.000Z",
        failureReports: { jsonPath: failureJsonPath, markdownPath: failureMarkdownPath },
        manifestVersion,
        openClawVersion: "historical",
        runId: `historical-v${manifestVersion}`,
        startedAt: "2030-01-01T00:00:00.000Z",
        targets: [
          {
            ...trustedMigrationTarget(store),
            completedMoves: [],
            issues: [{ code: "startup_failure", message: "sanitized failure" }],
            plannedMoves: [],
            validationBeforeArchive: "failed",
          },
        ],
      };
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      const authority = { assertCurrent: vi.fn() };
      fs.writeFileSync(failureMarkdownPath, `stable sanitized report v${manifestVersion}\n`, {
        mode: 0o600,
      });
      const { marker, title } = prepareGithubIssue(
        expectDefined(createSessionSqliteMigrationFailureIssue(manifestPath), "historical report"),
      );
      const issue = { marker, title };

      expect(claimSessionSqliteMigrationGithubIssue(manifestPath, issue, authority)).toMatchObject({
        issue: { ...issue, status: "attempted" },
        status: "claimed",
      });
      expect(
        claimSessionSqliteMigrationGithubIssue(
          manifestPath,
          { ...issue, title: "regenerated title must not replace the claim" },
          authority,
        ),
      ).toMatchObject({ issue: { ...issue, status: "attempted" }, status: "existing" });

      writeSessionSqliteMigrationFailureReports(manifestPath, { reason: "retry" });
      expect(createSessionSqliteMigrationFailureIssue(manifestPath)).toMatchObject({
        body: expect.stringContaining(`stable sanitized report v${manifestVersion}`),
        title: issue.title,
      });
      const receiptManifest = readMigrationManifest(manifestPath);
      expect(receiptManifest).toMatchObject({
        failureReports: { githubIssue: { ...issue, status: "attempted" } },
        manifestVersion: 4,
      });
      fs.writeFileSync(
        manifestPath,
        `${JSON.stringify({ ...receiptManifest, manifestVersion }, null, 2)}\n`,
        { mode: 0o600 },
      );
      expect(migrationRun.readSessionSqliteMigrationManifest(manifestPath)).toBeUndefined();
      fs.writeFileSync(manifestPath, `${JSON.stringify(receiptManifest, null, 2)}\n`, {
        mode: 0o600,
      });
      const beforeHistoricalRewrite = fs.readFileSync(manifestPath, "utf8");
      expect(simulateHistoricalFailureReportRewrite(manifestPath)).toBe(false);
      expect(fs.readFileSync(manifestPath, "utf8")).toBe(beforeHistoricalRewrite);
      expect(
        claimSessionSqliteMigrationGithubIssue(
          manifestPath,
          {
            marker: `openclaw-report:${"c".repeat(64)}`,
            title: "regenerated process must not replace the claim",
          },
          authority,
        ),
      ).toMatchObject({ issue: { ...issue, status: "attempted" }, status: "existing" });
      const receiptJson = fs.readFileSync(manifestPath, "utf8");
      expect(receiptJson).not.toContain(`stable sanitized report v${manifestVersion}`);
      expect(receiptJson).not.toContain("github.com/openclaw/openclaw/issues/");
      expect(receiptJson).not.toContain("openclaw doctor");
      expect(receiptJson).not.toContain('"body"');
      expect(receiptJson).not.toContain("?body=");
      expect(fs.readFileSync(failureMarkdownPath, "utf8")).toBe(
        `stable sanitized report v${manifestVersion}\n`,
      );
      expect(
        clearSessionSqliteMigrationGithubIssueClaim(manifestPath, issue.marker, authority),
      ).toBe(true);
      const clearedManifest = readMigrationManifest(manifestPath);
      expect(clearedManifest.manifestVersion).toBe(4);
      expect(clearedManifest.failureReports).not.toHaveProperty("githubIssue");
      expect(simulateHistoricalFailureReportRewrite(manifestPath)).toBe(false);
      expect(authority.assertCurrent).toHaveBeenCalledTimes(4);
    },
  );

  it("derives private report paths instead of trusting persisted destinations", () => {
    const store = createLegacyStore();
    const manifestPath = path.join(store.tempDir, "path-ownership.json");
    const expectedJsonPath = path.join(store.tempDir, "path-ownership.failure.json");
    const expectedMarkdownPath = path.join(store.tempDir, "path-ownership.failure.md");
    const untrustedJsonPath = path.join(store.tempDir, "untrusted-destination.json");
    const untrustedMarkdownPath = path.join(store.tempDir, "untrusted-destination.md");
    const manifest: SessionSqliteMigrationManifest = {
      failedAt: "2030-01-01T00:00:00.000Z",
      failureReports: { jsonPath: untrustedJsonPath, markdownPath: untrustedMarkdownPath },
      manifestVersion: 3,
      openClawVersion: "test",
      runId: "path-ownership",
      startedAt: "2030-01-01T00:00:00.000Z",
      targets: [
        {
          ...trustedMigrationTarget(store),
          completedMoves: [],
          issues: [{ code: "startup_failure", message: "sanitized failure" }],
          plannedMoves: [],
          validationBeforeArchive: "failed",
        },
      ],
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(untrustedJsonPath, "private json sentinel\n", { mode: 0o600 });
    fs.writeFileSync(untrustedMarkdownPath, "private markdown sentinel\n", { mode: 0o600 });

    expect(writeSessionSqliteMigrationFailureReports(manifestPath, { reason: "failed" })).toEqual({
      jsonPath: expectedJsonPath,
      markdownPath: expectedMarkdownPath,
    });
    expect(createSessionSqliteMigrationFailureIssue(manifestPath)).toMatchObject({
      body: expect.not.stringContaining("private markdown sentinel"),
      bodyPath: expectedMarkdownPath,
    });
    expect(fs.readFileSync(untrustedJsonPath, "utf8")).toBe("private json sentinel\n");
    expect(fs.readFileSync(untrustedMarkdownPath, "utf8")).toBe("private markdown sentinel\n");
    expect(readMigrationManifest(manifestPath).failureReports).toEqual({
      jsonPath: expectedJsonPath,
      markdownPath: expectedMarkdownPath,
    });
  });

  it("keeps bounded GitHub issue bodies on a valid UTF-16 boundary", () => {
    const store = createLegacyStore();
    const manifestPath = path.join(store.tempDir, "failed-migration.json");
    const unpairedSurrogate =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
    const writeManifest = (messages: string[]) => {
      const manifest: SessionSqliteMigrationManifest = {
        failedAt: "2030-01-01T00:00:00.000Z",
        manifestVersion: 2,
        openClawVersion: "test",
        runId: "utf16-boundary",
        startedAt: "2030-01-01T00:00:00.000Z",
        targets: Array.from({ length: Math.ceil(messages.length / 10) }, (_, index) => {
          return {
            agentId: `agent-${index}`,
            completedMoves: [],
            issues: messages.slice(index * 10, (index + 1) * 10).map((message) => ({
              code: "startup_failure",
              message,
            })),
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
    expect(fieldIssue?.body).toContain(`${"x".repeat(499)}\n`);
    expect(fieldIssue?.body).not.toContain("🎉tail");
    expect(fieldIssue?.body).not.toMatch(unpairedSurrogate);
    expect(fieldIssue).not.toHaveProperty("url");

    for (const [limit, messageCount] of [
      [6_000, 20],
      [20_000, 50],
    ] as const) {
      const marker = "BOUNDARY";
      const messages = Array.from({ length: messageCount - 1 }, () => "");
      writeManifest([...messages, `${marker}!!tail`]);
      const probe = createSessionSqliteMigrationFailureIssue(manifestPath);
      const markerOffset = probe?.body.indexOf(marker) ?? -1;
      expect(markerOffset).toBeGreaterThanOrEqual(0);
      let padding = limit - 1 - markerOffset - marker.length;
      expect(padding).toBeGreaterThanOrEqual(0);

      // Fill earlier fields, each within its 500-unit cap, so path length cannot
      // move the surrogate away from the URL/body boundary being exercised.
      for (let index = 0; index < messages.length; index += 1) {
        const length = Math.min(padding, 500);
        messages[index] = "x".repeat(length);
        padding -= length;
      }
      expect(padding).toBe(0);
      writeManifest([...messages, `${marker}!!tail`]);
      const aligned = createSessionSqliteMigrationFailureIssue(manifestPath);
      expect(aligned?.body.slice(limit - 1 - marker.length, limit)).toBe(`${marker}!`);

      writeManifest([...messages, `${marker}🎉tail`]);
      const issue = createSessionSqliteMigrationFailureIssue(manifestPath);
      expect(issue?.body).not.toMatch(unpairedSurrogate);
      expect(issue).not.toHaveProperty("url");
      if (limit === 6_000) {
        expect(issue?.body).toContain(`${marker}🎉tail`);
      } else {
        expect(issue?.body).toHaveLength(limit - 1);
        expect(issue?.body.endsWith(marker)).toBe(true);
      }
    }
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

  it.each([false, true])(
    "imports aliases before archival and retains a failed alias (failed=%s)",
    async (failed) => {
      const store = createLegacyStore({
        transcriptLines: [
          '{"type":"session","sessionId":"session-1"}',
          '{"type":"message","message":{"role":"user","content":"shared legacy message"}}',
        ],
      });
      const legacyStore = JSON.parse(fs.readFileSync(store.storePath, "utf-8")) as Record<
        string,
        unknown
      >;
      legacyStore["agent:main:alias"] = legacyStore["agent:main:main"];
      fs.writeFileSync(store.storePath, `${JSON.stringify(legacyStore, null, 2)}\n`, {
        mode: 0o600,
      });

      const original = fs.readFileSync(store.transcriptPath);
      const snapshot = sqliteReaders.readOnlySqliteValidationSnapshot;
      const spy = vi
        .spyOn(sqliteReaders, "readOnlySqliteValidationSnapshot")
        .mockImplementation((target) => {
          const result = snapshot(target);
          if (
            failed &&
            result.ok &&
            result.snapshot.sessionIdsBySessionKey.has("agent:main:alias")
          ) {
            const keys = new Map(result.snapshot.sessionIdsBySessionKey);
            keys.delete("agent:main:alias");
            return { ok: true, snapshot: { ...result.snapshot, sessionIdsBySessionKey: keys } };
          }
          return result;
        });
      let report;
      try {
        report = await runDoctorSessionSqlite({
          env: store.env,
          mode: "import",
          store: store.storePath,
        });
      } finally {
        spy.mockRestore();
      }
      if (failed) {
        expect(report.targets[0]?.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "sqlite_entry_missing",
              sessionKey: "agent:main:alias",
            }),
          ]),
        );
        expect(fs.readFileSync(store.transcriptPath)).toEqual(original);
      } else {
        expect(report.targets[0]?.issues).toEqual([]);
      }

      expect(report.totals).toMatchObject({
        archivedTranscriptFiles: failed ? 0 : 2,
        importedEntries: 2,
        importedTranscriptEvents: 2,
        sqliteEntries: 2,
      });
      expect(fs.existsSync(store.transcriptPath)).toBe(failed);
      expect(
        loadExactSessionEntry({
          agentId: "main",
          sessionKey: "agent:main:main",
          storePath: store.storePath,
        })?.entry.sessionId,
      ).toBe("session-1");
      expect(
        loadExactSessionEntry({
          agentId: "main",
          sessionKey: "agent:main:alias",
          storePath: store.storePath,
        })?.entry.sessionId,
      ).toBe("session-1");
      closeOpenClawAgentDatabasesForTest();
      const cleanup = await retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      expect(cleanup.totals.removedFiles).toBe(failed ? 0 : 2);
      if (failed) {
        expect(fs.readFileSync(store.transcriptPath)).toEqual(original);
      }
    },
  );

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
      loadTranscriptEventsSync({
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
      loadExactSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      })?.entry.sessionId,
    ).toBe("session-1");
    expect(
      loadTranscriptEventsSync({
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
        issues: 2,
      });
      expect(report.targets[0]?.issues).toMatchObject([
        { code: "transcript_archive_deferred", sessionKey: "agent:main:main" },
        { code: "active_sqlite_transcript_jsonl", sessionKey: "agent:main:main" },
      ]);
      expect(fs.existsSync(storePath)).toBe(true);
      expect(fs.existsSync(mainTranscriptPath)).toBe(true);
      expect(fs.existsSync(workTranscriptPath)).toBe(true);
      expect(
        loadExactSessionEntry({
          agentId: "main",
          sessionKey: "agent:main:main",
          storePath,
        })?.entry.sessionId,
      ).toBe("main-session");
      expect(
        loadExactSessionEntry({
          agentId: "work",
          sessionKey: "agent:work:main",
          storePath,
        }),
      ).toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("partitions the retired top-level store without guessing unscoped ownership", async () => {
    const stateDir = autoCleanupTempDirs.make("openclaw-doctor-retired-sessions-");
    const sessionDir = path.join(stateDir, "sessions");
    const storePath = path.join(sessionDir, "sessions.json");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:main:main": {
          sessionFile: "/retired/home/.openclaw/sessions/main-session.jsonl",
          sessionId: "main-会議",
          updatedAt: 20,
        },
        "agent:ops:main": {
          sessionFile: "ops-session.jsonl",
          sessionId: "ops-session",
          updatedAt: 30,
        },
        "voice:ambiguous": { sessionId: "ambiguous-session", updatedAt: 40 },
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(sessionDir, "main-session.jsonl"),
      '{"type":"session","sessionId":"main-会議"}\n',
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(sessionDir, "ops-session.jsonl"),
      '{"type":"session","sessionId":"ops-session"}\n',
      { mode: 0o600 },
    );

    const cfg = {
      agents: { ownership: "explicit" as const, entries: { main: {}, ops: {} } },
    };
    const report = await runDoctorSessionSqlite({
      allAgents: true,
      cfg,
      env,
      mode: "import",
    });

    expect(report.targets.map((target) => target.agentId)).toEqual(["main", "ops"]);
    expect(report.totals).toMatchObject({
      archivedLegacyStoreFiles: 0,
      importedEntries: 2,
      importedTranscriptEvents: 2,
      legacyEntries: 2,
      sqliteEntries: 2,
    });
    for (const [agentId, sessionId] of [
      ["main", "main-会議"],
      ["ops", "ops-session"],
    ] as const) {
      const agentStorePath = path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
      expect(
        loadExactSessionEntry({
          agentId,
          sessionKey: `agent:${agentId}:main`,
          storePath: agentStorePath,
        })?.entry.sessionId,
      ).toBe(sessionId);
      expect(
        loadExactSessionEntry({
          agentId,
          sessionKey: "voice:ambiguous",
          storePath: agentStorePath,
        }),
      ).toBeUndefined();
    }
    expect(fs.existsSync(storePath)).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "main-session.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "ops-session.jsonl"))).toBe(true);

    const owned = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {
        ...cfg,
        agents: { ...cfg.agents, defaults: { sessionStore: { agentId: "main" } } },
      },
      env,
      mode: "import",
    });
    expect(owned.totals.archivedLegacyStoreFiles).toBe(1);
    expect(owned.totals.importedEntries).toBe(3);
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it.each([true, false])(
    "imports shared custom stores and respects cleanup ownership (internal=%s)",
    async (internal) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-session-sqlite-"));
      try {
        const stateDir = path.join(tempDir, "state");
        const sessionDir = path.join(internal ? stateDir : tempDir, "shared-session-store");
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
        expect(report.totals).toHaveProperty("reclaimedBytes");
        const manifest = readMigrationManifest(report.migrationRun?.manifestPath);
        for (const target of manifest.targets) {
          expect(target.completedMoves.some((move) => move.kind === "legacy-store")).toBe(true);
        }
        expect(
          loadExactSessionEntry({
            agentId: "main",
            sessionKey: "agent:main:main",
            storePath,
          })?.entry.sessionId,
        ).toBe("main-session");
        expect(
          loadExactSessionEntry({
            agentId: "work",
            sessionKey: "agent:work:main",
            storePath,
          })?.entry.sessionId,
        ).toBe("work-session");
        expect(fs.existsSync(mainTranscriptPath)).toBe(false);
        expect(fs.existsSync(workTranscriptPath)).toBe(false);
        expect(fs.existsSync(orphanTranscriptPath)).toBe(false);
        closeOpenClawAgentDatabasesForTest();
        const cfg = { agents: { entries: { main: {}, work: {} } }, session: { store: storePath } };
        const preview = inspectSessionSqliteRecovery({ cfg, env });
        const cleanup = await retireSessionSqliteRecovery({
          env,
          preview,
          readConfig: async () => cfg,
          confirm: async () => true,
        });
        expect(cleanup.totals.removedFiles).toBe(internal ? 3 : 0);
        expect(cleanup.artifacts.filter((item) => item.outcome === "protected")).toHaveLength(
          internal ? 1 : 4,
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

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
    await upsertSessionEntryCore(
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
    for (const suffix of ["zeta", "alpha"]) {
      fs.writeFileSync(path.join(store.sessionDir, `${suffix}.jsonl`), '{"type":"event"}\n', {
        mode: 0o600,
      });
      await upsertSessionEntryCore(
        {
          agentId: "main",
          env: store.env,
          sessionKey: `agent:main:${suffix}`,
          storePath: store.storePath,
        },
        {
          sessionId: `${suffix}-session`,
          skillsSnapshot: {
            prompt: "active-transcript-scan".repeat(16 * 1024),
            skills: [],
          },
          updatedAt: 3000,
        },
      );
    }
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env: store.env,
      path: resolveTargetSqlitePath({ agentId: "main", storePath: store.storePath }),
    });
    for (const suffix of ["zeta", "alpha"]) {
      database.db
        .prepare(
          "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.sessionFile', ?) WHERE session_key = ?",
        )
        .run(`${suffix}.jsonl`, `agent:main:${suffix}`);
    }
    database.db.prepare("UPDATE session_nodes SET entry_valid = 1").run();

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "inspect",
      store: store.storePath,
    });

    expect(report.targets[0]?.issues).toMatchObject([
      { code: "active_sqlite_transcript_jsonl", sessionKey: "agent:main:alpha" },
      { code: "active_sqlite_transcript_jsonl", sessionKey: "agent:main:main" },
      { code: "active_sqlite_transcript_jsonl", sessionKey: "agent:main:zeta" },
    ]);
    expect(report.targets[0]?.issues[1]?.message).toContain("session-1.jsonl");
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

  it.each(["maintenance", "inspection"])(
    "preserves recovery state when the %s SQLite loader fails",
    async (failure) => {
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
      const openDatabase = nodeSqlite.openNodeSqliteDatabase;
      const openSqlite = vi
        .spyOn(nodeSqlite, "openNodeSqliteDatabase")
        .mockImplementation((pathname, options) => {
          // An unavailable lease store must refuse; an unreadable agent copy is reportable.
          if (failure === "maintenance" || path.basename(pathname) === path.basename(sqlitePath)) {
            throw new Error("node:sqlite unavailable");
          }
          return openDatabase(pathname, options);
        });

      let report: Awaited<ReturnType<typeof runDoctorSessionSqlite>> | undefined;
      try {
        const recovery = runDoctorSessionSqlite({
          env: store.env,
          mode: "recover",
          store: store.storePath,
        });
        if (failure === "maintenance") {
          await expect(recovery).rejects.toThrow(
            "failed to acquire agent database maintenance lease",
          );
          expect(fs.readFileSync(sqlitePath, "utf8")).toBe("not a sqlite database\n");
          return;
        }
        report = await recovery;
      } finally {
        openSqlite.mockRestore();
      }

      expect(report?.totals.issues).toBe(1);
      expect(report?.targets[0]?.issues[0]).toMatchObject({
        code: "sqlite_recovery_inspect_failed",
        message: expect.stringContaining("node:sqlite unavailable"),
      });
      expect(report?.targets[0]?.corruptRecovery).toBeUndefined();
      expect(fs.existsSync(sqlitePath)).toBe(true);
    },
  );

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
      loadTranscriptEventsSync({
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
      loadTranscriptEventsSync({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }),
    ).toHaveLength(2);
  });

  it("reports a malformed non-newline-terminated final JSONL record", async () => {
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
      issues: 1,
      sqliteEntries: 1,
    });
    expect(report.targets[0]?.issues[0]?.code).toBe("transcript_malformed");
    expect(
      loadTranscriptEventsSync({
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
      loadTranscriptEventsSync({
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
    expect(manifest.failedAt).toBeUndefined();
    expect(manifest.failureReports).toBeUndefined();
    expect(report.migrationRun?.failureReportMarkdownPath).toBeUndefined();
  });

  it("reports malformed selected legacy transcripts during validation", async () => {
    const store = createLegacyStore({ transcriptLines: ['{"type":"session"}', "{bad"] });
    await upsertSessionEntryCore(
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

async function createImportedStoreForCompaction(shared = false): Promise<{
  sqlitePath: string;
  store: TestStore;
}> {
  const store = createLegacyStore({ agentDirName: shared ? "alpha" : undefined });
  const report = await runDoctorSessionSqlite({
    env: store.env,
    mode: "import",
    store: store.storePath,
  });
  let sqlitePath = report.targets[0]?.sqlitePath;
  if (!sqlitePath) {
    throw new Error("expected imported agent SQLite path");
  }
  closeOpenClawAgentDatabasesForTest();
  if (shared) {
    const sharedPath = path.join(store.stateDir, "shared.sqlite");
    fs.renameSync(sqlitePath, sharedPath);
    sqlitePath = sharedPath;
    store.storePath = sharedPath;
  }
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

function createCanonicalCacheIndexDrift(sqlitePath: string): void {
  const sqlite = nodeSqlite.requireNodeSqlite();
  const database = new sqlite.DatabaseSync(sqlitePath);
  try {
    database.exec(`
      INSERT INTO cache_entries (scope, key, value_json, expires_at, updated_at)
      VALUES ('doctor', 'canonical-index', '{"ok":true}', 100, 1);
      DROP INDEX idx_agent_cache_expiry;
      CREATE INDEX idx_agent_cache_expiry ON cache_entries(key);
    `);
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare(
        `UPDATE sqlite_schema
            SET sql = 'CREATE INDEX idx_agent_cache_expiry ON cache_entries(scope, expires_at, key) WHERE expires_at IS NOT NULL'
          WHERE name = 'idx_agent_cache_expiry'`,
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

const RECOVERY_TRANSCRIPT_LINES = [
  JSON.stringify({
    type: "session",
    id: "session-1",
    version: 3,
    timestamp: "2026-08-30T00:00:00Z",
    cwd: "/fixture",
  }),
  JSON.stringify({
    type: "message",
    id: "one",
    parentId: null,
    message: { role: "user", content: "preserved history" },
  }),
];

function createHistoricalRestoreStore(version: 1 | 2) {
  const store = createLegacyStore({ transcriptLines: RECOVERY_TRANSCRIPT_LINES });
  const archiveDir = path.join(path.dirname(store.sessionDir), "session-sqlite-import-archive");
  const runsDir = path.join(store.stateDir, "session-sqlite-migration-runs");
  fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  // Model the historical on-disk contract directly; the current importer is not fixture setup.
  const moves = (
    [
      ["transcript", store.transcriptPath],
      ["trajectory", store.trajectoryPath],
      ["unreferenced-jsonl", store.unreferencedJsonlPath],
      ["legacy-store", store.storePath],
    ] as const
  ).map(([kind, sourcePath]) => {
    const archivePath = path.join(archiveDir, `${kind}.${path.basename(sourcePath)}.imported-1`);
    fs.renameSync(sourcePath, archivePath);
    return { kind, sourcePath, archivePath };
  });
  const manifest: SessionSqliteMigrationManifest = {
    manifestVersion: version,
    openClawVersion: "test",
    runId: `historical-v${version}`,
    startedAt: "2026-08-30T00:00:00.000Z",
    completedAt: "2026-08-30T00:00:01.000Z",
    targets: [
      {
        ...trustedMigrationTarget(store),
        plannedMoves: moves,
        completedMoves: structuredClone(moves),
        issues: [],
        validationBeforeArchive: "passed",
      },
    ],
  };
  const manifestPath = path.join(runsDir, `${manifest.runId}.json`);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  const archivePath = expectDefined(
    moves.find((move) => move.kind === "transcript"),
    "historical transcript archive",
  ).archivePath;
  return { store, manifestPath, manifest, archivePath };
}

async function runPublicSessionSqlite(store: TestStore, mode: "import" | "restore" | "recover") {
  let exitCode: number | undefined;
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number): never => {
      exitCode = code;
      throw new ExitError(code);
    }),
  };
  try {
    await doctorCommand(runtime, {
      sessionSqlite: mode,
      sessionSqliteStore: store.storePath,
      json: true,
    });
  } catch (error) {
    if (!(error instanceof ExitError)) {
      throw error;
    }
  }
  const output = expectDefined(runtime.log.mock.calls.at(-1)?.[0], "Doctor JSON report");
  return {
    exitCode: expectDefined(exitCode, "Doctor exit code"),
    report: JSON.parse(String(output)) as DoctorSessionSqliteReport,
  };
}

function observeRecoveryDirectorySync(
  manifestDir: string,
  onSynced: (directory: string) => void,
): () => void {
  const sync = directoryDurability.syncDirectory;
  const asyncSpy = vi
    .spyOn(directoryDurability, "syncDirectory")
    .mockImplementation(async (directory, options) => {
      const result = await sync(directory, options);
      onSynced(typeof directory === "string" ? directory : directory.path);
      return result;
    });
  const fsync = fs.fsyncSync;
  const syncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    fsync(fd);
    if (isDirectoryDescriptor(fd, manifestDir)) {
      onSynced(manifestDir);
    }
  });
  return () => {
    asyncSpy.mockRestore();
    syncSpy.mockRestore();
  };
}

function isDirectoryDescriptor(fd: number, directory: string): boolean {
  const opened = fs.fstatSync(fd);
  if (!opened.isDirectory()) {
    return false;
  }
  const expected = fs.statSync(directory);
  return opened.dev === expected.dev && opened.ino === expected.ino;
}

async function createVerifiedRecoveryStore(transcriptLines = RECOVERY_TRANSCRIPT_LINES) {
  const store = createLegacyStore({ transcriptLines });
  const imported = await runDoctorSessionSqlite({
    env: store.env,
    mode: "import",
    store: store.storePath,
  });
  expect(imported.targets[0]?.issues).toEqual([]);
  const manifest = readMigrationManifest(imported.migrationRun?.manifestPath);
  const archivePath = manifest.targets[0]!.completedMoves.find(
    (move) => move.kind === "transcript",
  )!.archivePath;
  closeOpenClawAgentDatabasesForTest();
  return { store, imported, archivePath };
}

function createSharedRecoveryFixture(params: {
  separateIndexes: boolean;
  reverse: boolean;
  sharedTranscript?: boolean;
}) {
  const independent = createLegacyStore({
    agentDirName: "spare",
    transcriptLines: [
      '{"type":"session","id":"session-1","version":3}',
      '{"type":"message","id":"one","parentId":null,"message":{"role":"user","content":"independent"}}',
    ],
  });
  const { env, stateDir } = independent;
  const sessionDir = path.join(stateDir, "shared-session-store");
  fs.mkdirSync(sessionDir, { recursive: true });
  const owners = params.reverse ? ["work", "main"] : ["main", "work"];
  const storePath = path.join(
    sessionDir,
    params.separateIndexes ? "{agentId}.json" : "sessions.json",
  );
  const records = Object.fromEntries(
    owners.map((owner) => {
      const sessionId = params.sharedTranscript === false ? `${owner}-session` : "main-session";
      fs.writeFileSync(
        path.join(sessionDir, `${sessionId}.jsonl`),
        `${JSON.stringify({ type: "session", version: 3, id: sessionId })}\n${JSON.stringify({ type: "message", id: "one", parentId: null, message: { role: "user", content: "shared original" } })}\n`,
      );
      return [
        `agent:${owner}:main`,
        { sessionId, sessionFile: `${sessionId}.jsonl`, updatedAt: 20 },
      ];
    }),
  );
  const indexes = params.separateIndexes
    ? owners.map((owner) => {
        const index = storePath.replace("{agentId}", owner);
        fs.writeFileSync(
          index,
          JSON.stringify({ [`agent:${owner}:main`]: records[`agent:${owner}:main`] }),
        );
        return index;
      })
    : [storePath];
  if (!params.separateIndexes) {
    fs.writeFileSync(storePath, JSON.stringify(records));
  }
  const cfg = {
    agents: {
      entries: Object.fromEntries(owners.map((owner) => [owner, { default: owner === "main" }])),
    },
    session: { store: storePath },
  };
  return {
    cfg,
    env,
    indexes,
    independent,
    transcriptPath: path.join(sessionDir, "main-session.jsonl"),
  };
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

function simulateHistoricalFailureReportRewrite(manifestPath: string): boolean {
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    failureReports?: { jsonPath?: unknown; markdownPath?: unknown };
    manifestVersion?: unknown;
    [key: string]: unknown;
  };
  // Released Doctors accept only v1-v3. Their schema strips the unknown receipt
  // before the failure-report writer atomically serializes the parsed manifest.
  if (![1, 2, 3].includes(parsed.manifestVersion as number) || !parsed.failureReports) {
    return false;
  }
  parsed.failureReports = {
    jsonPath: parsed.failureReports.jsonPath,
    markdownPath: parsed.failureReports.markdownPath,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  return true;
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
