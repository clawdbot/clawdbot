// Session creation tests protect dashboard-origin session records, transcript
// creation, parent linkage, and model/provider overrides exposed by the gateway API.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { findGitCheckoutRoot } from "../agents/worktrees/git.js";
import {
  findLiveRegistryWorktreeByOwner,
  getRegistryWorktree,
  listRegistryWorktrees,
} from "../agents/worktrees/registry.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { initSessionState } from "../auto-reply/reply/session.js";
import { getRuntimeConfig } from "../config/io.js";
import { loadCombinedSessionStoreForGateway } from "../config/sessions/combined-store-gateway.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntry,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { isSessionLifecycleMutationActive } from "../sessions/session-lifecycle-admission.js";
import { listSessionStateEventsSince } from "../sessions/session-state-events.js";
import {
  closeOpenClawAgentDatabasesForTest,
  listOpenIncognitoAgentDatabases,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { resolveGatewaySessionStoreTarget } from "./session-utils.js";
import {
  agentCommandMock,
  agentDiscoveryMock,
  dispatchInboundMessageMock,
  embeddedRunMock,
  onceMessage,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  createCheckpointFixture,
  sessionStoreEntry,
  directSessionReq,
  sessionHookMocks,
  sessionLifecycleHookMocks,
  seedSessionTranscript,
  threadBindingMocks,
} from "./test/server-sessions.test-helpers.js";

type EnsureSessionDiffBaseline =
  (typeof import("../sessions/session-diff-baseline.js"))["ensureSessionDiffBaseline"];
type GenerateDashboardSessionTitle =
  (typeof import("./dashboard-session-title.js"))["generateDashboardSessionTitle"];
type ReadSessionMessageCountAsync =
  (typeof import("./session-transcript-readers.js"))["readSessionMessageCountAsync"];

const sessionDiffBaselineMocks = vi.hoisted(() => ({
  ensure: vi.fn<EnsureSessionDiffBaseline>(),
  useReal: false,
}));

const dashboardTitleMocks = vi.hoisted(() => ({
  actual: undefined as GenerateDashboardSessionTitle | undefined,
  generate: vi.fn<GenerateDashboardSessionTitle>(),
}));

const sessionTranscriptReaderMocks = vi.hoisted(() => ({
  actual: undefined as ReadSessionMessageCountAsync | undefined,
  readCount: vi.fn<ReadSessionMessageCountAsync>(),
}));

vi.mock("../sessions/session-diff-baseline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sessions/session-diff-baseline.js")>();
  sessionDiffBaselineMocks.ensure.mockImplementation(async (params) =>
    sessionDiffBaselineMocks.useReal
      ? await actual.ensureSessionDiffBaseline(params)
      : params.entry,
  );
  return { ...actual, ensureSessionDiffBaseline: sessionDiffBaselineMocks.ensure };
});

vi.mock("./dashboard-session-title.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dashboard-session-title.js")>();
  dashboardTitleMocks.actual = actual.generateDashboardSessionTitle;
  dashboardTitleMocks.generate.mockImplementation(actual.generateDashboardSessionTitle);
  return { ...actual, generateDashboardSessionTitle: dashboardTitleMocks.generate };
});

vi.mock("./session-transcript-readers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-transcript-readers.js")>();
  sessionTranscriptReaderMocks.actual = actual.readSessionMessageCountAsync;
  sessionTranscriptReaderMocks.readCount.mockImplementation(actual.readSessionMessageCountAsync);
  return { ...actual, readSessionMessageCountAsync: sessionTranscriptReaderMocks.readCount };
});

const { createSessionStoreDir, createSelectedGlobalSessionStore, openClient } =
  setupGatewaySessionsTestHarness();
const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  sessionDiffBaselineMocks.ensure.mockClear();
  // Baseline capture has dedicated owner coverage and one authenticated integration below.
  sessionDiffBaselineMocks.useReal = false;
  dashboardTitleMocks.generate.mockReset();
  if (!dashboardTitleMocks.actual) {
    throw new Error("actual dashboard title generator was not loaded");
  }
  dashboardTitleMocks.generate.mockImplementation(dashboardTitleMocks.actual);
  sessionTranscriptReaderMocks.readCount.mockReset();
  if (!sessionTranscriptReaderMocks.actual) {
    throw new Error("actual session transcript reader was not loaded");
  }
  sessionTranscriptReaderMocks.readCount.mockImplementation(sessionTranscriptReaderMocks.actual);
});

async function makeNonGitTempDir(prefix: string): Promise<string> {
  let root = await fs.realpath(os.tmpdir());
  for (;;) {
    const checkoutRoot = findGitCheckoutRoot(root);
    if (!checkoutRoot) {
      return tempDirs.make(prefix, root);
    }
    const parent = path.dirname(checkoutRoot);
    if (parent === checkoutRoot) {
      throw new Error("could not find a temp root outside a git checkout");
    }
    root = parent;
  }
}

test("sessions.create and sessions.delete preserve every concurrent session lifecycle", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionCount = 24;

  const created = await Promise.all(
    Array.from({ length: sessionCount }, (_, index) =>
      directSessionReq<{ key: string; sessionId: string }>("sessions.create", {
        agentId: "main",
        label: `Concurrent session ${index}`,
      }),
    ),
  );

  expect(created.every((result) => result.ok)).toBe(true);
  const sessionKeys = created.map((result) =>
    requireNonEmptyString(result.payload?.key, "concurrent session key"),
  );
  const sessionIds = created.map((result) =>
    requireNonEmptyString(result.payload?.sessionId, "concurrent session id"),
  );
  expect(new Set(sessionKeys).size).toBe(sessionCount);
  expect(new Set(sessionIds).size).toBe(sessionCount);
  for (const [index, sessionKey] of sessionKeys.entries()) {
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      sessionId: sessionIds[index],
      label: `Concurrent session ${index}`,
    });
  }

  const deleted = await Promise.all(
    sessionKeys.map((key) =>
      directSessionReq<{ deleted: boolean }>("sessions.delete", {
        key,
        deleteTranscript: false,
      }),
    ),
  );

  expect(deleted.every((result) => result.ok && result.payload?.deleted === true)).toBe(true);
  for (const sessionKey of sessionKeys) {
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
  }
});

test("concurrent sessions.create requests adopt one canonical keyed session", async () => {
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard:concurrent-keyed-session";

  const created = await Promise.all(
    Array.from({ length: 16 }, () =>
      directSessionReq<{ key: string; sessionId: string }>("sessions.create", {
        agentId: "main",
        key,
      }),
    ),
  );

  expect(created.every((result) => result.ok)).toBe(true);
  expect(new Set(created.map((result) => result.payload?.key))).toEqual(new Set([key]));
  const sessionIds = new Set(created.map((result) => result.payload?.sessionId));
  expect(sessionIds.size).toBe(1);
  expect(loadSessionEntry({ sessionKey: key, storePath })?.sessionId).toBe(
    created[0]?.payload?.sessionId,
  );
});

test("keyed sessions remain recoverable across overlapping create and delete waves", async () => {
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard:concurrent-lifecycle-waves";

  for (let wave = 0; wave < 6; wave += 1) {
    const operations = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        index % 3 === 0
          ? directSessionReq<{ deleted: boolean }>("sessions.delete", {
              key,
              deleteTranscript: false,
            })
          : directSessionReq<{ key: string; sessionId: string }>("sessions.create", {
              agentId: "main",
              key,
            }),
      ),
    );

    expect(
      operations.every((result) => result.ok),
      `lifecycle wave ${wave}`,
    ).toBe(true);

    const recovered = await directSessionReq<{ key: string; sessionId: string }>(
      "sessions.create",
      { agentId: "main", key },
    );
    expect(recovered.ok, `creation after lifecycle wave ${wave}`).toBe(true);
    expect(recovered.payload?.key).toBe(key);
    expect(loadSessionEntry({ sessionKey: key, storePath })?.sessionId).toBe(
      recovered.payload?.sessionId,
    );

    const deleted = await directSessionReq<{ deleted: boolean }>("sessions.delete", {
      key,
      deleteTranscript: false,
    });
    expect(deleted.ok, `deletion after lifecycle wave ${wave}`).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);
    expect(loadSessionEntry({ sessionKey: key, storePath })).toBeUndefined();
  }
});

test("sessions.create keeps incognito rows process-local through list, spawn, reset, and delete", async () => {
  const { storePath } = await createSessionStoreDir();
  try {
    const durableParentKey = "main";
    await writeSessionStore({ entries: { main: sessionStoreEntry("durable-parent") } });
    const created = await directSessionReq<{
      key: string;
      entry: {
        incognito?: true;
        parentSessionKey?: string;
        sessionFile?: string;
        sessionId: string;
      };
    }>("sessions.create", { agentId: "main", incognito: true });
    expect(created.ok).toBe(true);
    const key = requireNonEmptyString(created.payload?.key, "incognito session key");
    expect(key).toMatch(/^agent:main:dashboard:incognito-/u);
    const entry = created.payload?.entry;
    expect(entry?.incognito).toBe(true);
    expect(entry?.parentSessionKey).toBeUndefined();
    expect(entry).not.toHaveProperty("sessionFile");
    const openedIncognitoDatabase = openOpenClawAgentDatabase({
      agentId: "main",
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
    });
    expect(
      openedIncognitoDatabase.db
        .prepare("SELECT session_key FROM session_nodes WHERE session_key = ?")
        .get(key),
    ).toEqual({ session_key: key });
    expect(loadSessionEntry({ agentId: "main", sessionKey: key })?.incognito).toBe(true);
    expect(loadCombinedSessionStoreForGateway(getRuntimeConfig()).store[key]?.incognito).toBe(true);
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.incognito).toBe(true);
    const persistentDatabase = openOpenClawAgentDatabase({
      agentId: "main",
      path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
    });
    expect(
      persistentDatabase.db
        .prepare("SELECT session_key FROM session_nodes WHERE session_key = ?")
        .get(key),
    ).toBeUndefined();

    const rejectedDurableParent = await directSessionReq("sessions.create", {
      agentId: "main",
      incognito: true,
      parentSessionKey: durableParentKey,
    });
    expect(rejectedDurableParent).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "incognito sessions cannot have durable parents",
      },
    });

    const listed = await directSessionReq<{ sessions: Array<{ key: string; incognito?: true }> }>(
      "sessions.list",
      {},
    );
    expect(listed.payload?.sessions).toContainEqual(
      expect.objectContaining({ key, incognito: true }),
    );

    const rejectedReuse = await directSessionReq("sessions.create", {
      agentId: "main",
      key,
    });
    expect(rejectedReuse).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "incognito-shaped session keys require incognito: true",
      },
    });
    expect(loadSessionEntry({ agentId: "main", sessionKey: key })?.sessionId).toBe(
      entry?.sessionId,
    );

    const child = await directSessionReq<{
      key: string;
      entry: {
        incognito?: true;
        parentSessionId?: string;
        parentSessionKey?: string;
        sessionFile?: string;
      };
    }>("sessions.create", { agentId: "main", parentSessionKey: key });
    expect(child.ok).toBe(true);
    const childKey = requireNonEmptyString(child.payload?.key, "incognito child key");
    expect(child.payload?.entry.incognito).toBe(true);
    expect(child.payload?.entry.parentSessionKey).toBe(key);
    expect(child.payload?.entry.parentSessionId).toBe(entry?.sessionId);
    expect(child.payload?.entry).not.toHaveProperty("sessionFile");

    const rejectedInheritedChannel = await directSessionReq("sessions.create", {
      agentId: "main",
      key: "agent:main:discord:channel:inherited",
      parentSessionKey: key,
    });
    expect(rejectedInheritedChannel).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "incognito sessions are web-only" },
    });
    const durableSubagentKey = "agent:main:subagent:durable-existing";
    await upsertSessionEntry(
      { agentId: "main", sessionKey: durableSubagentKey, storePath },
      { sessionId: "durable-subagent", updatedAt: Date.now() },
    );
    const rejectedInheritedExisting = await directSessionReq("sessions.create", {
      agentId: "main",
      key: durableSubagentKey,
      parentSessionKey: key,
    });
    expect(rejectedInheritedExisting).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "incognito sessions are web-only" },
    });
    expect(
      persistentDatabase.db
        .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
        .get(durableSubagentKey),
    ).toEqual({ current_session_id: "durable-subagent" });

    const deleted = await directSessionReq<{ archived: string[]; deleted: boolean }>(
      "sessions.delete",
      { key: childKey },
    );
    expect(deleted.payload).toMatchObject({ archived: [], deleted: true });

    const reset = await directSessionReq<{ deleted?: boolean }>("sessions.reset", { key });
    expect(reset.payload).toMatchObject({ deleted: true });
    expect(resolveGatewaySessionStoreTarget({ cfg: getRuntimeConfig(), key }).storePath).toBe(
      resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
    );
    const incognitoDatabase = openOpenClawAgentDatabase({
      agentId: "main",
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
    });
    for (const table of ["session_nodes", "session_windows", "transcript_events"] as const) {
      expect(incognitoDatabase.db.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({
        count: 0,
      });
    }
    const afterReset = await directSessionReq<{ sessions: Array<{ key: string }> }>(
      "sessions.list",
      {},
    );
    expect(afterReset.payload?.sessions.some((session) => session.key === key)).toBe(false);

    await upsertSessionEntry(
      { agentId: "main", sessionKey: key, storePath },
      { sessionId: "rematerialized-incognito", updatedAt: Date.now() },
    );
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.incognito).toBe(
      undefined,
    );
    const resetRematerialized = await directSessionReq<{ deleted?: boolean }>("sessions.reset", {
      key,
    });
    expect(resetRematerialized.payload).toMatchObject({ deleted: true });
    expect(
      openedIncognitoDatabase.db
        .prepare("SELECT session_key FROM session_nodes WHERE session_key = ?")
        .get(key),
    ).toBeUndefined();

    const rejected = await directSessionReq("sessions.create", {
      agentId: "main",
      key: "agent:main:discord:channel:123",
      incognito: true,
    });
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "incognito sessions are web-only" },
    });
    const rejectedSubagentKey = await directSessionReq("sessions.create", {
      agentId: "main",
      key: "agent:main:subagent:incognito-client-key",
      incognito: true,
    });
    expect(rejectedSubagentKey).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "incognito sessions are web-only" },
    });
    const rejectedAgentMismatch = await directSessionReq("sessions.create", {
      agentId: "main",
      key: "agent:work:dashboard:incognito-client-key",
      incognito: true,
    });
    expect(rejectedAgentMismatch).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "sessions.create key agent (work) does not match agentId (main)",
      },
    });
    const durableCollisionKey = "agent:main:dashboard:incognito-durable-collision";
    const durableCollisionUpdatedAt = Date.now();
    persistentDatabase.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, 'durable-collision', ?, ?)",
      )
      .run(
        durableCollisionKey,
        JSON.stringify({ sessionId: "durable-collision", updatedAt: durableCollisionUpdatedAt }),
        durableCollisionUpdatedAt,
      );
    persistentDatabase.db
      .prepare(
        "INSERT INTO session_windows (session_id, session_key, session_scope, created_at, updated_at) VALUES ('durable-collision', ?, 'conversation', ?, ?)",
      )
      .run(durableCollisionKey, durableCollisionUpdatedAt, durableCollisionUpdatedAt);
    const rejectedExplicitDashboard = await directSessionReq("sessions.create", {
      agentId: "main",
      key: durableCollisionKey,
      incognito: true,
    });
    expect(rejectedExplicitDashboard).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "incognito is immutable and requires a new session key",
      },
    });
  } finally {
    closeOpenClawAgentDatabasesForTest();
  }
});

