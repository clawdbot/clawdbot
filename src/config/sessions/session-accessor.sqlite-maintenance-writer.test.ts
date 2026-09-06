import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { recordInboundSession } from "../../channels/session.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  applySessionEntryLifecycleMutation,
  cleanupSessionLifecycleArtifactsCore,
  loadSessionEntry,
  loadTranscriptEventsSync,
  replaceSessionEntrySync,
  replaceTranscriptEventsSync,
} from "./session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const archiveMaterializationHook = vi.hoisted(() => ({
  beforeMaterialize: undefined as (() => Promise<void> | void) | undefined,
}));

vi.mock("./session-accessor.sqlite-archive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-archive.js")>();
  return {
    ...actual,
    materializeSessionStateDeletePlans: async (
      ...args: Parameters<typeof actual.materializeSessionStateDeletePlans>
    ) => {
      await archiveMaterializationHook.beforeMaterialize?.();
      return await actual.materializeSessionStateDeletePlans(...args);
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  archiveMaterializationHook.beforeMaterialize = undefined;
  closeOpenClawAgentDatabasesForTest();
});

function createPlannerStore(entryCount: number) {
  const tempDir = tempDirs.make("openclaw-session-maintenance-planner-");
  const storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  for (let index = 0; index < entryCount; index += 1) {
    replaceSessionEntrySync(
      { sessionKey: `agent:main:planner-${index}`, storePath },
      { sessionId: `planner-${index}`, updatedAt: index + 1 },
    );
  }
  const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
    agentId: "main",
  }).path;
  if (!databasePath) {
    throw new Error("expected planner maintenance database path");
  }
  const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
  database.db.exec("ANALYZE; PRAGMA analysis_limit = 37;");
  return { database, storePath };
}

it.each([false, true])(
  "does not rescan unrelated rows when no lifecycle removal matches (requested: %s)",
  async (requestRemoval) => {
    const { storePath } = createPlannerStore(2);
    const retained = { sessionKey: "agent:main:planner-1", sessionId: "planner-1", storePath };
    const transcript = [{ type: "session", id: retained.sessionId, content: "retained" }];
    replaceTranscriptEventsSync(retained, transcript);
    const parseSpy = vi.spyOn(JSON, "parse");
    await expect(
      applySessionEntryLifecycleMutation({
        storePath,
        skipMaintenance: true,
        removals: requestRemoval ? [{ sessionKey: "agent:main:missing" }] : [],
        upserts: [
          {
            sessionKey: "agent:main:planner-0",
            buildEntry: async ({ currentEntry }) => ({ ...currentEntry!, label: "updated" }),
          },
        ],
      }),
    ).resolves.toMatchObject({
      afterCount: 2,
      removedEntries: 0,
      archivedTranscriptDirectories: [],
    });

    // Allow the builder snapshot and before/after counts, but no unused deletion scans.
    expect(
      parseSpy.mock.calls.filter(([serialized]) => serialized.includes('"planner-1"')).length,
    ).toBeLessThanOrEqual(3);
    parseSpy.mockRestore();
    expect(loadSessionEntry({ sessionKey: "agent:main:planner-0", storePath })?.label).toBe(
      "updated",
    );
    expect(loadSessionEntry(retained)?.sessionId).toBe(retained.sessionId);
    expect(loadTranscriptEventsSync(retained)).toEqual(transcript);
  },
);

it("releases the store writer before maintenance archive sizing completes", async () => {
  const tempDir = tempDirs.make("openclaw-session-maintenance-writer-");
  const storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  const removedKey = "agent:main:subagent:maintenance-sizing-removed";
  const writerKey = "agent:main:maintenance-sizing-writer";
  replaceSessionEntrySync(
    { sessionKey: removedKey, storePath },
    { sessionId: "maintenance-sizing-removed", updatedAt: 1 },
  );
  replaceTranscriptEventsSync(
    { sessionKey: removedKey, sessionId: "maintenance-sizing-removed", storePath },
    [{ type: "session", id: "maintenance-sizing-removed", content: "archive me" }],
  );
  replaceSessionEntrySync(
    { sessionKey: writerKey, storePath },
    { sessionId: "maintenance-sizing-writer", updatedAt: Date.now() },
  );

  let writerCompleted = false;
  let writerCompletedBeforeMaterialization = false;
  archiveMaterializationHook.beforeMaterialize = () => {
    writerCompletedBeforeMaterialization = writerCompleted;
  };

  const cleanup = applySessionEntryLifecycleMutation({
    storePath,
    maintenanceOverride: {
      maxEntries: 1,
      mode: "enforce",
      pruneAfterMs: Number.MAX_SAFE_INTEGER,
    },
  });
  const writer = applySessionEntryLifecycleMutation({
    storePath,
    skipMaintenance: true,
    upserts: [
      {
        sessionKey: writerKey,
        entry: {
          sessionId: "maintenance-sizing-writer",
          label: "progressed",
          updatedAt: Date.now(),
        },
      },
    ],
  }).then((result) => {
    writerCompleted = true;
    return result;
  });

  await expect(cleanup).resolves.toMatchObject({ capped: 1 });
  await writer;
  expect(loadSessionEntry({ sessionKey: writerKey, storePath })).toMatchObject({
    label: "progressed",
  });
  expect(writerCompletedBeforeMaterialization).toBe(true);
});

