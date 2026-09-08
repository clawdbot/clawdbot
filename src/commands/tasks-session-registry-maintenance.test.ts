// Covers session-registry sweep isolation: unreadable cron facts fail the whole
// sweep closed, while completed agent deletions are reported as per-store skips.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState } from "../config/config.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  beginAgentDeletionJournal,
  completeAgentDeletionJournalInDatabase,
} from "../state/agent-deletion-journal.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import * as taskRegistryMaintenance from "../tasks/task-registry.maintenance.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runSessionRegistryMaintenance } from "./tasks-session-registry-maintenance.js";
import { tasksMaintenanceCommand } from "./tasks.js";

const DAY_MS = 24 * 60 * 60_000;
const mocks = vi.hoisted(() => ({
  cronStoreLoadError: undefined as Error | undefined,
}));

vi.mock("../cron/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cron/store.js")>();
  return {
    ...actual,
    loadCronJobsStoreSync: (storePath: string) => {
      if (mocks.cronStoreLoadError) {
        throw mocks.cronStoreLoadError;
      }
      return actual.loadCronJobsStoreSync(storePath);
    },
  };
});

function writeAgentDeletion(
  state: OpenClawTestState,
  agentId: string,
  cleanupCompleted: boolean,
): void {
  const deletion = beginAgentDeletionJournal({
    agentId,
    operationId: randomUUID(),
    agentDir: state.agentDir(agentId),
    workspaceDir: state.path(`workspace-${agentId}`),
    sessionsDir: state.sessionsDir(agentId),
    deleteFiles: false,
  });
  if (cleanupCompleted) {
    runOpenClawStateWriteTransaction((database) =>
      completeAgentDeletionJournalInDatabase(database, deletion.agentId, deletion.operationId),
    );
  }
}

async function writeStaleCronSession(storePath: string, agentId: string): Promise<string> {
  const sessionKey = `agent:${agentId}:cron:done-job:run:old-run`;
  await replaceSessionEntry(
    { sessionKey, storePath },
    { sessionId: `${agentId}-old-run`, updatedAt: Date.now() - 8 * DAY_MS },
  );
  return sessionKey;
}

async function withMaintenanceState(run: (state: OpenClawTestState) => Promise<void>) {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-session-registry-maintenance-" },
    async (state) => {
      resetConfigRuntimeState();
      await run(state);
    },
  );
}

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } as unknown as RuntimeEnv;
}