test("incognito sessions survive non-default-agent webchat reply initialization", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "work" }] };
  const { ws } = await openClient({
    browserOrigin: "http://127.0.0.1",
    client: {
      id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      version: "dev",
      platform: "web",
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
    },
  });
  try {
    const created = await rpcReq<{ key?: string; sessionId?: string }>(ws, "sessions.create", {
      agentId: "work",
      incognito: true,
    });
    expect(created.ok).toBe(true);
    const sessionKey = requireNonEmptyString(created.payload?.key, "incognito webchat key");
    const sessionId = requireNonEmptyString(created.payload?.sessionId, "incognito webchat id");
    let resolveDispatch!: (value: Awaited<ReturnType<typeof initSessionState>>) => void;
    let rejectDispatch!: (error: unknown) => void;
    const dispatched = new Promise<Awaited<ReturnType<typeof initSessionState>>>(
      (resolve, reject) => {
        resolveDispatch = resolve;
        rejectDispatch = reject;
      },
    );
    dispatchInboundMessageMock.mockImplementationOnce(async (params: unknown) => {
      const input = params as {
        cfg: OpenClawConfig;
        ctx: Parameters<typeof initSessionState>[0]["ctx"];
        replyOptions?: {
          expectedExistingSessionId?: string;
          pinExpectedExistingSession?: boolean;
          requestedSessionId?: string;
          resumeRequestedSession?: boolean;
        };
      };
      try {
        resolveDispatch(
          await initSessionState({
            cfg: input.cfg,
            ctx: finalizeInboundContext(input.ctx),
            commandAuthorized: true,
            expectedExistingSessionId: input.replyOptions?.expectedExistingSessionId,
            pinExpectedExistingSession: input.replyOptions?.pinExpectedExistingSession,
            requestedSessionId: input.replyOptions?.requestedSessionId,
            resumeRequestedSession: input.replyOptions?.resumeRequestedSession,
          }),
        );
      } catch (error) {
        rejectDispatch(error);
      }
      return {
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
      };
    });

    const sent = await rpcReq(ws, "chat.send", {
      sessionKey,
      sessionId,
      message: "hello from incognito webchat",
      idempotencyKey: "incognito-webchat-send",
    });
    expect(sent.ok).toBe(true);
    await expect(dispatched).resolves.toMatchObject({
      sessionId,
      sessionKey,
      storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "work" }),
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    closeOpenClawAgentDatabasesForTest();
    dispatchInboundMessageMock.mockClear();
    const stale = await rpcReq(ws, "chat.send", {
      sessionKey,
      sessionId,
      message: "this must not persist after restart",
      idempotencyKey: "stale-incognito-webchat-send",
    });
    expect(stale.ok).toBe(false);
    expect(stale.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: `Incognito session "${sessionKey}" was not found.`,
    });
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(listOpenIncognitoAgentDatabases()).toEqual([]);

    const persistentDatabase = openOpenClawAgentDatabase({
      agentId: "work",
      path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "work" }).path,
    });
    expect(
      persistentDatabase.db
        .prepare("SELECT session_key FROM session_nodes WHERE session_key = ?")
        .get(sessionKey),
    ).toBeUndefined();
  } finally {
    ws.close();
    closeOpenClawAgentDatabasesForTest();
  }
});

test("createGatewaySession rechecks admin scope after incognito inheritance resolves", async () => {
  await createSessionStoreDir();
  try {
    const { createGatewaySession } = await import("./session-create-service.js");
    const parent = await directSessionReq<{ key?: string }>("sessions.create", {
      agentId: "main",
      incognito: true,
    });
    const parentSessionKey = requireNonEmptyString(parent.payload?.key, "incognito parent key");
    const base = {
      cfg: getRuntimeConfig(),
      agentId: "main",
      parentSessionKey,
      commandSource: "test",
    };

    await expect(
      createGatewaySession({ ...base, requestingOperatorScopes: ["operator.write"] }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "incognito sessions require gateway scope: operator.admin",
      },
    });
    await expect(
      createGatewaySession({ ...base, requestingOperatorScopes: ["operator.admin"] }),
    ).resolves.toMatchObject({ ok: true, entry: { incognito: true } });
  } finally {
    closeOpenClawAgentDatabasesForTest();
  }
});

test("createGatewaySession forwards its commit guard into main-session reset", async () => {
  const { storePath } = await createSessionStoreDir();
  try {
    const { createGatewaySession } = await import("./session-create-service.js");
    const key = "agent:main:main";
    const original = sessionStoreEntry("main-before-guard-close");
    testState.sessionConfig = { dmScope: "main" };
    await writeSessionStore({ entries: { main: original } });
    const commitGuard = vi.fn(() => {
      if (commitGuard.mock.calls.length > 1) {
        throw new Error("session create authority closed");
      }
    });

    await expect(
      createGatewaySession({
        cfg: getRuntimeConfig(),
        agentId: "main",
        parentSessionKey: "main",
        emitCommandHooks: true,
        resetMainWhenUnspecified: true,
        commandSource: "test",
        commitGuard,
      }),
    ).rejects.toThrow("session create authority closed");

    expect(commitGuard).toHaveBeenCalledTimes(2);
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toMatchObject(
      original,
    );
  } finally {
    testState.sessionConfig = undefined;
    closeOpenClawAgentDatabasesForTest();
  }
});

test("createGatewaySession persists a generated title only for a new session", async () => {
  await createSessionStoreDir();
  const { createGatewaySession } = await import("./session-create-service.js");
  const key = "agent:main:dashboard:generated-worktree-title";
  const base = {
    cfg: getRuntimeConfig(),
    agentId: "main",
    key,
    commandSource: "test",
  };

  const created = await createGatewaySession({
    ...base,
    generatedDisplayName: "Readable Worktree Names",
  });
  expect(created).toMatchObject({ ok: true, entry: { displayName: "Readable Worktree Names" } });

  const reused = await createGatewaySession({
    ...base,
    generatedDisplayName: "Replacement Title",
  });
  expect(reused).toMatchObject({ ok: true, entry: { displayName: "Readable Worktree Names" } });
});

test("incognito operator RPCs treat identityless connections as owner-equivalent", async () => {
  const { dir } = await createSessionStoreDir();
  const admin = await openClient({
    scopes: ["operator.admin"],
    deviceIdentityPath: path.join(dir, "admin-device.json"),
  });
  const reader = await openClient({
    scopes: ["operator.read"],
    deviceIdentityPath: path.join(dir, "reader-device.json"),
  });
  const writer = await openClient({
    scopes: ["operator.write"],
    deviceIdentityPath: path.join(dir, "writer-device.json"),
  });
  try {
    const created = await rpcReq<{ key?: string; sessionId?: string }>(
      admin.ws,
      "sessions.create",
      { agentId: "main", incognito: true },
    );
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const sessionKey = requireNonEmptyString(created.payload?.key, "admin incognito key");

    const adminList = await rpcReq<{ sessions?: Array<{ key?: string }> }>(
      admin.ws,
      "sessions.list",
      {},
    );
    expect(adminList.payload?.sessions?.some((session) => session.key === sessionKey)).toBe(true);

    for (const ws of [admin.ws, reader.ws, writer.ws]) {
      await expect(rpcReq(ws, "sessions.subscribe", {})).resolves.toMatchObject({ ok: true });
    }
    for (const ws of [reader.ws, writer.ws]) {
      const listed = await rpcReq<{ path?: string; sessions?: Array<{ key?: string }> }>(
        ws,
        "sessions.list",
        {},
      );
      expect(listed.ok).toBe(true);
      expect(listed.payload?.sessions?.some((session) => session.key === sessionKey)).toBe(true);
    }

    const deniedCreate = await rpcReq(writer.ws, "sessions.create", {
      agentId: "main",
      incognito: true,
    });
    expect(deniedCreate).toMatchObject({
      ok: false,
      error: { message: "missing scope: operator.admin" },
    });
    for (const params of [
      { parentSessionKey: sessionKey },
      { parentSessionKey: sessionKey, fork: true },
      { parentSessionKey: sessionKey, spawnDepth: 1 },
      { parentSessionKey: sessionKey, succeedsParent: false, emitCommandHooks: true },
    ]) {
      await expect(rpcReq(writer.ws, "sessions.create", params)).resolves.toMatchObject({
        ok: false,
        error: { message: "missing scope: operator.admin" },
      });
    }
    await expect(
      rpcReq(admin.ws, "sessions.create", { parentSessionKey: sessionKey }),
    ).resolves.toMatchObject({ ok: true, payload: { entry: { incognito: true } } });

    await expect(rpcReq(reader.ws, "sessions.get", { key: sessionKey })).resolves.toMatchObject({
      ok: true,
    });

    const changedEvent = (ws: typeof admin.ws) =>
      onceMessage(
        ws,
        (message) =>
          message.type === "event" &&
          message.event === "sessions.changed" &&
          (message.payload as { sessionKey?: unknown } | undefined)?.sessionKey === sessionKey,
      );
    const changedEvents = [admin.ws, reader.ws, writer.ws].map(changedEvent);
    const patched = await rpcReq(admin.ws, "sessions.patch", {
      key: sessionKey,
      label: "admin-only",
    });
    expect(patched.ok, JSON.stringify(patched.error)).toBe(true);
    await Promise.all(changedEvents);
  } finally {
    admin.ws.close();
    reader.ws.close();
    writer.ws.close();
    closeOpenClawAgentDatabasesForTest();
  }
});

function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

async function initializeGitWorkspace(root: string): Promise<string> {
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  await execFileAsync("git", ["-C", workspace, "init", "-b", "main"]);
  await fs.writeFile(path.join(workspace, "README.md"), "base\n");
  await execFileAsync("git", ["-C", workspace, "add", "README.md"]);
  await execFileAsync("git", [
    "-c",
    "user.name=OpenClaw Test",
    "-c",
    "user.email=openclaw-test@example.invalid",
    "-C",
    workspace,
    "commit",
    "-m",
    "initial",
  ]);
  return await fs.realpath(workspace);
}

test("sessions.create captures and persists the initial workspace diff baseline", async () => {
  const root = tempDirs.make("openclaw-session-diff-baseline-");
  const workspace = await initializeGitWorkspace(root);
  await fs.appendFile(path.join(workspace, "README.md"), "dirty at session start\n");
  const { storePath } = await createSessionStoreDir();
  sessionDiffBaselineMocks.useReal = true;
  const { ws } = await openClient({
    browserOrigin: "http://127.0.0.1",
    client: {
      id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      version: "dev",
      platform: "web",
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
    },
  });
  try {
    const created = await rpcReq<{ key?: string; sessionId?: string }>(ws, "sessions.create", {
      agentId: "main",
      cwd: workspace,
    });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(sessionDiffBaselineMocks.ensure).toHaveBeenCalledTimes(1);
    const sessionKey = requireNonEmptyString(created.payload?.key, "baseline session key");
    const sessionId = requireNonEmptyString(created.payload?.sessionId, "baseline session id");
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      sessionId,
      spawnedCwd: workspace,
      sessionDiffBaseline: {
        version: 1,
        sessionId,
        root: workspace,
        files: [
          {
            path: "README.md",
            fingerprint: expect.any(String),
          },
        ],
      },
    });
  } finally {
    sessionDiffBaselineMocks.useReal = false;
    ws.close();
  }
});

function requireNonEmptyString(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

test("sessions.create persists draft visibility in the initial session entry", async () => {
  const { storePath } = await createSessionStoreDir();
  const created = await directSessionReq<{
    key: string;
    entry: { visibility?: string };
  }>("sessions.create", { agentId: "main", visibility: "draft" });

  expect(created.ok).toBe(true);
  expect(created.payload?.entry.visibility).toBe("draft");
  const key = requireNonEmptyString(created.payload?.key, "created session key");
  expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.visibility).toBe(
    "draft",
  );
  const listed = await directSessionReq<{
    sessions?: Array<{ key: string; visibility?: string }>;
  }>("sessions.list", {});
  expect(listed.payload?.sessions?.find((row) => row.key === key)?.visibility).toBe("draft");
});

test("sessions.create keeps omitted visibility on the prior shared default", async () => {
  const { storePath } = await createSessionStoreDir();
  const created = await directSessionReq<{
    key: string;
    entry: { visibility?: string };
  }>("sessions.create", { agentId: "main" });

  expect(created.ok).toBe(true);
  expect(created.payload?.entry.visibility).toBeUndefined();
  const key = requireNonEmptyString(created.payload?.key, "created session key");
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.visibility,
  ).toBeUndefined();
  const listed = await directSessionReq<{
    sessions?: Array<{ key: string; visibility?: string }>;
  }>("sessions.list", {});
  expect(listed.payload?.sessions?.find((row) => row.key === key)?.visibility).toBe("shared");
});

test("sessions.create preserves keyed draft adoption idempotency", async () => {
  await createSessionStoreDir();
  const key = "agent:main:dashboard:idempotent-draft";
  const first = await directSessionReq<{
    sessionId: string;
    entry: { visibility?: string };
  }>("sessions.create", { agentId: "main", key, visibility: "draft" });

  expect(first.ok).toBe(true);
  const retried = await directSessionReq<{
    sessionId: string;
    entry: { visibility?: string };
  }>("sessions.create", { agentId: "main", key, visibility: "draft" });
  expect(retried).toMatchObject({
    ok: true,
    payload: {
      sessionId: first.payload?.sessionId,
      entry: { visibility: "draft" },
    },
  });

  testState.sessionConfig = { sharing: { drafts: false } };
  const retriedAfterPolicyChange = await directSessionReq<{
    sessionId: string;
    entry: { visibility?: string };
  }>("sessions.create", { agentId: "main", key, visibility: "draft" });
  expect(retriedAfterPolicyChange).toMatchObject({
    ok: true,
    payload: {
      sessionId: first.payload?.sessionId,
      entry: { visibility: "draft" },
    },
  });

  const mismatch = await directSessionReq("sessions.create", {
    agentId: "main",
    key,
    visibility: "shared",
  });
  expect(mismatch).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: "sessions.create visibility requires a new session",
    },
  });
});

test("sessions.create rejects draft visibility when policy disables drafts", async () => {
  testState.sessionConfig = { sharing: { drafts: false } };
  const created = await directSessionReq("sessions.create", {
    agentId: "main",
    visibility: "draft",
  });

  expect(created).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: "session visibility is disabled: draft",
      details: { code: "SESSION_VISIBILITY_DISABLED", visibility: "draft" },
    },
  });
});

test("sessions.create provisions its worktree inside the target lifecycle fence", async () => {
  const openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-session-worktree-fence-",
  });
  const workspace = await initializeGitWorkspace(openClawState.root);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard:worktree-fence";
  const originalCreate = managedWorktrees.create.bind(managedWorktrees);
  const createSpy = vi.spyOn(managedWorktrees, "create").mockImplementation(async (params) => {
    expect(isSessionLifecycleMutationActive(storePath, [key])).toBe(true);
    return await originalCreate(params);
  });
  let worktreeId: string | undefined;
  try {
    const created = await directSessionReq<{
      worktree: { id: string; path: string; branch: string };
    }>(
      "sessions.create",
      { key, agentId: "main", worktree: true },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );
    expect(created.ok).toBe(true);
    worktreeId = created.payload?.worktree.id;
    expect(createSpy).toHaveBeenCalledTimes(1);
  } finally {
    createSpy.mockRestore();
    if (worktreeId) {
      await managedWorktrees.remove({ id: worktreeId, reason: "test-cleanup", force: true });
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await openClawState.cleanup();
  }
});