it("does not hold channel recording behind automatic session maintenance", async () => {
  const tempDir = tempDirs.make("openclaw-session-maintenance-ingress-");
  const storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  const staleSessionKey = "agent:main:maintenance-ingress-stale";
  replaceSessionEntrySync(
    { sessionKey: staleSessionKey, storePath },
    { sessionId: "maintenance-ingress-stale", updatedAt: 1 },
  );

  let signalMaterializationStarted = () => {};
  const materializationStarted = new Promise<void>((resolve) => {
    signalMaterializationStarted = resolve;
  });
  let releaseMaterialization = () => {};
  const materializationReleased = new Promise<void>((resolve) => {
    releaseMaterialization = resolve;
  });
  archiveMaterializationHook.beforeMaterialize = async () => {
    signalMaterializationStarted();
    await materializationReleased;
  };

  const entryWrite = recordInboundSession({
    storePath,
    sessionKey: "agent:main:discord:direct:maintenance-ingress",
    ctx: {
      Body: "maintenance ingress proof",
      ChatType: "direct",
      From: "discord:maintenance-ingress",
      Provider: "discord",
      SenderId: "maintenance-ingress",
      To: "discord:bot",
    },
    updateLastRoute: {
      accountId: "default",
      channel: "discord",
      sessionKey: "agent:main:discord:direct:maintenance-ingress",
      to: "user:maintenance-ingress",
    },
    onRecordError(error) {
      throw error;
    },
  });
  const firstCompleted = await Promise.race([
    entryWrite.then(() => "entry-write" as const),
    materializationStarted.then(() => "maintenance" as const),
  ]);
  const laterStaleSessionKey = "agent:main:maintenance-ingress-later-stale";
  if (firstCompleted === "entry-write") {
    await materializationStarted;
    replaceSessionEntrySync(
      { sessionKey: laterStaleSessionKey, storePath },
      { sessionId: "maintenance-ingress-later-stale", updatedAt: 1 },
    );
    await recordInboundSession({
      storePath,
      sessionKey: "agent:main:discord:direct:maintenance-ingress-later",
      ctx: {
        Body: "later maintenance ingress proof",
        ChatType: "direct",
        From: "discord:maintenance-ingress-later",
        Provider: "discord",
        SenderId: "maintenance-ingress-later",
        To: "discord:bot",
      },
      updateLastRoute: {
        accountId: "default",
        channel: "discord",
        sessionKey: "agent:main:discord:direct:maintenance-ingress-later",
        to: "user:maintenance-ingress-later",
      },
      onRecordError(error) {
        throw error;
      },
    });
  }
  releaseMaterialization();
  await entryWrite;

  expect(firstCompleted).toBe("entry-write");
  await vi.waitFor(() => {
    expect(loadSessionEntry({ sessionKey: staleSessionKey, storePath })).toBeUndefined();
    if (firstCompleted === "entry-write") {
      expect(loadSessionEntry({ sessionKey: laterStaleSessionKey, storePath })).toBeUndefined();
    }
  });
});

it.each([
  {
    expected: { afterCount: 66, capArchived: 65, capped: 65 },
    expectedStat: /^66\b/u,
    name: "maintenance pruning",
    mutate: async (storePath: string) =>
      await applySessionEntryLifecycleMutation({
        storePath,
        maintenanceOverride: {
          maxEntries: 1,
          mode: "enforce",
          pruneAfterMs: Number.MAX_SAFE_INTEGER,
        },
      }),
  },
  {
    expected: { afterCount: 1, removedEntries: 65 },
    expectedStat: /^1\b/u,
    name: "explicit lifecycle cleanup",
    mutate: async (storePath: string) =>
      await applySessionEntryLifecycleMutation({
        storePath,
        removals: Array.from({ length: 65 }, (_, index) => ({
          sessionKey: `agent:main:planner-${index + 1}`,
        })),
        skipMaintenance: true,
      }),
  },
  {
    expected: { archivedTranscriptArtifacts: 0, removedEntries: 65 },
    expectedStat: /^1\b/u,
    name: "lifecycle artifact cleanup",
    mutate: async (storePath: string) =>
      await cleanupSessionLifecycleArtifactsCore({
        storePath,
        sessionKeySegmentPrefix: "planner-",
        transcriptContentMarker: "planner-marker",
        orphanTranscriptMinAgeMs: 1,
        nowMs: 66,
      }),
  },
])("refreshes planner statistics after bulk $name", async ({ expected, expectedStat, mutate }) => {
  const { database, storePath } = createPlannerStore(66);
  expect(
    database.db
      .prepare("SELECT stat FROM sqlite_stat1 WHERE idx = ?")
      .get("idx_agent_session_nodes_updated_at"),
  ).toEqual({ stat: expect.stringMatching(/^66\b/u) });

  await expect(mutate(storePath)).resolves.toMatchObject(expected);

  expect(
    database.db
      .prepare("SELECT stat FROM sqlite_stat1 WHERE idx = ?")
      .get("idx_agent_session_nodes_updated_at"),
  ).toEqual({ stat: expect.stringMatching(expectedStat) });
  expect(database.db.prepare("PRAGMA analysis_limit").get()).toEqual({ analysis_limit: 37 });
});

it("does not refresh planner statistics after one routine session deletion", async () => {
  const { database, storePath } = createPlannerStore(66);

  await expect(
    applySessionEntryLifecycleMutation({
      storePath,
      removals: [{ sessionKey: "agent:main:planner-65" }],
      skipMaintenance: true,
    }),
  ).resolves.toMatchObject({ afterCount: 65, removedEntries: 1 });

  expect(
    database.db
      .prepare("SELECT stat FROM sqlite_stat1 WHERE idx = ?")
      .get("idx_agent_session_nodes_updated_at"),
  ).toEqual({ stat: expect.stringMatching(/^66\b/u) });
  expect(database.db.prepare("PRAGMA analysis_limit").get()).toEqual({ analysis_limit: 37 });
});
