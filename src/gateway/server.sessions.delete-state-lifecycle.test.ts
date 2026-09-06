import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { SessionsCompanionStateResult } from "../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { SqliteBoardStore } from "../boards/sqlite-board-store.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import * as sessionArchiveStore from "../config/sessions/session-accessor.sqlite-archive-store.js";
import * as sessionArchive from "../config/sessions/session-accessor.sqlite-archive.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  emitSessionIdentityMutation,
  onSessionIdentityMutation,
  type SessionIdentityMutation,
} from "../sessions/session-lifecycle-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { loadGatewayWorkerEnvironmentStartupState } from "./server-worker-environment-startup.js";
import type { SessionCompanionAskDeps } from "./session-companion-ask.js";
import { defaultSessionCompanionContextReader } from "./session-companion-context.js";
import { createSessionCompanion, type SessionCompanionService } from "./session-companion.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
  writeSingleLineSession,
} from "./test/server-sessions.test-helpers.js";

function afterSessionStateMaterialization(after: () => void) {
  const materialize = sessionArchive.materializeSessionStateDeletePlans;
  // Earlier files can load the owner in this non-isolated shard. Observe its
  // real export instead of replacing a module after that owner has captured it.
  vi.spyOn(sessionArchive, "materializeSessionStateDeletePlans").mockImplementation(
    async (...args) => {
      const result = await materialize(...args);
      after();
      return result;
    },
  );
}

const {
  createSessionStoreDir,
  createConfiguredGlobalAgentSessionStore,
  resetConfiguredGlobalAgentSessionStore,
} = setupGatewaySessionsHandlerTestHarness();
const companions = new Set<SessionCompanionService>();