test("sessions.create rolls back failed provisioning before a same-key creator proceeds", async () => {
  const openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-session-worktree-rollback-",
  });
  const workspace = await initializeGitWorkspace(openClawState.root);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  testState.sessionConfig = { sharing: { drafts: false } };
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard:worktree-rollback";
  const adminClient = { connect: { scopes: ["operator.admin"] } } as never;
  const originalRemove = managedWorktrees.remove.bind(managedWorktrees);
  let failedWorktreeId: string | undefined;
  let successorWorktreeId: string | undefined;
  let releaseRollback = () => {};
  const rollbackGate = new Promise<void>((resolve) => {
    releaseRollback = resolve;
  });
  let markRollbackStarted = () => {};
  const rollbackStarted = new Promise<void>((resolve) => {
    markRollbackStarted = resolve;
  });
  const removeSpy = vi.spyOn(managedWorktrees, "remove").mockImplementation(async (params) => {
    if (params.reason === "session-create-failed") {
      failedWorktreeId = params.id;
      markRollbackStarted();
      expect(isSessionLifecycleMutationActive(storePath, [key])).toBe(true);
      await rollbackGate;
    }
    return await originalRemove(params);
  });
  try {
    const failedPromise = directSessionReq(
      "sessions.create",
      {
        key,
        agentId: "main",
        visibility: "draft",
        worktree: true,
      },
      { client: adminClient },
    );
    await rollbackStarted;
    let successorSettled = false;
    const successorPromise = directSessionReq<{
      entry: { worktree?: { id: string; branch: string; repoRoot: string } };
      worktree: { id: string; path: string; branch: string };
    }>("sessions.create", { key, agentId: "main", worktree: true }, { client: adminClient }).then(
      (result) => {
        successorSettled = true;
        return result;
      },
    );
    await Promise.resolve();
    expect(successorSettled).toBe(false);

    releaseRollback();
    const [failed, successor] = await Promise.all([failedPromise, successorPromise]);
    expect(failed).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "session visibility is disabled: draft",
        details: { code: "SESSION_VISIBILITY_DISABLED", visibility: "draft" },
      },
    });
    expect(failedWorktreeId).toBeTruthy();
    expect(getRegistryWorktree(process.env, failedWorktreeId!)).toMatchObject({
      removedAt: expect.any(Number),
    });
    expect(successor.ok).toBe(true);
    const successorWorktree = successor.payload!.worktree;
    successorWorktreeId = successorWorktree.id;
    expect(successorWorktree.id).not.toBe(failedWorktreeId);
    await expect(fs.access(successorWorktree.path)).resolves.toBeUndefined();
    expect(loadSessionEntry({ sessionKey: key, storePath })?.worktree).toEqual({
      id: successorWorktree.id,
      branch: successorWorktree.branch,
      repoRoot: workspace,
    });

    const adoptedFailure = await directSessionReq(
      "sessions.create",
      { key, agentId: "main", visibility: "draft", worktree: true },
      { client: adminClient },
    );
    expect(adoptedFailure).toMatchObject({
      ok: false,
      error: { message: "sessions.create visibility requires a new session" },
    });
    expect(
      removeSpy.mock.calls.some(
        ([params]) =>
          params.reason === "session-create-failed" && params.id === successorWorktree.id,
      ),
    ).toBe(false);
    expect(getRegistryWorktree(process.env, successorWorktree.id)?.removedAt).toBeUndefined();
  } finally {
    releaseRollback();
    removeSpy.mockRestore();
    if (
      successorWorktreeId &&
      getRegistryWorktree(process.env, successorWorktreeId)?.removedAt === undefined
    ) {
      await managedWorktrees.remove({
        id: successorWorktreeId,
        reason: "test-cleanup",
        force: true,
      });
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    testState.sessionConfig = undefined;
    await openClawState.cleanup();
  }
});

test("sessions.create provisions and reuses a session worktree for later runs", async () => {
  const openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-session-worktree-",
  });
  const root = openClawState.root;
  const workspace = await initializeGitWorkspace(root);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  let worktreeId: string | undefined;
  try {
    const created = await directSessionReq<{
      key: string;
      entry: { spawnedCwd?: string };
      worktree: { id: string; path: string; branch: string };
    }>(
      "sessions.create",
      { agentId: "main", label: "Release planning", worktree: true },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );

    expect(created.ok).toBe(true);
    const key = requireNonEmptyString(created.payload?.key, "created session key");
    const worktree = created.payload?.worktree;
    expect(worktree?.branch).toBe("openclaw/release-planning");
    expect(created.payload?.entry.spawnedCwd).toBe(worktree?.path);
    worktreeId = worktree?.id;
    expect(findLiveRegistryWorktreeByOwner(process.env, "session", key)).toMatchObject({
      id: worktree?.id,
      path: worktree?.path,
      ownerKind: "session",
      ownerId: key,
    });

    const recreated = await directSessionReq<{
      entry: { spawnedCwd?: string };
      worktree: { id: string; path: string; branch: string };
    }>(
      "sessions.create",
      { key, agentId: "main", worktree: true },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );
    expect(recreated.ok).toBe(true);
    expect(recreated.payload?.worktree).toEqual(worktree);
    expect(recreated.payload?.entry.spawnedCwd).toBe(worktree?.path);
    expect(
      listRegistryWorktrees(process.env).filter(
        (record) =>
          record.ownerKind === "session" &&
          record.ownerId === key &&
          record.removedAt === undefined,
      ),
    ).toHaveLength(1);

    agentCommandMock.mockClear();
    const { ws } = await openClient();
    const run = await rpcReq(ws, "agent", {
      message: "verify worktree cwd",
      sessionKey: key,
      idempotencyKey: "session-worktree-cwd",
    });
    expect(run.ok, JSON.stringify(run)).toBe(true);
    await waitForFast(() => expect(agentCommandMock).toHaveBeenCalled());
    expect(agentCommandMock.mock.calls.at(-1)?.[0]).toMatchObject({
      cwd: worktree?.path,
      workspaceDir: worktree?.path,
    });
    ws.close();
  } finally {
    if (worktreeId) {
      await managedWorktrees.remove({ id: worktreeId, reason: "test-cleanup", force: true });
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await openClawState.cleanup();
  }
});

test("sessions.create preserves a committed worktree when initial-turn setup fails", async () => {
  const openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-session-worktree-post-commit-failure-",
  });
  const workspace = await initializeGitWorkspace(openClawState.root);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard:post-commit-worktree";
  let worktreeId: string | undefined;
  sessionTranscriptReaderMocks.readCount.mockRejectedValueOnce(
    new Error("synthetic post-commit initial-turn failure"),
  );
  try {
    await expect(
      directSessionReq(
        "sessions.create",
        {
          agentId: "main",
          key,
          message: "start the committed session",
          worktree: true,
          worktreeName: "post-commit-worktree",
        },
        { client: { connect: { scopes: ["operator.admin"] } } as never },
      ),
    ).rejects.toThrow("synthetic post-commit initial-turn failure");

    expect(loadSessionEntry({ sessionKey: key, storePath })).toMatchObject({
      sessionId: expect.any(String),
      worktree: { id: expect.any(String), branch: "openclaw/post-commit-worktree" },
    });
    const owned = findLiveRegistryWorktreeByOwner(process.env, "session", key);
    expect(owned).toBeDefined();
    await expect(
      fs.stat(requireNonEmptyString(owned?.path, "committed worktree path")),
    ).resolves.toBeDefined();
    worktreeId = owned?.id;
  } finally {
    if (worktreeId) {
      await managedWorktrees.remove({ id: worktreeId, reason: "test-cleanup", force: true });
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await openClawState.cleanup();
  }
});

test("sessions.create derives its managed-worktree title from message and pasted text", async () => {
  const openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-session-worktree-title-",
  });
  const workspace = await initializeGitWorkspace(openClawState.root);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  const { ws } = await openClient({ scopes: ["operator.admin"] });
  let worktreeId: string | undefined;
  const pastedText = `Pasted deployment plan ${"x".repeat(2_000)}`;
  const message = "Review this rollout [[reply_to_current]]";
  const attachment = {
    type: "file",
    mimeType: "text/plain",
    content: Buffer.from(pastedText).toString("base64"),
  };
  dashboardTitleMocks.generate.mockResolvedValueOnce("Attachment Repair");
  try {
    const created = await rpcReq<{
      worktree: { id: string; branch: string };
    }>(ws, "sessions.create", {
      agentId: "main",
      worktree: true,
      message,
      attachments: [attachment],
    });

    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    worktreeId = created.payload?.worktree.id;
    expect(created.payload?.worktree.branch).toBe("openclaw/attachment-repair");
    expect(dashboardTitleMocks.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        userMessage: message,
        attachments: [attachment],
      }),
    );
  } finally {
    if (worktreeId) {
      await managedWorktrees.remove({ id: worktreeId, reason: "test-cleanup", force: true });
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    ws.close();
    await openClawState.cleanup();
  }
});

test("sessions.create honors worktree name/base ref and persists worktree info", async () => {
  const openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-session-worktree-target-",
  });
  const root = openClawState.root;
  const workspace = await initializeGitWorkspace(root);
  await execFileAsync("git", ["-C", workspace, "checkout", "-b", "base-branch"]);
  await fs.writeFile(path.join(workspace, "base.txt"), "base\n");
  await execFileAsync("git", ["-C", workspace, "add", "base.txt"]);
  await execFileAsync("git", [
    "-c",
    "user.name=OpenClaw Test",
    "-c",
    "user.email=openclaw-test@example.invalid",
    "-C",
    workspace,
    "commit",
    "-m",
    "base branch commit",
  ]);
  const { stdout: baseCommitRaw } = await execFileAsync("git", [
    "-C",
    workspace,
    "rev-parse",
    "HEAD",
  ]);
  await execFileAsync("git", ["-C", workspace, "checkout", "main"]);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  let worktreeId: string | undefined;
  try {
    const created = await directSessionReq<{
      key: string;
      entry: { spawnedCwd?: string; worktree?: { id: string; branch: string; repoRoot: string } };
      worktree: { id: string; path: string; branch: string };
    }>(
      "sessions.create",
      {
        agentId: "main",
        worktree: true,
        worktreeName: "target-task",
        worktreeBaseRef: "base-branch",
      },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );

    expect(created.ok).toBe(true);
    const worktree = created.payload?.worktree;
    worktreeId = worktree?.id;
    expect(worktree?.branch).toBe("openclaw/target-task");
    const { stdout: worktreeCommitRaw } = await execFileAsync("git", [
      "-C",
      requireNonEmptyString(worktree?.path, "worktree path"),
      "rev-parse",
      "HEAD",
    ]);
    expect(worktreeCommitRaw.trim()).toBe(baseCommitRaw.trim());
    expect(created.payload?.entry.worktree).toEqual({
      id: worktree?.id,
      branch: "openclaw/target-task",
      repoRoot: workspace,
    });

    const rejected = await directSessionReq(
      "sessions.create",
      { agentId: "main", worktreeName: "no-flag" },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );
    expect(rejected.ok).toBe(false);
  } finally {
    if (worktreeId) {
      await managedWorktrees.remove({ id: worktreeId, reason: "test-cleanup", force: true });
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await openClawState.cleanup();
  }
});

test("sessions.create execNode binds session exec routing", async () => {
  await createSessionStoreDir();
  const created = await directSessionReq<{
    key: string;
    entry: { execHost?: string; execNode?: string };
  }>(
    "sessions.create",
    { agentId: "main", execNode: "macbook" },
    { client: { connect: { scopes: ["operator.admin"] } } as never },
  );
  expect(created.ok).toBe(true);
  expect(created.payload?.entry.execHost).toBe("node");
  expect(created.payload?.entry.execNode).toBe("macbook");
});

test("sessions.create accepts a node-host cwd without provisioning a Gateway worktree", async () => {
  await createSessionStoreDir();
  const created = await directSessionReq<{
    entry: { execHost?: string; execNode?: string; execCwd?: string; spawnedCwd?: string };
  }>(
    "sessions.create",
    { agentId: "main", execNode: "macbook", cwd: "/Users/peter/Projects/openclaw" },
    { client: { connect: { scopes: ["operator.admin"] } } as never },
  );

  expect(created.ok).toBe(true);
  expect(created.payload?.entry).toMatchObject({
    execHost: "node",
    execNode: "macbook",
    execCwd: "/Users/peter/Projects/openclaw",
  });
  expect(created.payload?.entry.spawnedCwd).toBeUndefined();
});

test("sessions.create accepts a Windows node-host cwd from a non-Windows Gateway", async () => {
  await createSessionStoreDir();
  const created = await directSessionReq<{
    entry: { execNode?: string; execCwd?: string; spawnedCwd?: string };
  }>(
    "sessions.create",
    { agentId: "main", execNode: "windows-box", cwd: "C:\\Users\\peter\\Projects" },
    { client: { connect: { scopes: ["operator.admin"] } } as never },
  );

  expect(created.ok).toBe(true);
  expect(created.payload?.entry).toMatchObject({
    execNode: "windows-box",
    execCwd: "C:\\Users\\peter\\Projects",
  });
  expect(created.payload?.entry.spawnedCwd).toBeUndefined();
});

test("sessions.create reset-in-place clears a prior node binding for Gateway execution", async () => {
  testState.sessionConfig = { dmScope: "main" };
  await createSessionStoreDir();
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-node-parent") } });

  const nodeSession = await directSessionReq<{
    entry: { execHost?: string; execNode?: string; execCwd?: string; spawnedCwd?: string };
  }>(
    "sessions.create",
    {
      agentId: "main",
      parentSessionKey: "main",
      emitCommandHooks: true,
      execNode: "macbook",
      cwd: "/Users/peter/Projects/openclaw",
    },
    { client: { connect: { scopes: ["operator.admin"] } } as never },
  );
  expect(nodeSession.ok).toBe(true);
  expect(nodeSession.payload?.entry).toMatchObject({
    execHost: "node",
    execNode: "macbook",
    execCwd: "/Users/peter/Projects/openclaw",
  });
  expect(nodeSession.payload?.entry.spawnedCwd).toBeUndefined();

  const gatewaySession = await directSessionReq<{
    entry: { execHost?: string; execNode?: string; execCwd?: string };
  }>(
    "sessions.create",
    { agentId: "main", parentSessionKey: "main", emitCommandHooks: true },
    { client: { connect: { scopes: ["operator.write"] } } as never },
  );
  expect(gatewaySession.ok).toBe(true);
  expect(gatewaySession.payload?.entry.execHost).toBeUndefined();
  expect(gatewaySession.payload?.entry.execNode).toBeUndefined();
  expect(gatewaySession.payload?.entry.execCwd).toBeUndefined();
});

test("sessions.create does not apply create-time visibility to an in-place reset", async () => {
  testState.sessionConfig = { dmScope: "main" };
  await createSessionStoreDir();
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-existing-main") } });

  const reset = await directSessionReq("sessions.create", {
    agentId: "main",
    parentSessionKey: "main",
    emitCommandHooks: true,
    visibility: "draft",
  });

  expect(reset).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: "sessions.create visibility requires a new session",
    },
  });
});

test("sessions.create rejects a Gateway worktree targeting a node", async () => {
  await createSessionStoreDir();
  const created = await directSessionReq(
    "sessions.create",
    { agentId: "main", execNode: "macbook", worktree: true },
    { client: { connect: { scopes: ["operator.admin"] } } as never },
  );

  expect(created).toMatchObject({
    ok: false,
    error: { message: "sessions.create worktree cannot target execNode" },
  });
});

test("sessions.create provisions a worktree from an admin-selected cwd", async () => {
  const openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-configured-workspace-",
  });
  const configuredRoot = openClawState.root;
  const selectedRoot = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "openclaw-selected-workspace-"),
  );
  const configuredWorkspace = await initializeGitWorkspace(configuredRoot);
  const selectedWorkspace = await initializeGitWorkspace(selectedRoot);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace: configuredWorkspace };
  await createSessionStoreDir();
  let worktreeId: string | undefined;
  try {
    const created = await directSessionReq<{
      key: string;
      entry: { spawnedCwd?: string };
      worktree: { id: string; path: string };
    }>(
      "sessions.create",
      { agentId: "main", worktree: true, cwd: selectedWorkspace },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );

    expect(created.ok).toBe(true);
    const worktree = created.payload?.worktree;
    worktreeId = worktree?.id;
    expect(created.payload?.entry.spawnedCwd).toBe(worktree?.path);
    expect(
      findLiveRegistryWorktreeByOwner(process.env, "session", created.payload?.key ?? ""),
    ).toMatchObject({
      id: worktree?.id,
      repoRoot: selectedWorkspace,
    });

    const mismatched = await directSessionReq(
      "sessions.create",
      {
        key: created.payload?.key,
        agentId: "main",
        worktree: true,
        cwd: configuredWorkspace,
      },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );
    expect(mismatched).toMatchObject({
      ok: false,
      error: { message: "session worktree belongs to a different repository" },
    });
  } finally {
    if (worktreeId) {
      await managedWorktrees.remove({ id: worktreeId, reason: "test-cleanup", force: true });
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await openClawState.cleanup();
    await fs.rm(selectedRoot, { recursive: true, force: true });
  }
});

test("sessions.create persists a Gateway cwd without a managed worktree", async () => {
  const created = await directSessionReq(
    "sessions.create",
    { cwd: "/tmp/repo" },
    { client: { connect: { scopes: ["operator.admin"] } } as never },
  );

  expect(created.ok).toBe(true);
  expect((created.payload as { entry?: { spawnedCwd?: string } })?.entry?.spawnedCwd).toBe(
    "/tmp/repo",
  );
});

