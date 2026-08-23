// Session delete lifecycle tests protect transcript deletion, ACP metadata,
// active-run cleanup, hooks, thread bindings, and browser/MCP cleanup.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  readAcpSessionMeta,
  writeAcpSessionMetaForMigration,
} from "../acp/runtime/session-meta.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import {
  beginSessionWorkAdmission,
  runExclusiveSessionLifecycleMutation,
} from "../sessions/session-lifecycle-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { SessionMutationAuthorization } from "./server-methods/shared-types.js";
import { embeddedRunMock, rpcReq, writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionLifecycleHookMocks,
  subagentLifecycleHookMocks,
  subagentLifecycleHookState,
  threadBindingMocks,
  acpManagerMocks,
  browserSessionTabMocks,
  bundleMcpRuntimeMocks,
  writeSingleLineSession,
  sessionStoreEntry,
  expectActiveRunCleanup,
  directSessionReq,
} from "./test/server-sessions.test-helpers.js";

const sessionArchiveMaterializationHook = vi.hoisted(() => ({
  afterMaterialize: undefined as (() => void) | undefined,
}));

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

const {
  createConfiguredGlobalAgentSessionStore,
  createSessionStoreDir,
  openClient,
  resetConfiguredGlobalAgentSessionStore,
} = setupGatewaySessionsTestHarness();

afterEach(() => {
  sessionArchiveMaterializationHook.afterMaterialize = undefined;
  closeOpenClawStateDatabaseForTest();
});

function expectObject(value: unknown) {
  if (!value || typeof value !== "object") {
    throw new Error("expected object");
  }
}

type SessionDeleteRequest = {
  key: string;
  agentId?: string;
  archivedOnly?: boolean;
  deleteTranscript?: boolean;
  emitLifecycleHooks?: boolean;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  expectedSessionUpdatedAt?: number;
};

async function expectSessionDeleteSucceeds(request: SessionDeleteRequest) {
  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>(
    "sessions.delete",
    request,
  );
  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(true);
  return deleted;
}

async function expectSessionDeleteChanged(
  request: SessionDeleteRequest,
  authorization?: SessionMutationAuthorization,
) {
  const deleted = await directSessionReq(
    "sessions.delete",
    request,
    authorization ? { sessionMutationAuthorization: authorization } : undefined,
  );
  expect(deleted.ok).toBe(false);
  expect(deleted.error?.message).toBe(`Session ${request.key} changed before deletion. Retry.`);
  expect((deleted.error as { details?: unknown } | undefined)?.details).toEqual({
    reason: "session-changed",
  });
  return deleted;
}

async function seedSubagentWorkerSession() {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-subagent", "hello");
  await writeSessionStore({
    entries: {
      "agent:main:subagent:worker": sessionStoreEntry("sess-subagent"),
    },
  });
}

function expectThreadBindingsUnbound(targetSessionKey: string) {
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
    targetSessionKey,
    reason: "session-delete",
  });
}

test("sessions.delete rejects main and aborts active runs", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeSingleLineSession(dir, "sess-active", "active");

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
      "discord:group:dev": sessionStoreEntry("sess-active"),
    },
  });

  embeddedRunMock.activeIds.add("sess-active");
  embeddedRunMock.waitResults.set("sess-active", true);

  const mainDelete = await directSessionReq("sessions.delete", { key: "main" });
  expect(mainDelete.ok).toBe(false);

  await expectSessionDeleteSucceeds({
    key: "discord:group:dev",
  });
  expectActiveRunCleanup(
    "agent:main:discord:group:dev",
    ["discord:group:dev", "agent:main:discord:group:dev", "sess-active"],
    "sess-active",
  );
  expect(bundleMcpRuntimeMocks.disposeSessionMcpRuntime).toHaveBeenCalledWith("sess-active");
  expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).toHaveBeenCalledTimes(1);
  const closeTabsCall = (
    browserSessionTabMocks.closeTrackedBrowserTabsForSessions.mock.calls as unknown as Array<
      [{ sessionKeys?: string[]; onWarn?: unknown }]
    >
  )[0]?.[0];
  expect(closeTabsCall?.sessionKeys).toHaveLength(3);
  expect(closeTabsCall?.sessionKeys).toContain("discord:group:dev");
  expect(closeTabsCall?.sessionKeys).toContain("agent:main:discord:group:dev");
  expect(closeTabsCall?.sessionKeys).toContain("sess-active");
  expect(typeof closeTabsCall?.onWarn).toBe("function");
  expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
  expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledWith(
    {
      targetSessionKey: "agent:main:discord:group:dev",
      targetKind: "acp",
      reason: "session-delete",
      sendFarewell: true,
      outcome: "deleted",
    },
    {
      childSessionKey: "agent:main:discord:group:dev",
    },
  );
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
    targetSessionKey: "agent:main:discord:group:dev",
    reason: "session-delete",
  });
});