afterEach(() => {
  for (const companion of companions) {
    companion.dispose();
  }
  companions.clear();
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

test("repository ownership survives reset and archive, then permanent deletion releases it", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:repository-lifecycle";
  const repositories = getSessionRepositoryWorkspaceStore();
  const repository = repositories.create({
    agentId: "main",
    sessionKey,
    url: "https://github.com/openclaw/fixture.git",
    runSetupScript: false,
    assertCurrent: () => {},
  });
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry("repository-lifecycle-session", {
        repositoryWorkspaceId: repository.workspaceId,
      }),
    },
  });
  const artifactRoot = repositories.artifactPath(repository.workspaceId);
  await fs.mkdir(artifactRoot, { recursive: true });
  await fs.writeFile(path.join(artifactRoot, "retained-checkpoint"), "accepted checkpoint");

  for (const [method, params] of [
    ["sessions.reset", { key: sessionKey }],
    ["sessions.patch", { key: sessionKey, archived: true }],
    ["sessions.patch", { key: sessionKey, archived: false }],
  ] as const) {
    const result = await directSessionReq(
      method,
      method === "sessions.patch"
        ? { ...params, expectedSessionId: loadSessionEntry({ sessionKey, storePath })!.sessionId }
        : params,
    );
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    const entry = loadSessionEntry({ sessionKey, storePath });
    expect(entry?.repositoryWorkspaceId).toBe(repository.workspaceId);
    expect(entry?.worktree).toBeUndefined();
    expect(entry?.spawnedCwd).toBeUndefined();
    expect(repositories.get(repository.workspaceId)).toEqual(repository);
  }
  const denied = await directSessionReq("sessions.delete", {
    key: sessionKey,
    expectedSessionId: "replaced-session",
  });
  expect(denied.ok).toBe(false);
  expect(repositories.get(repository.workspaceId)).toEqual(repository);
  expect(await fs.readFile(path.join(artifactRoot, "retained-checkpoint"), "utf8")).toBe(
    "accepted checkpoint",
  );
  const deleted = await directSessionReq("sessions.delete", { key: sessionKey });
  expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
  expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
  expect(repositories.get(repository.workspaceId)).toBeUndefined();
  await expect(fs.stat(artifactRoot)).rejects.toMatchObject({ code: "ENOENT" });
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
  expect(store.getSnapshot({ sessionKey })).toEqual({
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
  afterSessionStateMaterialization(() => {
    replaceSessionEntrySync(
      { sessionKey, storePath },
      sessionStoreEntry(sessionId, {
        label: "concurrent replacement",
        lifecycleRevision,
        updatedAt,
      }),
    );
  });

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
    afterSessionStateMaterialization(() => {
      if (change === "authorization") {
        authorized = false;
      } else {
        placementStore.startDispatch({ sessionId, sessionKey, agentId: "main" });
      }
    });
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
  const publish = sessionArchiveStore.publishSessionStateArchives;
  vi.spyOn(sessionArchiveStore, "publishSessionStateArchives").mockImplementation(
    async (...args) => {
      const result = await publish(...args);
      if (!loadSessionEntry({ sessionKey }) && !retired) {
        placementStore.retireSessionPlacement({
          sessionId,
          expectedState: "local",
          expectedGeneration: claim.placementGeneration,
        });
        retired = true;
      }
      return result;
    },
  );
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

async function createCompanion(runModel?: SessionCompanionAskDeps["run"]) {
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const run = vi.fn(runModel ?? (async () => "Synthetic answer from the selected session."));
  const service = createSessionCompanion({
    getConfig: getRuntimeConfig,
    contextReader: defaultSessionCompanionContextReader,
    sessionObserver: { getCompanionSnapshot: () => ({ agentId: "main", notes: [] }) },
    resolveUtilityModelRef: () => "openai/gpt-5.6-luna",
    run,
  });
  companions.add(service);
  return { service, run };
}

async function ask(
  service: SessionCompanionService,
  sessionKey: string,
  question: string,
  agentId = "main",
) {
  return service.ask({ agentId, sessionKey, question, connId: `conn-${agentId}` });
}

async function readState(service: SessionCompanionService, sessionKey: string, agentId = "main") {
  const response = await directSessionReq<SessionsCompanionStateResult>(
    "sessions.companion.state",
    { sessionKey, agentId },
    { context: { sessionCompanion: service } },
  );
  expect(response.ok, response.error?.message).toBe(true);
  return response.payload;
}

async function recreate(sessionKey: string) {
  const response = await directSessionReq<{ entry: { sessionId: string } }>("sessions.patch", {
    key: sessionKey,
    label: "Recreated session",
  });
  expect(response.ok, response.error?.message).toBe(true);
  return response.payload?.entry.sessionId;
}

test("sessions.delete retires Side chat before same-key recreation", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:companion-delete";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry("generation-a") } });
  const { service, run } = await createCompanion();
  await ask(service, sessionKey, "Question about generation A?");
  expect((await readState(service, sessionKey))?.exchanges).toHaveLength(1);

  const deleted = await directSessionReq("sessions.delete", { key: sessionKey });
  expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
  expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
  expect.soft(await readState(service, sessionKey)).toEqual({ exchanges: [] });

  const nextSessionId = await recreate(sessionKey);
  expect(nextSessionId).toBeTruthy();
  expect(nextSessionId).not.toBe("generation-a");
  expect.soft(await readState(service, sessionKey)).toEqual({ exchanges: [] });
  expect(run).toHaveBeenCalledTimes(1);
});

test("sessions.delete preserves Side chat when the deletion expectation is stale", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:companion-rejected-delete";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry("current-generation") } });
  const { service } = await createCompanion();
  await ask(service, sessionKey, "Keep this exchange?");
  const before = await readState(service, sessionKey);

  const deleted = await directSessionReq("sessions.delete", {
    key: sessionKey,
    expectedSessionId: "stale-generation",
  });
  expect(deleted).toMatchObject({ ok: false, error: { details: { reason: "session-changed" } } });
  expect(loadSessionEntry({ sessionKey, storePath })?.sessionId).toBe("current-generation");
  expect(await readState(service, sessionKey)).toEqual(before);
});

