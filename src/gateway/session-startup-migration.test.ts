/** SQLite startup maintenance without the unrelated full-Gateway fixture lifecycle. */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runDoctorSessionSqlite } from "../commands/doctor-session-sqlite.js";
import {
  loadExactSessionEntry,
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { setCanonicalSqliteSessionMainKey } from "../config/sessions/session-canonical-key.js";
import { sessionTranscriptIndexNeedsReconcile } from "../config/sessions/session-transcript-index.js";
import { waitForSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabaseOptions,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runStartupSessionMigration } from "./server-startup-session-migration.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function makeLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe("runStartupSessionMigration", () => {
  it.each(["successful", "failed"] as const)(
    "hands the cold maintenance connection directly to %s reconciliation",
    async (outcome) => {
      const stateDir = fs.realpathSync.native(tempDirs.make("openclaw-startup-handoff-"));
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const options = { agentId: "main", env };
      const initial = openOpenClawAgentDatabase(options);
      setCanonicalSqliteSessionMainKey(initial, "previous");
      closeOpenClawAgentDatabasesForTest();
      const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
      let handedOff: ReturnType<typeof getOpenClawAgentDatabaseIfOpen>;
      let reconciled: ReturnType<typeof openOpenClawAgentDatabase> | undefined;
      const failure = new Error("projection reconciliation failed");
      const reconcileSessionTranscriptIndexes = vi.fn(
        async (databaseOptions: OpenClawAgentDatabaseOptions) => {
          handedOff = getOpenClawAgentDatabaseIfOpen(databaseOptions);
          reconciled = openOpenClawAgentDatabase(databaseOptions);
          if (outcome === "failed") {
            throw failure;
          }
          return { reconciledSessions: 0 };
        },
      );
      try {
        const startup = runStartupSessionMigration({
          cfg: { agents: { entries: { main: {} } } },
          env,
          log: makeLog(),
          deps: { reconcileSessionTranscriptIndexes },
        });
        if (outcome === "failed") {
          await expect(startup).rejects.toBe(failure);
        } else {
          await startup;
        }
        expect(reconcileSessionTranscriptIndexes).toHaveBeenCalledOnce();
        expect(handedOff).toBe(reconciled);
        expect(
          open.mock.calls.filter(
            ([databasePath, behavior]) =>
              databasePath === initial.path && behavior?.readOnly !== true,
          ),
        ).toHaveLength(1);
        expect(isOpenClawAgentDatabaseOpen(initial.path)).toBe(outcome === "successful");
      } finally {
        open.mockRestore();
      }
    },
  );

  it("does not create databases for agents without durable sessions", async () => {
    const stateDir = tempDirs.make("openclaw-empty-session-startup-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const reconcileSessionTranscriptIndexes = vi.fn(async () => ({ reconciledSessions: 0 }));
    await runStartupSessionMigration({
      cfg: { agents: { entries: { main: {}, ops: {} } } },
      env,
      log: makeLog(),
      deps: { reconcileSessionTranscriptIndexes },
    });
    expect(reconcileSessionTranscriptIndexes).not.toHaveBeenCalled();
    for (const agentId of ["main", "ops"]) {
      expect(fs.existsSync(resolveOpenClawAgentSqlitePath({ agentId, env }))).toBe(false);
    }
  });

  it.each(["default", "custom", "shared"] as const)(
    "repairs transcript projections in the %s SQLite store before serving history",
    async (layout) => {
      const root = fs.realpathSync.native(tempDirs.make("openclaw-sqlite-session-startup-"));
      const stateDir = path.join(root, "state");
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const env = { ...process.env };
        const agentId = "qa";
        const storePath =
          layout === "default"
            ? undefined
            : path.join(root, "custom", layout === "shared" ? "shared.sqlite" : "sessions.json");
        const cfg: OpenClawConfig = {
          agents: { ownership: "explicit", entries: { qa: {} } },
          ...(storePath ? { session: { store: storePath } } : {}),
        };
        const scope = {
          agentId,
          defaultAgentId: "main",
          env,
          sessionId: "startup-session",
          sessionKey: "agent:qa:startup",
          storePath,
        };
        await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
        await persistSessionTranscriptTurn(scope, {
          messages: [
            { eventId: "startup-message", message: { role: "user", content: "retained history" } },
          ],
          touchSessionEntry: false,
        });
        const options = toDatabaseOptions(resolveSqliteReadScope(scope));
        await waitForSessionTranscriptIndexReconcile(options);
        const database = openOpenClawAgentDatabase(options);
        database.db
          .prepare(
            "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
          )
          .run(scope.sessionId);
        expect(sessionTranscriptIndexNeedsReconcile(database.db, scope.sessionId)).toBe(true);
        closeOpenClawAgentDatabasesForTest();
        const log = makeLog();

        await runStartupSessionMigration({ cfg, env, log });

        const reopened = openOpenClawAgentDatabase(options);
        expect(sessionTranscriptIndexNeedsReconcile(reopened.db, scope.sessionId)).toBe(false);
        expect(loadExactSessionEntry(scope)?.entry.sessionId).toBe(scope.sessionId);
        expect(log.warn).not.toHaveBeenCalled();
        expect(log.info).toHaveBeenCalledWith(
          "session: rebuilt 1 transcript projection(s) before serving history",
        );
        if (layout === "shared") {
          expect(reopened.agentId).toBe("main");
          expect(fs.existsSync(resolveOpenClawAgentSqlitePath({ agentId, env }))).toBe(false);
        }
        expect(fs.existsSync(path.join(stateDir, "session-sqlite-migration-runs"))).toBe(false);
      });
    },
  );

  it.each(["configured", "retired-root"] as const)(
    "preserves the %s legacy source and requires explicit Doctor import",
    async (layout) => {
      const stateDir = fs.realpathSync.native(tempDirs.make("openclaw-legacy-session-startup-"));
      const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_PROFILE: "migration" };
      const storePath =
        layout === "configured"
          ? path.join(stateDir, "custom", "sessions.json")
          : path.join(stateDir, "sessions", "sessions.json");
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {} } },
        ...(layout === "configured" ? { session: { store: storePath } } : {}),
      };
      const original = JSON.stringify({
        "agent:main:legacy": { sessionId: "legacy-session", updatedAt: 1 },
      });
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, original);

      await expect(runStartupSessionMigration({ cfg, env, log: makeLog() })).rejects.toThrow(
        "openclaw --profile migration doctor --fix",
      );
      expect(fs.readFileSync(storePath, "utf8")).toBe(original);
      expect(fs.existsSync(path.join(stateDir, "session-sqlite-migration-runs"))).toBe(false);

      const imported = await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "import" });
      expect(imported.totals.importedEntries).toBe(1);
      expect(imported.totals.archivedLegacyStoreFiles).toBe(1);
      await expect(
        runStartupSessionMigration({ cfg, env, log: makeLog() }),
      ).resolves.toBeUndefined();
    },
  );
});
