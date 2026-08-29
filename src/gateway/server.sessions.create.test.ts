// Session creation tests protect dashboard-origin session records, transcript
// creation, parent linkage, and model/provider overrides exposed by the gateway API.
import { execFile } from "node:child_process";
import { constants as fsConstants, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getContextWindowCaches } from "../agents/context-cache.js";
import {
  applyDiscoveredContextWindows,
  resetContextWindowCacheForTest,
} from "../agents/context.js";
import { findGitCheckoutRoot } from "../agents/worktrees/git.js";
import {
  findLiveRegistryWorktreeByOwner,
  getRegistryWorktree,
  listRegistryWorktrees,
} from "../agents/worktrees/registry.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { persistReplySessionEntry } from "../auto-reply/reply/session-entry-persistence.js";
import { getRuntimeConfig } from "../config/io.js";
import { loadCombinedSessionStoreForGatewayCore } from "../config/sessions/combined-store-gateway.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteStoreScope,
  runExclusiveSqliteSessionWrite,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { withTimeout } from "../infra/fs-safe.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  beginSessionWorkAdmission,
  getSessionWorkAdmissionRelease,
  isSessionLifecycleMutationActive,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../sessions/session-lifecycle-admission.js";
import { listSessionStateEventsSince } from "../sessions/session-state-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesForTest,
  listOpenIncognitoAgentDatabases,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { waitForChatAbortControllerRemoval } from "./chat-abort-lifecycle-internal.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import {
  attachGatewayLocalUserIngress,
  prepareGatewayLocalUserIngress,
} from "./local-user-ingress.js";
import { sessionLog } from "./server-methods/sessions-shared.js";
import { listSessionGroups } from "./session-groups.js";
import {
  resolveSessionMutationAuthorization,
  SessionMutationAuthorizationChangedError,
} from "./session-sharing.js";
import { resolveGatewaySessionStoreTarget } from "./session-utils.js";
import {
  agentCommandMock,
  agentDiscoveryMock,
  dispatchInboundMessageMock,
  embeddedRunMock,
  mockGetReplyFromConfigOnce,
  onceMessage,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  createCheckpointFixture,
  getGatewayConfigModule,
  sessionStoreEntry,
  directSessionReq,
  sessionHookMocks,
  sessionLifecycleHookMocks,
  seedSessionTranscript,
  threadBindingMocks,
} from "./test/server-sessions.test-helpers.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

type EnsureSessionDiffBaseline =
  (typeof import("../sessions/session-diff-baseline.js"))["ensureSessionDiffBaseline"];
type CaptureSessionDiffBaseline =
  (typeof import("../sessions/session-diff.js"))["captureSessionDiffBaseline"];
type GenerateConversationLabelWithFallback =
  (typeof import("../auto-reply/reply/conversation-label-generator.js"))["generateConversationLabelWithFallback"];
type ScheduleChatDashboardSessionTitle =
  (typeof import("./server-methods/chat-send-background.js"))["scheduleChatDashboardSessionTitle"];
type ReadSessionMessageCountAsync =
  (typeof import("./session-transcript-readers.js"))["readSessionMessageCountAsync"];

const sessionDiffBaselineMocks = vi.hoisted(() => ({
  captureGate: undefined as Promise<void> | undefined,
  captureStarted: undefined as (() => void) | undefined,
  capture: vi.fn<CaptureSessionDiffBaseline>(),
  ensure: vi.fn<EnsureSessionDiffBaseline>(),
  useReal: false,
}));

const dashboardTitleGenerationMocks = vi.hoisted(() => ({
  generate: vi.fn<GenerateConversationLabelWithFallback>(),
}));

const dashboardTitleScheduleMocks = vi.hoisted(() => ({
  schedule: vi.fn<ScheduleChatDashboardSessionTitle>(),
}));

const sessionTranscriptReaderMocks = vi.hoisted(() => ({
  readCount: vi.fn<ReadSessionMessageCountAsync>(),
}));

vi.mock("../sessions/session-diff.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sessions/session-diff.js")>();
  sessionDiffBaselineMocks.capture.mockImplementation(async (params) => {
    sessionDiffBaselineMocks.captureStarted?.();
    if (sessionDiffBaselineMocks.captureGate) {
      await sessionDiffBaselineMocks.captureGate;
    }
    return await actual.captureSessionDiffBaseline(params);
  });
  return { ...actual, captureSessionDiffBaseline: sessionDiffBaselineMocks.capture };
});

vi.mock("../sessions/session-diff-baseline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sessions/session-diff-baseline.js")>();
  sessionDiffBaselineMocks.ensure.mockImplementation(async (params) => {
    return sessionDiffBaselineMocks.useReal
      ? await actual.ensureSessionDiffBaseline(params)
      : params.entry;
  });
  return { ...actual, ensureSessionDiffBaseline: sessionDiffBaselineMocks.ensure };
});

vi.mock("../auto-reply/reply/conversation-label-generator.js", () => ({
  generateConversationLabelWithFallback: dashboardTitleGenerationMocks.generate,
}));

vi.mock("./server-methods/chat-send-background.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-methods/chat-send-background.js")>();
  return { ...actual, scheduleChatDashboardSessionTitle: dashboardTitleScheduleMocks.schedule };
});

vi.mock("./session-transcript-readers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-transcript-readers.js")>();
  return { ...actual, readSessionMessageCountAsync: sessionTranscriptReaderMocks.readCount };
});

const { createSessionStoreDir, createSelectedGlobalSessionStore, openClient } =
  setupGatewaySessionsTestHarness();
const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let gitWorkspaceTemplateRoot: string;
let gitWorkspaceTemplate: string;

async function waitForCreatedSessionRun(
  context: { chatAbortControllers: Map<string, ChatAbortControllerEntry> },
  storePath: string,
  sessionKey: string | undefined,
) {
  const released = getSessionWorkAdmissionRelease({
    scope: storePath,
    identities: [sessionKey],
  });
  const removed = await waitForChatAbortControllerRemoval({
    entries: context.chatAbortControllers,
    targets: [...context.chatAbortControllers].map(([runId, entry]) => ({ runId, entry })),
    timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
  });
  if (released) {
    await withTimeout(
      released,
      SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
      "worktree title run cleanup",
    );
  }
  return removed;
}

beforeAll(async () => {
  gitWorkspaceTemplateRoot = await fs.realpath(
    await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-session-git-template-")),
  );
  gitWorkspaceTemplate = await createGitWorkspace(gitWorkspaceTemplateRoot);
});

afterAll(async () => {
  await fs.rm(gitWorkspaceTemplateRoot, { recursive: true, force: true });
});

// Read the real implementations back here rather than capturing them inside the
// mock factories: Vitest runs a factory on first import of the mocked module, and
// this project is `isolate: false`, so on a warm module graph a factory can still
// be unrun when the first `beforeEach` fires.
async function actualDashboardTitleScheduler(): Promise<ScheduleChatDashboardSessionTitle> {
  const actual = await vi.importActual<typeof import("./server-methods/chat-send-background.js")>(
    "./server-methods/chat-send-background.js",
  );
  return actual.scheduleChatDashboardSessionTitle;
}

async function actualSessionMessageCountReader(): Promise<ReadSessionMessageCountAsync> {
  const actual = await vi.importActual<typeof import("./session-transcript-readers.js")>(
    "./session-transcript-readers.js",
  );
  return actual.readSessionMessageCountAsync;
}

beforeEach(async () => {
  sessionDiffBaselineMocks.captureGate = undefined;
  sessionDiffBaselineMocks.captureStarted = undefined;
  sessionDiffBaselineMocks.capture.mockClear();
  sessionDiffBaselineMocks.ensure.mockClear();
  // Baseline capture has dedicated owner coverage and one authenticated integration below.
  sessionDiffBaselineMocks.useReal = false;
  dashboardTitleGenerationMocks.generate.mockReset();
  dashboardTitleGenerationMocks.generate.mockResolvedValue("Generated Dashboard Title");
  dashboardTitleScheduleMocks.schedule.mockReset();
  dashboardTitleScheduleMocks.schedule.mockImplementation(await actualDashboardTitleScheduler());
  sessionTranscriptReaderMocks.readCount.mockReset();
  sessionTranscriptReaderMocks.readCount.mockImplementation(
    await actualSessionMessageCountReader(),
  );
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

// The adoption assertion below flaked once on CI (run 31609081812) with the persisted
// row missing while all 16 creates succeeded; exhaustive owner-path analysis found no
// mechanism, and the failure never reproduced locally. On mismatch, capture which SQLite
// files exist and what session_nodes actually holds so the next occurrence names the
// writer/reader split instead of printing a bare undefined.
function describeSessionStoreForensics(storePath: string): string {
  const storeDir = path.dirname(storePath);
  const files = readdirSync(storeDir).toSorted();
  const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
  const database = openOpenClawAgentDatabase({ agentId: "main", path: target.path });
  const rows = database.db
    .prepare(
      "SELECT session_key, length(entry_json) AS entry_bytes, updated_at FROM session_nodes ORDER BY session_key",
    )
    .all();
  return JSON.stringify({ storeDir, files, resolvedTargetPath: target.path, rows });
}

test("sessions.create assigns and registers its requested group", async () => {
  const { storePath } = await createSessionStoreDir();
  const broadcastToConnIds = vi.fn();

  const created = await directSessionReq<{ key: string }>(
    "sessions.create",
    {
      agentId: "main",
      category: "  Client work  ",
    },
    {
      context: {
        broadcastToConnIds,
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      },
    },
  );

  expect(created.ok).toBe(true);
  const key = requireNonEmptyString(created.payload?.key, "grouped session key");
  expect(loadSessionEntry({ sessionKey: key, storePath })?.category).toBe("Client work");
  expect(listSessionGroups().map((group) => group.name)).toContain("Client work");
  expect(broadcastToConnIds).toHaveBeenCalledWith(
    "sessions.changed",
    expect.objectContaining({ reason: "groups" }),
    new Set(["conn-1"]),
    { dropIfSlow: true },
  );
});

test.each([
  ["sessions.create", "create"],
  ["sessions.patch", "patch"],
  ["sessions.patchMany", "patch-many"],
] as const)(
  "required operator sandbox follows new %s session ownership",
  async (method, suffix) => {
    const { storePath } = await createSessionStoreDir();
    const profile = ensureProfileForEmail(`sandboxed-session-${suffix}@example.com`);
    setUserProfileRole(profile.id, "guest");
    const cfg = {
      ...getRuntimeConfig(),
      session: { ...getRuntimeConfig().session, store: storePath },
      gateway: {
        ...getRuntimeConfig().gateway,
        roles: {
          default: "guest",
          definitions: {
            guest: {
              sessions: { others: "view" as const },
              agents: ["main"],
              scopes: ["operator.read" as const, "operator.write" as const],
              sandbox: "required" as const,
            },
          },
        },
      },
    };
    const client = {
      connect: { role: "operator", scopes: ["operator.read", "operator.write"] },
      authenticatedUserProfile: {
        profileId: profile.id,
        displayName: profile.displayName,
        hasAvatar: false,
        updatedAt: profile.updatedAt,
      },
    } as never;
    const key = `agent:main:dashboard:role-sandbox-${suffix}`;
    const request =
      method === "sessions.create"
        ? { agentId: "main", key }
        : method === "sessions.patch"
          ? { key, label: "Guest session" }
          : { patch: { label: "Guest session" }, targets: [{ key }] };

    const created = await directSessionReq<{ outcomes?: Array<{ ok: boolean }> }>(method, request, {
      client,
      context: { getRuntimeConfig: () => cfg },
    });

    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    if (method === "sessions.patchMany") {
      expect(created.payload?.outcomes).toEqual([{ ok: true, key }]);
    }
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toMatchObject({
      createdActor: { type: "human", id: profile.id },
      sandbox: "required",
    });

    for (const forgedSandbox of [null, "inherit"] as const) {
      const forged = await directSessionReq(
        "sessions.patch",
        { key, sandbox: forgedSandbox },
        { client, context: { getRuntimeConfig: () => cfg } },
      );

      expect(forged).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    }
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toMatchObject({
      sandbox: "required",
    });
  },
);

test("operator role agent allowlists protect creation without blocking existing sessions", async () => {
  const { storePath } = await createSessionStoreDir();
  const profile = ensureProfileForEmail("restricted-session-creator@example.com");
  setUserProfileRole(profile.id, "guest");
  const cfg = {
    ...getRuntimeConfig(),
    session: { ...getRuntimeConfig().session, store: storePath },
    gateway: {
      ...getRuntimeConfig().gateway,
      roles: {
        default: "guest",
        definitions: {
          guest: {
            sessions: { others: "view" as const },
            agents: ["guest-only"],
            scopes: ["operator.read" as const, "operator.write" as const],
          },
        },
      },
    },
  };
  const client = {
    connect: { role: "operator", scopes: ["operator.read", "operator.write"] },
    authenticatedUserProfile: {
      profileId: profile.id,
      displayName: profile.displayName,
      hasAvatar: false,
      updatedAt: profile.updatedAt,
    },
  } as never;
  const requestOptions = { client, context: { getRuntimeConfig: () => cfg } };
  const deniedKey = "agent:main:dashboard:role-denied";

  const created = await directSessionReq(
    "sessions.create",
    { agentId: "main", key: deniedKey },
    requestOptions,
  );
  expect(created).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN", message: expect.stringContaining('agent "main"') },
  });
  expect(loadSessionEntry({ agentId: "main", sessionKey: deniedKey, storePath })).toBeUndefined();

  const patched = await directSessionReq(
    "sessions.patch",
    { key: deniedKey, label: "bypass attempt" },
    requestOptions,
  );
  expect(patched).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

  const patchedMany = await directSessionReq<{ outcomes: Array<{ ok: boolean; error?: unknown }> }>(
    "sessions.patchMany",
    { patch: { label: "bulk bypass attempt" }, targets: [{ key: deniedKey }] },
    requestOptions,
  );
  expect(patchedMany).toMatchObject({
    ok: true,
    payload: { outcomes: [{ ok: false, error: { code: "FORBIDDEN" } }] },
  });
  expect(loadSessionEntry({ agentId: "main", sessionKey: deniedKey, storePath })).toBeUndefined();

  const existingKey = "agent:main:dashboard:role-existing";
  await writeSessionStore({
    entries: {
      [existingKey]: sessionStoreEntry("role-existing-session", {
        createdActor: { type: "human", id: profile.id },
      }),
    },
  });
  expect(loadSessionEntry({ agentId: "main", sessionKey: existingKey, storePath })).toMatchObject({
    sessionId: "role-existing-session",
  });
  expect(
    resolveGatewaySessionStoreTarget({ cfg, key: existingKey, agentId: "main" }).storePath,
  ).toBe(storePath);
  const adopted = await directSessionReq(
    "sessions.create",
    { agentId: "main", key: existingKey },
    requestOptions,
  );
  expect(adopted.ok).toBe(true);
  const existingPatch = await directSessionReq(
    "sessions.patch",
    { key: existingKey, label: "still allowed" },
    requestOptions,
  );
  expect(existingPatch.ok).toBe(true);
});