test("sessions.delete preserves locked archived sessions and deletes ordinary archived sessions", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  const lockedKey = "agent:main:harness:codex:supervision:native-thread";
  const ordinaryKey = "agent:main:ordinary-archived";
  const lockedSessionId = "sess-locked-archived";
  const ordinarySessionId = "sess-ordinary-archived";
  await writeSingleLineSession(dir, lockedSessionId, "locked");
  await writeSingleLineSession(dir, ordinarySessionId, "ordinary");
  await writeSessionStore({
    entries: {
      [lockedKey]: sessionStoreEntry(lockedSessionId, {
        agentHarnessId: "codex",
        archivedAt: Date.now(),
        modelSelectionLocked: true,
      }),
      [ordinaryKey]: sessionStoreEntry(ordinarySessionId, { archivedAt: Date.now() }),
    },
  });
  const lockedEntryBefore = structuredClone(loadSessionEntry({ storePath, sessionKey: lockedKey }));
  const lockedTranscriptPath = path.join(dir, `${lockedSessionId}.jsonl`);
  const lockedTranscriptBefore = await fs.readFile(lockedTranscriptPath, "utf8");

  const rejected = await directSessionReq("sessions.delete", {
    key: lockedKey,
    archivedOnly: true,
  });
  expect(rejected.ok).toBe(false);
  expect(rejected.error).toMatchObject({
    code: "INVALID_REQUEST",
    message: "This session cannot be deleted while model selection is locked.",
  });
  expect(loadSessionEntry({ storePath, sessionKey: lockedKey })).toEqual(lockedEntryBefore);
  expect(await fs.readFile(lockedTranscriptPath, "utf8")).toBe(lockedTranscriptBefore);

  await expectSessionDeleteSucceeds({ key: ordinaryKey, archivedOnly: true });
  expect(loadSessionEntry({ storePath, sessionKey: ordinaryKey })).toBeUndefined();
  expect(loadSessionEntry({ storePath, sessionKey: lockedKey })).toEqual(lockedEntryBefore);
});

test("sessions.delete removes a locked plugin-owned session from its persisted alias", async () => {
  const { storePath } = await createSessionStoreDir();
  const requestedKey = "agent:main:catalog-owned";
  const persistedKey = "catalog-owned";
  const canonicalSessionId = "sess-catalog-owned-canonical";
  const aliasSessionId = "sess-catalog-owned-alias";
  await writeSessionStore({
    entries: {
      [requestedKey]: sessionStoreEntry(canonicalSessionId, {
        modelSelectionLocked: true,
        pluginOwnerId: "anthropic",
        updatedAt: 2,
      }),
    },
  });
  await replaceSessionEntry(
    { agentId: "main", sessionKey: persistedKey, storePath },
    sessionStoreEntry(aliasSessionId, {
      modelSelectionLocked: true,
      pluginOwnerId: "anthropic",
      updatedAt: 1,
    }),
  );
  for (const sessionId of [canonicalSessionId, aliasSessionId]) {
    await replaceTranscriptEvents({ sessionKey: requestedKey, sessionId, storePath }, [
      { type: "session", id: sessionId, content: sessionId },
    ]);
  }

  const deleted = await directSessionReq<{ archived: string[]; deleted: boolean; ok: true }>(
    "sessions.delete",
    {
      key: persistedKey,
    },
  );

  expect(deleted.ok).toBe(true);
  expect(loadSessionEntry({ storePath, sessionKey: requestedKey })).toBeUndefined();
  expect(loadSessionEntry({ storePath, sessionKey: persistedKey })).toBeUndefined();
  expect(deleted.payload?.archived).toEqual(
    expect.arrayContaining([
      expect.stringContaining(`${canonicalSessionId}.jsonl.deleted.`),
      expect.stringContaining(`${aliasSessionId}.jsonl.deleted.`),
    ]),
  );
  for (const sessionId of [canonicalSessionId, aliasSessionId]) {
    await expect(
      loadTranscriptEvents({ sessionKey: requestedKey, sessionId, storePath }),
    ).resolves.toEqual([]);
  }
});