test("sessions.create allows a write-scoped cwd inside the configured workspace", async () => {
  const workspace = tempDirs.make("openclaw-session-cwd-workspace-");
  const cwd = path.join(workspace, "packages", "app");
  await fs.mkdir(cwd, { recursive: true });
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  const { ws } = await openClient({
    scopes: ["operator.write"],
    deviceIdentityPath: path.join(workspace, "write-cwd-device.json"),
  });
  try {
    const created = await rpcReq<{ entry?: { spawnedCwd?: string } }>(ws, "sessions.create", {
      cwd,
    });

    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(created.payload?.entry?.spawnedCwd).toBe(cwd);
  } finally {
    ws.close();
    testState.agentConfig = undefined;
  }
});

test("sessions.create rejects a write-scoped cwd outside configured workspaces", async () => {
  const workspace = tempDirs.make("openclaw-session-cwd-workspace-");
  const outside = tempDirs.make("openclaw-session-cwd-outside-");
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  const { ws } = await openClient({
    scopes: ["operator.write"],
    deviceIdentityPath: path.join(workspace, "outside-cwd-device.json"),
  });
  try {
    const created = await rpcReq(ws, "sessions.create", { cwd: outside });

    expect(created).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", message: "missing scope: operator.admin" },
    });
  } finally {
    ws.close();
    testState.agentConfig = undefined;
  }
});

test("sessions.create uses a non-git Gateway cwd directly but not as a worktree source", async () => {
  const cwd = await makeNonGitTempDir("openclaw-session-direct-cwd-");
  const client = { client: { connect: { scopes: ["operator.admin"] } } as never };
  const direct = await directSessionReq("sessions.create", { cwd }, client);
  expect(direct.ok).toBe(true);
  expect((direct.payload as { entry?: { spawnedCwd?: string } })?.entry?.spawnedCwd).toBe(cwd);

  const isolated = await directSessionReq("sessions.create", { cwd, worktree: true }, client);
  expect(isolated.ok).toBe(false);
  expect(isolated.error).toMatchObject({
    code: "INVALID_REQUEST",
    message: "agent workspace is not a git checkout",
  });
});

test("sessions.create keeps its cwd contract absolute-only", async () => {
  const created = await directSessionReq("sessions.create", { cwd: "~/repo" });

  expect(created.ok).toBe(false);
  expect(created.error).toMatchObject({
    code: "INVALID_REQUEST",
    message: "sessions.create cwd must be absolute",
  });
});

test("sessions.create rejects cwd outside a sandboxed agent workspace", async () => {
  testState.agentConfig = { workspace: "/tmp/safe-workspace", sandbox: { mode: "all" } };
  try {
    const created = await directSessionReq(
      "sessions.create",
      { cwd: "/tmp/outside" },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );

    expect(created.ok).toBe(false);
    expect(created.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "sessions.create cwd is outside the sandboxed agent workspace",
    });
  } finally {
    testState.agentConfig = undefined;
  }
});

test("sessions.create allows cwd within a sandboxed agent workspace", async () => {
  testState.agentConfig = { workspace: "/tmp/safe-workspace", sandbox: { mode: "all" } };
  try {
    const cwd = "/tmp/safe-workspace/packages/app";
    const created = await directSessionReq(
      "sessions.create",
      { cwd },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );

    expect(created.ok).toBe(true);
    expect((created.payload as { entry?: { spawnedCwd?: string } })?.entry?.spawnedCwd).toBe(cwd);
  } finally {
    testState.agentConfig = undefined;
  }
});

test("sessions.create skips the worktree setup script for non-admin callers", async () => {
  const openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-worktree-setup-scope-",
  });
  const root = openClawState.root;
  const workspace = await initializeGitWorkspace(root);
  await fs.mkdir(path.join(workspace, ".openclaw"), { recursive: true });
  const setupScript = path.join(workspace, ".openclaw", "worktree-setup.sh");
  await fs.writeFile(setupScript, "#!/bin/sh\ntouch setup-marker.txt\n");
  await fs.chmod(setupScript, 0o755);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  let worktreeId: string | undefined;
  try {
    const created = await directSessionReq<{
      key: string;
      worktree: { id: string; path: string; branch: string };
    }>(
      "sessions.create",
      { agentId: "main", worktree: true },
      { client: { connect: { scopes: ["operator.write"] } } as never },
    );
    expect(created.ok).toBe(true);
    const worktree = requireNonEmptyString(created.payload?.worktree.path, "worktree path");
    worktreeId = created.payload?.worktree.id;
    // Write-scoped callers get provisioning but never repo-script execution.
    await expect(fs.stat(path.join(worktree, "setup-marker.txt"))).rejects.toThrow();
  } finally {
    if (worktreeId) {
      await managedWorktrees.remove({ id: worktreeId, reason: "test-cleanup", force: true });
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await openClawState.cleanup();
  }
});

test("sessions.create preserves a linked-worktree subdirectory", async () => {
  const openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-subdir-session-worktree-",
  });
  const root = openClawState.root;
  const repoRoot = await initializeGitWorkspace(root);
  const linkedRoot = path.join(root, "linked");
  await execFileAsync("git", ["-C", repoRoot, "worktree", "add", "-b", "linked", linkedRoot]);
  const workspace = path.join(linkedRoot, "packages", "app");
  await fs.mkdir(workspace, { recursive: true });
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  let worktreeId: string | undefined;
  try {
    const created = await directSessionReq<{
      key: string;
      entry: { spawnedCwd?: string };
      worktree: { id: string; path: string; branch: string };
    }>(
      "sessions.create",
      { agentId: "main", worktree: true },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );
    expect(created.ok).toBe(true);
    const worktree = created.payload?.worktree;
    worktreeId = worktree?.id;
    // The managed worktree anchors at the repo root even when the workspace is nested;
    // the session cwd points at the equivalent subdirectory inside the worktree.
    expect(worktree?.branch).toMatch(/^openclaw\/[a-z0-9]+(?:-[a-z0-9]+)+$/);
    expect(created.payload?.entry.spawnedCwd).toBe(
      path.join(requireNonEmptyString(worktree?.path, "worktree path"), "packages", "app"),
    );
  } finally {
    if (worktreeId) {
      await managedWorktrees.remove({ id: worktreeId, reason: "test-cleanup", force: true });
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await openClawState.cleanup();
  }
});

test("sessions.create reset-in-place persists the returned worktree cwd", async () => {
  const openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-reset-session-worktree-",
  });
  const root = openClawState.root;
  const workspace = await initializeGitWorkspace(root);
  // A remote makes the base commit reachable from `--remotes`, so leaving the worktree via a
  // plain New Chat is lossless and the reset can remove it (the real leave-worktree flow).
  const origin = path.join(root, "origin.git");
  await execFileAsync("git", ["init", "--bare", origin]);
  await execFileAsync("git", ["-C", workspace, "remote", "add", "origin", origin]);
  await execFileAsync("git", ["-C", workspace, "push", "-u", "origin", "main"]);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace, model: { primary: "openai/current-model" } };
  testState.sessionConfig = { dmScope: "main" };
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-reset-parent") } });
  let worktreeId: string | undefined;
  let releaseWorktreeRemoval = () => {};
  let restoreRemoveIfLossless = () => {};
  try {
    const created = await directSessionReq<{
      key: string;
      entry: { spawnedCwd?: string };
      resolved: { modelProvider?: string; model?: string };
      worktree: { id: string; path: string; branch: string };
    }>(
      "sessions.create",
      {
        agentId: "main",
        parentSessionKey: "main",
        emitCommandHooks: true,
        worktree: true,
      },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );

    expect(created.ok).toBe(true);
    expect(created.payload?.key).toBe("agent:main:main");
    expect(created.payload?.resolved).toEqual({
      modelProvider: "openai",
      model: "current-model",
    });
    const worktree = created.payload?.worktree;
    worktreeId = worktree?.id;
    expect(created.payload?.entry.spawnedCwd).toBe(worktree?.path);
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.spawnedCwd).toBe(
      worktree?.path,
    );

    // Pause the exact old-binding removal before destructive work. A same-key
    // worktree reset must remain fenced until that prior generation is gone.
    const originalRemoveIfLossless = managedWorktrees.removeIfLossless.bind(managedWorktrees);
    const removalGate = new Promise<void>((resolve) => {
      releaseWorktreeRemoval = resolve;
    });
    let markRemovalStarted = () => {};
    const removalStarted = new Promise<void>((resolve) => {
      markRemovalStarted = resolve;
    });
    const removeIfLosslessSpy = vi
      .spyOn(managedWorktrees, "removeIfLossless")
      .mockImplementation(async (id) => {
        if (id === worktree?.id) {
          expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
            targetSessionKey: "agent:main:main",
            reason: "session-reset",
          });
          markRemovalStarted();
          expect(isSessionLifecycleMutationActive(storePath, ["agent:main:main"])).toBe(true);
          await removalGate;
        }
        return await originalRemoveIfLossless(id);
      });
    restoreRemoveIfLossless = () => removeIfLosslessSpy.mockRestore();
    const resetPromise = directSessionReq<{
      key: string;
      entry: { spawnedCwd?: string };
      resolved: { modelProvider?: string; model?: string };
    }>(
      "sessions.create",
      { agentId: "main", parentSessionKey: "main", emitCommandHooks: true },
      { client: { connect: { scopes: ["operator.write"] } } as never },
    );
    await removalStarted;
    let successorSettled = false;
    const successorPromise = directSessionReq<{
      entry: { spawnedCwd?: string; worktree?: { id: string; branch: string; repoRoot: string } };
      worktree: { id: string; path: string; branch: string };
    }>(
      "sessions.create",
      {
        key: "agent:main:main",
        agentId: "main",
        worktree: true,
      },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    ).then((result) => {
      successorSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(successorSettled).toBe(false);
    releaseWorktreeRemoval();
    const [reset, successor] = await Promise.all([resetPromise, successorPromise]);
    restoreRemoveIfLossless();
    expect(reset.ok).toBe(true);
    expect(reset.payload?.entry.spawnedCwd).toBeUndefined();
    expect(reset.payload?.resolved).toEqual({
      modelProvider: "openai",
      model: "current-model",
    });
    expect(getRegistryWorktree(process.env, worktree!.id)?.removedAt).toEqual(expect.any(Number));
    expect(successor.ok).toBe(true);
    const successorWorktree = successor.payload!.worktree;
    expect(successorWorktree.id).not.toBe(worktree?.id);
    worktreeId = successorWorktree.id;
    await expect(fs.access(successorWorktree.path)).resolves.toBeUndefined();
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      spawnedCwd: successorWorktree.path,
      worktree: {
        id: successorWorktree.id,
        branch: successorWorktree.branch,
        repoRoot: workspace,
      },
    });
    expect(getRegistryWorktree(process.env, successorWorktree.id)?.removedAt).toBeUndefined();
  } finally {
    releaseWorktreeRemoval();
    restoreRemoveIfLossless();
    if (worktreeId && getRegistryWorktree(process.env, worktreeId)?.removedAt === undefined) {
      await managedWorktrees.remove({ id: worktreeId, reason: "test-cleanup", force: true });
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    testState.sessionConfig = undefined;
    await openClawState.cleanup();
  }
});

test("sessions.create rejects worktrees for non-git agent workspaces", async () => {
  const workspace = await makeNonGitTempDir("openclaw-session-plain-workspace-");
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  try {
    const created = await directSessionReq(
      "sessions.create",
      { agentId: "main", worktree: true },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );

    expect(created.ok).toBe(false);
    expect(created.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "agent workspace is not a git checkout",
    });
  } finally {
    testState.agentConfig = undefined;
  }
});

test("sessions.create rejects worktrees for agent workspaces without a commit", async () => {
  const workspace = await makeNonGitTempDir("openclaw-session-unborn-workspace-");
  await execFileAsync("git", ["init", workspace]);
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  try {
    const created = await directSessionReq(
      "sessions.create",
      { agentId: "main", worktree: true },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );

    expect(created.ok).toBe(false);
    expect(created.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "agent workspace is not a git checkout",
    });
  } finally {
    testState.agentConfig = undefined;
  }
});

test("sessions.create stores dashboard model, thinking, and parent linkage, and creates a transcript", async () => {
  const { storePath } = await createSessionStoreDir();
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [{ id: "gpt-test-a", name: "A", provider: "openai" }];
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-parent"),
    },
  });
  const created = await directSessionReq<{
    key?: string;
    sessionId?: string;
    entry?: {
      label?: string;
      providerOverride?: string;
      modelOverride?: string;
      thinkingLevel?: string;
      parentSessionKey?: string;
      sessionFile?: string;
    };
  }>("sessions.create", {
    agentId: "ops",
    label: "Dashboard Chat",
    model: "openai/gpt-test-a",
    thinkingLevel: "high",
    parentSessionKey: "main",
  });

  expect(created.ok).toBe(true);
  expect(created.payload?.key).toMatch(/^agent:ops:dashboard:/);
  expect(created.payload?.entry?.label).toBe("Dashboard Chat");
  expect(created.payload?.entry?.providerOverride).toBe("openai");
  expect(created.payload?.entry?.modelOverride).toBe("gpt-test-a");
  expect(created.payload?.entry?.thinkingLevel).toBe("high");
  expect(created.payload?.entry?.parentSessionKey).toBe("agent:main:main");
  expect(created.payload?.entry).not.toHaveProperty("sessionFile");
  expect(created.payload?.sessionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );

  const key = created.payload?.key as string;
  const storedEntry = loadSessionEntry({ agentId: "ops", sessionKey: key, storePath });
  expect(storedEntry?.sessionId).toBe(created.payload?.sessionId);
  expect(storedEntry?.label).toBe("Dashboard Chat");
  expect(storedEntry?.providerOverride).toBe("openai");
  expect(storedEntry?.modelOverride).toBe("gpt-test-a");
  expect(storedEntry?.thinkingLevel).toBe("high");
  expect(storedEntry?.parentSessionKey).toBe("agent:main:main");
  expect(storedEntry).not.toHaveProperty("sessionFile");

  await expect(
    loadTranscriptEvents({
      agentId: "ops",
      sessionId: requireNonEmptyString(created.payload?.sessionId, "created session id"),
      sessionKey: key,
      storePath,
    }),
  ).resolves.toEqual([
    expect.objectContaining({ id: created.payload?.sessionId, type: "session" }),
  ]);
});

test.each([undefined, "main"])(
  "sessions.create parents dashboard sessions to agent main when dmScope is %s",
  async (dmScope) => {
    await createSessionStoreDir();
    testState.sessionConfig = dmScope ? { dmScope } : undefined;

    const created = await directSessionReq<{
      key?: string;
      entry?: { parentSessionKey?: string; spawnDepth?: number };
    }>("sessions.create", { agentId: "main" });

    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(created.payload?.key).toMatch(/^agent:main:dashboard:/);
    expect(created.payload?.entry?.parentSessionKey).toBe("agent:main:main");
    // Auto-parented operator sessions must stay spawn-capable roots: without the
    // explicit depth, spawn admission derives depth 1 from parentSessionKey and
    // rejects all sessions_spawn calls at the default maxSpawnDepth of 1.
    expect(created.payload?.entry?.spawnDepth).toBe(0);
  },
);

test("sessions.create preserves an explicit parent under main dmScope", async () => {
  await createSessionStoreDir();
  testState.sessionConfig = { dmScope: "main" };
  await writeSessionStore({
    entries: {
      "agent:main:explicit-parent": sessionStoreEntry("sess-explicit-parent"),
    },
  });

  const created = await directSessionReq<{
    key?: string;
    entry?: { parentSessionKey?: string; spawnDepth?: number };
  }>("sessions.create", {
    agentId: "main",
    parentSessionKey: "agent:main:explicit-parent",
  });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.entry?.parentSessionKey).toBe("agent:main:explicit-parent");
  // Operator creations with a parent (UI forks/threads) are still roots: only a
  // declared spawnDepth marks spawn lineage.
  expect(created.payload?.entry?.spawnDepth).toBe(0);

  const reused = await directSessionReq<{
    entry?: { parentSessionKey?: string };
  }>("sessions.create", {
    agentId: "main",
    key: created.payload?.key,
  });

  expect(reused.ok, JSON.stringify(reused.error)).toBe(true);
  expect(reused.payload?.entry?.parentSessionKey).toBe("agent:main:explicit-parent");
});