test("sessions.create carries keyed adoption authorization through the durable commit", async () => {
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard:categorized-adoption";
  await writeSessionStore({
    entries: {
      [key]: sessionStoreEntry("session-categorized-adoption", { category: "Personal" }),
    },
  });
  const assertCurrent = vi.fn();

  const adopted = await directSessionReq(
    "sessions.create",
    { agentId: "main", key, category: "Projects" },
    {
      sessionMutationAuthorization: {
        assertCurrent,
        assertTargetCurrent: vi.fn(),
      },
    },
  );

  expect(adopted.ok).toBe(true);
  expect(assertCurrent).toHaveBeenCalled();
  expect(loadSessionEntry({ sessionKey: key, storePath })?.category).toBe("Projects");
});

test("sessions.create revalidates parent participation before committing a fork transcript", async () => {
  const { storePath } = await createSessionStoreDir();
  const parentSessionKey = "agent:main:dashboard:participation-race-parent";
  const parentSessionId = "participation-race-parent-session";
  const childSessionKey = "agent:main:dashboard:participation-race-child";
  await writeSessionStore({
    entries: {
      [parentSessionKey]: sessionStoreEntry(parentSessionId, {
        visibility: "read-only",
        createdActor: { type: "human", id: "owner" },
      }),
    },
  });
  await seedSessionTranscript({
    agentId: "main",
    sessionId: parentSessionId,
    sessionKey: parentSessionKey,
    storePath,
    messages: [{ role: "user", content: "private parent context" }],
  });
  addSessionMember(
    { agentId: "main", sessionKey: parentSessionKey, storePath },
    { identityId: "member", addedBy: "owner", expectedSessionId: parentSessionId },
  );
  const client = {
    authenticatedUserId: "member@example.com",
    authenticatedUserProfile: {
      profileId: "member",
      displayName: "Member",
      hasAvatar: false,
      updatedAt: 1,
    },
    connect: { role: "operator", scopes: ["operator.write"] },
  } as never;
  const requestParams = {
    agentId: "main",
    key: childSessionKey,
    parentSessionKey,
    fork: true,
  };
  const authorization = resolveSessionMutationAuthorization({
    client,
    method: "sessions.create",
    requestParams,
    context: { getRuntimeConfig } as never,
  });
  expect(authorization.error).toBeNull();
  const assertCurrent = authorization.authorization?.assertCurrent;
  if (!assertCurrent) {
    throw new Error("sessions.create did not capture parent participation");
  }

  const writerEntered = createDeferredCore();
  const releaseWriter = createDeferredCore();
  const resolvedStore = resolveSqliteStoreScope(storePath, { agentId: "main" });
  const heldWriter = runExclusiveSqliteSessionWrite(resolvedStore, async () => {
    writerEntered.resolve();
    await releaseWriter.promise;
  });
  await writerEntered.promise;
  const database = openOpenClawAgentDatabase({
    agentId: "main",
    ...(resolvedStore.path ? { path: resolvedStore.path } : {}),
  });
  const transcriptCount = () =>
    (
      database.db.prepare("SELECT count(*) AS count FROM transcript_events").get() as {
        count: number;
      }
    ).count;
  const beforeTranscriptCount = transcriptCount();
  const firstGuard = createDeferredCore();
  let guardCalls = 0;
  const { createGatewaySession } = await import("./session-create-service.js");
  const creating = createGatewaySession({
    cfg: getRuntimeConfig(),
    ...requestParams,
    commandSource: "test",
    commitGuard: () => {
      assertCurrent();
      guardCalls += 1;
      if (guardCalls === 1) {
        firstGuard.resolve();
      }
    },
  });

  try {
    await firstGuard.promise;
    removeSessionMember(
      { agentId: "main", sessionKey: parentSessionKey, storePath },
      "member",
      undefined,
      parentSessionId,
    );
  } finally {
    releaseWriter.resolve();
    await heldWriter;
  }

  await expect(creating).rejects.toBeInstanceOf(SessionMutationAuthorizationChangedError);
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: childSessionKey, storePath }),
  ).toBeUndefined();
  expect(transcriptCount()).toBe(beforeTranscriptCount);
});