test("sessions.delete interrupts work admitted before runtime registration", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      "agent:main:subagent:worker": sessionStoreEntry("sess-subagent"),
    },
  });
  let interrupted = false;
  let releaseAdmission = () => {};
  const admissionLease = await beginSessionWorkAdmission({
    scope: storePath,
    identities: ["agent:main:subagent:worker", "sess-subagent"],
    assertAllowed: () => {},
    onInterrupt: () => {
      interrupted = true;
      releaseAdmission();
    },
  });
  releaseAdmission = admissionLease.release;

  const deleted = await expectSessionDeleteSucceeds({
    key: "agent:main:subagent:worker",
  });

  expect(deleted.payload?.deleted).toBe(true);
  expect(interrupted).toBe(true);
});

test("sessions.delete rejects a stale expected session id without interrupting its replacement", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:worker";
  const replacementSessionId = "sess-replacement";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(replacementSessionId),
    },
  });
  let interrupted = false;
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [sessionKey, replacementSessionId],
    assertAllowed: () => {},
    onInterrupt: () => {
      interrupted = true;
    },
  });

  try {
    await expectSessionDeleteChanged({
      key: sessionKey,
      expectedSessionId: "sess-stale",
    });
    expect(interrupted).toBe(false);
  } finally {
    admission.release();
  }
});

test("sessions.delete rechecks its expected id before interrupting replacement work", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:worker";
  const originalSessionId = "sess-original";
  const replacementSessionId = "sess-replacement";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(originalSessionId),
    },
  });
  let replacementInterrupted = false;
  const replacementAdmission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [sessionKey, replacementSessionId],
    assertAllowed: () => {},
    onInterrupt: () => {
      replacementInterrupted = true;
    },
  });
  let releaseBlockingMutation = () => {};
  let markBlockingMutationStarted = () => {};
  const blockingMutationStarted = new Promise<void>((resolve) => {
    markBlockingMutationStarted = resolve;
  });
  const blockingMutation = runExclusiveSessionLifecycleMutation({
    scope: storePath,
    identities: [sessionKey],
    run: async () => {
      markBlockingMutationStarted();
      await new Promise<void>((release) => {
        releaseBlockingMutation = release;
      });
    },
  });
  await blockingMutationStarted;

  const deletion = directSessionReq("sessions.delete", {
    key: sessionKey,
    expectedSessionId: originalSessionId,
  });
  await Promise.resolve();
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(replacementSessionId),
    },
  });
  releaseBlockingMutation();

  try {
    const [deleted] = await Promise.all([deletion, blockingMutation]);
    expect(deleted.ok).toBe(false);
    expect(replacementInterrupted).toBe(false);
  } finally {
    replacementAdmission.release();
  }
});