test("sessions.create persists declared spawn lineage for spawn-owned creations", async () => {
  await createSessionStoreDir();
  testState.sessionConfig = { dmScope: "main" };
  await writeSessionStore({
    entries: {
      "agent:main:main": sessionStoreEntry("sess-spawn-parent"),
    },
  });

  const created = await directSessionReq<{
    entry?: { parentSessionKey?: string; spawnDepth?: number };
  }>("sessions.create", {
    agentId: "main",
    parentSessionKey: "agent:main:main",
    spawnDepth: 2,
  });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.entry?.parentSessionKey).toBe("agent:main:main");
  expect(created.payload?.entry?.spawnDepth).toBe(2);
});

test("sessions.create atomically persists trusted visible-spawn tool policy", async () => {
  const { storePath } = await createSessionStoreDir();
  const parentSessionKey = "agent:main:main";
  await writeSessionStore({
    entries: {
      [parentSessionKey]: sessionStoreEntry("sess-visible-spawn-parent"),
    },
  });

  const created = await directSessionReq<{
    key?: string;
    entry?: {
      label?: string;
      spawnedBy?: string;
      completionOwnerSessionKey?: string;
      parentSessionKey?: string;
      spawnDepth?: number;
      inheritedToolPolicyVersion?: number;
      inheritedToolAllow?: string[];
      inheritedToolDeny?: string[];
    };
  }>(
    "sessions.create",
    {
      agentId: "main",
      label: "Restricted visible child",
      parentSessionKey,
      spawnDepth: 1,
    },
    {
      client: {
        connect: { scopes: ["operator.write"] },
        internal: {
          syntheticClient: true,
          sessionCreation: {
            via: "spawn",
            actor: { type: "agent", id: parentSessionKey },
            completionOwnerSessionKey: "agent:main:discord:direct:alice",
            inheritedToolPolicy: {
              version: 1,
              allow: ["read", "sessions_spawn"],
              deny: ["exec"],
            },
          },
        },
      } as never,
    },
  );

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.key).toMatch(/^agent:main:dashboard:/);
  expect(created.payload?.entry).toMatchObject({
    label: "Restricted visible child",
    spawnedBy: parentSessionKey,
    completionOwnerSessionKey: "agent:main:discord:direct:alice",
    parentSessionKey,
    spawnDepth: 1,
    inheritedToolPolicyVersion: 1,
    inheritedToolAllow: ["read", "sessions_spawn"],
    inheritedToolDeny: ["exec"],
  });
  const key = requireNonEmptyString(created.payload?.key, "visible child key");
  expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toMatchObject({
    spawnedBy: parentSessionKey,
    completionOwnerSessionKey: "agent:main:discord:direct:alice",
    inheritedToolPolicyVersion: 1,
    inheritedToolAllow: ["read", "sessions_spawn"],
    inheritedToolDeny: ["exec"],
  });
});

test("sessions.create accepts a signed agent-runtime visible-spawn policy", async () => {
  const { storePath } = await createSessionStoreDir();
  const parentSessionKey = "agent:main:main";
  await writeSessionStore({
    entries: {
      [parentSessionKey]: sessionStoreEntry("sess-runtime-spawn-parent"),
    },
  });

  const created = await directSessionReq<{
    key?: string;
    entry?: {
      createdVia?: string;
      createdActor?: unknown;
      spawnedBy?: string;
      completionOwnerSessionKey?: string;
      inheritedToolAllow?: string[];
      inheritedToolDeny?: string[];
    };
  }>(
    "sessions.create",
    {
      agentId: "main",
      label: "Runtime visible child",
      parentSessionKey,
      spawnDepth: 1,
    },
    {
      client: {
        connect: { scopes: ["operator.write"] },
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey: parentSessionKey,
            sessionSpawnContext: {
              completionOwnerSessionKey: "agent:main:discord:direct:bob",
              inheritedToolPolicy: {
                version: 1,
                allow: ["read", "sessions_spawn"],
                deny: ["exec"],
              },
            },
          },
        },
      } as never,
    },
  );

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.key).toMatch(/^agent:main:dashboard:/);
  expect(created.payload?.entry).toMatchObject({
    createdVia: "spawn",
    createdActor: { type: "agent", id: parentSessionKey },
    spawnedBy: parentSessionKey,
    completionOwnerSessionKey: "agent:main:discord:direct:bob",
    inheritedToolAllow: ["read", "sessions_spawn"],
    inheritedToolDeny: ["exec"],
  });
  const key = requireNonEmptyString(created.payload?.key, "runtime visible child key");
  expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toMatchObject({
    spawnedBy: parentSessionKey,
    completionOwnerSessionKey: "agent:main:discord:direct:bob",
    inheritedToolPolicyVersion: 1,
  });
});

test("sessions.create commits no session after delegated authority closes", async () => {
  await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:authority-race";
  let validations = 0;

  const created = await directSessionReq(
    "sessions.create",
    { agentId: "main", key: sessionKey },
    {
      context: {
        validateAgentRuntimeApprovalAuthority: () => ++validations < 3,
      },
      client: {
        connect: { scopes: ["operator.write"] },
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey: "agent:main:main",
          },
        },
      } as never,
    },
  );

  expect(created.ok).toBe(false);
  expect(created.error?.message).toContain("agent runtime authority is no longer active");
  expect(loadCombinedSessionStoreForGateway(getRuntimeConfig()).store[sessionKey]).toBeUndefined();
});

test("sessions.create starts no initial turn when authority closes after session commit", async () => {
  await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:authority-post-commit";
  const { chatHandlers } = await import("./server-methods/chat.js");
  const chatSend = vi.spyOn(chatHandlers, "chat.send").mockImplementation(async ({ respond }) => {
    respond(true, { runId: "must-not-start", status: "started" });
  });
  let validations = 0;

  try {
    const created = await directSessionReq<{ runStarted?: boolean }>(
      "sessions.create",
      { agentId: "main", key: sessionKey, message: "do not launch after closure" },
      {
        context: {
          // Four validations cover handler admission and both SQLite commit boundaries.
          // The fifth is the post-commit follow-on-work fence.
          validateAgentRuntimeApprovalAuthority: () => ++validations < 5,
        },
        client: {
          connect: { scopes: ["operator.write"] },
          internal: {
            agentRuntimeIdentity: {
              kind: "agentRuntime",
              agentId: "main",
              sessionKey: "agent:main:main",
            },
          },
        } as never,
      },
    );

    expect(created.ok).toBe(true);
    expect(created.payload?.runStarted).toBe(false);
    expect(chatSend).not.toHaveBeenCalled();
    expect(loadCombinedSessionStoreForGateway(getRuntimeConfig()).store[sessionKey]).toBeDefined();
  } finally {
    chatSend.mockRestore();
  }
});

test("sessions.create removes a provisioned worktree when authority closes before session commit", async () => {
  const openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-session-authority-worktree-",
  });
  const workspace = await initializeGitWorkspace(openClawState.root);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  let validations = 0;

  try {
    const created = await directSessionReq(
      "sessions.create",
      {
        agentId: "main",
        worktree: true,
        worktreeName: "authority-cleanup",
      },
      {
        context: {
          // Admission plus both worktree allocation guards succeed; session admission loses.
          validateAgentRuntimeApprovalAuthority: () => ++validations < 4,
        },
        client: {
          connect: { scopes: ["operator.admin"] },
          internal: {
            agentRuntimeIdentity: {
              kind: "agentRuntime",
              agentId: "main",
              sessionKey: "agent:main:main",
            },
          },
        } as never,
      },
    );

    expect(created.ok).toBe(false);
    expect(created.error?.message).toContain("agent runtime authority is no longer active");
    expect(
      listRegistryWorktrees(process.env).filter(
        (record) => record.ownerKind === "session" && record.removedAt === undefined,
      ),
    ).toEqual([]);
  } finally {
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await openClawState.cleanup();
  }
});

test("sessions.create rejects a trusted spawn whose parent differs from its agent caller", async () => {
  await createSessionStoreDir();

  const created = await directSessionReq(
    "sessions.create",
    {
      agentId: "main",
      parentSessionKey: "agent:main:other",
      spawnDepth: 1,
    },
    {
      client: {
        connect: { scopes: ["operator.write"] },
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey: "agent:main:main",
            sessionSpawnContext: {
              inheritedToolPolicy: { version: 1, allow: ["read"], deny: ["exec"] },
            },
          },
        },
      } as never,
    },
  );

  expect(created.ok).toBe(false);
  expect(created.error?.message).toContain("spawn parent must match the trusted agent caller");
});

test("sessions.create rejects spawnDepth without parentSessionKey", async () => {
  await createSessionStoreDir();

  const created = await directSessionReq("sessions.create", {
    agentId: "main",
    spawnDepth: 1,
  });

  expect(created.ok).toBe(false);
  expect(created.error).toMatchObject({
    message: "spawnDepth requires parentSessionKey",
  });
});

test("sessions.create leaves dashboard sessions unparented under per-channel-peer dmScope", async () => {
  await createSessionStoreDir();
  testState.sessionConfig = { dmScope: "per-channel-peer" };

  const created = await directSessionReq<{
    entry?: { parentSessionKey?: string };
  }>("sessions.create", { agentId: "main" });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.entry?.parentSessionKey).toBeUndefined();
});

test("sessions.create leaves dashboard sessions unparented under global session scope", async () => {
  await createSessionStoreDir();
  testState.sessionConfig = { dmScope: "main", scope: "global" };

  const created = await directSessionReq<{
    entry?: { parentSessionKey?: string };
  }>("sessions.create", { agentId: "main" });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.entry?.parentSessionKey).toBeUndefined();
});

test("sessions.create does not parent the main session to itself", async () => {
  await createSessionStoreDir();
  testState.sessionConfig = { dmScope: "main" };

  const created = await directSessionReq<{
    key?: string;
    entry?: { parentSessionKey?: string };
  }>("sessions.create", { agentId: "main", key: "main" });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.key).toBe("agent:main:main");
  expect(created.payload?.entry?.parentSessionKey).toBeUndefined();
});

test("sessions.create resolves a catalog target server-side and pins its runtime", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentConfig = { model: { primary: "anthropic/claude-opus-4-8" } };
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [
    { id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic" },
  ];
  const resolveCreateSession = vi.fn(() => ({
    model: "anthropic/claude-opus-4-8",
    agentRuntime: "claude-cli",
  }));
  const registry = createEmptyPluginRegistry();
  registry.sessionCatalogs.push({
    pluginId: "anthropic",
    source: "test",
    provider: {
      id: "claude",
      label: "Claude Code",
      resolveCreateSession,
      list: vi.fn(async () => []),
      read: vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] })),
    },
  });
  setActivePluginRegistry(registry);

  try {
    const created = await directSessionReq<{
      entry?: {
        providerOverride?: string;
        modelOverride?: string;
        agentRuntimeOverride?: string;
        modelSelectionLocked?: boolean;
        pluginOwnerId?: string;
      };
      key?: string;
    }>("sessions.create", { agentId: "main", catalogId: "claude" });

    expect(created.ok).toBe(true);
    expect(created.payload?.entry).toMatchObject({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-8",
      agentRuntimeOverride: "claude-cli",
      modelSelectionLocked: true,
      pluginOwnerId: "anthropic",
    });
    expect(resolveCreateSession).toHaveBeenCalledWith({ agentId: "main" });

    const patched = await directSessionReq("sessions.patch", {
      key: created.payload?.key,
      agentId: "main",
      model: "anthropic/claude-opus-4-8",
    });
    expect(patched.ok).toBe(false);
    expect(patched.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "Model selection is locked for this session.",
    });

    const deleted = await directSessionReq("sessions.delete", {
      key: created.payload?.key,
      agentId: "main",
      deleteTranscript: false,
    });
    expect(deleted.ok).toBe(true);
    expect(
      loadSessionEntry({
        agentId: "main",
        sessionKey: created.payload?.key ?? "",
        storePath,
      }),
    ).toBeUndefined();
  } finally {
    testState.agentConfig = undefined;
    setActivePluginRegistry(createEmptyPluginRegistry());
  }
});

test("sessions.create rejects a caller-supplied key for a catalog target", async () => {
  const { storePath } = await createSessionStoreDir();
  const existing = sessionStoreEntry("sess-existing-catalog-target", {
    providerOverride: "openai",
    modelOverride: "gpt-existing",
  });
  await writeSessionStore({ entries: { main: existing } });
  const registry = createEmptyPluginRegistry();
  registry.sessionCatalogs.push({
    pluginId: "anthropic",
    source: "test",
    provider: {
      id: "claude",
      label: "Claude Code",
      resolveCreateSession: () => ({
        model: "anthropic/claude-opus-4-8",
        agentRuntime: "claude-cli",
      }),
      list: vi.fn(async () => []),
      read: vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] })),
    },
  });
  setActivePluginRegistry(registry);

  try {
    const created = await directSessionReq("sessions.create", {
      key: "main",
      agentId: "main",
      catalogId: "claude",
    });

    expect(created.ok).toBe(false);
    expect(created.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "sessions.create catalogId cannot include key",
    });
    expect(
      loadSessionEntry({ agentId: "main", sessionKey: "agent:main:main", storePath }),
    ).toMatchObject({
      sessionId: existing.sessionId,
      providerOverride: "openai",
      modelOverride: "gpt-existing",
    });
  } finally {
    setActivePluginRegistry(createEmptyPluginRegistry());
  }
});

test("sessions.create authorizes a catalog target for the requested agent", async () => {
  await createSessionStoreDir();
  testState.agentsConfig = {
    list: [{ id: "main", default: true }, { id: "research" }],
  };
  const resolveCreateSession = vi.fn(({ agentId }: { agentId?: string }) =>
    agentId === "research"
      ? undefined
      : {
          model: "anthropic/claude-opus-4-8",
          agentRuntime: "claude-cli",
        },
  );
  const registry = createEmptyPluginRegistry();
  registry.sessionCatalogs.push({
    pluginId: "anthropic",
    source: "test",
    provider: {
      id: "claude",
      label: "Claude Code",
      resolveCreateSession,
      list: vi.fn(async () => []),
      read: vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] })),
    },
  });
  setActivePluginRegistry(registry);

  try {
    const created = await directSessionReq("sessions.create", {
      agentId: "research",
      catalogId: "claude",
    });

    expect(created.ok).toBe(false);
    expect(created.error).toMatchObject({
      code: "UNAVAILABLE",
      message: "session catalog claude cannot create sessions",
    });
    expect(resolveCreateSession).toHaveBeenCalledWith({ agentId: "research" });
  } finally {
    testState.agentsConfig = undefined;
    setActivePluginRegistry(createEmptyPluginRegistry());
  }
});

test("sessions.create bypasses main-session reset for a catalog target", async () => {
  await createSessionStoreDir();
  testState.agentConfig = { model: { primary: "anthropic/claude-opus-4-8" } };
  testState.sessionConfig = { dmScope: "main" };
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [
    { id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic" },
  ];
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-parent-catalog"),
    },
  });
  const registry = createEmptyPluginRegistry();
  registry.sessionCatalogs.push({
    pluginId: "anthropic",
    source: "test",
    provider: {
      id: "claude",
      label: "Claude Code",
      resolveCreateSession: () => ({
        model: "anthropic/claude-opus-4-8",
        agentRuntime: "claude-cli",
      }),
      list: vi.fn(async () => []),
      read: vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] })),
    },
  });
  setActivePluginRegistry(registry);

  try {
    const created = await directSessionReq<{
      key?: string;
      entry?: {
        parentSessionKey?: string;
        providerOverride?: string;
        modelOverride?: string;
        agentRuntimeOverride?: string;
        modelSelectionLocked?: boolean;
      };
    }>("sessions.create", {
      agentId: "main",
      catalogId: "claude",
      parentSessionKey: "main",
      emitCommandHooks: true,
    });

    expect(created.ok).toBe(true);
    expect(created.payload?.key).toMatch(/^agent:main:dashboard:/);
    expect(created.payload?.entry).toMatchObject({
      parentSessionKey: "agent:main:main",
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-8",
      agentRuntimeOverride: "claude-cli",
      modelSelectionLocked: true,
    });
  } finally {
    testState.agentConfig = undefined;
    testState.sessionConfig = undefined;
    setActivePluginRegistry(createEmptyPluginRegistry());
  }
});