test("sessions.create registers a category only after the session commit succeeds", async () => {
  await createSessionStoreDir();
  const category = "Deferred category";
  let validations = 0;

  const failed = await directSessionReq(
    "sessions.create",
    { agentId: "main", category, key: "agent:main:dashboard:failed-category-create" },
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

  expect(failed.ok).toBe(false);
  expect(listSessionGroups().map((group) => group.name)).not.toContain(category);

  const broadcastToConnIds = vi.fn();
  const created = await directSessionReq(
    "sessions.create",
    { agentId: "main", category, key: "agent:main:dashboard:successful-category-create" },
    {
      context: {
        broadcastToConnIds,
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      },
    },
  );

  expect(created.ok).toBe(true);
  expect(listSessionGroups().filter((group) => group.name === category)).toHaveLength(1);
  expect(
    broadcastToConnIds.mock.calls.filter(([, payload]) => payload?.reason === "groups"),
  ).toHaveLength(1);
});

test("concurrent sessions.create requests adopt one canonical keyed session", async () => {
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard:concurrent-keyed-session";

  const created = await Promise.all(
    Array.from({ length: 4 }, () =>
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
  const persistedSessionId = loadSessionEntry({ sessionKey: key, storePath })?.sessionId;
  const canonicalSessionId = created[0]?.payload?.sessionId;
  expect(
    persistedSessionId,
    persistedSessionId === canonicalSessionId ? "" : describeSessionStoreForensics(storePath),
  ).toBe(canonicalSessionId);
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
    expect(loadCombinedSessionStoreForGatewayCore(getRuntimeConfig()).store[key]?.incognito).toBe(
      true,
    );
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
    await upsertSessionEntryCore(
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

    await upsertSessionEntryCore(
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
        message: 'agent "main" does not match session key agent "work"',
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

test("incognito webchat rejects a vanished non-default-agent session before dispatch", async () => {
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
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const sessionKey = requireNonEmptyString(created.payload?.key, "incognito webchat key");
    const sessionId = requireNonEmptyString(created.payload?.sessionId, "incognito webchat id");

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

test("createGatewaySession rejects explicit and key-derived unconfigured creation owners", async () => {
  const { createGatewaySession } = await import("./session-create-service.js");
  const cfg = { agents: { entries: { ops: { default: true } } } };
  const prepareLifecycle = vi.fn();

  for (const { owner, message } of [
    { owner: { agentId: "main" }, message: 'Unknown agent id "main"' },
    {
      owner: { key: "agent:main:dashboard:unconfigured-owner" },
      message: 'Unknown agent id "main"',
    },
    { owner: { agentId: "   " }, message: 'Unknown agent id "   "' },
  ]) {
    await expect(
      createGatewaySession({ cfg, ...owner, commandSource: "test", prepareLifecycle }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message },
    });
  }

  expect(prepareLifecycle).not.toHaveBeenCalled();
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

test("chat.send fences dashboard title persistence from concurrent session deletion", async () => {
  const { storePath } = await createSessionStoreDir();
  const { ws } = await openClient();
  let finishDispatch: (() => void) | undefined;
  const dispatchFinished = new Promise<void>((resolve) => {
    finishDispatch = resolve;
  });
  let finishTitle: (() => void) | undefined;
  let markTitleStarted = () => {};
  const titleStarted = new Promise<void>((resolve) => {
    markTitleStarted = resolve;
  });
  dashboardTitleGenerationMocks.generate.mockImplementationOnce(async () => {
    markTitleStarted();
    await new Promise<void>((resolve) => {
      finishTitle = resolve;
    });
    return "Generated Dashboard Title";
  });
  dispatchInboundMessageMock.mockImplementationOnce(async () => {
    await dispatchFinished;
    return {
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    };
  });
  try {
    const created = await rpcReq<{ key: string }>(ws, "sessions.create", {
      agentId: "main",
      key: "agent:main:dashboard:title-order",
    });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const sessionKey = requireNonEmptyString(created.payload?.key, "created session key");

    const sent = await rpcReq(ws, "chat.send", {
      sessionKey,
      message: "Help me plan the release",
      idempotencyKey: "post-dispatch-dashboard-title",
    });
    expect(sent.ok, JSON.stringify(sent.error)).toBe(true);
    await waitForFast(() => expect(dispatchInboundMessageMock).toHaveBeenCalled());
    await waitForFast(() => expect(dashboardTitleScheduleMocks.schedule).toHaveBeenCalled(), {
      timeout: 5_000,
    });
    expect(dashboardTitleScheduleMocks.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ rawMessage: "Help me plan the release" }),
        sessionKey,
      }),
    );
    await titleStarted;
    finishDispatch?.();

    let deletionSettled = false;
    const deletion = directSessionReq<{ deleted: boolean }>("sessions.delete", {
      key: sessionKey,
    }).finally(() => {
      deletionSettled = true;
    });
    await waitForFast(
      () => expect(isSessionLifecycleMutationActive(storePath, [sessionKey])).toBe(true),
      { timeout: 5_000 },
    );
    expect(deletionSettled).toBe(false);

    finishTitle?.();
    const deleted = await deletion;
    expect(deleted.ok, JSON.stringify(deleted.error)).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);
  } finally {
    finishDispatch?.();
    finishTitle?.();
    ws.close();
  }
});

test("chat.send persists a dashboard title while the first turn is still running", async () => {
  const { storePath } = await createSessionStoreDir();
  const { ws } = await openClient();
  let finishDispatch: (() => void) | undefined;
  let dispatchFinished = false;
  const dispatchPending = new Promise<void>((resolve) => {
    finishDispatch = resolve;
  });
  dispatchInboundMessageMock.mockImplementationOnce(async () => {
    await dispatchPending;
    dispatchFinished = true;
    return {
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    };
  });
  try {
    const created = await rpcReq<{ key: string }>(ws, "sessions.create", {
      agentId: "main",
      key: "agent:main:dashboard:title-during-turn",
    });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const sessionKey = requireNonEmptyString(created.payload?.key, "created session key");

    const sent = await rpcReq(ws, "chat.send", {
      sessionKey,
      message: "Help me plan the release",
      idempotencyKey: "dashboard-title-during-turn",
    });
    expect(sent.ok, JSON.stringify(sent.error)).toBe(true);
    await waitForFast(() => expect(dispatchInboundMessageMock).toHaveBeenCalled());
    await waitForFast(() =>
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
        displayName: "Generated Dashboard Title",
      }),
    );
    expect(dispatchFinished).toBe(false);
  } finally {
    finishDispatch?.();
    ws.close();
  }
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

async function createGitWorkspace(root: string): Promise<string> {
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

async function initializeGitWorkspace(root: string): Promise<string> {
  const workspace = path.join(root, "workspace");
  await fs.cp(gitWorkspaceTemplate, workspace, {
    recursive: true,
    mode: fsConstants.COPYFILE_FICLONE,
  });
  return await fs.realpath(workspace);
}

function managedWorktreeFixture(params: {
  id: string;
  name: string;
  ownerId: string;
  path: string;
  repoRoot: string;
}): NonNullable<ReturnType<typeof managedWorktrees.findLiveById>> {
  return {
    ...params,
    baseRef: "HEAD",
    branch: `openclaw/${params.name}`,
    createdAt: 1,
    lastActiveAt: 1,
    ownerKind: "session",
    repoFingerprint: "test-repository",
  };
}

test("sessions.create atomically arms a private workspace diff claim", async () => {
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
    const created = await rpcReq<{
      entry?: Record<string, unknown>;
      key?: string;
      sessionId?: string;
    }>(ws, "sessions.create", { agentId: "main", cwd: workspace });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const sessionKey = requireNonEmptyString(created.payload?.key, "baseline session key");
    const sessionId = requireNonEmptyString(created.payload?.sessionId, "baseline session id");
    expect(created.payload?.entry).not.toHaveProperty("sessionDiffBaselineCapture");
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      sessionId,
      spawnedCwd: workspace,
      sessionDiffBaselineCapture: {
        version: 1,
        captureId: expect.any(String),
        status: "pending",
      },
    });
    expect(sessionDiffBaselineMocks.ensure).not.toHaveBeenCalled();
    expect(sessionDiffBaselineMocks.capture).not.toHaveBeenCalled();
  } finally {
    sessionDiffBaselineMocks.useReal = false;
    ws.close();
  }
});

test("sessions.create fences the first workspace write behind its diff baseline", async () => {
  const root = tempDirs.make("openclaw-session-diff-first-write-");
  const workspace = await initializeGitWorkspace(root);
  await fs.appendFile(path.join(workspace, "README.md"), "dirty before session\n");
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:diff-first-write";
  const captureStarted = createDeferredCore();
  const releaseCapture = createDeferredCore();
  sessionDiffBaselineMocks.captureStarted = captureStarted.resolve;
  sessionDiffBaselineMocks.captureGate = releaseCapture.promise;
  sessionDiffBaselineMocks.useReal = true;

  const { ensureSessionDiffBaseline } = await import("../sessions/session-diff-baseline.js");
  const { chatHandlers } = await import("./server-methods/chat.js");
  let firstTurn: Promise<void> | undefined;
  const chatSend = vi.spyOn(chatHandlers, "chat.send").mockImplementation(async ({ respond }) => {
    respond(true, { runId: "diff-first-write-run", status: "started" });
    firstTurn = (async () => {
      const entry = loadSessionEntry({ agentId: "main", sessionKey, storePath });
      if (!entry) {
        throw new Error("expected the precreated session entry");
      }
      await ensureSessionDiffBaseline({
        cwd: workspace,
        entry,
        isNewSession: false,
        sessionKey,
        storePath,
      });
      await fs.writeFile(path.join(workspace, "first-turn.txt"), "written by first turn\n");
    })();
  });
  const client = {
    client: {
      connect: {
        scopes: ["operator.admin", "operator.write"],
        client: {
          id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
          version: "dev",
          platform: "web",
          mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        },
      },
    } as never,
  };

  try {
    const created = await directSessionReq<{ runStarted?: boolean; sessionId?: string }>(
      "sessions.create",
      {
        agentId: "main",
        cwd: workspace,
        key: sessionKey,
        message: "write a file",
      },
      client,
    );
    expect(created).toMatchObject({
      ok: true,
      payload: { runStarted: true, sessionId: expect.any(String) },
    });
    await captureStarted.promise;
    await expect(fs.stat(path.join(workspace, "first-turn.txt"))).rejects.toThrow();

    releaseCapture.resolve();
    await firstTurn;
    const diff = await directSessionReq<{ files?: Array<{ path: string }> }>(
      "sessions.diff",
      { sessionKey },
      client,
    );
    expect(diff.ok, JSON.stringify(diff.error)).toBe(true);
    expect(diff.payload?.files?.map((file) => file.path)).toEqual(["first-turn.txt"]);
  } finally {
    releaseCapture.resolve();
    await firstTurn?.catch(() => undefined);
    sessionDiffBaselineMocks.captureGate = undefined;
    sessionDiffBaselineMocks.captureStarted = undefined;
    sessionDiffBaselineMocks.useReal = false;
    chatSend.mockRestore();
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

test("sessions.create persists explicit tool overrides before the first turn", async () => {
  const { storePath } = await createSessionStoreDir();
  const parentSessionKey = "agent:main:main";
  const sessionKey = "agent:main:dashboard:create-tool-overrides";
  await writeSessionStore({
    entries: {
      [parentSessionKey]: sessionStoreEntry("tool-overrides-parent", {
        toolOverrides: { skills: { inherited: false } },
      }),
    },
  });
  const requested = {
    mcpServers: { zeta: false, alpha: true },
    mcpToolsDeny: { github: ["write", "read", "write"] },
    skills: { release: false },
    webSearch: false,
  };
  const normalized = {
    mcpServers: { alpha: true, zeta: false },
    mcpToolsDeny: { github: ["read", "write"] },
    skills: { release: false },
    webSearch: false,
  };
  const { chatHandlers } = await import("./server-methods/chat.js");
  const observed: Array<unknown> = [];
  const chatSend = vi.spyOn(chatHandlers, "chat.send").mockImplementation(async ({ respond }) => {
    observed.push(loadSessionEntry({ agentId: "main", sessionKey, storePath })?.toolOverrides);
    respond(true, { runId: "create-tool-overrides-run", status: "started" });
  });
  const client = { client: { connect: { scopes: ["operator.admin"] } } as never };

  try {
    const created = await directSessionReq<{
      entry?: { toolOverrides?: unknown };
      runStarted?: boolean;
    }>(
      "sessions.create",
      {
        agentId: "main",
        key: sessionKey,
        parentSessionKey,
        message: "run with the selected capabilities",
        toolOverrides: requested,
      },
      client,
    );

    expect(created).toMatchObject({
      ok: true,
      payload: { entry: { toolOverrides: normalized }, runStarted: true },
    });
    expect(observed).toEqual([normalized]);
    expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })?.toolOverrides).toEqual(
      normalized,
    );

    const retried = await directSessionReq(
      "sessions.create",
      { agentId: "main", key: sessionKey, toolOverrides: requested },
      client,
    );
    expect(retried.ok).toBe(true);

    const mismatch = await directSessionReq(
      "sessions.create",
      { agentId: "main", key: sessionKey, toolOverrides: { skills: { release: true } } },
      client,
    );
    expect(mismatch).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "sessions.create toolOverrides requires a new session",
      },
    });
  } finally {
    chatSend.mockRestore();
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
      entry: {
        worktree?: {
          id: string;
          branch: string;
          repoRoot: string;
          canonicalWorkspaceDir?: string;
        };
      };
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
      canonicalWorkspaceDir: workspace,
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
        allowSnapshotLoss: true,
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
  const { storePath } = await createSessionStoreDir();
  const originalCreate = managedWorktrees.create.bind(managedWorktrees);
  const createSpy = vi.spyOn(managedWorktrees, "create").mockImplementation(async (params) => {
    expect(isSessionLifecycleMutationActive(storePath, [params.ownerId])).toBe(true);
    return await originalCreate(params);
  });
  let worktreeId: string | undefined;
  try {
    const created = await directSessionReq<{
      key: string;
      entry: {
        permissionMode?: string;
        sessionRoot?: string;
        spawnedCwd?: string;
      };
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
    expect(created.payload?.entry.permissionMode).toBeUndefined();
    expect(loadSessionEntry({ sessionKey: key, storePath })?.permissionMode).toBeUndefined();
    expect(created.payload?.entry.sessionRoot).toBe(worktree?.path);
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
    expect(createSpy).toHaveBeenCalledTimes(1);
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
    createSpy.mockRestore();
    if (worktreeId) {
      await managedWorktrees.remove({
        id: worktreeId,
        reason: "test-cleanup",
        allowSnapshotLoss: true,
      });
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await openClawState.cleanup();
  }
});

test("sessions.create runs an existing managed worktree cwd for initial and follow-up turns", async () => {
  const openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-session-existing-worktree-cwd-",
  });
  const workspace = await initializeGitWorkspace(openClawState.root);
  closeOpenClawStateDatabaseForTest();
  testState.agentsConfig = {
    list: [
      { id: "main", default: true },
      { id: "roboclaw", workspace },
    ],
  };
  const { storePath } = await createSessionStoreDir();
  const worktree = await managedWorktrees.create({
    repoRoot: workspace,
    ownerKind: "manual",
    name: "roboclaw-existing-worktree",
    runSetupScript: false,
  });
  const requestedCwd = await fs.realpath(worktree.path);
  const { prepareAgentCommandExecution } = await import("../agents/command/prepare.js");
  const { resolveIngressWorkspaceOverrideForSessionRun } =
    await import("../agents/spawned-context.js");
  const acpManagerModule = await import("../acp/control-plane/manager.js");
  const getAcpSessionManager = vi
    .spyOn(acpManagerModule, "getAcpSessionManager")
    .mockReturnValue({ resolveSession: () => null } as never);
  const { defaultRuntime } = await import("../runtime.js");
  const preparedRuntime = vi.fn<(params: { cwd?: string; workspaceDir?: string }) => void>();
  const mockPreparedRuntime = () =>
    mockGetReplyFromConfigOnce(async (ctx, opts) => {
      const sessionKey = requireNonEmptyString(ctx.SessionKey, "prepared session key");
      const loaded = loadSessionEntry({ agentId: "roboclaw", sessionKey, storePath });
      const workspaceDir =
        resolveIngressWorkspaceOverrideForSessionRun({
          spawnedBy: loaded?.spawnedBy,
          workspaceDir: loaded?.spawnedWorkspaceDir,
          cwd: loaded?.spawnedCwd,
        }) ?? workspace;
      const prepared = await prepareAgentCommandExecution(
        {
          agentId: "roboclaw",
          message: "exercise the prepared runtime cwd",
          runId: opts?.runId,
          sessionKey,
          workspaceDir,
        },
        defaultRuntime,
      );
      try {
        preparedRuntime({ cwd: prepared.cwd, workspaceDir: prepared.workspaceDir });
      } finally {
        await prepared.runLease?.release();
      }
      return { text: "ok" };
    });
  const { ws } = await openClient({
    scopes: ["operator.admin"],
    deviceIdentityPath: path.join(openClawState.root, "roboclaw-device.json"),
  });

  try {
    mockPreparedRuntime();
    const created = await rpcReq<{
      entry?: { permissionMode?: string; sessionRoot?: string; spawnedCwd?: string };
      key?: string;
      runId?: string;
      runStarted?: boolean;
      sessionId?: string;
    }>(ws, "sessions.create", {
      agentId: "roboclaw",
      cwd: requestedCwd,
      permissionMode: "full",
      task: "start in the existing worktree",
    });

    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(created.payload?.entry).toMatchObject({
      spawnedCwd: requestedCwd,
      sessionRoot: requestedCwd,
      permissionMode: "full",
    });
    expect(created.payload?.runStarted).toBe(true);
    const sessionKey = requireNonEmptyString(created.payload?.key, "roboclaw session key");
    const sessionId = requireNonEmptyString(created.payload?.sessionId, "roboclaw session id");
    await expect(
      loadTranscriptEvents({
        agentId: "roboclaw",
        sessionId,
        sessionKey,
        storePath,
      }),
    ).resolves.toContainEqual(expect.objectContaining({ cwd: requestedCwd, type: "session" }));
    const createRunId = requireNonEmptyString(created.payload?.runId, "roboclaw create run id");
    const createWait = await rpcReq(ws, "agent.wait", { runId: createRunId, timeoutMs: 10_000 });
    expect(createWait, JSON.stringify(createWait)).toMatchObject({
      ok: true,
      payload: { status: "ok" },
    });
    await waitForFast(() => expect(preparedRuntime).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(preparedRuntime.mock.calls[0]?.[0]).toEqual({
      cwd: requestedCwd,
      workspaceDir: requestedCwd,
    });

    preparedRuntime.mockClear();
    mockPreparedRuntime();
    const followup = await rpcReq<{ runId?: string }>(ws, "sessions.send", {
      key: sessionKey,
      message: "continue in the existing worktree",
      idempotencyKey: "roboclaw-existing-worktree-followup",
    });
    expect(followup.ok, JSON.stringify(followup.error)).toBe(true);
    await waitForFast(() => expect(preparedRuntime).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(preparedRuntime.mock.calls[0]?.[0]).toEqual({
      cwd: requestedCwd,
      workspaceDir: requestedCwd,
    });
    const followupRunId = requireNonEmptyString(followup.payload?.runId, "follow-up run id");
    const followupWait = await rpcReq(ws, "agent.wait", {
      runId: followupRunId,
      timeoutMs: 10_000,
    });
    expect(followupWait, JSON.stringify(followupWait)).toMatchObject({
      ok: true,
      payload: { status: "ok" },
    });
  } finally {
    ws.close();
    getAcpSessionManager.mockRestore();
    await managedWorktrees.remove({
      id: worktree.id,
      reason: "test-cleanup",
      allowSnapshotLoss: true,
    });
    closeOpenClawStateDatabaseForTest();
    testState.agentsConfig = undefined;
    await openClawState.cleanup();
  }
});

test("sessions.create preserves pending worktree intent when initial-turn admission fails", async () => {
  const openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-session-worktree-post-commit-failure-",
  });
  const workspace = await initializeGitWorkspace(openClawState.root);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard:post-commit-worktree";
  sessionTranscriptReaderMocks.readCount.mockRejectedValueOnce(
    new Error("synthetic post-commit initial-turn failure"),
  );
  try {
    const created = await directSessionReq<{
      key: string;
      runError: { code: string; message: string };
      runStarted: boolean;
      sessionId: string;
    }>(
      "sessions.create",
      {
        agentId: "main",
        key,
        message: "start the committed session",
        worktree: true,
        worktreeName: "post-commit-worktree",
      },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );
    expect(created).toMatchObject({
      ok: true,
      payload: {
        key,
        runError: {
          code: "UNAVAILABLE",
          message: "synthetic post-commit initial-turn failure",
        },
        runStarted: false,
        sessionId: expect.any(String),
      },
    });

    expect(loadSessionEntry({ sessionKey: key, storePath })).toMatchObject({
      sessionId: expect.any(String),
      pendingWorktree: { name: "post-commit-worktree", workspace },
    });
    expect(findLiveRegistryWorktreeByOwner(process.env, "session", key)).toBeUndefined();
  } finally {
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await openClawState.cleanup();
  }
});

test.each([
  {
    name: "agent default",
    request: {},
    catalogTarget: undefined,
    parentEntry: undefined,
    expectedEntry: {},
    expectedTitleSelection: { regularModelRef: "openai/gpt-5.6-luna" },
  },
  {
    name: "explicit model",
    request: { model: "anthropic/sonnet-4.6@work" },
    catalogTarget: undefined,
    parentEntry: undefined,
    expectedEntry: {
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      authProfileOverride: "work",
    },
    expectedTitleSelection: {
      regularModelRef: "anthropic/claude-sonnet-4-6@work",
      preferredProfile: "work",
    },
  },
  {
    name: "registered catalog target",
    request: { catalogId: "claude" },
    catalogTarget: {
      model: "anthropic/sonnet-4.6@catalog-work",
      agentRuntime: "claude-cli",
    },
    parentEntry: undefined,
    expectedEntry: {
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      agentRuntimeOverride: "claude-cli",
      authProfileOverride: "catalog-work",
    },
    expectedTitleSelection: {
      regularModelRef: "anthropic/claude-sonnet-4-6@catalog-work",
      agentHarnessRuntimeOverride: "claude-cli",
      preferredProfile: "catalog-work",
    },
  },
  {
    name: "inherited parent",
    request: { parentSessionKey: "main" },
    catalogTarget: undefined,
    parentEntry: {
      providerOverride: "openai",
      modelOverride: "gpt-5.6-sol",
      modelOverrideSource: "user" as const,
      agentRuntimeOverride: "codex",
      authProfileOverride: "parent-work",
      authProfileOverrideSource: "user" as const,
    },
    expectedEntry: {
      providerOverride: "openai",
      modelOverride: "gpt-5.6-sol",
      agentRuntimeOverride: "codex",
      authProfileOverride: "parent-work",
    },
    expectedTitleSelection: {
      regularModelRef: "openai/gpt-5.6-sol@parent-work",
      agentHarnessRuntimeOverride: "codex",
      preferredProfile: "parent-work",
    },
  },
])(
  "sessions.create shares a title routed through the $name selection with its worktree and first chat send",
  async ({ request, catalogTarget, parentEntry, expectedEntry, expectedTitleSelection }) => {
    const openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-session-worktree-title-selection-",
    });
    const workspace = await initializeGitWorkspace(openClawState.root);
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = {
      workspace,
      model: { primary: "openai/gpt-5.6-luna" },
    };
    agentDiscoveryMock.enabled = true;
    agentDiscoveryMock.models = [
      { id: "gpt-5.6-luna", name: "GPT 5.6 Luna", provider: "openai" },
      { id: "gpt-5.6-sol", name: "GPT 5.6 Sol", provider: "openai" },
      { id: "sonnet-4.6", name: "Sonnet 4.6", provider: "anthropic" },
    ];
    if (catalogTarget) {
      const registry = createEmptyPluginRegistry();
      registry.sessionCatalogs.push({
        pluginId: "anthropic",
        source: "test",
        provider: {
          id: "claude",
          label: "Claude Code",
          resolveCreateSession: () => catalogTarget,
          list: vi.fn(async () => []),
          read: vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] })),
        },
      });
      registry.cliBackends.push({
        pluginId: "anthropic",
        source: "test",
        backend: {
          id: "claude-cli",
          modelProvider: "anthropic",
          config: { command: "claude" },
          bundleMcp: false,
        },
      });
      setActivePluginRegistry(registry);
    }
    const { storePath } = await createSessionStoreDir();
    if (parentEntry) {
      await writeSessionStore({
        entries: { main: sessionStoreEntry("worktree-title-parent", parentEntry) },
      });
    }
    let worktreeId: string | undefined;
    let sessionKey: string | undefined;
    const pastedText = `Pasted deployment plan ${"x".repeat(2_000)}`;
    const context = { chatAbortControllers: new Map<string, ChatAbortControllerEntry>() };
    const message = "Review this rollout [[reply_to_current]]";
    const attachment = {
      type: "file",
      mimeType: "text/plain",
      content: Buffer.from(pastedText).toString("base64"),
    };
    dashboardTitleGenerationMocks.generate.mockResolvedValueOnce("Attachment Repair");
    const dispatchCountBefore = dispatchInboundMessageMock.mock.calls.length;
    dispatchInboundMessageMock.mockResolvedValueOnce({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });
    try {
      const created = await directSessionReq<{
        key: string;
        entry: {
          providerOverride?: string;
          modelOverride?: string;
          agentRuntimeOverride?: string;
          authProfileOverride?: string;
        };
        runId: string;
        runStarted: boolean;
      }>(
        "sessions.create",
        {
          agentId: "main",
          worktree: true,
          message,
          attachments: [attachment],
          ...request,
        },
        { client: { connect: { scopes: ["operator.admin"] } } as never, context },
      );

      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      expect(created.payload?.entry).toMatchObject(expectedEntry);
      expect(created.payload, JSON.stringify(created.payload)).toMatchObject({ runStarted: true });
      sessionKey = requireNonEmptyString(created.payload?.key, "created session key");
      expect(await waitForCreatedSessionRun(context, storePath, sessionKey)).toBe(true);
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
        displayName: "Attachment Repair",
        worktree: { branch: "openclaw/attachment-repair" },
      });
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(dispatchCountBefore + 1);
      worktreeId = loadSessionEntry({ agentId: "main", sessionKey, storePath })?.worktree?.id;
      expect(dashboardTitleGenerationMocks.generate).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 4_000, ...expectedTitleSelection }),
      );
      expect(dashboardTitleGenerationMocks.generate).toHaveBeenCalledOnce();
    } finally {
      for (const entry of context.chatAbortControllers.values()) {
        entry.controller.abort();
      }
      expect(await waitForCreatedSessionRun(context, storePath, sessionKey)).toBe(true);
      if (worktreeId) {
        await managedWorktrees.remove({
          id: worktreeId,
          reason: "test-cleanup",
          allowSnapshotLoss: true,
        });
      }
      setActivePluginRegistry(createEmptyPluginRegistry());
      closeOpenClawStateDatabaseForTest();
      testState.agentConfig = undefined;
      await openClawState.cleanup();
    }
  },
);

