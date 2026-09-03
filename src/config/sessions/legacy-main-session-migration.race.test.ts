import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../../agents/admitted-run-context.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { migrateLegacyMainSessionKeys } from "./legacy-main-session-migration.js";
import { readExactSessionEntryRowForCanonicalRepair } from "./session-accessor.sqlite-canonical-repair.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionOwnerInTransaction } from "./session-accessor.sqlite-owner.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";

const race = vi.hoisted(() => ({
  beforeDelete: undefined as (() => void) | undefined,
  afterDelete: undefined as (() => void) | undefined,
  queued: undefined as ((pathname: string | undefined) => void) | undefined,
}));

vi.mock("./session-accessor.sqlite-scope.js", async (original) => {
  const actual = await original<typeof import("./session-accessor.sqlite-scope.js")>();
  return {
    ...actual,
    runExclusiveSqliteSessionWrite: (
      ...args: Parameters<typeof actual.runExclusiveSqliteSessionWrite>
    ) => {
      const pending = actual.runExclusiveSqliteSessionWrite(...args);
      race.queued?.(args[0].path);
      return pending;
    },
  };
});

vi.mock("./session-accessor.sqlite-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-lifecycle.js")>();
  return {
    ...actual,
    deleteSessionEntryLifecycle: async (
      params: Parameters<typeof actual.deleteSessionEntryLifecycle>[0],
    ) => {
      const beforeDelete = race.beforeDelete;
      race.beforeDelete = undefined;
      beforeDelete?.();
      const result = await actual.deleteSessionEntryLifecycle(params);
      const afterDelete = race.afterDelete;
      race.afterDelete = undefined;
      afterDelete?.();
      return result;
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function databasePath(stateDir: string, agentId: string): string {
  return path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
}

function seedClaim(databaseAgentId: string, databasePathname: string, key: string): void {
  runOpenClawAgentWriteTransaction(
    (database) => {
      const entry = {
        sessionId: "race-session",
        updatedAt: 100,
        owner: { actor: { type: "human" as const, id: "migration-owner" }, assignedAt: 40 },
      };
      writeSessionEntry(database, key, entry, {
        allowStoredAliases: true,
        previousEntry: null,
      });
      replaceSessionOwnerInTransaction(database, key, entry.owner);
      appendTranscriptEventInTransaction(
        database,
        {
          agentId: databaseAgentId,
          path: databasePathname,
          sessionId: entry.sessionId,
          sessionKey: key,
        },
        { id: "event-1", type: "message" },
        { allowStoredAlias: true },
      );
    },
    { agentId: databaseAgentId, path: databasePathname },
  );
}

function readClaim(databaseAgentId: string, databasePathname: string, key: string) {
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => {
      const entry = readExactSessionEntryRowForCanonicalRepair(database, key)?.entry;
      return entry
        ? {
            entry,
            events: readTranscriptEventRows(database, entry.sessionId).map((row) => row.eventJson),
          }
        : undefined;
    },
    { agentId: databaseAgentId, path: databasePathname },
  );
  return result.found ? result.value : undefined;
}

afterEach(() => {
  race.beforeDelete = undefined;
  race.afterDelete = undefined;
  race.queued = undefined;
  resetAgentRunRegistryForTest();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it.each(["import queue", "in-place queue", "cleanup queue", "ledger"] as const)(
  "preserves committed work but defers new migration writes after closure at %s",
  async (boundary) => {
    await withOpenClawTestState({ label: "migration-lifetime" }, async (state) => {
      const mainPath = databasePath(state.stateDir, "main");
      const opsPath = databasePath(state.stateDir, "ops");
      const inPlace = boundary === "in-place queue";
      const sourceAgentId = inPlace ? "ops" : "main";
      const sourcePath = inPlace ? opsPath : mainPath;
      const cfg = {
        agents: { entries: { ops: {} } },
        ...(inPlace ? { session: { store: opsPath } } : {}),
      };
      await state.writeConfig(cfg);
      seedClaim(sourceAgentId, sourcePath, "agent:main:chat");
      const original = readClaim(sourceAgentId, sourcePath, "agent:main:chat")!;
      const admission = prepareSystemAgentRunAdmission(cfg, "migration-race", "ops", "setup");
      const beforePersistentApply = resolveAdmittedRunActiveAssertion(
        await admission.admit("embedded"),
      )!;
      const entered = createDeferred();
      const resume = createDeferred();
      const queued = createDeferred();
      let blocker: Promise<void> | undefined;
      let migration: Promise<unknown> | undefined;
      const readLedger = () =>
        withExistingOpenClawStateDatabaseReadOnly(
          ({ db }) =>
            db
              .prepare(
                "SELECT * FROM migration_sources WHERE source_key = 'legacy-main-session-keys'",
              )
              .all(),
          { env: state.env },
        );
      const ledgerBefore = readLedger();
      try {
        if (boundary === "ledger") {
          race.afterDelete = () => admission.close();
        } else {
          const blockedPath = boundary === "cleanup queue" ? mainPath : opsPath;
          blocker = runExclusiveSqliteSessionWrite(
            {
              agentId: boundary === "cleanup queue" ? "main" : "ops",
              path: blockedPath,
              env: state.env,
            },
            async () => {
              entered.resolve();
              await resume.promise;
            },
          );
          await entered.promise;
          race.queued = (pathname) => {
            if (pathname === blockedPath) {
              race.queued = undefined;
              queued.resolve();
            }
          };
        }
        migration = migrateLegacyMainSessionKeys({
          cfg,
          env: state.env,
          mode: "automatic",
          beforePersistentApply,
        }).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        if (boundary !== "ledger") {
          await withTestTimeout(
            Promise.race([
              queued.promise,
              migration.then(() => {
                throw new Error("migration ended before writer queue");
              }),
            ]),
            10_000,
            "migration never queued",
          );
          beforePersistentApply();
          admission.close();
          resume.resolve();
        }
        expect
          .soft(await migration)
          .toMatchObject({ error: new Error("admitted run authority is no longer active") });
        expect.soft(readLedger()).toEqual(ledgerBefore);
        const copied = boundary === "cleanup queue" || boundary === "ledger";
        const source = readClaim(sourceAgentId, sourcePath, "agent:main:chat");
        expect.soft(source).toEqual(boundary === "ledger" ? undefined : original);
        const destination = readClaim("ops", opsPath, "agent:ops:chat");
        if (copied) {
          expect.soft(destination?.events).toEqual(original.events);
          expect.soft(destination?.entry.owner).toEqual(original.entry.owner);
        } else {
          expect.soft(destination).toBeUndefined();
          if (!inPlace) {
            expect.soft(fs.existsSync(opsPath)).toBe(false);
          }
        }
        const recovered = await migrateLegacyMainSessionKeys({
          cfg,
          env: state.env,
          mode: "automatic",
        });
        expect(recovered.complete).toBe(true);
        expect(readClaim(sourceAgentId, sourcePath, "agent:main:chat")).toBeUndefined();
        expect(readClaim("ops", opsPath, "agent:ops:chat")?.events).toEqual(original.events);
        expect(readLedger()).toEqual([expect.objectContaining({ status: "completed" })]);
      } finally {
        race.queued = undefined;
        race.afterDelete = undefined;
        resume.resolve();
        await blocker;
        await migration;
        admission.close();
      }
    });
  },
);

async function runCleanupRace(mutateSource: (mainPath: string) => void) {
  const root = fs.realpathSync.native(tempDirs.make("openclaw-legacy-main-race-"));
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const mainPath = databasePath(stateDir, "main");
  const opsPath = databasePath(stateDir, "ops");
  const env = { ...process.env, OPENCLAW_AGENT_DIR: undefined, OPENCLAW_STATE_DIR: stateDir };
  seedClaim("main", mainPath, "agent:main:chat");
  race.beforeDelete = () => mutateSource(mainPath);

  const result = await migrateLegacyMainSessionKeys({
    cfg: { agents: { entries: { ops: {} } } },
    env,
    mode: "automatic",
  });

  return { mainPath, opsPath, result };
}

it("preserves both claims when the source transcript changes before atomic cleanup", async () => {
  const { mainPath, opsPath, result } = await runCleanupRace((sourcePath) => {
    runOpenClawAgentWriteTransaction(
      (database) => {
        appendTranscriptEventInTransaction(
          database,
          {
            agentId: "main",
            path: sourcePath,
            sessionId: "race-session",
            sessionKey: "agent:main:chat",
          },
          { id: "event-2", type: "message" },
          { allowStoredAlias: true },
        );
      },
      { agentId: "main", path: sourcePath },
    );
  });

  expect(result.complete).toBe(false);
  expect(result.outcomes.map((outcome) => outcome.kind)).toContain("divergent-canonical");
  expect(readClaim("main", mainPath, "agent:main:chat")?.events).toHaveLength(2);
  expect(readClaim("ops", opsPath, "agent:ops:chat")?.events).toHaveLength(1);
});

it("preserves both claims when the source entry becomes locked before cleanup", async () => {
  const { mainPath, opsPath, result } = await runCleanupRace((sourcePath) => {
    runOpenClawAgentWriteTransaction(
      (database) => {
        const current = readExactSessionEntryRowForCanonicalRepair(
          database,
          "agent:main:chat",
        )?.entry;
        if (!current) {
          throw new Error("missing race source entry");
        }
        writeSessionEntry(
          database,
          "agent:main:chat",
          { ...current, modelSelectionLocked: true },
          { allowStoredAliases: true, previousEntry: current },
        );
      },
      { agentId: "main", path: sourcePath },
    );
  });

  expect(result.complete).toBe(false);
  expect(result.outcomes.map((outcome) => outcome.kind)).toContain("divergent-canonical");
  expect(readClaim("main", mainPath, "agent:main:chat")?.entry.modelSelectionLocked).toBe(true);
  expect(readClaim("ops", opsPath, "agent:ops:chat")?.events).toHaveLength(1);
});