test("sessions.delete rejects a replacement with the same updated-at timestamp", async () => {
  const sessionKey = "agent:main:cron:cleanup";
  const updatedAt = 1_737_600_000_000;
  const { storePath } = await createSessionStoreDir();
  await replaceSessionEntry(
    { sessionKey, storePath },
    {
      ...sessionStoreEntry("replacement-run", {
        lifecycleRevision: "replacement-revision",
        updatedAt,
      }),
    },
  );
  let interrupted = false;
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [sessionKey, "replacement-run"],
    assertAllowed: () => {},
    onInterrupt: () => {
      interrupted = true;
    },
  });

  try {
    await expectSessionDeleteChanged({
      key: sessionKey,
      expectedSessionId: "stale-run",
      expectedLifecycleRevision: "stale-revision",
      expectedSessionUpdatedAt: updatedAt,
    });

    expect(interrupted).toBe(false);
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      lifecycleRevision: "replacement-revision",
      sessionId: "replacement-run",
      updatedAt,
    });
  } finally {
    admission.release();
  }
});

test("sessions.delete reports an exact-entry replacement after cleanup", async () => {
  const sessionKey = "agent:main:cron:cleanup-race";
  const sessionId = "cleanup-race-run";
  const lifecycleRevision = "cleanup-race-revision";
  const updatedAt = 1_737_600_000_000;
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId, { lifecycleRevision, updatedAt }),
    },
  });
  let cleanupReached = false;
  let replaced = false;
  bundleMcpRuntimeMocks.disposeSessionMcpRuntime.mockImplementationOnce(async () => {
    cleanupReached = true;
  });
  const assertCurrent = vi.fn(() => {
    if (!cleanupReached || replaced) {
      return;
    }
    replaced = true;
    replaceSessionEntrySync(
      { sessionKey, storePath },
      sessionStoreEntry(sessionId, {
        label: "concurrent replacement",
        lifecycleRevision,
        updatedAt,
      }),
    );
  });

  await expectSessionDeleteChanged(
    { key: sessionKey, expectedLifecycleRevision: lifecycleRevision, expectedSessionId: sessionId },
    { assertCurrent, assertTargetCurrent: vi.fn() },
  );

  expect(cleanupReached).toBe(true);
  expect(replaced).toBe(true);
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    label: "concurrent replacement",
    lifecycleRevision,
    sessionId,
    updatedAt,
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

  await expectSessionDeleteChanged({
    key: sessionKey,
    expectedLifecycleRevision: lifecycleRevision,
    expectedSessionId: sessionId,
  });

  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    label: "concurrent replacement",
    lifecycleRevision,
    sessionId,
    updatedAt,
  });
  await expect(loadTranscriptEvents({ sessionKey, sessionId, storePath })).resolves.toEqual(events);
});

test("sessions.delete includes cleanup-owned row changes in its guarded deletion", async () => {
  const sessionKey = "agent:main:cron:cleanup";
  const sessionId = "sess-cleanup";
  const lifecycleRevision = "cleanup-revision";
  const updatedAt = 1_737_600_000_000;
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId, { lifecycleRevision, updatedAt }),
    },
  });
  bundleMcpRuntimeMocks.disposeSessionMcpRuntime.mockImplementationOnce(async () => {
    await writeSessionStore({
      entries: {
        [sessionKey]: sessionStoreEntry(sessionId, {
          label: "cleanup-owned revision",
          lifecycleRevision,
          updatedAt: updatedAt + 1,
        }),
      },
    });
  });

  const deleted = await expectSessionDeleteSucceeds({
    key: sessionKey,
    expectedSessionId: sessionId,
    expectedLifecycleRevision: lifecycleRevision,
    expectedSessionUpdatedAt: updatedAt,
  });

  expect(deleted.payload?.deleted).toBe(true);
  expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
});