test("sessions.create does not start title generation for a model denied by policy", async () => {
  const openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-session-worktree-title-denied-model-",
  });
  const workspace = await initializeGitWorkspace(openClawState.root);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = {
    workspace,
    model: { primary: "openai/gpt-5.6-luna" },
    models: { "openai/gpt-5.6-luna": {} },
  };
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [
    { id: "gpt-5.6-luna", name: "GPT 5.6 Luna", provider: "openai" },
    { id: "sonnet-4.6", name: "Sonnet 4.6", provider: "anthropic" },
  ];
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard:denied-title-route";
  try {
    const created = await directSessionReq(
      "sessions.create",
      {
        agentId: "main",
        key,
        model: "anthropic/sonnet-4.6@work",
        worktree: true,
        message: "Keep this title source on an allowed route",
      },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );

    expect(created.ok).toBe(false);
    expect(created.error?.message).toContain("model not allowed");
    expect(dashboardTitleGenerationMocks.generate).not.toHaveBeenCalled();
    expect(findLiveRegistryWorktreeByOwner(process.env, "session", key)).toBeUndefined();
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toBeUndefined();
  } finally {
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await openClawState.cleanup();
  }
});

test.each([
  {
    name: "generator error",
    key: "agent:main:subagent:worktree-title-error",
    arrange: () => dashboardTitleGenerationMocks.generate.mockRejectedValueOnce(new Error("boom")),
  },
  {
    name: "overall timeout",
    key: "agent:main:subagent:worktree-title-timeout",
    arrange: () =>
      dashboardTitleGenerationMocks.generate.mockReturnValueOnce(new Promise<string>(() => {})),
  },
])(
  "sessions.create falls back to the raw title source after $name",
  async ({ key, arrange }) => {
    const openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-session-worktree-title-fallback-",
    });
    const workspace = await initializeGitWorkspace(openClawState.root);
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = { workspace };
    const { storePath } = await createSessionStoreDir();
    const context = { chatAbortControllers: new Map<string, ChatAbortControllerEntry>() };
    let worktreeId: string | undefined;
    arrange();
    try {
      const created = await directSessionReq<{ runStarted: boolean }>(
        "sessions.create",
        {
          agentId: "main",
          key,
          worktree: true,
          message: "Investigate the raw fallback title",
        },
        { client: { connect: { scopes: ["operator.admin"] } } as never, context },
      );

      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      expect(created.payload?.runStarted).toBe(true);
      expect(await waitForCreatedSessionRun(context, storePath, key)).toBe(true);
      const worktree = loadSessionEntry({ sessionKey: key, storePath })?.worktree;
      worktreeId = worktree?.id;
      expect(worktree?.branch).toBe("openclaw/investigate-the-raw-fallback-title");
      expect(dashboardTitleGenerationMocks.generate).toHaveBeenCalledOnce();
    } finally {
      for (const entry of context.chatAbortControllers.values()) {
        entry.controller.abort();
      }
      expect(await waitForCreatedSessionRun(context, storePath, key)).toBe(true);
      if (worktreeId) {
        await managedWorktrees.remove({
          id: worktreeId,
          reason: "test-cleanup",
          allowSnapshotLoss: true,
        });
      }
      closeOpenClawStateDatabaseForTest();
      testState.agentConfig = undefined;
      await openClawState.cleanup();
    }
  },
  15_000,
);