describe("runSessionRegistryMaintenance", () => {
  afterEach(() => {
    mocks.cronStoreLoadError = undefined;
    taskRegistryMaintenance.stopTaskRegistryMaintenance();
    taskRegistryMaintenance.resetTaskRegistryMaintenanceRuntimeForTests();
    resetConfigRuntimeState();
    closeOpenClawAgentDatabasesForTest();
  });

  it("skips the sweep instead of pruning when the cron store is unreadable", async () => {
    await withMaintenanceState(async (state) => {
      const storePath = path.join(state.sessionsDir("main"), "sessions.json");
      const staleCronKey = "agent:main:cron:maybe-running:run:old-run";
      await replaceSessionEntry(
        { sessionKey: staleCronKey, storePath },
        { sessionId: "maybe-running", updatedAt: Date.now() - 8 * DAY_MS },
      );
      mocks.cronStoreLoadError = new Error("SQLITE_CORRUPT: database disk image is malformed");

      const summary = await runSessionRegistryMaintenance({ apply: true });

      expect(summary.skippedReason).toContain("cron store unreadable");
      expect(summary.pruned).toBe(0);
      // The possibly-running cron transcript survives until cron facts are readable.
      expect(loadSessionEntry({ sessionKey: staleCronKey, storePath })).toBeDefined();
    });
  });

  it.each(["per-agent", "fixed selector", "exact database"])(
    "prunes every configured agent's stale cron rows with a %s store",
    async (kind) => {
      await withMaintenanceState(async (state) => {
        const store =
          kind === "per-agent"
            ? undefined
            : state.statePath(kind === "fixed selector" ? "shared.json" : "shared.sqlite");
        await state.writeConfig({
          agents: { ownership: "explicit", entries: { main: {}, beta: {} } },
          ...(store ? { session: { store } } : {}),
        });
        const scopes = [];
        for (const agentId of ["main", "beta"]) {
          const storePath = store ?? path.join(state.sessionsDir(agentId), "sessions.json");
          const sessionKey = await writeStaleCronSession(storePath, agentId);
          scopes.push({ agentId, sessionKey, storePath });
        }

        const summary = await runSessionRegistryMaintenance({ apply: true });

        expect(summary.skippedReason).toBeUndefined();
        expect(summary.pruned).toBe(2);
        for (const scope of scopes) {
          expect(loadSessionEntry(scope)).toBeUndefined();
        }
      });
    },
  );

  it.each([
    { apply: false, mainEntrySurvives: true },
    { apply: true, mainEntrySurvives: false },
  ])(
    "reports completed agent deletions while maintaining healthy stores (apply=$apply)",
    async ({ apply, mainEntrySurvives }) => {
      await withMaintenanceState(async (state) => {
        const mainStorePath = path.join(state.sessionsDir("main"), "sessions.json");
        const retiredStorePath = path.join(state.sessionsDir("retired"), "sessions.json");
        const mainKey = await writeStaleCronSession(mainStorePath, "main");
        await writeStaleCronSession(retiredStorePath, "retired");
        writeAgentDeletion(state, "retired", true);
        closeOpenClawAgentDatabasesForTest();

        const summary = await runSessionRegistryMaintenance({ apply });

        expect(summary).toMatchObject({
          pruned: 1,
          skippedStores: 1,
          stores: expect.arrayContaining([
            expect.objectContaining({ agentId: "main", pruned: 1 }),
            {
              agentId: "retired",
              storePath: retiredStorePath,
              skippedReason: "agent-deletion-complete",
            },
          ]),
        });
        expect(
          loadSessionEntry({ sessionKey: mainKey, storePath: mainStorePath }) !== undefined,
        ).toBe(mainEntrySurvives);
        if (!apply) {
          const jsonRuntime = createRuntime();
          await tasksMaintenanceCommand({ json: true }, jsonRuntime);
          expect(JSON.parse(String(vi.mocked(jsonRuntime.log).mock.calls[0]?.[0]))).toMatchObject({
            maintenance: {
              sessions: {
                skippedStores: 1,
                stores: expect.arrayContaining([
                  {
                    agentId: "retired",
                    storePath: retiredStorePath,
                    skippedReason: "agent-deletion-complete",
                  },
                ]),
              },
            },
          });
          const textRuntime = createRuntime();
          await tasksMaintenanceCommand({}, textRuntime);
          expect(vi.mocked(textRuntime.log).mock.calls.flat().join("\n")).toContain(
            "1 skipped store",
          );
        }
      });
    },
  );

  it("keeps incomplete agent deletions terminal", async () => {
    await withMaintenanceState(async (state) => {
      const retiredStorePath = path.join(state.sessionsDir("retired"), "sessions.json");
      await writeStaleCronSession(retiredStorePath, "retired");
      writeAgentDeletion(state, "retired", false);
      closeOpenClawAgentDatabasesForTest();

      await expect(runSessionRegistryMaintenance({ apply: false })).rejects.toThrow(
        "OpenClaw agent database is unavailable while agent retired is deleted.",
      );
    });
  });

  it("keeps corrupt discovered stores terminal", async () => {
    await withMaintenanceState(async (state) => {
      const retiredStorePath = path.join(state.sessionsDir("retired"), "sessions.json");
      const sqlitePath = resolveSqliteTargetFromSessionStorePath(retiredStorePath).path;
      if (!sqlitePath) {
        throw new Error("expected retired store to resolve to SQLite");
      }
      await fs.mkdir(path.dirname(sqlitePath), { recursive: true });
      await fs.writeFile(sqlitePath, "not a sqlite database");

      await expect(runSessionRegistryMaintenance({ apply: false })).rejects.toThrow();
    });
  });
});