test("sessions.delete serializes a patch behind asynchronous runtime cleanup", async () => {
  const sessionKey = "agent:main:subagent:worker";
  const sessionId = "sess-subagent";
  const updatedAt = 1_737_600_000_000;
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId, { updatedAt }),
    },
  });
  let releaseRuntimeCleanup = () => {};
  const runtimeCleanupStarted = new Promise<void>((resolve) => {
    bundleMcpRuntimeMocks.disposeSessionMcpRuntime.mockImplementationOnce(async () => {
      resolve();
      await new Promise<void>((release) => {
        releaseRuntimeCleanup = release;
      });
    });
  });

  const deletion = directSessionReq("sessions.delete", {
    key: sessionKey,
    expectedSessionId: sessionId,
    expectedSessionUpdatedAt: updatedAt,
  });
  await runtimeCleanupStarted;
  let patchSettled = false;
  let markPatchPreflight = () => {};
  const patchPreflight = new Promise<void>((resolve) => {
    markPatchPreflight = resolve;
  });
  const patch = directSessionReq(
    "sessions.patch",
    {
      key: sessionKey,
      label: "updated during cleanup",
    },
    {
      context: {
        workerSessionPlacementService: {
          getMany(sessionIds: readonly string[]) {
            if (sessionIds.includes(sessionId)) {
              markPatchPreflight();
            }
            return new Map();
          },
        },
      },
    },
  ).then((result) => {
    patchSettled = true;
    return result;
  });
  await patchPreflight;
  expect(patchSettled).toBe(false);
  releaseRuntimeCleanup();

  const [deleted, patched] = await Promise.all([deletion, patch]);
  expect(deleted.ok).toBe(true);
  expect(patched.ok).toBe(false);
  expect(patched.error?.message).toBe(`Session ${sessionKey} changed before patch. Retry.`);
  expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
});

test("sessions.patch waits for an in-flight session lifecycle mutation", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:worker";
  const sessionId = "sess-subagent";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId),
    },
  });
  let releaseMutation = () => {};
  let markMutationStarted = () => {};
  const mutationStarted = new Promise<void>((resolve) => {
    markMutationStarted = resolve;
  });
  const mutation = runExclusiveSessionLifecycleMutation({
    scope: storePath,
    identities: [sessionKey, sessionId],
    run: async () => {
      markMutationStarted();
      await new Promise<void>((release) => {
        releaseMutation = release;
      });
    },
  });
  await mutationStarted;
  let patchSettled = false;
  const patch = directSessionReq("sessions.patch", {
    key: sessionKey,
    label: "after lifecycle mutation",
  }).then((result) => {
    patchSettled = true;
    return result;
  });
  await Promise.resolve();
  expect(patchSettled).toBe(false);
  releaseMutation();

  const [patched] = await Promise.all([patch, mutation]);
  expect(patched.ok).toBe(true);
  expect(loadSessionEntry({ sessionKey, storePath })?.label).toBe("after lifecycle mutation");
});

test("sessions.delete keeps lifecycle admission blocked through session unbinding", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:worker";
  const sessionId = "sess-subagent";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId),
    },
  });
  let releaseUnbind = () => {};
  const unbindStarted = new Promise<void>((resolve) => {
    threadBindingMocks.unbindThreadBindingsBySessionKey.mockImplementationOnce(async () => {
      resolve();
      await new Promise<void>((release) => {
        releaseUnbind = release;
      });
      return [];
    });
  });

  const deletion = directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
    key: sessionKey,
  });
  await unbindStarted;
  let replacementAdmitted = false;
  const replacement = beginSessionWorkAdmission({
    scope: storePath,
    identities: [sessionKey, sessionId],
    assertAllowed: () => {},
  }).then((lease) => {
    replacementAdmitted = true;
    return lease;
  });
  await Promise.resolve();
  expect(replacementAdmitted).toBe(false);

  releaseUnbind();
  const [deleted, replacementAdmission] = await Promise.all([deletion, replacement]);
  try {
    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);
    expect(replacementAdmitted).toBe(true);
  } finally {
    replacementAdmission.release();
  }
});