test("sessions.create keeps the crustacean fallback when no title source exists", async () => {
  const openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-session-worktree-empty-title-",
  });
  const workspace = await initializeGitWorkspace(openClawState.root);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  let worktreeId: string | undefined;
  try {
    const created = await directSessionReq<{ worktree: { id: string; branch: string } }>(
      "sessions.create",
      { agentId: "main", worktree: true },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );

    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    worktreeId = created.payload?.worktree.id;
    expect(created.payload?.worktree.branch).toMatch(
      /^openclaw\/[a-z]+-(?:barnacle|claw|crab|crayfish|krill|langoustine|lobster|prawn|shrimp|shell)$/,
    );
    expect(dashboardTitleGenerationMocks.generate).not.toHaveBeenCalled();
  } finally {
    if (worktreeId) {
      await managedWorktrees.remove({
        id: worktreeId,
        reason: "test-cleanup",
        allowSnapshotLoss: true,
      });
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await openClawState.cleanup();
  }
});

test("sessions.create maps worktree options and preserves a nested workspace cwd", async () => {
  const openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-session-worktree-options-",
  });
  const repoRoot = await initializeGitWorkspace(openClawState.root);
  const workspace = path.join(repoRoot, "packages", "app");
  const worktreePath = path.join(openClawState.root, "managed-worktree");
  const key = "agent:main:dashboard:worktree-options";
  await Promise.all([
    fs.mkdir(workspace, { recursive: true }),
    fs.mkdir(worktreePath, { recursive: true }),
  ]);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  const createSpy = vi.spyOn(managedWorktrees, "create").mockResolvedValue(
    managedWorktreeFixture({
      id: "worktree-options",
      name: "target-task",
      ownerId: key,
      path: worktreePath,
      repoRoot,
    }),
  );
  try {
    const created = await directSessionReq<{
      entry: {
        permissionMode?: string;
        sessionRoot?: string;
        spawnedCwd?: string;
        worktree?: { id: string; branch: string; repoRoot: string };
      };
      worktree: { id: string; path: string; branch: string };
    }>(
      "sessions.create",
      {
        agentId: "main",
        key,
        worktree: true,
        worktreeName: "target-task",
        worktreeBaseRef: "base-branch",
        permissionMode: "workspace",
      },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );

    expect(created.ok).toBe(true);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: workspace,
        ownerKind: "session",
        ownerId: key,
        name: "target-task",
        baseRef: "base-branch",
      }),
    );
    expect(created.payload?.entry).toMatchObject({
      permissionMode: "workspace",
      sessionRoot: worktreePath,
      spawnedCwd: path.join(worktreePath, "packages", "app"),
      worktree: {
        id: "worktree-options",
        branch: "openclaw/target-task",
        repoRoot,
      },
    });
    await expect(fs.stat(path.join(worktreePath, "packages", "app"))).resolves.toBeDefined();

    const rejected = await directSessionReq(
      "sessions.create",
      { agentId: "main", worktreeName: "no-flag" },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );
    expect(rejected.ok).toBe(false);
  } finally {
    createSpy.mockRestore();
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await openClawState.cleanup();
  }
});

test("sessions.create maps an admin-selected worktree cwd and rejects repository changes", async () => {
  const openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-session-selected-workspace-",
  });
  const selectedRoot = tempDirs.make(
    "openclaw-session-selected-repository-",
    await fs.realpath(os.tmpdir()),
  );
  const [configuredWorkspace, selectedWorkspace] = await Promise.all([
    initializeGitWorkspace(openClawState.root),
    initializeGitWorkspace(selectedRoot),
  ]);
  const worktreePath = path.join(openClawState.root, "selected-worktree");
  const key = "agent:main:dashboard:selected-workspace";
  await fs.mkdir(worktreePath, { recursive: true });
  const record = managedWorktreeFixture({
    id: "selected-worktree",
    name: "selected-worktree",
    ownerId: key,
    path: worktreePath,
    repoRoot: selectedWorkspace,
  });
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace: configuredWorkspace };
  await createSessionStoreDir();
  const createSpy = vi.spyOn(managedWorktrees, "create").mockResolvedValue(record);
  const findSpy = vi.spyOn(managedWorktrees, "findLiveById").mockReturnValue(record);
  try {
    const created = await directSessionReq<{
      entry: {
        spawnedCwd?: string;
        worktree?: { canonicalWorkspaceDir?: string };
      };
      worktree: { id: string; path: string };
    }>(
      "sessions.create",
      { agentId: "main", key, worktree: true, cwd: selectedWorkspace },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );

    expect(created.ok).toBe(true);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: selectedWorkspace }),
    );
    expect(created.payload?.entry.spawnedCwd).toBe(worktreePath);
    expect(created.payload?.entry.worktree?.canonicalWorkspaceDir).toBe(selectedWorkspace);

    const mismatched = await directSessionReq(
      "sessions.create",
      { key, agentId: "main", worktree: true, cwd: configuredWorkspace },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );
    expect(mismatched).toMatchObject({
      ok: false,
      error: { message: "session worktree belongs to a different repository" },
    });
  } finally {
    createSpy.mockRestore();
    findSpy.mockRestore();
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await openClawState.cleanup();
  }
});

test("sessions.create accepts a node-host cwd without provisioning a Gateway worktree", async () => {
  // A running suite server can read config before this test installs its per-case session store.
  getRuntimeConfig();
  const { storePath } = await createSessionStoreDir();
  const created = await directSessionReq<{
    key: string;
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
  const sessionKey = requireNonEmptyString(created.payload?.key, "node session key");
  const stored = loadSessionEntry({ agentId: "main", sessionKey, storePath });
  expect(stored).toMatchObject({ execHost: "node", execNode: "macbook" });
  expect(stored).not.toHaveProperty("sessionDiffBaselineCapture");
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

test("sessions.create reset-in-place applies Fast Mode only for admin callers", async () => {
  testState.sessionConfig = { dmScope: "main" };
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: { main: sessionStoreEntry("sess-fast-reset", { fastMode: false }) },
  });
  const params = {
    agentId: "main",
    parentSessionKey: "main",
    emitCommandHooks: true,
    fastMode: true,
  };

  const denied = await directSessionReq("sessions.create", params, {
    client: { connect: { scopes: ["operator.write"] } } as never,
  });
  expect(denied).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN", message: "missing scope: operator.admin" },
  });
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: "agent:main:main", storePath }),
  ).toMatchObject({ sessionId: "sess-fast-reset", fastMode: false });

  const changed = await directSessionReq<{ entry: { fastMode?: boolean } }>(
    "sessions.create",
    params,
    { client: { connect: { scopes: ["operator.admin"] } } as never },
  );
  expect(changed.ok, JSON.stringify(changed.error)).toBe(true);
  expect(changed.payload?.entry.fastMode).toBe(true);
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: "agent:main:main", storePath }),
  ).toMatchObject({ fastMode: true });
});

test("sessions.create rechecks Fast Mode before interrupting reset work", async () => {
  testState.sessionConfig = { dmScope: "main" };
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:main";
  await writeSessionStore({
    entries: { main: sessionStoreEntry("sess-fast-race", { fastMode: false }) },
  });
  let interrupted = false;
  let releaseAdmission = () => {};
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [key, "sess-fast-race"],
    assertAllowed: () => undefined,
    onInterrupt: () => {
      interrupted = true;
      releaseAdmission();
    },
  });
  releaseAdmission = admission.release;
  let replaced = false;
  const commitGuard = () => {
    if (replaced) {
      return;
    }
    replaced = true;
    const current = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
    if (!current) {
      throw new Error("expected current main session");
    }
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key, storePath },
      { ...current, fastMode: true },
    );
  };
  const { createGatewaySession } = await import("./session-create-service.js");

  try {
    const denied = await createGatewaySession({
      cfg: getRuntimeConfig(),
      agentId: "main",
      parentSessionKey: "main",
      emitCommandHooks: true,
      resetMainWhenUnspecified: true,
      fastMode: false,
      requestingOperatorScopes: ["operator.write"],
      allowExistingModelSelection: false,
      commandSource: "test",
      commitGuard,
    });

    expect(denied).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", message: "missing scope: operator.admin" },
    });
    expect(interrupted).toBe(false);
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toMatchObject({
      sessionId: "sess-fast-race",
      fastMode: true,
    });
  } finally {
    admission.release();
  }
});

test("sessions.create rejects a Fast Mode change completed by draining work before reset cleanup", async () => {
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:main";
  const initialEntry = sessionStoreEntry("sess-fast-drain", { fastMode: false });
  await writeSessionStore({ entries: { main: initialEntry } });
  const placements = createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() });
  const claim = placements.claimTurn({
    agentId: "main",
    sessionKey: key,
    sessionId: initialEntry.sessionId,
    owner: { kind: "local" },
    claimId: "fast-drain-claim",
    runId: "fast-drain-run",
  });
  const interrupted = createDeferredCore();
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [key, initialEntry.sessionId],
    assertAllowed: () => undefined,
    onInterrupt: () => interrupted.resolve(),
  });
  const writerEntered = createDeferredCore();
  const releaseWriter = createDeferredCore();
  const heldWriter = runExclusiveSqliteSessionWrite(
    resolveSqliteStoreScope(storePath, { agentId: "main" }),
    async () => {
      writerEntered.resolve();
      await releaseWriter.promise;
    },
  );
  await writerEntered.promise;
  const persisted = persistReplySessionEntry({
    storePath,
    sessionKey: key,
    initialEntry,
    entry: { ...initialEntry, fastMode: true },
    touchedFields: ["fastMode"],
  });
  const { performGatewaySessionReset } = await import("./session-reset-service.js");
  const reset = performGatewaySessionReset({
    key,
    reason: "new",
    commandSource: "test",
    fastModeSelection: { value: false, allowExistingChange: false },
    workerPlacementContext: { workerSessionPlacementService: placements },
  });
  try {
    await interrupted.promise;
    releaseWriter.resolve();
    await heldWriter;
    expect(await persisted).toMatchObject({ status: "current", entry: { fastMode: true } });
    placements.releaseTurn(claim);
    admission.release();
    expect(await reset).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", message: "missing scope: operator.admin" },
    });
    expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();
    expect(sessionLifecycleHookMocks.runSessionEnd).not.toHaveBeenCalled();
    expect(embeddedRunMock.abortCalls).toEqual([]);
    expect(placements.get(initialEntry.sessionId)).toMatchObject({ state: "local" });
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toMatchObject({
      sessionId: initialEntry.sessionId,
      fastMode: true,
    });
  } finally {
    releaseWriter.resolve();
    await heldWriter;
    if (placements.validateTurnClaim(claim)) {
      placements.releaseTurn(claim);
    }
    admission.release();
    await reset;
  }
});

test("sessions.reset preserves the recorded permission boundary", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-permission-reset", {
        permissionMode: "guarded",
        sessionRoot: "/workspace/project",
      }),
    },
  });

  const reset = await directSessionReq<{
    entry: { permissionMode?: string; sessionRoot?: string };
  }>("sessions.reset", { key: "main" });

  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry).toMatchObject({
    permissionMode: "guarded",
    sessionRoot: "/workspace/project",
  });
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

