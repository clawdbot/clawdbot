import { afterEach, expect, test, vi } from "vitest";
import { SqliteBoardStore } from "../boards/sqlite-board-store.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { loadGatewayWorkerEnvironmentStartupState } from "./server-worker-environment-startup.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
  writeSingleLineSession,
} from "./test/server-sessions.test-helpers.js";

const sessionArchiveMaterializationHook = vi.hoisted(() => {
  const hooks: { afterMaterialize?: () => void; afterPublish?: () => void } = {};
  return hooks;
});

vi.mock("../config/sessions/session-accessor.sqlite-archive.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../config/sessions/session-accessor.sqlite-archive.js")>();
  return {
    ...actual,
    materializeSessionStateDeletePlans: async (
      ...args: Parameters<typeof actual.materializeSessionStateDeletePlans>
    ) => {
      const result = await actual.materializeSessionStateDeletePlans(...args);
      sessionArchiveMaterializationHook.afterMaterialize?.();
      return result;
    },
  };
});

vi.mock("../config/sessions/session-accessor.sqlite-archive-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../config/sessions/session-accessor.sqlite-archive-store.js")
    >();
  return {
    ...actual,
    publishSessionStateArchives: async (
      ...args: Parameters<typeof actual.publishSessionStateArchives>
    ) => {
      const result = await actual.publishSessionStateArchives(...args);
      sessionArchiveMaterializationHook.afterPublish?.();
      return result;
    },
  };
});

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(() => {
  sessionArchiveMaterializationHook.afterMaterialize = undefined;
  sessionArchiveMaterializationHook.afterPublish = undefined;
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

test("sessions.delete broadcasts the removed generation after a replacement appears", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:event-generation";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry("generation-a") } });
  const broadcast = vi.fn();
  const deleted = await directSessionReq(
    "sessions.delete",
    { key: sessionKey },
    {
      coercePayload: (payload) => {
        replaceSessionEntrySync({ sessionKey, storePath }, sessionStoreEntry("generation-b"));
        return payload;
      },
      context: {
        broadcastToConnIds: broadcast,
        getSessionEventSubscriberConnIds: () => new Set(["observer"]),
      },
    },
  );
  expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
  expect(loadSessionEntry({ sessionKey, storePath })?.sessionId).toBe("generation-b");
  expect(broadcast.mock.calls.map(([event, payload]) => ({ event, payload }))).toEqual([
    {
      event: "sessions.changed",
      payload: {
        sessionKey,
        agentId: "main",
        sessionId: "generation-a",
        reason: "delete",
        ts: expect.any(Number),
      },
    },
    { event: "sessions.changed", payload: { reason: "delete", ts: expect.any(Number) } },
  ]);
});

test("sessions.delete removes the session board from its agent database", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-board", "hello");
  await writeSessionStore({
    entries: {
      "discord:group:board-delete": sessionStoreEntry("sess-board"),
    },
  });
  const sessionKey = "agent:main:discord:group:board-delete";
  if (!testState.sessionStorePath) {
    throw new Error("expected gateway session store path");
  }
  const databasePath = resolveSqliteTargetFromSessionStorePath(testState.sessionStorePath, {
    agentId: "main",
  }).path;
  if (!databasePath) {
    throw new Error("expected gateway agent database path");
  }
  const store = new SqliteBoardStore({
    resolveSession: () => ({
      agentId: "main",
      path: databasePath,
      sessionKey,
    }),
    env: process.env,
  });
  store.putWidget({
    sessionKey,
    name: "status",
    content: { kind: "html", html: "ok" },
  });

  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
    key: "discord:group:board-delete",
  });

  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(true);
  expect(store.getSnapshot(sessionKey)).toEqual({
    sessionKey,
    revision: 0,
    tabs: [],
    widgets: [],
  });
});