test("sessions.reset clears its Side chat and preserves another session", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:companion-reset";
  const otherKey = "agent:main:companion-unrelated";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry("reset-generation"),
      [otherKey]: sessionStoreEntry("unrelated-generation"),
    },
  });
  const { service } = await createCompanion();
  await ask(service, sessionKey, "Before reset?");
  await ask(service, otherKey, "Keep the unrelated conversation?");
  const otherBefore = await readState(service, otherKey);

  const reset = await directSessionReq("sessions.reset", { key: sessionKey });
  expect(reset.ok, reset.error?.message).toBe(true);
  expect(loadSessionEntry({ sessionKey, storePath })?.sessionId).toBe("reset-generation");
  expect(await readState(service, sessionKey)).toEqual({ exchanges: [] });
  expect(await readState(service, otherKey)).toEqual(otherBefore);
});

test("sessions.delete isolates Side chat for the same global key and session ID in another agent", async () => {
  const stores = await createConfiguredGlobalAgentSessionStore();
  await writeSessionStore({
    agentId: "work",
    entries: { global: sessionStoreEntry("sess-main-global") },
    storePath: stores.workStorePath,
  });
  const { service } = await createCompanion();
  try {
    await ask(service, "global", "Main agent question?", "main");
    await ask(service, "global", "Work agent question?", "work");
    const mainBefore = await readState(service, "global", "main");

    const deleted = await directSessionReq("sessions.delete", { key: "global", agentId: "work" });
    expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
    expect(await readState(service, "global", "main")).toEqual(mainBefore);
    expect(await readState(service, "global", "work")).toEqual({ exchanges: [] });
  } finally {
    service.dispose();
    companions.delete(service);
    await resetConfiguredGlobalAgentSessionStore(stores);
  }
});

test("a delayed deletion event cannot erase Side chat for a newer generation", async () => {
  await createSessionStoreDir();
  const sessionKey = "agent:main:companion-late-delete";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry("old-generation") } });
  const { service } = await createCompanion();
  await ask(service, sessionKey, "Old generation question?");
  let deletion: Extract<SessionIdentityMutation, { kind: "delete" }> | undefined;
  const stop = onSessionIdentityMutation((event) => {
    if (event.kind === "delete" && event.previous.sessionId === "old-generation") {
      deletion = event;
    }
  });
  try {
    const deleted = await directSessionReq("sessions.delete", { key: sessionKey });
    expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
  } finally {
    stop();
  }
  expect(deletion).toBeDefined();
  await recreate(sessionKey);
  await ask(service, sessionKey, "New generation question?");
  const newState = await readState(service, sessionKey);
  expect(newState?.exchanges.map((exchange) => exchange.question)).toEqual([
    "New generation question?",
  ]);

  emitSessionIdentityMutation(deletion!);
  expect(await readState(service, sessionKey)).toEqual(newState);
});

test("sessions.delete cancels a prepared Side chat ask before its late answer", async () => {
  await createSessionStoreDir();
  const sessionKey = "agent:main:companion-active-delete";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry("active-generation") } });
  const pending = createDeferred<string>();
  const { service, run } = await createCompanion(() => pending.promise);
  const active = ask(service, sessionKey, "Can this survive deletion?");
  const failure = active.catch((error: unknown) => error);
  try {
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const deleted = await directSessionReq("sessions.delete", { key: sessionKey });
    expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
    expect(run.mock.calls[0]?.[0].signal.aborted).toBe(true);
    pending.resolve("Late answer from the deleted session.");
    await expect(failure).resolves.toMatchObject({ reason: "context-unavailable" });
    await active.catch(() => undefined);
    expect(await readState(service, sessionKey)).toEqual({ exchanges: [] });
  } finally {
    pending.resolve("Late answer from the deleted session.");
    await active.catch(() => undefined);
  }
});