test("sessions.create persists a canonical Gateway cwd without a managed worktree", async () => {
  const root = tempDirs.make("openclaw-session-admin-cwd-");
  const cwd = path.join(root, "real");
  const alias = path.join(root, "alias");
  await fs.mkdir(cwd);
  await fs.symlink(cwd, alias, "dir");
  const created = await directSessionReq(
    "sessions.create",
    { cwd: alias },
    { client: { connect: { scopes: ["operator.admin"] } } as never },
  );

  expect(created.ok).toBe(true);
  expect(
    (
      created.payload as {
        entry?: { sessionRoot?: string; spawnedCwd?: string };
      }
    )?.entry,
  ).toMatchObject({ sessionRoot: cwd, spawnedCwd: cwd });
});

test("sessions.create rejects a regular-file Gateway cwd before creating session state", async () => {
  const root = tempDirs.make("openclaw-session-file-cwd-");
  const cwd = path.join(root, "workspace.txt");
  const key = "agent:main:dashboard:file-cwd";
  await fs.writeFile(cwd, "not a directory\n");
  const { storePath } = await createSessionStoreDir();
  const { ws } = await openClient({
    scopes: ["operator.admin"],
    deviceIdentityPath: path.join(root, "device.json"),
  });
  try {
    const created = await rpcReq(ws, "sessions.create", { agentId: "main", key, cwd });

    expect(created).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "sessions.create cwd is not a directory",
      },
    });
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toBeUndefined();
  } finally {
    ws.close();
  }
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
    const created = await rpcReq<{
      entry?: { sessionRoot?: string; spawnedCwd?: string };
    }>(ws, "sessions.create", { cwd });

    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(created.payload?.entry?.spawnedCwd).toBe(cwd);
    expect(created.payload?.entry?.sessionRoot).toBe(cwd);
  } finally {
    ws.close();
    testState.agentConfig = undefined;
  }
});

test("sessions.create records the selected agent workspace when cwd is omitted", async () => {
  const workspace = tempDirs.make("openclaw-session-default-root-");
  const expectedRoot = await fs.realpath(workspace);
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  try {
    const created = await directSessionReq<{
      entry: { permissionMode?: string; sessionRoot?: string; spawnedCwd?: string };
      key?: string;
      sessionId?: string;
    }>("sessions.create", { agentId: "main", permissionMode: "guarded" });

    expect(created.ok).toBe(true);
    expect(created.payload?.entry).toMatchObject({
      permissionMode: "guarded",
      sessionRoot: expectedRoot,
    });
    expect(created.payload?.entry.spawnedCwd).toBeUndefined();
    await expect(
      loadTranscriptEvents({
        agentId: "main",
        sessionId: requireNonEmptyString(created.payload?.sessionId, "guarded session id"),
        sessionKey: requireNonEmptyString(created.payload?.key, "guarded session key"),
        storePath,
      }),
    ).resolves.toEqual([expect.objectContaining({ cwd: expectedRoot, type: "session" })]);
  } finally {
    testState.agentConfig = undefined;
  }
});

test("sessions.create requires admin for full permission mode", async () => {
  const workspace = tempDirs.make("openclaw-session-full-mode-");
  testState.agentConfig = { workspace };
  const writer = await openClient({
    scopes: ["operator.write"],
    deviceIdentityPath: path.join(workspace, "writer.json"),
  });
  const admin = await openClient({
    scopes: ["operator.admin"],
    deviceIdentityPath: path.join(workspace, "admin.json"),
  });
  try {
    await expect(
      rpcReq(writer.ws, "sessions.create", { agentId: "main", permissionMode: "full" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { message: "missing scope: operator.admin" },
    });
    await expect(
      rpcReq(admin.ws, "sessions.create", { agentId: "main", permissionMode: "full" }),
    ).resolves.toMatchObject({
      ok: true,
      payload: { entry: { permissionMode: "full", sessionRoot: workspace } },
    });
  } finally {
    writer.ws.close();
    admin.ws.close();
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
  const workspace = tempDirs.make("openclaw-session-sandbox-workspace-");
  testState.agentConfig = { workspace, sandbox: { mode: "all" } };
  try {
    const cwd = path.join(workspace, "packages", "app");
    await fs.mkdir(cwd, { recursive: true });
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
      await managedWorktrees.remove({
        id: worktreeId,
        reason: "test-cleanup",
        allowSnapshotLoss: true,
      });
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await openClawState.cleanup();
  }
});

test.each([
  { name: "a dirty checkout", outcome: "dirty" },
  { name: "a concurrently finalized checkout", outcome: "finalized" },
  { name: "successful cleanup", outcome: "removed" },
  { name: "a cleanup exception", outcome: "failed" },
] as const)(
  "sessions.create reset-in-place reports cleanup truth for $name",
  async ({ outcome }) => {
    const openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-reset-retained-worktree-",
    });
    const root = openClawState.root;
    const workspace = await initializeGitWorkspace(root);
    const origin = path.join(root, "origin.git");
    await execFileAsync("git", ["init", "--bare", origin]);
    await execFileAsync("git", ["-C", workspace, "remote", "add", "origin", origin]);
    await execFileAsync("git", ["-C", workspace, "push", "-u", "origin", "main"]);
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = { workspace };
    testState.sessionConfig = { dmScope: "main" };
    const { storePath } = await createSessionStoreDir();
    await writeSessionStore({ entries: { main: sessionStoreEntry("sess-retained-parent") } });
    const warnSpy = vi.spyOn(sessionLog, "warn").mockImplementation(() => {});
    const originalRemoveIfLossless = managedWorktrees.removeIfLossless.bind(managedWorktrees);
    let restoreRemoveIfLossless = () => {};
    let worktreeId: string | undefined;
    try {
      const created = await directSessionReq<{
        worktree: { id: string; path: string; branch: string };
      }>(
        "sessions.create",
        { agentId: "main", parentSessionKey: "main", emitCommandHooks: true, worktree: true },
        { client: { connect: { scopes: ["operator.admin"] } } as never },
      );
      expect(created.ok).toBe(true);
      const worktree = created.payload!.worktree;
      worktreeId = worktree.id;
      const dirtyFile = path.join(worktree.path, "retained-work.txt");
      if (outcome === "dirty") {
        await fs.writeFile(dirtyFile, "preserve my work\n");
      } else if (outcome === "finalized" || outcome === "failed") {
        const removeSpy = vi
          .spyOn(managedWorktrees, "removeIfLossless")
          .mockImplementation(async (id) => {
            if (outcome === "failed") {
              throw new Error("simulated cleanup failure");
            }
            await originalRemoveIfLossless(id);
            return false;
          });
        restoreRemoveIfLossless = () => removeSpy.mockRestore();
      }

      const reset = await directSessionReq<{
        entry: { spawnedCwd?: string; sessionRoot?: string; worktree?: unknown };
      }>(
        "sessions.create",
        { agentId: "main", parentSessionKey: "main", emitCommandHooks: true },
        { client: { connect: { scopes: ["operator.write"] } } as never },
      );

      expect(reset.ok).toBe(true);
      expect(reset.payload).not.toHaveProperty("worktreePreserved");
      expect(reset.payload?.entry.spawnedCwd).toBeUndefined();
      expect(reset.payload?.entry.sessionRoot).toBeUndefined();
      expect(reset.payload?.entry.worktree).toBeUndefined();
      expect(
        loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.worktree,
      ).toBeUndefined();
      if (outcome === "dirty") {
        expect(getRegistryWorktree(process.env, worktree.id)).toMatchObject({
          runEndCleanup: { outcome: "retained-dirty" },
        });
        await expect(fs.readFile(dirtyFile, "utf8")).resolves.toBe("preserve my work\n");
        expect(warnSpy).toHaveBeenCalledOnce();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(worktree.branch));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(worktree.path));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("retained-dirty"));
      } else if (outcome === "failed") {
        expect(getRegistryWorktree(process.env, worktree.id)?.removedAt).toBeUndefined();
        await expect(fs.access(worktree.path)).resolves.toBeUndefined();
        expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
          "failed to finalize session worktree lifecycle: simulated cleanup failure",
        );
      } else {
        expect(getRegistryWorktree(process.env, worktree.id)?.removedAt).toEqual(
          expect.any(Number),
        );
        await expect(fs.access(worktree.path)).rejects.toThrow();
        expect(warnSpy).not.toHaveBeenCalled();
      }
    } finally {
      restoreRemoveIfLossless();
      warnSpy.mockRestore();
      if (worktreeId && getRegistryWorktree(process.env, worktreeId)?.removedAt === undefined) {
        await managedWorktrees.remove({
          id: worktreeId,
          reason: "test-cleanup",
          allowSnapshotLoss: true,
        });
      }
      closeOpenClawStateDatabaseForTest();
      testState.agentConfig = undefined;
      testState.sessionConfig = undefined;
      await openClawState.cleanup();
    }
  },
);

test("sessions.create reset-in-place detaches the prior worktree permission boundary", async () => {
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
      entry: { spawnedCwd?: string; sessionRoot?: string; permissionMode?: string };
      resolved: { modelProvider?: string; model?: string };
      worktree: { id: string; path: string; branch: string };
    }>(
      "sessions.create",
      {
        agentId: "main",
        parentSessionKey: "main",
        emitCommandHooks: true,
        worktree: true,
        permissionMode: "workspace",
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
    expect(created.payload?.entry.sessionRoot).toBe(worktree?.path);
    expect(created.payload?.entry.permissionMode).toBe("workspace");
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
      entry: { spawnedCwd?: string; sessionRoot?: string; permissionMode?: string };
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
    expect(reset.payload?.entry.sessionRoot).toBeUndefined();
    expect(reset.payload?.entry.permissionMode).toBeUndefined();
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
      await managedWorktrees.remove({
        id: worktreeId,
        reason: "test-cleanup",
        allowSnapshotLoss: true,
      });
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    testState.sessionConfig = undefined;
    await openClawState.cleanup();
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

test("sessions.create stores dashboard model, thinking, fast mode, and parent linkage", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "ops" }] };
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
      fastMode?: boolean | "auto";
      parentSessionKey?: string;
      sessionFile?: string;
    };
  }>("sessions.create", {
    agentId: "ops",
    label: "Dashboard Chat",
    model: "openai/gpt-test-a",
    thinkingLevel: "high",
    fastMode: true,
    parentSessionKey: "main",
  });

  expect(created.ok).toBe(true);
  expect(created.payload?.key).toMatch(/^agent:ops:dashboard:/);
  expect(created.payload?.entry?.label).toBe("Dashboard Chat");
  expect(created.payload?.entry?.providerOverride).toBe("openai");
  expect(created.payload?.entry?.modelOverride).toBe("gpt-test-a");
  expect(created.payload?.entry?.thinkingLevel).toBe("high");
  expect(created.payload?.entry?.fastMode).toBe(true);
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
  expect(storedEntry?.fastMode).toBe(true);
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
            actor: { type: "agent", id: "main" },
            requesterSessionKey: parentSessionKey,
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
    createdActor: { type: "agent", id: "main" },
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
  expect(
    loadCombinedSessionStoreForGatewayCore(getRuntimeConfig()).store[sessionKey],
  ).toBeUndefined();
});

test("sessions.create commits no child after its bound Gateway is replaced", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:gateway-replacement-race";
  const admitted = {};
  const replacement = {};
  let current = admitted;
  let guardCalls = 0;
  const firstGuard = createDeferredCore();
  const writerEntered = createDeferredCore();
  const releaseWriter = createDeferredCore();
  const resolvedStore = resolveSqliteStoreScope(storePath, { agentId: "main" });
  const heldWriter = runExclusiveSqliteSessionWrite(resolvedStore, async () => {
    writerEntered.resolve();
    await releaseWriter.promise;
  });
  await writerEntered.promise;
  const creating = directSessionReq(
    "sessions.create",
    { agentId: "main", key: sessionKey },
    {
      sessionMutationAuthorization: {
        assertCurrent: () => {
          if (current !== admitted) {
            throw new Error("current gateway instance binding was replaced");
          }
          guardCalls += 1;
          if (guardCalls === 1) {
            firstGuard.resolve();
          }
        },
        assertTargetCurrent: vi.fn(),
      },
    },
  );

  await firstGuard.promise;
  current = replacement;
  releaseWriter.resolve();
  await heldWriter;

  await expect(creating).rejects.toThrow("current gateway instance binding was replaced");
  expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toBeUndefined();
});