test("sessions.create inherits explicit selection without runtime model identity", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-parent", {
        providerOverride: "codex",
        modelOverride: "gpt-5.5",
        modelOverrideSource: "user",
        agentRuntimeOverride: "codex",
        modelProvider: "codex",
        model: "gpt-5.5",
        contextTokens: 272000,
        inputTokens: 12000,
        outputTokens: 340,
        totalTokens: 12340,
        totalTokensFresh: false,
        contextBudgetStatus: {
          schemaVersion: 1,
          source: "pre-prompt-estimate",
          updatedAt: 1,
          provider: "codex",
          model: "gpt-5.5",
          route: "compact_then_truncate",
          shouldCompact: true,
          estimatedPromptTokens: 250000,
          contextTokenBudget: 128000,
          promptBudgetBeforeReserve: 112000,
          reserveTokens: 16000,
          effectiveReserveTokens: 16000,
          remainingPromptBudgetTokens: 0,
          overflowTokens: 138000,
          toolResultReducibleChars: 5000,
          messageCount: 12,
          unwindowedMessageCount: 12,
        },
        thinkingLevel: "off",
        fastMode: "auto",
        traceLevel: "debug",
        authProfileOverride: "codex-oauth",
        authProfileOverrideSource: "user",
      }),
    },
  });

  const created = await directSessionReq<{
    key?: string;
    resolved?: { modelProvider?: string; model?: string };
    entry?: {
      providerOverride?: string;
      modelOverride?: string;
      modelOverrideSource?: string;
      agentRuntimeOverride?: string;
      modelProvider?: string;
      model?: string;
      contextTokens?: number;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      totalTokensFresh?: boolean;
      contextBudgetStatus?: unknown;
      thinkingLevel?: string;
      fastMode?: string;
      traceLevel?: string;
      authProfileOverride?: string;
      authProfileOverrideSource?: string;
      parentSessionKey?: string;
    };
  }>("sessions.create", {
    agentId: "main",
    label: "Fresh Chat",
    parentSessionKey: "main",
  });

  expect(created.ok).toBe(true);
  expect(created.payload?.entry?.parentSessionKey).toBe("agent:main:main");
  expect(created.payload?.entry?.providerOverride).toBe("codex");
  expect(created.payload?.entry?.modelOverride).toBe("gpt-5.5");
  expect(created.payload?.entry?.modelOverrideSource).toBe("user");
  expect(created.payload?.entry?.agentRuntimeOverride).toBe("codex");
  expect(created.payload?.entry?.modelProvider).toBeUndefined();
  expect(created.payload?.entry?.model).toBeUndefined();
  expect(created.payload?.resolved).toEqual({ modelProvider: "codex", model: "gpt-5.5" });
  expect(created.payload?.entry?.contextTokens).toBeUndefined();
  expect(created.payload?.entry?.inputTokens).toBeUndefined();
  expect(created.payload?.entry?.outputTokens).toBeUndefined();
  expect(created.payload?.entry?.totalTokens).toBeUndefined();
  expect(created.payload?.entry?.totalTokensFresh).toBeUndefined();
  expect(created.payload?.entry?.contextBudgetStatus).toBeUndefined();
  expect(created.payload?.entry?.thinkingLevel).toBe("off");
  expect(created.payload?.entry?.fastMode).toBe("auto");
  expect(created.payload?.entry?.traceLevel).toBe("debug");
  expect(created.payload?.entry?.authProfileOverride).toBe("codex-oauth");
  expect(created.payload?.entry?.authProfileOverrideSource).toBe("user");

  const key = created.payload?.key as string;
  const storedEntry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
  expect(storedEntry?.providerOverride).toBe("codex");
  expect(storedEntry?.modelOverride).toBe("gpt-5.5");
  expect(storedEntry?.modelProvider).toBeUndefined();
  expect(storedEntry?.model).toBeUndefined();
  expect(storedEntry?.parentSessionKey).toBe("agent:main:main");
});

test("sessions.create resolves the current default instead of inherited runtime identity", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentConfig = { model: { primary: "anthropic/current-model" } };
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-parent-stale", {
        modelProvider: "openai",
        model: "stale-model",
      }),
    },
  });

  const created = await directSessionReq<{
    key?: string;
    resolved?: { modelProvider?: string; model?: string };
    entry?: { modelProvider?: string; model?: string };
  }>("sessions.create", {
    agentId: "main",
    parentSessionKey: "main",
  });

  expect(created.ok).toBe(true);
  expect(created.payload?.entry?.modelProvider).toBeUndefined();
  expect(created.payload?.entry?.model).toBeUndefined();
  expect(created.payload?.resolved).toEqual({
    modelProvider: "anthropic",
    model: "current-model",
  });

  const key = created.payload?.key as string;
  const storedEntry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
  expect(storedEntry?.modelProvider).toBeUndefined();
  expect(storedEntry?.model).toBeUndefined();
});

test("sessions.create accepts an explicit key for persistent dashboard sessions", async () => {
  await createSessionStoreDir();

  const key = "agent:ops-agent:dashboard:direct:subagent-orchestrator";
  const created = await directSessionReq<{
    key?: string;
    sessionId?: string;
    entry?: {
      label?: string;
    };
  }>("sessions.create", {
    key,
    label: "Dashboard Orchestrator",
  });

  expect(created.ok).toBe(true);
  expect(created.payload?.key).toBe(key);
  expect(created.payload?.entry?.label).toBe("Dashboard Orchestrator");
  expect(created.payload?.sessionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});

test("sessions.create preserves write-scoped fresh keyed model selection but gates adopted rows", async () => {
  const { storePath } = await createSessionStoreDir();
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [
    { id: "gpt-test-a", name: "A", provider: "openai" },
    { id: "gpt-test-b", name: "B", provider: "openai" },
  ];
  testState.agentConfig = { subagents: { model: "openai/gpt-test-a" } };
  const writeClient = { connect: { scopes: ["operator.write"] } } as never;
  const adminClient = { connect: { scopes: ["operator.admin"] } } as never;
  const unscopedClient = { connect: {} } as never;
  const freshKey = "agent:main:dashboard:fresh-model";
  const existingKey = "agent:main:dashboard:existing-model";
  const existingProfileKey = "agent:main:dashboard:existing-profile-model";
  const existingSubagentKey = "agent:main:subagent:existing-model";
  await writeSessionStore({
    entries: {
      [existingKey]: sessionStoreEntry("sess-existing", {
        providerOverride: "openai",
        modelOverride: "gpt-test-a",
        thinkingLevel: "low",
      }),
      [existingProfileKey]: sessionStoreEntry("sess-existing-profile", {
        providerOverride: "openai",
        modelOverride: "gpt-test-a",
        authProfileOverride: "work",
        authProfileOverrideSource: "user",
      }),
      [existingSubagentKey]: sessionStoreEntry("sess-existing-subagent"),
    },
  });

  const fresh = await directSessionReq<{
    entry?: { providerOverride?: string; modelOverride?: string };
  }>("sessions.create", { key: freshKey, model: "openai/gpt-test-a" }, { client: writeClient });
  expect(fresh.ok, JSON.stringify(fresh.error)).toBe(true);
  expect(fresh.payload?.entry).toMatchObject({
    providerOverride: "openai",
    modelOverride: "gpt-test-a",
  });

  const sameSelection = await directSessionReq<{
    entry?: { providerOverride?: string; modelOverride?: string; thinkingLevel?: string };
  }>(
    "sessions.create",
    { key: existingKey, model: "openai/gpt-test-a", thinkingLevel: "low" },
    { client: writeClient },
  );
  expect(sameSelection.ok, JSON.stringify(sameSelection.error)).toBe(true);
  expect(sameSelection.payload?.entry).toMatchObject({
    providerOverride: "openai",
    modelOverride: "gpt-test-a",
    thinkingLevel: "low",
  });

  const sameSubagentSelection = await directSessionReq<{
    entry?: { providerOverride?: string; modelOverride?: string };
  }>(
    "sessions.create",
    { key: existingSubagentKey, model: "openai/gpt-test-a" },
    { client: writeClient },
  );
  expect(sameSubagentSelection.ok, JSON.stringify(sameSubagentSelection.error)).toBe(true);
  expect(sameSubagentSelection.payload?.entry).toMatchObject({
    providerOverride: "openai",
    modelOverride: "gpt-test-a",
  });

  const sameSelectionWithProfile = await directSessionReq<{
    entry?: { providerOverride?: string; modelOverride?: string; authProfileOverride?: string };
  }>(
    "sessions.create",
    { key: existingProfileKey, model: "openai/gpt-test-a" },
    { client: writeClient },
  );
  expect(sameSelectionWithProfile.ok, JSON.stringify(sameSelectionWithProfile.error)).toBe(true);
  expect(sameSelectionWithProfile.payload?.entry).toMatchObject({
    providerOverride: "openai",
    modelOverride: "gpt-test-a",
    authProfileOverride: "work",
  });

  const profileDenied = await directSessionReq(
    "sessions.create",
    { key: existingProfileKey, model: "openai/gpt-test-a@other" },
    { client: writeClient },
  );
  expect(profileDenied.ok).toBe(false);
  expect(profileDenied.error).toMatchObject({
    code: "FORBIDDEN",
    message: "missing scope: operator.admin",
  });

  const denied = await directSessionReq(
    "sessions.create",
    { key: existingKey, model: "openai/gpt-test-b" },
    { client: writeClient },
  );
  expect(denied.ok).toBe(false);
  expect(denied.error).toMatchObject({
    code: "FORBIDDEN",
    message: "missing scope: operator.admin",
  });

  const unscopedDenied = await directSessionReq(
    "sessions.create",
    { key: existingKey, model: "openai/gpt-test-b" },
    { client: unscopedClient },
  );
  expect(unscopedDenied.ok).toBe(false);
  expect(unscopedDenied.error).toMatchObject({
    code: "FORBIDDEN",
    message: "missing scope: operator.admin",
  });

  testState.agentConfig = {
    models: {
      "openai/gpt-test-b": { alias: "gpt-test-a" },
    },
  };
  const aliasDenied = await directSessionReq(
    "sessions.create",
    { key: existingKey, model: "gpt-test-a" },
    { client: writeClient },
  );
  expect(aliasDenied.ok).toBe(false);
  expect(aliasDenied.error).toMatchObject({
    code: "FORBIDDEN",
    message: "missing scope: operator.admin",
  });

  expect(loadSessionEntry({ sessionKey: existingKey, storePath })).toMatchObject({
    sessionId: "sess-existing",
    providerOverride: "openai",
    modelOverride: "gpt-test-a",
    thinkingLevel: "low",
  });
  expect(loadSessionEntry({ sessionKey: existingProfileKey, storePath })).toMatchObject({
    sessionId: "sess-existing-profile",
    providerOverride: "openai",
    modelOverride: "gpt-test-a",
    authProfileOverride: "work",
  });

  const thinkingDenied = await directSessionReq(
    "sessions.create",
    { key: existingKey, thinkingLevel: "high" },
    { client: writeClient },
  );
  expect(thinkingDenied.ok).toBe(false);
  expect(thinkingDenied.error).toMatchObject({
    code: "FORBIDDEN",
    message: "missing scope: operator.admin",
  });

  const admin = await directSessionReq<{
    entry?: { providerOverride?: string; modelOverride?: string; thinkingLevel?: string };
  }>(
    "sessions.create",
    { key: existingKey, model: "openai/gpt-test-b", thinkingLevel: "high" },
    { client: adminClient },
  );
  expect(admin.ok, JSON.stringify(admin.error)).toBe(true);
  expect(admin.payload?.entry).toMatchObject({
    providerOverride: "openai",
    modelOverride: "gpt-test-b",
    thinkingLevel: "high",
  });
});

test("sessions.create stamps trusted operator provenance and records created", async () => {
  await createSessionStoreDir();
  const profileId = "profile-session-creator";
  const created = await directSessionReq<{
    key?: string;
    entry?: {
      createdVia?: string;
      createdActor?: { type: string; id?: string };
      createdAt?: number;
    };
  }>(
    "sessions.create",
    { agentId: "main" },
    {
      client: {
        connect: { scopes: ["operator.write"] },
        authenticatedUserProfile: {
          profileId,
          displayName: "Test Operator",
          hasAvatar: false,
          updatedAt: 1,
        },
      } as never,
    },
  );

  expect(created.ok).toBe(true);
  expect(created.payload?.entry).toMatchObject({
    createdVia: "operator",
    createdActor: { type: "human", id: profileId },
    createdAt: expect.any(Number),
  });
  const key = requireNonEmptyString(created.payload?.key, "created session key");
  expect(listSessionStateEventsSince(key, "main", 0, 20).events).toContainEqual(
    expect.objectContaining({
      kind: "created",
      actorType: "human",
      actorId: profileId,
      summary: "session created",
    }),
  );

  const synthetic = await directSessionReq<{
    entry?: { createdVia?: string; createdActor?: unknown; createdAt?: number };
  }>(
    "sessions.create",
    { agentId: "main" },
    {
      client: {
        connect: { scopes: ["operator.write"] },
        internal: { syntheticClient: true },
      } as never,
    },
  );
  expect(synthetic.payload?.entry).toMatchObject({
    createdVia: "operator",
    createdAt: expect.any(Number),
  });
  expect(synthetic.payload?.entry?.createdActor).toBeUndefined();

  const hinted = await directSessionReq<{
    entry?: { createdVia?: string; createdActor?: unknown };
  }>(
    "sessions.create",
    { agentId: "main" },
    {
      client: {
        connect: { scopes: ["operator.write"] },
        internal: {
          syntheticClient: true,
          sessionCreation: {
            via: "spawn",
            actor: { type: "agent", id: "agent:main:main" },
          },
        },
      } as never,
    },
  );
  expect(hinted.payload?.entry).toMatchObject({
    createdVia: "spawn",
    createdActor: { type: "agent", id: "agent:main:main" },
  });
});

test("sessions.create reset-in-place preserves the node creation stamp", async () => {
  testState.sessionConfig = { dmScope: "main" };
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("existing-main", {
        createdVia: "channel",
        createdActor: { type: "human", id: "telegram:42" },
        createdAt: 1234,
      }),
    },
  });

  const reset = await directSessionReq<{ entry?: Record<string, unknown> }>(
    "sessions.create",
    { agentId: "main", parentSessionKey: "main", emitCommandHooks: true },
    {
      client: {
        connect: { scopes: ["operator.write"] },
        authenticatedUserProfile: {
          profileId: "profile-resetter",
          displayName: null,
          hasAvatar: false,
          updatedAt: 1,
        },
      } as never,
    },
  );

  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry).toMatchObject({
    createdVia: "channel",
    createdActor: { type: "human", id: "telegram:42" },
    createdAt: 1234,
  });
  expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
    createdVia: "channel",
    createdActor: { type: "human", id: "telegram:42" },
    createdAt: 1234,
  });
});

test("sessions.create adopting an existing key does not restamp node provenance", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      "agent:main:dashboard:adopted": sessionStoreEntry("existing-adopted", {
        createdVia: "spawn",
        createdActor: { type: "agent", id: "agent:main:main" },
        createdAt: 4321,
      }),
    },
  });
  const { chatHandlers } = await import("./server-methods/chat.js");
  const chatSend = vi.spyOn(chatHandlers, "chat.send").mockImplementation(async ({ respond }) => {
    respond(true, { runId: "adopted-run", status: "started" });
  });

  try {
    const adopted = await directSessionReq<{
      entry?: Record<string, unknown>;
      runStarted?: boolean;
    }>(
      "sessions.create",
      { key: "agent:main:dashboard:adopted", agentId: "main", message: "adopted follow-up" },
      {
        client: {
          connect: { scopes: ["operator.write"] },
          authenticatedUserProfile: {
            profileId: "profile-adopter",
            displayName: null,
            hasAvatar: false,
            updatedAt: 1,
          },
        } as never,
      },
    );

    expect(adopted.ok).toBe(true);
    // Post-create work (the nested initial chat.send) still runs on adoption.
    expect(adopted.payload?.runStarted).toBe(true);
    expect(chatSend).toHaveBeenCalledTimes(1);
    expect(
      loadSessionEntry({ sessionKey: "agent:main:dashboard:adopted", storePath }),
    ).toMatchObject({
      createdVia: "spawn",
      createdActor: { type: "agent", id: "agent:main:main" },
      createdAt: 4321,
    });
    // Adoption is not a node creation: no `created` event may enter the journal.
    expect(
      listSessionStateEventsSince("agent:main:dashboard:adopted", "main", 0, 20).events.filter(
        (event) => event.kind === "created",
      ),
    ).toEqual([]);
  } finally {
    chatSend.mockRestore();
  }
});