test("sessions.delete limits plugin-runtime cleanup to sessions owned by that plugin", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-owned", "owned");
  await writeSingleLineSession(dir, "sess-foreign", "foreign");

  await writeSessionStore({
    entries: {
      "agent:main:dreaming-narrative-owned": sessionStoreEntry("sess-owned", {
        pluginOwnerId: "memory-core",
      }),
      "agent:main:dreaming-narrative-foreign": sessionStoreEntry("sess-foreign", {
        pluginOwnerId: "other-plugin",
      }),
    },
  });

  const pluginClient = {
    connect: {
      scopes: ["operator.admin"],
    },
    internal: {
      pluginRuntimeOwnerId: "memory-core",
    },
  } as never;
  let foreignWorkInterrupted = false;
  const foreignAdmission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: ["agent:main:dreaming-narrative-foreign", "sess-foreign"],
    assertAllowed: () => {},
    onInterrupt: () => {
      foreignWorkInterrupted = true;
    },
  });

  try {
    const denied = await directSessionReq(
      "sessions.delete",
      {
        key: "agent:main:dreaming-narrative-foreign",
      },
      {
        client: pluginClient,
      },
    );
    expect(denied.ok).toBe(false);
    expect(denied.error?.message).toContain("did not create it");
    expect(foreignWorkInterrupted).toBe(false);
  } finally {
    foreignAdmission.release();
  }

  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>(
    "sessions.delete",
    {
      key: "agent:main:dreaming-narrative-owned",
    },
    {
      client: pluginClient,
    },
  );
  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(true);
});

test("sessions.delete scopes selected global deletes to the requested agent", async () => {
  const globalStores = await createConfiguredGlobalAgentSessionStore({ writePrimeStore: true });

  await expectSessionDeleteSucceeds({
    key: "global",
    agentId: "work",
    deleteTranscript: false,
  });
  expect(
    loadSessionEntry({
      agentId: "main",
      sessionKey: "global",
      storePath: globalStores.mainStorePath,
    })?.sessionId,
  ).toBe("sess-main-global");
  expect(
    loadSessionEntry({
      agentId: "work",
      sessionKey: "global",
      storePath: globalStores.workStorePath,
    }),
  ).toBeUndefined();
  await resetConfiguredGlobalAgentSessionStore(globalStores);
});

test("sessions.delete closes ACP runtime handles before removing ACP sessions", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeSingleLineSession(dir, "sess-acp", "acp");

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
      "discord:group:dev": sessionStoreEntry("sess-acp"),
    },
  });
  writeAcpSessionMetaForMigration({
    sessionKey: "agent:main:discord:group:dev",
    meta: {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "runtime:delete",
      mode: "persistent",
      state: "idle",
      lastActivityAt: Date.now(),
    },
  });
  await expectSessionDeleteSucceeds({
    key: "discord:group:dev",
  });
  expect(acpManagerMocks.closeSession).toHaveBeenCalledTimes(1);
  const closeSessionCall = (
    acpManagerMocks.closeSession.mock.calls as unknown as Array<
      [
        {
          allowBackendUnavailable?: boolean;
          cfg?: unknown;
          discardPersistentState?: boolean;
          requireAcpSession?: boolean;
          reason?: string;
          sessionKey?: string;
        },
      ]
    >
  )[0]?.[0];
  expect(closeSessionCall?.allowBackendUnavailable).toBe(true);
  expectObject(closeSessionCall?.cfg);
  expect(closeSessionCall?.discardPersistentState).toBe(true);
  expect(closeSessionCall?.requireAcpSession).toBe(false);
  expect(closeSessionCall?.reason).toBe("session-delete");
  expect(closeSessionCall?.sessionKey).toBe("agent:main:discord:group:dev");

  expect(acpManagerMocks.cancelSession).toHaveBeenCalledTimes(1);
  const cancelSessionCall = (
    acpManagerMocks.cancelSession.mock.calls as unknown as Array<
      [{ cfg?: unknown; reason?: string; sessionKey?: string }]
    >
  )[0]?.[0];
  expectObject(cancelSessionCall?.cfg);
  expect(cancelSessionCall?.reason).toBe("session-delete");
  expect(cancelSessionCall?.sessionKey).toBe("agent:main:discord:group:dev");
  expect(readAcpSessionMeta({ sessionKey: "agent:main:discord:group:dev" })).toBeUndefined();
});