test("sessions.create commits no child after its worker turn closes", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:worker-turn-race";
  const placements = createWorkerSessionPlacementStore({
    database: openOpenClawStateDatabase(),
  });
  let placement = placements.startDispatch({
    agentId: "main",
    sessionId: "worker-source-session",
    sessionKey: "agent:main:dashboard:worker-source",
  });
  for (const [from, to, patch] of [
    ["requested", "provisioning", { environmentId: "worker-environment" }],
    ["provisioning", "syncing", { workerBundleHash: "a".repeat(64) }],
    [
      "syncing",
      "starting",
      { remoteWorkspaceDir: "/workspace/source", workspaceBaseManifestRef: "manifest-source" },
    ],
    ["starting", "active", { activeOwnerEpoch: 7 }],
  ] as const) {
    placement = placements.transition({
      sessionId: placement.sessionId,
      from,
      to,
      expectedGeneration: placement.generation,
      patch,
    });
  }
  const turnClaim = placements.claimTurn({
    agentId: placement.agentId,
    sessionId: placement.sessionId,
    sessionKey: placement.sessionKey,
    claimId: "worker-claim",
    runId: "worker-run",
    owner: { kind: "worker", environmentId: "worker-environment", ownerEpoch: 7 },
  });
  let guardCalls = 0;
  const firstGuard = createDeferredCore();
  const writerEntered = createDeferredCore();
  const releaseWriter = createDeferredCore();
  const heldWriter = runExclusiveSqliteSessionWrite(
    resolveSqliteStoreScope(storePath, { agentId: "main" }),
    async () => {
      writerEntered.resolve();
      await releaseWriter.promise;
    },
  );
  await writerEntered.promise;
  const creating = directSessionReq(
    "sessions.create",
    { agentId: "main", key: sessionKey },
    {
      sessionMutationAuthorization: {
        assertCurrent: () => {
          if (!placements.validateTurnClaim(turnClaim)) {
            throw new Error("worker turn authority changed");
          }
          if (++guardCalls === 1) {
            firstGuard.resolve();
          }
        },
        assertTargetCurrent: vi.fn(),
      },
    },
  );

  await firstGuard.promise;
  placements.releaseTurn(turnClaim);
  releaseWriter.resolve();
  await heldWriter;

  await expect(creating).rejects.toThrow("worker turn authority changed");
  expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toBeUndefined();
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
    expect(
      loadCombinedSessionStoreForGatewayCore(getRuntimeConfig()).store[sessionKey],
    ).toBeDefined();
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
  testState.sessionConfig = { dmScope: "per-channel-peer" };
  await createSessionStoreDir();

  const created = await directSessionReq<{
    entry?: { parentSessionKey?: string };
  }>("sessions.create", { agentId: "main" });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.entry?.parentSessionKey).toBeUndefined();
});

test("sessions.create leaves dashboard sessions unparented under global session scope", async () => {
  testState.sessionConfig = { dmScope: "main", scope: "global" };
  await createSessionStoreDir();

  const created = await directSessionReq<{
    entry?: { parentSessionKey?: string };
  }>("sessions.create", { agentId: "main" });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.entry?.parentSessionKey).toBeUndefined();
});

test("sessions.create does not parent the main session to itself", async () => {
  testState.sessionConfig = { dmScope: "main" };
  await createSessionStoreDir();

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

  const overridden = await directSessionReq<{
    entry?: { fastMode?: boolean | "auto" };
  }>("sessions.create", {
    agentId: "main",
    fastMode: false,
    parentSessionKey: "main",
  });
  expect(overridden.ok, JSON.stringify(overridden.error)).toBe(true);
  expect(overridden.payload?.entry?.fastMode).toBe(false);
});

test("sessions.create skips inherited active auto fallback model overrides", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentConfig = { model: { primary: "openai/gpt-primary" } };
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-parent-auto-fallback", {
        providerOverride: "google-vertex",
        modelOverride: "gemini-fallback",
        modelOverrideSource: "auto",
        modelOverrideFallbackOriginProvider: "openai",
        modelOverrideFallbackOriginModel: "gpt-primary",
        agentRuntimeOverride: "vertex-runtime",
        contextWindow: "1m",
        authProfileOverride: "google-vertex:fallback",
        authProfileOverrideSource: "auto",
        thinkingLevel: "high",
      }),
    },
  });

  const created = await directSessionReq<{
    key?: string;
    resolved?: { modelProvider?: string; model?: string };
    entry?: {
      parentSessionKey?: string;
      providerOverride?: string;
      modelOverride?: string;
      modelOverrideSource?: string;
      agentRuntimeOverride?: string;
      contextWindow?: string;
      authProfileOverride?: string;
      authProfileOverrideSource?: string;
      thinkingLevel?: string;
    };
  }>("sessions.create", {
    agentId: "main",
    parentSessionKey: "main",
  });

  expect(created.ok).toBe(true);
  expect(created.payload?.entry?.parentSessionKey).toBe("agent:main:main");
  expect(created.payload?.entry?.providerOverride).toBeUndefined();
  expect(created.payload?.entry?.modelOverride).toBeUndefined();
  expect(created.payload?.entry?.modelOverrideSource).toBeUndefined();
  expect(created.payload?.entry?.agentRuntimeOverride).toBeUndefined();
  expect(created.payload?.entry?.contextWindow).toBe("1m");
  expect(created.payload?.entry?.authProfileOverride).toBeUndefined();
  expect(created.payload?.entry?.authProfileOverrideSource).toBeUndefined();
  expect(created.payload?.entry?.thinkingLevel).toBe("high");
  expect(created.payload?.resolved).toEqual({ modelProvider: "openai", model: "gpt-primary" });

  const key = created.payload?.key as string;
  const storedEntry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
  expect(storedEntry?.parentSessionKey).toBe("agent:main:main");
  expect(storedEntry?.providerOverride).toBeUndefined();
  expect(storedEntry?.modelOverride).toBeUndefined();
  expect(storedEntry?.agentRuntimeOverride).toBeUndefined();
  expect(storedEntry?.contextWindow).toBe("1m");
  expect(storedEntry?.authProfileOverride).toBeUndefined();
  expect(storedEntry?.authProfileOverrideSource).toBeUndefined();
  expect(storedEntry?.thinkingLevel).toBe("high");
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
  testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "ops-agent" }] };

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

test("sessions.create preserves write-scoped fresh selection but gates adopted rows", async () => {
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
        fastMode: false,
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
    entry?: { fastMode?: boolean; providerOverride?: string; modelOverride?: string };
  }>(
    "sessions.create",
    { key: freshKey, model: "openai/gpt-test-a", fastMode: true },
    { client: writeClient },
  );
  expect(fresh.ok, JSON.stringify(fresh.error)).toBe(true);
  expect(fresh.payload?.entry).toMatchObject({
    providerOverride: "openai",
    modelOverride: "gpt-test-a",
    fastMode: true,
  });

  const sameSelection = await directSessionReq<{
    entry?: {
      fastMode?: boolean;
      providerOverride?: string;
      modelOverride?: string;
      thinkingLevel?: string;
    };
  }>(
    "sessions.create",
    { key: existingKey, model: "openai/gpt-test-a", thinkingLevel: "low", fastMode: false },
    { client: writeClient },
  );
  expect(sameSelection.ok, JSON.stringify(sameSelection.error)).toBe(true);
  expect(sameSelection.payload?.entry).toMatchObject({
    providerOverride: "openai",
    modelOverride: "gpt-test-a",
    thinkingLevel: "low",
    fastMode: false,
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

  const fastModeDenied = await directSessionReq(
    "sessions.create",
    { key: existingKey, fastMode: true },
    { client: writeClient },
  );
  expect(fastModeDenied.ok).toBe(false);
  expect(fastModeDenied.error).toMatchObject({
    code: "FORBIDDEN",
    message: "missing scope: operator.admin",
  });

  const admin = await directSessionReq<{
    entry?: {
      fastMode?: boolean;
      providerOverride?: string;
      modelOverride?: string;
      thinkingLevel?: string;
    };
  }>(
    "sessions.create",
    { key: existingKey, model: "openai/gpt-test-b", thinkingLevel: "high", fastMode: true },
    { client: adminClient },
  );
  expect(admin.ok, JSON.stringify(admin.error)).toBe(true);
  expect(admin.payload?.entry).toMatchObject({
    providerOverride: "openai",
    modelOverride: "gpt-test-b",
    thinkingLevel: "high",
    fastMode: true,
  });
});

test("sessions.create model change clears a selection the new model does not support", async () => {
  const { storePath } = await createSessionStoreDir();
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [
    {
      id: "gpt-test-a",
      name: "A",
      provider: "openai",
      contextWindows: [
        { id: "200k", label: "200K", contextWindow: 200_000 },
        { id: "1m", label: "1M", contextWindow: 1_000_000 },
      ],
      contextWindowDefault: "1m",
    },
    { id: "gpt-test-b", name: "B", provider: "openai" },
  ];
  const adminClient = { connect: { scopes: ["operator.admin"] } } as never;
  const existingKey = "agent:main:dashboard:selected-window";
  await writeSessionStore({
    entries: {
      [existingKey]: sessionStoreEntry("sess-selected-window", {
        providerOverride: "openai",
        modelOverride: "gpt-test-a",
        contextWindow: "200k",
      }),
    },
  });

  // Create-with-key adoption omits contextWindow, so the model change must take
  // the clearing branch for the now-unsupported selection instead of rejecting.
  const changed = await directSessionReq<{
    entry?: { modelOverride?: string; contextWindow?: string };
  }>("sessions.create", { key: existingKey, model: "openai/gpt-test-b" }, { client: adminClient });
  expect(changed.ok, JSON.stringify(changed.error)).toBe(true);
  expect(changed.payload?.entry?.modelOverride).toBe("gpt-test-b");
  expect(changed.payload?.entry?.contextWindow).toBeUndefined();
  const stored = loadSessionEntry({ sessionKey: existingKey, storePath });
  expect(stored?.modelOverride).toBe("gpt-test-b");
  expect(stored?.contextWindow).toBeUndefined();
});

test("sessions.create stamps trusted operator provenance and records created", async () => {
  const { storePath } = await createSessionStoreDir();
  const profileId = "profile-session-creator";
  const client = {
    connect: { scopes: ["operator.write"] },
    authenticatedUserProfile: {
      profileId,
      displayName: "Test Operator",
      hasAvatar: false,
      updatedAt: 1,
    },
  };
  attachGatewayLocalUserIngress(
    client,
    prepareGatewayLocalUserIngress({
      authenticatedUserExpected: true,
      profile: { profileId, displayName: "Test Operator" },
      isLocalClient: false,
    }),
  );
  const created = await directSessionReq<{
    key?: string;
    entry?: {
      createdVia?: string;
      createdActor?: { type: string; id?: string };
      createdAt?: number;
    };
  }>("sessions.create", { agentId: "main" }, { client: client as never });

  expect(created.ok).toBe(true);
  expect(created.payload?.entry).toMatchObject({
    createdVia: "operator",
    createdActor: { type: "human", id: profileId },
    createdAt: expect.any(Number),
  });
  expect(created.payload?.entry).not.toHaveProperty("createdActor.label");
  const key = requireNonEmptyString(created.payload?.key, "created session key");
  expect(loadSessionEntry({ sessionKey: key, storePath })).not.toHaveProperty("createdActor.label");
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

  for (const { actor, sandbox } of [
    { actor: { type: "agent", id: "main" }, sandbox: undefined },
    { actor: { type: "human", id: "profile-delegated-creator" }, sandbox: "required" },
  ] as const) {
    // The required parent's creation policy survives removal of gateway.roles.
    const hinted = await directSessionReq<{
      key?: string;
      entry?: { createdVia?: string; createdActor?: unknown; sandbox?: "required" };
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
              actor,
              sandbox,
              requesterSessionKey: "agent:main:main",
            },
          },
        } as never,
      },
    );
    expect(hinted.ok, JSON.stringify(hinted.error)).toBe(true);
    expect(hinted.payload?.entry).toMatchObject({ createdVia: "spawn", createdActor: actor });
    expect(hinted.payload?.entry?.sandbox).toBe(sandbox);
    const hintedKey = requireNonEmptyString(hinted.payload?.key, "delegated session key");
    const stored = loadSessionEntry({ sessionKey: hintedKey, storePath });
    expect(stored).toMatchObject({ createdVia: "spawn", createdActor: actor });
    expect(stored?.sandbox).toBe(sandbox);
  }
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