test("sessions.create scopes the main alias to the requested agent", async () => {
  const { storePath } = await createSessionStoreDir();

  const created = await directSessionReq<{
    key?: string;
    sessionId?: string;
    entry?: {
      sessionFile?: string;
    };
  }>("sessions.create", {
    key: "main",
    agentId: "longmemeval",
  });

  expect(created.ok).toBe(true);
  expect(created.payload?.key).toBe("agent:longmemeval:main");
  expect(created.payload?.entry).not.toHaveProperty("sessionFile");

  expect(
    loadSessionEntry({
      agentId: "longmemeval",
      sessionKey: "agent:longmemeval:main",
      storePath,
    })?.sessionId,
  ).toBe(created.payload?.sessionId);
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: "agent:main:main", storePath }),
  ).toBeUndefined();
});

test("sessions.create replaces a dead main entry with a fresh session id", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "ops", default: true }] };
  try {
    await writeSessionStore({
      agentId: "ops",
      entries: {
        main: {
          updatedAt: 1,
          label: "Ops Main",
          sessionFile: "stale.jsonl",
        },
      },
    });

    const created = await directSessionReq<{
      key?: string;
      sessionId?: string;
      entry?: {
        label?: string;
        sessionFile?: string;
      };
    }>("sessions.create", {
      key: "main",
      agentId: "ops",
    });

    expect(created.ok).toBe(true);
    expect(created.payload?.key).toBe("agent:ops:main");
    expect(created.payload?.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(created.payload?.entry?.label).toBeUndefined();
    expect(created.payload?.entry?.sessionFile).not.toBe("stale.jsonl");

    const storedEntry = loadSessionEntry({
      agentId: "ops",
      sessionKey: "agent:ops:main",
      storePath,
    });
    expect(storedEntry?.sessionId).toBe(created.payload?.sessionId);
    expect(storedEntry?.sessionFile).not.toBe("stale.jsonl");
  } finally {
    testState.agentsConfig = undefined;
  }
});

test("sessions.create preserves global and unknown sentinel keys", async () => {
  const { storePath } = await createSessionStoreDir();

  const globalCreated = await directSessionReq<{
    key?: string;
    sessionId?: string;
    entry?: {
      sessionFile?: string;
    };
  }>("sessions.create", {
    key: "global",
    agentId: "longmemeval",
  });

  expect(globalCreated.ok).toBe(true);
  expect(globalCreated.payload?.key).toBe("global");
  expect(globalCreated.payload?.entry).not.toHaveProperty("sessionFile");

  const unknownCreated = await directSessionReq<{
    key?: string;
    sessionId?: string;
    entry?: {
      sessionFile?: string;
    };
  }>("sessions.create", {
    key: "unknown",
    agentId: "longmemeval",
  });

  expect(unknownCreated.ok).toBe(true);
  expect(unknownCreated.payload?.key).toBe("unknown");
  expect(unknownCreated.payload?.entry).not.toHaveProperty("sessionFile");

  expect(
    loadSessionEntry({ agentId: "longmemeval", sessionKey: "global", storePath })?.sessionId,
  ).toBe(globalCreated.payload?.sessionId);
  expect(
    loadSessionEntry({ agentId: "longmemeval", sessionKey: "unknown", storePath })?.sessionId,
  ).toBe(unknownCreated.payload?.sessionId);
  expect(
    loadSessionEntry({
      agentId: "longmemeval",
      sessionKey: "agent:longmemeval:global",
      storePath,
    }),
  ).toBeUndefined();
  expect(
    loadSessionEntry({
      agentId: "longmemeval",
      sessionKey: "agent:longmemeval:unknown",
      storePath,
    }),
  ).toBeUndefined();
});

test("sessions.create stores selected global sessions in the requested agent store", async () => {
  const { mainStorePath, workStorePath } = await createSelectedGlobalSessionStore();
  const broadcastToConnIds = vi.fn();

  const created = await directSessionReq<{
    key?: string;
    sessionId?: string;
    entry?: { sessionFile?: string };
  }>(
    "sessions.create",
    {
      key: "global",
      agentId: "work",
    },
    {
      context: {
        broadcastToConnIds,
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      },
    },
  );

  expect(created.ok).toBe(true);
  expect(created.payload?.key).toBe("global");
  expect(created.payload?.entry).not.toHaveProperty("sessionFile");
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: "global", storePath: mainStorePath }),
  ).toBeUndefined();
  expect(
    loadSessionEntry({ agentId: "work", sessionKey: "global", storePath: workStorePath })
      ?.sessionId,
  ).toBe(created.payload?.sessionId);
  expect(broadcastToConnIds).toHaveBeenCalledWith(
    "sessions.changed",
    expect.objectContaining({ sessionKey: "global", agentId: "work", reason: "create" }),
    new Set(["conn-1"]),
    { dropIfSlow: true, agentId: "work", sessionKeys: ["global"] },
  );
  testState.sessionStorePath = undefined;
  testState.sessionConfig = undefined;
  testState.agentsConfig = undefined;
});

test("sessions.create loads selected global parent from the requested agent store", async () => {
  const { mainStorePath, workStorePath } = await createSelectedGlobalSessionStore();
  try {
    await writeSessionStore({
      storePath: mainStorePath,
      entries: {
        global: sessionStoreEntry("sess-main-parent", {
          providerOverride: "codex",
          modelOverride: "main-model",
        }),
      },
    });
    await writeSessionStore({
      storePath: workStorePath,
      agentId: "work",
      entries: {
        global: sessionStoreEntry("sess-work-parent", {
          providerOverride: "openai",
          modelOverride: "work-model",
          thinkingLevel: "high",
        }),
      },
    });

    const created = await directSessionReq<{
      key?: string;
      entry?: {
        parentSessionKey?: string;
        providerOverride?: string;
        modelOverride?: string;
        thinkingLevel?: string;
      };
    }>("sessions.create", {
      agentId: "work",
      parentSessionKey: "global",
      emitCommandHooks: true,
    });

    expect(created.ok).toBe(true);
    expect(created.payload?.key).toMatch(/^agent:work:dashboard:/);
    expect(created.payload?.entry?.parentSessionKey).toBe("global");
    expect(created.payload?.entry?.providerOverride).toBe("openai");
    expect(created.payload?.entry?.modelOverride).toBe("work-model");
    expect(created.payload?.entry?.thinkingLevel).toBe("high");

    const commandNewEvent = (
      sessionHookMocks.triggerInternalHook.mock.calls as unknown as Array<[unknown]>
    )
      .map((call) => call[0])
      .find(
        (
          event,
        ): event is {
          context?: { sessionEntry?: { sessionId?: string } };
        } =>
          Boolean(event) &&
          typeof event === "object" &&
          (event as { type?: unknown }).type === "command" &&
          (event as { action?: unknown }).action === "new",
      );
    expect(commandNewEvent?.context?.sessionEntry?.sessionId).toBe("sess-work-parent");
    const [endEvent] = sessionLifecycleHookMocks.runSessionEnd.mock.calls[0] as unknown as [
      { sessionId?: string; sessionKey?: string },
      unknown,
    ];
    expect(endEvent.sessionId).toBe("sess-work-parent");
    expect(endEvent.sessionKey).toBe("global");
  } finally {
    testState.sessionStorePath = undefined;
    testState.sessionConfig = undefined;
    testState.agentsConfig = undefined;
  }
});

test("sessions.get reads selected global messages from the requested agent store", async () => {
  const { mainStorePath, workStorePath } = await createSelectedGlobalSessionStore();
  try {
    await writeSessionStore({
      storePath: mainStorePath,
      entries: {
        global: sessionStoreEntry("sess-main-global"),
      },
    });
    await writeSessionStore({
      storePath: workStorePath,
      agentId: "work",
      entries: {
        global: sessionStoreEntry("sess-work-global"),
      },
    });
    await seedSessionTranscript({
      agentId: "main",
      messages: [{ role: "user", content: "main global" }],
      sessionId: "sess-main-global",
      sessionKey: "global",
      storePath: mainStorePath,
    });
    await seedSessionTranscript({
      agentId: "work",
      messages: [{ role: "user", content: "work global" }],
      sessionId: "sess-work-global",
      sessionKey: "global",
      storePath: workStorePath,
    });

    const result = await directSessionReq<{ messages?: unknown[] }>("sessions.get", {
      key: "global",
      agentId: "work",
    });

    expect(result.ok).toBe(true);
    const renderedMessages = JSON.stringify(result.payload?.messages ?? []);
    expect(renderedMessages).toContain("work global");
    expect(renderedMessages).not.toContain("main global");
  } finally {
    testState.sessionStorePath = undefined;
    testState.sessionConfig = undefined;
    testState.agentsConfig = undefined;
  }
});

test("sessions.create sends selected global initial tasks to the requested agent", async () => {
  const { mainStorePath, workStorePath } = await createSelectedGlobalSessionStore();
  const { ws } = await openClient();

  const created = await rpcReq<{
    key?: string;
    runStarted?: boolean;
    runId?: string;
  }>(ws, "sessions.create", {
    key: "global",
    agentId: "work",
    task: "hello selected global",
  });

  expect(created.ok).toBe(true);
  expect(created.payload?.key).toBe("global");
  expect(created.payload?.runStarted).toBe(true);
  const runId = requireNonEmptyString(created.payload?.runId, "selected global run id");
  const wait = await rpcReq(ws, "agent.wait", { runId, timeoutMs: 1_000 });
  expect(wait.ok).toBe(true);
  const workEntry = loadSessionEntry({
    agentId: "work",
    sessionKey: "global",
    storePath: workStorePath,
  });
  const workSessionId = requireNonEmptyString(workEntry?.sessionId, "selected global session id");
  await expect(
    loadTranscriptEvents({
      agentId: "work",
      sessionId: workSessionId,
      sessionKey: "global",
      storePath: workStorePath,
    }),
  ).resolves.toContainEqual(
    expect.objectContaining({
      message: expect.objectContaining({ content: "hello selected global" }),
      type: "message",
    }),
  );
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: "global", storePath: mainStorePath }),
  ).toBeUndefined();
  testState.sessionStorePath = undefined;
  testState.sessionConfig = undefined;
  testState.agentsConfig = undefined;
  ws.close();
});

test("sessions.create gives plugin runtimes an owned root without linking operator sessions", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: { main: sessionStoreEntry("operator-owned-main") },
  });
  const pluginClient = {
    connect: { scopes: ["operator.write"] },
    internal: { pluginRuntimeOwnerId: "memory-core" },
  } as never;

  const created = await directSessionReq<{
    key: string;
    entry: { parentSessionKey?: string; pluginOwnerId?: string };
  }>("sessions.create", { agentId: "main" }, { client: pluginClient });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const key = requireNonEmptyString(created.payload?.key, "plugin-owned root session key");
  expect(created.payload?.entry).toMatchObject({ pluginOwnerId: "memory-core" });
  expect(created.payload?.entry.parentSessionKey).toBeUndefined();
  expect(loadSessionEntry({ sessionKey: key, storePath })).toMatchObject({
    pluginOwnerId: "memory-core",
  });

  const patched = await directSessionReq(
    "sessions.patch",
    { key, label: "Plugin-owned root" },
    { client: pluginClient },
  );

  expect(patched.ok, JSON.stringify(patched.error)).toBe(true);
  expect(loadSessionEntry({ sessionKey: key, storePath })).toMatchObject({
    label: "Plugin-owned root",
    pluginOwnerId: "memory-core",
  });
});

test.each([
  {
    name: "forking a foreign plugin transcript",
    params: { parentSessionKey: "agent:main:dashboard:foreign-owned", fork: true },
    action: "fork",
    target: "agent:main:dashboard:foreign-owned",
  },
  {
    name: "linking a foreign plugin parent",
    params: { parentSessionKey: "agent:main:dashboard:foreign-owned" },
    action: "link",
    target: "agent:main:dashboard:foreign-owned",
  },
  {
    name: "forking an operator-owned transcript",
    params: { parentSessionKey: "agent:main:dashboard:operator-owned", fork: true },
    action: "fork",
    target: "agent:main:dashboard:operator-owned",
  },
  {
    name: "adopting a foreign plugin session",
    params: { key: "agent:main:dashboard:foreign-owned" },
    action: "adopt",
    target: "agent:main:dashboard:foreign-owned",
  },
  {
    name: "adopting an operator-owned session",
    params: { key: "agent:main:dashboard:operator-owned" },
    action: "adopt",
    target: "agent:main:dashboard:operator-owned",
  },
])("sessions.create prevents plugin runtimes from $name", async ({ params, action, target }) => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      "agent:main:dashboard:foreign-owned": sessionStoreEntry("foreign-session", {
        pluginOwnerId: "other-plugin",
      }),
      "agent:main:dashboard:operator-owned": sessionStoreEntry("operator-session"),
    },
  });
  const pluginClient = {
    connect: { scopes: ["operator.write"] },
    internal: { pluginRuntimeOwnerId: "memory-core" },
  } as never;

  const created = await directSessionReq("sessions.create", params, { client: pluginClient });

  expect(created.ok).toBe(false);
  expect(created.error).toMatchObject({
    code: "INVALID_REQUEST",
    message: `Plugin "memory-core" cannot ${action} session "${target}" because it did not create it.`,
  });
  expect(loadSessionEntry({ sessionKey: target, storePath })).toBeDefined();
});

test("sessions.create allows plugin runtimes to link their own parent session", async () => {
  const { storePath } = await createSessionStoreDir();
  const parentSessionKey = "agent:main:dashboard:memory-core-parent";
  await writeSessionStore({
    entries: {
      [parentSessionKey]: sessionStoreEntry("memory-core-parent", {
        pluginOwnerId: "memory-core",
      }),
    },
  });
  const pluginClient = {
    connect: { scopes: ["operator.write"] },
    internal: { pluginRuntimeOwnerId: "memory-core" },
  } as never;

  const created = await directSessionReq<{
    key: string;
    entry: { parentSessionKey?: string };
  }>("sessions.create", { parentSessionKey }, { client: pluginClient });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.entry.parentSessionKey).toBe(parentSessionKey);
  expect(loadSessionEntry({ sessionKey: parentSessionKey, storePath })?.pluginOwnerId).toBe(
    "memory-core",
  );
});

test("sessions.create rejects unknown parentSessionKey", async () => {
  await createSessionStoreDir();

  const created = await directSessionReq("sessions.create", {
    agentId: "ops",
    parentSessionKey: "agent:main:missing",
  });

  expect(created.ok).toBe(false);
  expect((created.error as { message?: string } | undefined)?.message ?? "").toContain(
    "unknown parent session",
  );
});

test("sessions.create forks the parent transcript into the new session", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  testState.sessionConfig = { scope: "per-sender" };
  const parent = await createCheckpointFixture(dir);
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(parent.sessionId, {
        sessionFile: parent.sessionFile,
        totalTokens: 123,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      }),
    },
  });
  await seedSessionTranscript({
    sessionId: parent.sessionId,
    sessionKey: "agent:main:main",
    storePath,
    messages: [
      { role: "user", content: "before compaction" },
      { role: "assistant", content: [{ type: "text", text: "working on it" }] },
    ],
  });

  const created = await directSessionReq<{
    key?: string;
    sessionId?: string;
    entry?: {
      sessionFile?: string;
      parentSessionKey?: string;
      forkSource?: { sessionKey: string; sessionId: string };
      forkedFromParent?: boolean;
      totalTokens?: number;
      totalTokensFresh?: boolean;
    };
  }>("sessions.create", {
    agentId: "main",
    parentSessionKey: "main",
    fork: true,
  });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.entry?.parentSessionKey).toBe("agent:main:main");
  expect(created.payload?.entry?.forkSource).toEqual({
    sessionKey: "agent:main:main",
    sessionId: parent.sessionId,
  });
  expect(created.payload?.entry?.forkedFromParent).toBe(true);
  expect(created.payload?.entry?.totalTokens).toBeUndefined();
  expect(created.payload?.entry?.totalTokensFresh).toBe(false);
  expect(created.payload?.sessionId).not.toBe(parent.sessionId);
  expect(created.payload?.entry).not.toHaveProperty("sessionFile");
  const readMessages = async (scope: {
    sessionFile?: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  }) =>
    (await loadTranscriptEvents(scope))
      .filter((entry): entry is { type: "message"; message: unknown } => {
        return (
          entry !== null &&
          typeof entry === "object" &&
          "type" in entry &&
          entry.type === "message" &&
          "message" in entry
        );
      })
      .map((entry) => entry.message);
  const forkedSessionId = requireNonEmptyString(created.payload?.sessionId, "forked session id");
  expect(
    await readMessages({
      sessionId: forkedSessionId,
      sessionKey: created.payload?.key ?? "",
      storePath,
    }),
  ).toEqual(
    await readMessages({
      sessionId: parent.sessionId,
      sessionKey: "agent:main:main",
      storePath,
    }),
  );

  const key = requireNonEmptyString(created.payload?.key, "forked session key");
  expect(loadSessionEntry({ sessionKey: key, storePath })).toMatchObject({
    sessionId: created.payload?.sessionId,
    forkSource: {
      sessionKey: "agent:main:main",
      sessionId: parent.sessionId,
    },
  });
  expect(loadSessionEntry({ sessionKey: key, storePath })).not.toHaveProperty("forkedFromParent");
  const listed = await directSessionReq<{
    sessions?: Array<{ key: string; forkedFromParent?: boolean }>;
  }>("sessions.list", {});
  expect(listed.payload?.sessions?.find((row) => row.key === key)?.forkedFromParent).toBe(true);
  testState.sessionConfig = undefined;
});