test("sessions.delete closes child ACP runtimes spawned from the deleted parent", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeSingleLineSession(dir, "sess-parent", "parent");
  await writeSingleLineSession(dir, "sess-child", "child");

  const acpMeta = (recordId: string) => ({
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: `runtime:${recordId}`,
    mode: "oneshot" as const,
    state: "idle" as const,
    lastActivityAt: Date.now(),
  });

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
      "acp-parent": sessionStoreEntry("sess-parent"),
      "acp-child": sessionStoreEntry("sess-child", {
        spawnedBy: "agent:main:acp-parent",
      }),
    },
  });
  writeAcpSessionMetaForMigration({
    sessionKey: "agent:main:acp-parent",
    meta: acpMeta("agent:main:acp-parent"),
  });
  writeAcpSessionMetaForMigration({
    sessionKey: "agent:main:acp-child",
    meta: acpMeta("agent:main:acp-child"),
  });

  await expectSessionDeleteSucceeds({
    key: "acp-parent",
  });

  // Deleting the parent must also close its spawned ACP child, not just its own
  // runtime, otherwise the child's claude-agent-acp process is orphaned (#68916).
  const closedKeys = (
    acpManagerMocks.closeSession.mock.calls as unknown as Array<[{ sessionKey?: string }]>
  ).map((call) => call[0]?.sessionKey);
  expect(closedKeys).toContain("agent:main:acp-parent");
  expect(closedKeys).toContain("agent:main:acp-child");
  expect(readAcpSessionMeta({ sessionKey: "agent:main:acp-parent" })).toBeUndefined();
  expect(readAcpSessionMeta({ sessionKey: "agent:main:acp-child" })).toBeUndefined();
});

test("sessions.delete emits session_end with deleted reason and no replacement", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
      "discord:group:delete": sessionStoreEntry("sess-delete"),
    },
  });

  await expectSessionDeleteSucceeds({
    key: "discord:group:delete",
  });
  expect(sessionLifecycleHookMocks.runSessionEnd).toHaveBeenCalledTimes(1);
  expect(sessionLifecycleHookMocks.runSessionStart).not.toHaveBeenCalled();

  const [event, context] = (
    sessionLifecycleHookMocks.runSessionEnd.mock.calls as unknown as Array<[unknown, unknown]>
  )[0] ?? [undefined, undefined];
  expect((event as { sessionId?: string } | undefined)?.sessionId).toBe("sess-delete");
  expect((event as { sessionKey?: string } | undefined)?.sessionKey).toBe(
    "agent:main:discord:group:delete",
  );
  expect((event as { reason?: string } | undefined)?.reason).toBe("deleted");
  expect(
    (event as { transcriptArchived?: boolean } | undefined)?.transcriptArchived,
  ).toBeUndefined();
  expect((event as { sessionFile?: string } | undefined)?.sessionFile).toBeUndefined();
  expect((event as { nextSessionId?: string } | undefined)?.nextSessionId).toBeUndefined();
  expect((context as { sessionId?: string } | undefined)?.sessionId).toBe("sess-delete");
  expect((context as { sessionKey?: string } | undefined)?.sessionKey).toBe(
    "agent:main:discord:group:delete",
  );
  expect((context as { agentId?: string } | undefined)?.agentId).toBe("main");
});

test("sessions.delete sessions.changed event always carries the resolved owner", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-side", "hello");
  await writeSessionStore({ entries: { "agent:main:side": sessionStoreEntry("sess-side") } });
  const broadcastToConnIds = vi.fn();

  const deleted = await directSessionReq<{ deleted: boolean }>(
    "sessions.delete",
    { key: "agent:main:side", deleteTranscript: true },
    {
      client: { connect: { scopes: ["operator.admin"] } } as never,
      context: {
        broadcastToConnIds,
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      },
    },
  );

  expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
  expect(broadcastToConnIds).toHaveBeenCalledWith(
    "sessions.changed",
    expect.objectContaining({ sessionKey: "agent:main:side", agentId: "main", reason: "delete" }),
    new Set(["conn-1"]),
    { agentId: "main", dropIfSlow: true },
  );
});