test("sessions.delete reports an exact-entry replacement during transcript materialization", async () => {
  const sessionKey = "agent:main:cron:materialization-race";
  const sessionId = "materialization-race-run";
  const lifecycleRevision = "materialization-race-revision";
  const updatedAt = 1_737_600_000_000;
  const { storePath } = await createSessionStoreDir();
  const events = [{ type: "session" as const, id: sessionId, content: "original transcript" }];
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId, { lifecycleRevision, updatedAt }),
    },
  });
  await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, events);
  sessionArchiveMaterializationHook.afterMaterialize = () => {
    replaceSessionEntrySync(
      { sessionKey, storePath },
      sessionStoreEntry(sessionId, {
        label: "concurrent replacement",
        lifecycleRevision,
        updatedAt,
      }),
    );
  };

  const changed = await directSessionReq("sessions.delete", {
    key: sessionKey,
    expectedLifecycleRevision: lifecycleRevision,
    expectedSessionId: sessionId,
  });
  expect(changed).toMatchObject({
    ok: false,
    error: {
      message: `Session ${sessionKey} changed before deletion. Retry.`,
      details: { reason: "session-changed" },
    },
  });

  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    label: "concurrent replacement",
    lifecycleRevision,
    sessionId,
    updatedAt,
  });
  await expect(loadTranscriptEvents({ sessionKey, sessionId, storePath })).resolves.toEqual(events);
});

test.each(["authorization", "placement"] as const)(
  "sessions.delete rechecks %s after transcript materialization before committing",
  async (change) => {
    const { storePath } = await createSessionStoreDir();
    const sessionKey = `agent:main:materialization-${change}`;
    const sessionId = `session-materialization-${change}`;
    const events = [{ type: "session" as const, id: sessionId, content: "preserve transcript" }];
    await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
    await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, events);
    const { placementStore } = await loadGatewayWorkerEnvironmentStartupState();
    let authorized = true;
    sessionArchiveMaterializationHook.afterMaterialize = () => {
      if (change === "authorization") {
        authorized = false;
      } else {
        placementStore.startDispatch({ sessionId, sessionKey, agentId: "main" });
      }
    };
    await expect(
      directSessionReq(
        "sessions.delete",
        { key: sessionKey },
        {
          context: { workerSessionPlacementService: placementStore },
          sessionMutationAuthorization: {
            assertTargetCurrent: () => {},
            assertCurrent: () => {
              if (!authorized) {
                throw new Error("session access revoked");
              }
            },
          },
        },
      ),
    ).rejects.toThrow(
      change === "authorization" ? "session access revoked" : "changed before retirement",
    );
    expect(loadSessionEntry({ sessionKey, storePath })?.sessionId).toBe(sessionId);
    await expect(loadTranscriptEvents({ sessionKey, sessionId, storePath })).resolves.toEqual(
      events,
    );
  },
);

test("sessions.delete accepts placement retirement by the absent-session reconciler after commit", async () => {
  await createSessionStoreDir();
  const sessionKey = "agent:main:postcommit-retirement";
  const sessionId = "postcommit-retirement-session";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  const { placementStore } = await loadGatewayWorkerEnvironmentStartupState();
  const claim = placementStore.claimTurn({
    sessionId,
    sessionKey,
    agentId: "main",
    owner: { kind: "local" },
    claimId: "postcommit-claim",
    runId: "postcommit-run",
  });
  placementStore.releaseTurn(claim);
  let retired = false;
  sessionArchiveMaterializationHook.afterPublish = () => {
    if (!loadSessionEntry({ sessionKey }) && !retired) {
      placementStore.retireSessionPlacement({
        sessionId,
        expectedState: "local",
        expectedGeneration: claim.placementGeneration,
      });
      retired = true;
    }
  };
  const deleted = await directSessionReq(
    "sessions.delete",
    { key: sessionKey },
    {
      context: { workerSessionPlacementService: placementStore },
    },
  );
  expect(retired).toBe(true);
  expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
  expect(placementStore.get(sessionId)).toBeUndefined();
});