test("sessions.create replays an identical creation once and rejects conflicting intent", async () => {
  await createSessionStoreDir();
  const { chatHandlers } = await import("./server-methods/chat.js");
  const { sessionCreateHandlers } = await import("./server-methods/sessions-create.js");
  let sharedContext:
    | Parameters<NonNullable<(typeof chatHandlers)["chat.send"]>>[0]["context"]
    | undefined;
  const chatSend = vi
    .spyOn(chatHandlers, "chat.send")
    .mockImplementation(async ({ context, respond }) => {
      sharedContext ??= context;
      respond(true, { runId: "create-once", status: "started" });
    });
  const dedupe = new Map();
  const client = {
    connect: {
      role: "operator",
      scopes: ["operator.write", "operator.admin"],
      device: { id: "control-ui-device" },
    },
    authenticatedUserProfile: { profileId: "profile-owner" },
  };
  const params = {
    agentId: "main",
    idempotencyKey: "create-once",
    message: "start this task exactly once",
    permissionMode: "full",
  };
  const request = async (nextParams = params, nextClient = client) => {
    if (!sharedContext) {
      return await directSessionReq<{ key: string }>("sessions.create", nextParams, {
        client: nextClient as never,
        context: { dedupe },
      });
    }
    let result:
      | { ok: boolean; payload?: { key: string }; error?: { code?: string; message?: string } }
      | undefined;
    await sessionCreateHandlers["sessions.create"]?.({
      req: {} as never,
      params: nextParams,
      client: nextClient as never,
      context: sharedContext,
      isWebchatConnect: () => false,
      respond: (ok, payload, error) => {
        result = { ok, payload: payload as { key: string } | undefined, error };
      },
    });
    if (!result) {
      throw new Error("sessions.create did not respond");
    }
    return result;
  };

  try {
    const first = await request();
    const replay = await request(
      {
        message: params.message,
        permissionMode: params.permissionMode,
        idempotencyKey: params.idempotencyKey,
        agentId: params.agentId,
      },
      {
        ...client,
        connect: {
          ...client.connect,
          scopes: ["operator.admin", "operator.read", "operator.write"],
        },
      },
    );

    expect(first.ok).toBe(true);
    expect(replay).toEqual(first);
    expect(chatSend).toHaveBeenCalledOnce();
    expect(chatSend.mock.calls[0]?.[0].params).toMatchObject({
      idempotencyKey: expect.any(String),
      message: "start this task exactly once",
    });

    const conflict = await request({ ...params, message: "start a different task" });
    expect(conflict).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "session creation idempotency key was reused with different parameters",
      },
    });
    expect(chatSend).toHaveBeenCalledOnce();

    const downgraded = await request(params, {
      ...client,
      connect: { ...client.connect, scopes: ["operator.write"] },
    });
    expect(downgraded).toMatchObject({
      ok: false,
      error: { message: "missing scope: operator.admin" },
    });
    expect(chatSend).toHaveBeenCalledOnce();

    const differentOwner = await request(params, {
      ...client,
      authenticatedUserProfile: { profileId: "profile-other" },
    });
    expect(differentOwner.ok).toBe(true);
    expect(differentOwner.payload?.key).not.toBe(first.payload?.key);
    expect(chatSend).toHaveBeenCalledTimes(2);
    expect(chatSend.mock.calls[1]?.[0].params.idempotencyKey).not.toBe(
      chatSend.mock.calls[0]?.[0].params.idempotencyKey,
    );
  } finally {
    chatSend.mockRestore();
  }
});

test("sessions.create scopes the main alias to the requested agent", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "longmemeval" }] };
  testState.agentConfig = { sessionStore: { agentId: "longmemeval" } };

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

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
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
  testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "longmemeval" }] };
  testState.agentConfig = { sessionStore: { agentId: "longmemeval" } };

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

  expect(globalCreated.ok, JSON.stringify(globalCreated.error)).toBe(true);
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

test("sessions.create applies configured fixed-store ownership to bare keys", async () => {
  const { storePath } = await createSessionStoreDir();
  const broadcastToConnIds = vi.fn();
  testState.agentsConfig = {
    ownership: "explicit",
    entries: { ops: {}, research: {} },
  };
  testState.agentConfig = { sessionStore: { agentId: "ops" } };
  const { clearConfigCache, clearRuntimeConfigSnapshot } = await getGatewayConfigModule();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  try {
    const created = await directSessionReq<{ key?: string; sessionId?: string }>(
      "sessions.create",
      { key: "global" },
      {
        context: {
          broadcastToConnIds,
          getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
        },
      },
    );

    expect(created.ok, JSON.stringify(created)).toBe(true);
    expect(created.payload?.key).toBe("global");
    expect(loadSessionEntry({ agentId: "ops", sessionKey: "global", storePath })?.sessionId).toBe(
      created.payload?.sessionId,
    );
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({ sessionKey: "global", agentId: "ops", reason: "create" }),
      new Set(["conn-1"]),
      { dropIfSlow: true, agentId: "ops", sessionKeys: ["global"] },
    );

    const conflict = await directSessionReq("sessions.create", {
      key: "global",
      agentId: "research",
    });
    expect(conflict).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: 'agent "research" does not match session key agent "ops"',
      },
    });
  } finally {
    testState.agentsConfig = undefined;
    testState.agentConfig = {};
  }
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
  const { mainStorePath, storeTemplate, workStorePath } = await createSelectedGlobalSessionStore();
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

    const result = await directSessionReq<{ messages?: unknown[] }>(
      "sessions.get",
      {
        key: "global",
        agentId: "work",
      },
      {
        context: {
          getRuntimeConfig: () => ({
            agents: { entries: { main: {}, work: {} } },
            session: { scope: "global", store: storeTemplate },
          }),
        },
      },
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
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
  testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "ops" }] };

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

test("sessions.create rejects forkFrom without fork", async () => {
  await createSessionStoreDir();

  const created = await directSessionReq("sessions.create", {
    parentSessionKey: "main",
    forkFrom: "last-completed",
  });

  expect(created.ok).toBe(false);
  expect(created.error).toMatchObject({
    code: "INVALID_REQUEST",
    message: "forkFrom requires fork=true",
  });
});

test("sessions.create retains the 100K fallback when only another provider has model capacity", async () => {
  const { dir } = await createSessionStoreDir();
  testState.sessionConfig = { scope: "per-sender" };
  resetContextWindowCacheForTest();
  applyDiscoveredContextWindows({
    cache: getContextWindowCaches().discoveredTokenCache,
    models: [{ id: "unresolved-model", provider: "other-provider", contextTokens: 300_000 }],
  });
  const parent = await createCheckpointFixture(dir);
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(parent.sessionId, {
        sessionFile: parent.sessionFile,
        providerOverride: "unresolved-provider",
        modelOverride: "unresolved-model",
        modelOverrideSource: "user",
        // Fresh persisted usage above DEFAULT_PARENT_FORK_MAX_TOKENS (100K).
        totalTokens: 200_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      }),
    },
  });

  try {
    const created = await directSessionReq("sessions.create", {
      agentId: "main",
      parentSessionKey: "main",
      fork: true,
    });

    expect(created.ok).toBe(false);
    expect((created.error as { message?: string } | undefined)?.message ?? "").toContain(
      "200000/100000 tokens",
    );
  } finally {
    resetContextWindowCacheForTest();
    testState.sessionConfig = undefined;
  }
});

test("sessions.create admits an explicit fork within the child model context window", async () => {
  const { dir } = await createSessionStoreDir();
  testState.sessionConfig = { scope: "per-sender" };
  agentDiscoveryMock.models = [
    { id: "gpt-large", name: "Large", provider: "openai", contextWindow: 922_000 },
  ];
  const parent = await createCheckpointFixture(dir);
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(parent.sessionId, {
        sessionFile: parent.sessionFile,
        providerOverride: "openai",
        modelOverride: "gpt-large",
        totalTokens: 391_869,
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

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  agentDiscoveryMock.models = [];
  testState.sessionConfig = undefined;
});

test("sessions.create rejects an explicit fork above the selected child model window", async () => {
  const { dir } = await createSessionStoreDir();
  testState.sessionConfig = { scope: "per-sender" };
  agentDiscoveryMock.models = [
    { id: "gpt-small", name: "Small", provider: "openai", contextWindow: 128_000 },
  ];
  const parent = await createCheckpointFixture(dir);
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(parent.sessionId, {
        sessionFile: parent.sessionFile,
        totalTokens: 150_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      }),
    },
  });

  const created = await directSessionReq("sessions.create", {
    agentId: "main",
    model: "openai/gpt-small",
    parentSessionKey: "main",
    fork: true,
  });

  expect(created.ok).toBe(false);
  expect((created.error as { message?: string } | undefined)?.message ?? "").toContain(
    "150000/128000 tokens",
  );
  agentDiscoveryMock.models = [];
  testState.sessionConfig = undefined;
});

test("sessions.create clamps configured capacity to the selected child model window", async () => {
  const { dir } = await createSessionStoreDir();
  testState.sessionConfig = { scope: "per-sender" };
  agentDiscoveryMock.models = [
    {
      id: "gpt-selectable",
      name: "Selectable",
      provider: "openai",
      contextWindows: [
        { id: "200k", label: "200K", contextWindow: 200_000 },
        { id: "1m", label: "1M", contextWindow: 1_000_000 },
      ],
      contextWindowDefault: "1m",
    },
  ];
  const parent = await createCheckpointFixture(dir);
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(parent.sessionId, {
        sessionFile: parent.sessionFile,
        totalTokens: 300_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      }),
    },
  });
  const cfg = getRuntimeConfig();

  const created = await directSessionReq(
    "sessions.create",
    {
      agentId: "main",
      contextWindow: "200k",
      fork: true,
      model: "openai/gpt-selectable",
      parentSessionKey: "main",
    },
    {
      context: {
        getRuntimeConfig: () => ({
          ...cfg,
          models: {
            providers: {
              openai: { models: [{ id: "gpt-selectable", contextTokens: 1_000_000 }] },
            },
          },
        }),
      },
    },
  );

  expect(created.ok).toBe(false);
  expect((created.error as { message?: string } | undefined)?.message ?? "").toContain(
    "300000/200000 tokens",
  );
  agentDiscoveryMock.models = [];
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

test("sessions.create forks an active parent from its last completed message", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.sessionConfig = { scope: "per-sender" };
  const parentSessionId = "sess-active-completed-fork-parent";
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(parentSessionId, {
        // The in-flight tail can make the whole parent exceed the cap; only the
        // selected completed prefix should govern this fork.
        totalTokens: 200_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      }),
    },
  });
  await seedSessionTranscript({
    sessionId: parentSessionId,
    sessionKey: "agent:main:main",
    storePath,
    messages: [
      { role: "user", content: "completed question" },
      {
        role: "assistant",
        content: [{ type: "text", text: "completed answer" }],
        stopReason: "stop",
      },
      { role: "user", content: "active question" },
      {
        role: "assistant",
        content: [{ type: "text", text: "active tool call" }],
        stopReason: "toolUse",
      },
    ],
  });
  embeddedRunMock.activeIds.add(parentSessionId);
  try {
    const created = await directSessionReq<{ key: string; sessionId: string }>("sessions.create", {
      parentSessionKey: "main",
      fork: true,
      forkFrom: "last-completed",
    });

    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const messages = await loadTranscriptEvents({
      sessionId: created.payload?.sessionId ?? "",
      sessionKey: created.payload?.key ?? "",
      storePath,
    });
    expect(
      messages.flatMap((entry) =>
        entry &&
        typeof entry === "object" &&
        "type" in entry &&
        entry.type === "message" &&
        "message" in entry
          ? [entry.message]
          : [],
      ),
    ).toEqual([
      expect.objectContaining({ role: "user", content: "completed question" }),
      expect.objectContaining({ role: "assistant", stopReason: "stop" }),
    ]);
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