test("sessions.delete does not emit lifecycle events when nothing was deleted", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
    },
  });

  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
    key: "agent:main:subagent:missing",
  });

  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(false);
  expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).not.toHaveBeenCalled();
});

test("sessions.delete emits subagent targetKind for subagent sessions", async () => {
  await seedSubagentWorkerSession();

  await expectSessionDeleteSucceeds({
    key: "agent:main:subagent:worker",
  });
  expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
  const event = (subagentLifecycleHookMocks.runSubagentEnded.mock.calls as unknown[][])[0]?.[0] as
    | { targetKind?: string; targetSessionKey?: string; reason?: string; outcome?: string }
    | undefined;
  expect(event?.targetSessionKey).toBe("agent:main:subagent:worker");
  expect(event?.targetKind).toBe("subagent");
  expect(event?.reason).toBe("session-delete");
  expect(event?.outcome).toBe("deleted");
  expectThreadBindingsUnbound("agent:main:subagent:worker");
});

test("sessions.delete can skip lifecycle hooks while still unbinding thread bindings", async () => {
  await seedSubagentWorkerSession();

  await expectSessionDeleteSucceeds({
    key: "agent:main:subagent:worker",
    emitLifecycleHooks: false,
  });
  expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
  expectThreadBindingsUnbound("agent:main:subagent:worker");
});

test("sessions.delete directly unbinds thread bindings when hooks are unavailable", async () => {
  await seedSubagentWorkerSession();
  subagentLifecycleHookState.hasSubagentEndedHook = false;

  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
    key: "agent:main:subagent:worker",
  });
  expect(deleted.ok).toBe(true);
  expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
  expectThreadBindingsUnbound("agent:main:subagent:worker");
});

test("sessions.delete returns unavailable when active run does not stop", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-active", "active");

  await writeSessionStore({
    entries: {
      "discord:group:dev": sessionStoreEntry("sess-active"),
    },
  });

  embeddedRunMock.activeIds.add("sess-active");
  embeddedRunMock.waitResults.set("sess-active", false);
  const waitCallCountsAtRetirement: number[] = [];
  bundleMcpRuntimeMocks.retireSessionMcpRuntime.mockImplementation(async () => {
    waitCallCountsAtRetirement.push(embeddedRunMock.waitCalls.length);
    return true;
  });

  const { ws } = await openClient();

  const deleted = await rpcReq(ws, "sessions.delete", {
    key: "discord:group:dev",
  });
  expect(deleted.ok).toBe(false);
  expect(deleted.error?.code).toBe("UNAVAILABLE");
  expect(deleted.error?.message ?? "").toMatch(/still active/i);
  expectActiveRunCleanup(
    "agent:main:discord:group:dev",
    ["discord:group:dev", "agent:main:discord:group:dev", "sess-active"],
    "sess-active",
  );
  expect(bundleMcpRuntimeMocks.retireSessionMcpRuntime).toHaveBeenCalledWith({
    sessionId: "sess-active",
    reason: "gateway-session-cleanup",
    preserveActiveLeases: true,
    retainAcrossReuse: true,
    onError: expect.any(Function),
  });
  expect(bundleMcpRuntimeMocks.retireSessionMcpRuntime).toHaveBeenCalledTimes(2);
  expect(waitCallCountsAtRetirement).toEqual([0, 1]);
  expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).not.toHaveBeenCalled();

  const storedEntry = loadSessionEntry({
    sessionKey: "agent:main:discord:group:dev",
    storePath,
  });
  expect(storedEntry?.sessionId).toBe("sess-active");
  const filesAfterDeleteAttempt = await fs.readdir(dir);
  expect(
    filesAfterDeleteAttempt.filter((fileName) => fileName.startsWith("sess-active.jsonl.deleted.")),
  ).toEqual([]);

  ws.close();
});
