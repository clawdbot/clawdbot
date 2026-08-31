import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { migrateLegacyMainSessionKeys } from "./legacy-main-session-migration.js";
import { readExactSessionEntryRowForCanonicalRepair } from "./session-accessor.sqlite-canonical-repair.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";

const race = vi.hoisted(() => ({ beforeDelete: undefined as (() => void) | undefined }));

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
      return await actual.deleteSessionEntryLifecycle(params);
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
      const entry = { sessionId: "race-session", updatedAt: 100 };
      writeSessionEntry(database, key, entry, {
        allowStoredAliases: true,
        previousEntry: null,
      });
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
  return runOpenClawAgentWriteTransaction(
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
}

afterEach(() => {
  race.beforeDelete = undefined;
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

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