test("public session mutations reserve agent harness-owned session keys", async () => {
  const { storePath } = await createSessionStoreDir();

  for (const key of [
    "harness:codex:supervision:native-thread",
    "agent:main:harness:codex:supervision:native-thread",
  ]) {
    for (const [method, params] of [
      ["sessions.create", { agentId: "main", key }],
      ["sessions.patch", { agentId: "main", key, label: "Public overwrite" }],
      ["sessions.reset", { agentId: "main", key }],
    ] as const) {
      const rejected = await directSessionReq(method, params);
      expect(rejected.ok).toBe(false);
      expect(rejected.error).toMatchObject({
        code: "INVALID_REQUEST",
        message: "Session key namespace is reserved for agent harness-owned sessions.",
      });
    }
  }

  const ordinary = await directSessionReq<{ key: string }>("sessions.create", {
    agentId: "main",
    key: "ordinary-session",
  });
  expect(ordinary.ok).toBe(true);
  expect(ordinary.payload?.key).toBe("agent:main:ordinary-session");

  expect(
    loadSessionEntry({
      sessionKey: "agent:main:harness:codex:supervision:native-thread",
      storePath,
    }),
  ).toBeUndefined();
  expect(loadSessionEntry({ sessionKey: "agent:main:ordinary-session", storePath })).toBeDefined();
});

test("sessions.create preserves a pre-existing unlocked harness-prefixed session", async () => {
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:harness:legacy-notes";
  await writeSessionStore({
    entries: {
      [key]: sessionStoreEntry("legacy-session", { label: "Legacy notes" }),
    },
  });

  const created = await directSessionReq<{
    key: string;
    sessionId: string;
  }>("sessions.create", {
    agentId: "main",
    key,
    label: "Updated notes",
  });

  expect(created.ok).toBe(true);
  expect(created.payload).toMatchObject({ key, sessionId: "legacy-session" });
  expect(loadSessionEntry({ sessionKey: key, storePath })).toMatchObject({
    sessionId: "legacy-session",
    label: "Updated notes",
  });
});

test("sessions.create rejects a pre-existing locked harness session", async () => {
  await createSessionStoreDir();
  const key = "agent:main:harness:codex:supervision:native-thread";
  await writeSessionStore({
    entries: {
      [key]: sessionStoreEntry("locked-session", {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      }),
    },
  });

  const created = await directSessionReq("sessions.create", {
    agentId: "main",
    key,
  });

  expect(created.ok).toBe(false);
  expect(created.error).toMatchObject({
    code: "INVALID_REQUEST",
    message: "Session key namespace is reserved for agent harness-owned sessions.",
  });
});

test("sessions.create rejects children of model-selection-locked sessions", async () => {
  const { dir } = await createSessionStoreDir();
  testState.sessionConfig = { dmScope: "main", scope: "per-sender" };
  const parent = await createCheckpointFixture(dir);
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(parent.sessionId, {
        sessionFile: parent.sessionFile,
        modelSelectionLocked: true,
      }),
    },
  });

  const linkedChild = await directSessionReq("sessions.create", {
    agentId: "main",
    parentSessionKey: "main",
  });
  const forkedChild = await directSessionReq("sessions.create", {
    agentId: "main",
    parentSessionKey: "main",
    fork: true,
  });
  const resetParent = await directSessionReq("sessions.create", {
    agentId: "main",
    parentSessionKey: "main",
    emitCommandHooks: true,
  });

  for (const created of [linkedChild, forkedChild, resetParent]) {
    expect(created.ok).toBe(false);
    expect(created.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "Model-selection-locked sessions cannot create child sessions from parent context.",
    });
  }
  testState.sessionConfig = undefined;
});

test("sessions.create rejects fork without parentSessionKey", async () => {
  await createSessionStoreDir();

  const created = await directSessionReq("sessions.create", { fork: true });

  expect(created.ok).toBe(false);
  expect(created.error).toMatchObject({
    code: "INVALID_REQUEST",
    message: "fork requires parentSessionKey",
  });
});

test("sessions.create rejects fork when the parent exceeds the fork size cap", async () => {
  const { dir } = await createSessionStoreDir();
  testState.sessionConfig = { scope: "per-sender" };
  const parent = await createCheckpointFixture(dir);
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(parent.sessionId, {
        sessionFile: parent.sessionFile,
        // Fresh persisted usage above DEFAULT_PARENT_FORK_MAX_TOKENS (100K).
        totalTokens: 200_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      }),
    },
  });

  const created = await directSessionReq("sessions.create", {
    agentId: "main",
    parentSessionKey: "main",
    fork: true,
  });

  expect(created.ok).toBe(false);
  expect((created.error as { message?: string } | undefined)?.message ?? "").toContain("too large");
  testState.sessionConfig = undefined;
});

test("sessions.create rejects fork while the parent session is active", async () => {
  await createSessionStoreDir();
  testState.sessionConfig = { scope: "per-sender" };
  const parentSessionId = "sess-active-fork-parent";
  await writeSessionStore({ entries: { main: sessionStoreEntry(parentSessionId) } });
  embeddedRunMock.activeIds.add(parentSessionId);
  try {
    const created = await directSessionReq("sessions.create", {
      parentSessionKey: "main",
      fork: true,
    });

    expect(created.ok).toBe(false);
    expect(created.error).toMatchObject({
      code: "UNAVAILABLE",
      message: "Parent session main is still active; try again in a moment.",
    });
  } finally {
    embeddedRunMock.activeIds.delete(parentSessionId);
    testState.sessionConfig = undefined;
  }
});

test("sessions.create resolves an agent-qualified fork from the parent store", async () => {
  const { dir } = await createSessionStoreDir();
  const storeTemplate = path.join(dir, "{agentId}", "sessions.json");
  const mainStorePath = storeTemplate.replace("{agentId}", "main");
  const workStorePath = storeTemplate.replace("{agentId}", "work");
  const workDir = path.dirname(workStorePath);
  testState.sessionStorePath = storeTemplate;
  testState.sessionConfig = { scope: "per-sender" };
  testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "work" }] };
  try {
    await fs.mkdir(workDir, { recursive: true });
    const parent = await createCheckpointFixture(workDir);
    await writeSessionStore({
      storePath: workStorePath,
      agentId: "work",
      entries: {
        main: sessionStoreEntry(parent.sessionId, { sessionFile: parent.sessionFile }),
      },
    });
    await seedSessionTranscript({
      agentId: "work",
      sessionId: parent.sessionId,
      sessionKey: "agent:work:main",
      storePath: workStorePath,
      messages: [
        { role: "user", content: "before compaction" },
        { role: "assistant", content: [{ type: "text", text: "working on it" }] },
      ],
    });

    const created = await directSessionReq<{
      key?: string;
      sessionId?: string;
      entry?: {
        parentSessionKey?: string;
        sessionFile?: string;
        forkSource?: { sessionKey: string; sessionId: string };
        forkedFromParent?: boolean;
      };
    }>("sessions.create", {
      parentSessionKey: "agent:work:main",
      fork: true,
    });

    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(created.payload?.key).toMatch(/^agent:main:dashboard:/);
    expect(created.payload?.entry?.parentSessionKey).toBe("agent:work:main");
    expect(created.payload?.entry?.forkSource).toEqual({
      sessionKey: "agent:work:main",
      sessionId: parent.sessionId,
    });
    expect(created.payload?.entry?.forkedFromParent).toBe(true);
    expect(created.payload?.entry).not.toHaveProperty("sessionFile");
    await expect(
      loadTranscriptEvents({
        sessionId: requireNonEmptyString(
          created.payload?.sessionId,
          "agent-qualified forked session id",
        ),
        sessionKey: created.payload?.key ?? "",
        storePath: mainStorePath,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.objectContaining({ content: "before compaction" }),
          type: "message",
        }),
      ]),
    );
  } finally {
    testState.sessionStorePath = undefined;
    testState.sessionConfig = undefined;
    testState.agentsConfig = undefined;
  }
});

test("sessions.create completes simultaneous opposite-direction cross-agent forks", async () => {
  const { dir } = await createSessionStoreDir();
  const storeTemplate = path.join(dir, "{agentId}", "sessions.json");
  const mainStorePath = storeTemplate.replace("{agentId}", "main");
  const workStorePath = storeTemplate.replace("{agentId}", "work");
  testState.sessionStorePath = storeTemplate;
  testState.sessionConfig = { scope: "per-sender" };
  testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "work" }] };

  try {
    const mainDir = path.dirname(mainStorePath);
    const workDir = path.dirname(workStorePath);
    await Promise.all([
      fs.mkdir(mainDir, { recursive: true }),
      fs.mkdir(workDir, { recursive: true }),
    ]);
    const [mainParent, workParent] = await Promise.all([
      createCheckpointFixture(mainDir),
      createCheckpointFixture(workDir),
    ]);
    await Promise.all([
      writeSessionStore({
        storePath: mainStorePath,
        agentId: "main",
        entries: {
          main: sessionStoreEntry(mainParent.sessionId, {
            sessionFile: mainParent.sessionFile,
          }),
        },
      }),
      writeSessionStore({
        storePath: workStorePath,
        agentId: "work",
        entries: {
          main: sessionStoreEntry(workParent.sessionId, {
            sessionFile: workParent.sessionFile,
          }),
        },
      }),
    ]);
    await Promise.all([
      seedSessionTranscript({
        agentId: "main",
        sessionId: mainParent.sessionId,
        sessionKey: "agent:main:main",
        storePath: mainStorePath,
        messages: [{ role: "user", content: "main parent context" }],
      }),
      seedSessionTranscript({
        agentId: "work",
        sessionId: workParent.sessionId,
        sessionKey: "agent:work:main",
        storePath: workStorePath,
        messages: [{ role: "user", content: "work parent context" }],
      }),
    ]);

    const requests = Array.from({ length: 12 }, (_, index) =>
      index % 2 === 0
        ? {
            agentId: "main",
            parentSessionKey: "agent:work:main",
            parentSessionId: workParent.sessionId,
            storePath: mainStorePath,
          }
        : {
            agentId: "work",
            parentSessionKey: "agent:main:main",
            parentSessionId: mainParent.sessionId,
            storePath: workStorePath,
          },
    );
    const created = await Promise.all(
      requests.map((request) =>
        directSessionReq<{
          key: string;
          sessionId: string;
          entry: {
            parentSessionKey?: string;
            forkSource?: { sessionKey: string; sessionId: string };
            forkedFromParent?: boolean;
          };
        }>("sessions.create", {
          agentId: request.agentId,
          parentSessionKey: request.parentSessionKey,
          fork: true,
        }),
      ),
    );

    expect(
      created.every((result) => result.ok),
      JSON.stringify(created.filter((result) => !result.ok)),
    ).toBe(true);
    expect(new Set(created.map((result) => result.payload?.key)).size).toBe(requests.length);
    expect(new Set(created.map((result) => result.payload?.sessionId)).size).toBe(requests.length);
    for (const [index, result] of created.entries()) {
      const request = requests[index];
      if (!request) {
        throw new Error(`missing cross-agent fork request ${index}`);
      }
      expect(result.payload?.entry).toMatchObject({
        forkSource: {
          sessionKey: request.parentSessionKey,
          sessionId: request.parentSessionId,
        },
        forkedFromParent: true,
        parentSessionKey: request.parentSessionKey,
      });
      const key = requireNonEmptyString(result.payload?.key, "cross-agent fork session key");
      expect(
        loadSessionEntry({
          agentId: request.agentId,
          sessionKey: key,
          storePath: request.storePath,
        }),
      ).toMatchObject({
        forkSource: {
          sessionKey: request.parentSessionKey,
          sessionId: request.parentSessionId,
        },
        parentSessionKey: request.parentSessionKey,
        sessionId: result.payload?.sessionId,
      });
    }
  } finally {
    testState.sessionStorePath = undefined;
    testState.sessionConfig = undefined;
    testState.agentsConfig = undefined;
  }
});

test("sessions.create can start the first agent turn from an initial task", async () => {
  await createSessionStoreDir();
  // Register "ops" so the deleted-agent guard added in #65986 does not
  // reject the auto-started chat.send triggered by `task:`.
  testState.agentsConfig = { list: [{ id: "ops", default: true }] };
  const { ws } = await openClient();

  const created = await rpcReq<{
    key?: string;
    sessionId?: string;
    runStarted?: boolean;
    runId?: string;
    messageSeq?: number;
  }>(ws, "sessions.create", {
    agentId: "ops",
    label: "Dashboard Chat",
    task: "hello from create",
  });

  expect(created.ok).toBe(true);
  expect(created.payload?.key).toMatch(/^agent:ops:dashboard:/);
  expect(created.payload?.sessionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  expect(created.payload?.runStarted).toBe(true);
  const runId = requireNonEmptyString(created.payload?.runId, "started run id");
  expect(created.payload?.messageSeq).toBe(1);

  const wait = await rpcReq(ws, "agent.wait", { runId, timeoutMs: 1_000 });
  expect(wait.ok).toBe(true);
  expect(wait.payload?.status).toBe("ok");

  ws.close();
});

test("sessions.create forwards an attachment-only first turn", async () => {
  await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "main", default: true }] };
  const { chatHandlers } = await import("./server-methods/chat.js");
  const chatSend = vi.spyOn(chatHandlers, "chat.send").mockImplementation(async ({ respond }) => {
    respond(true, { runId: "attachment-run", status: "started" });
  });
  const attachment = {
    type: "image",
    mimeType: "image/png",
    fileName: "pixel.png",
    content:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=",
  };

  try {
    const created = await directSessionReq<{ runStarted?: boolean; runId?: string }>(
      "sessions.create",
      { agentId: "main", message: "", attachments: [attachment] },
    );

    expect(created.ok).toBe(true);
    expect(created.payload).toMatchObject({ runStarted: true, runId: "attachment-run" });
    expect(chatSend.mock.calls[0]?.[0].params).toMatchObject({
      message: "",
      attachments: [attachment],
    });
  } finally {
    chatSend.mockRestore();
  }
});

test("sessions.create rejects unusable attachment-only input before creating a session", async () => {
  await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "main", default: true }] };

  const created = await directSessionReq("sessions.create", {
    agentId: "main",
    attachments: [null],
  });

  expect(created.ok).toBe(false);
  expect(created.error?.message).toContain("must be object");
  const listed = await directSessionReq<{ sessions?: unknown[] }>("sessions.list", {});
  expect(listed.payload?.sessions).toEqual([]);
});

test("sessions.create rejects replacing its parent key", async () => {
  await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "main", default: true }] };
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-parent-task") } });

  const created = await directSessionReq("sessions.create", {
    key: "main",
    parentSessionKey: "agent:main:main",
    emitCommandHooks: true,
    task: "hello after replacing parent",
  });

  expect(created.ok).toBe(false);
  expect(created.error).toMatchObject({
    code: "INVALID_REQUEST",
    message: "sessions.create key must differ from parentSessionKey",
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
