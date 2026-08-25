// Compare-and-swap session patches must reject reset replacements atomically.
import { afterEach, expect, test, vi } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { applySessionEntryCanonicalReplacements } from "../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { createDeferredCore as createDeferred } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { embeddedRunMock, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  expectNoSessionQueueCleanup,
  sessionHookMocks,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

test.each([
  { action: "archive", archived: true },
  { action: "restore", archived: false },
])("sessions.patch rejects missing $action targets without creating rows", async ({ archived }) => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:missing-lifecycle-target";
  const broadcastToConnIds = vi.fn();
  await writeSessionStore({ entries: {} });

  const result = await directSessionReq(
    "sessions.patch",
    { key: sessionKey, archived },
    {
      context: {
        broadcastToConnIds,
        getSessionEventSubscriberConnIds: () => new Set(["session-observer"]),
      },
    },
  );

  expect(result).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: `session not found: ${sessionKey}` },
  });
  expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
  expectNoSessionQueueCleanup();
  expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();
  expect(broadcastToConnIds).not.toHaveBeenCalled();
});

test.each([
  { action: "archive", archived: true },
  { action: "restore", archived: false },
])(
  "sessions.patch reports deleted $action identity as a typed terminal non-outcome",
  async ({ archived }) => {
    const { storePath } = await createSessionStoreDir();
    const sessionKey = "agent:main:deleted-lifecycle-target";
    const broadcastToConnIds = vi.fn();
    await writeSessionStore({ entries: {} });

    const result = await directSessionReq(
      "sessions.patch",
      { key: sessionKey, archived, expectedSessionId: "session-a" },
      {
        context: {
          broadcastToConnIds,
          getSessionEventSubscriberConnIds: () => new Set(["session-observer"]),
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        details: { reason: "session-changed" },
      },
    });
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
    expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();
    expect(broadcastToConnIds).not.toHaveBeenCalled();
  },
);

test.each([
  {
    name: "session id",
    expected: { expectedSessionId: "sess-before-reset" },
  },
  {
    name: "lifecycle revision",
    expected: { expectedLifecycleRevision: "revision-before-reset" },
  },
])("sessions.patch rejects a stale expected $name atomically", async ({ expected }) => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:archive-identity";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry("sess-after-reset", {
        lifecycleRevision: "revision-after-reset",
      }),
    },
  });

  const result = await directSessionReq("sessions.patch", {
    key: sessionKey,
    archived: true,
    ...expected,
  });

  expect(result).toMatchObject({
    ok: false,
    error: { message: `Session ${sessionKey} changed before patch. Retry.` },
  });
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    sessionId: "sess-after-reset",
    lifecycleRevision: "revision-after-reset",
  });
  expect(loadSessionEntry({ sessionKey, storePath })).not.toHaveProperty("archivedAt");
});

test.each([
  { action: "archive", archived: true },
  { action: "restore", archived: false },
])(
  "sessions.patch rejects a replaced identity before projected $action side effects",
  async ({ archived }) => {
    const { storePath } = await createSessionStoreDir();
    const sessionKey = "agent:main:subagent:active-replacement";
    const replacementSessionId = "sess-active-after-reset";
    await writeSessionStore({
      entries: {
        [sessionKey]: sessionStoreEntry(replacementSessionId, {
          lifecycleRevision: "revision-after-reset",
        }),
      },
    });
    const replacementBefore = loadSessionEntry({ sessionKey, storePath });
    const broadcastToConnIds = vi.fn();
    embeddedRunMock.activeIds.add(replacementSessionId);

    const result = await directSessionReq(
      "sessions.patch",
      {
        key: sessionKey,
        archived,
        expectedSessionId: "sess-before-reset",
      },
      {
        context: {
          broadcastToConnIds,
          getSessionEventSubscriberConnIds: () => new Set(["session-observer"]),
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        message: `Session ${sessionKey} changed before patch. Retry.`,
        details: { reason: "session-changed" },
      },
    });
    expect(loadSessionEntry({ sessionKey, storePath })).toEqual(replacementBefore);
    expect(embeddedRunMock.abortCalls).toEqual([]);
    expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();
    expect(broadcastToConnIds).not.toHaveBeenCalled();
  },
);

test("sessions.patch rejects a session replaced before restore reaches the SQLite writer", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:restore-generation-race";
  const originalSessionId = "restored-original";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(originalSessionId, { archivedAt: 1 }),
    },
  });

  const writerStarted = createDeferred();
  const replaceSession = createDeferred();
  const writer = applySessionEntryCanonicalReplacements({
    agentId: "main",
    sessionKeys: [sessionKey],
    storePath,
    update: async () => {
      writerStarted.resolve();
      await replaceSession.promise;
      return {
        replacements: [
          {
            entry: sessionStoreEntry("restored-replacement", { archivedAt: 2 }),
            previousSessionKeys: [],
            sessionKey,
          },
        ],
        result: undefined,
      };
    },
  });
  await writerStarted.promise;

  const preflightCompleted = createDeferred();
  const broadcastToConnIds = vi.fn();
  const restored = directSessionReq(
    "sessions.patch",
    {
      key: sessionKey,
      archived: false,
      expectedSessionId: originalSessionId,
    },
    {
      context: {
        broadcastToConnIds,
        getSessionEventSubscriberConnIds: () => new Set(["session-observer"]),
        workerSessionPlacementService: {
          getMany(sessionIds: readonly string[]) {
            if (sessionIds.includes(originalSessionId)) {
              preflightCompleted.resolve();
            }
            return new Map();
          },
        },
      },
    },
  );

  try {
    await preflightCompleted.promise;
    replaceSession.resolve();
    await writer;
    expect(await restored).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        details: { reason: "session-changed" },
      },
    });
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      archivedAt: 2,
      sessionId: "restored-replacement",
    });
    expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();
    expect(broadcastToConnIds).not.toHaveBeenCalled();
  } finally {
    replaceSession.resolve();
    await Promise.allSettled([writer, restored]);
  }
});

test.each([
  {
    name: "session id",
    expected: { expectedSessionId: "sess-before-reset" },
  },
  {
    name: "lifecycle revision",
    expected: { expectedLifecycleRevision: "revision-before-reset" },
  },
])("sessions.patch rejects stale $name for metadata mutations", async ({ expected }) => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:metadata-identity";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry("sess-after-reset", {
        lifecycleRevision: "revision-after-reset",
      }),
    },
  });

  const patched = await directSessionReq("sessions.patch", {
    key: sessionKey,
    label: "Stale agent request",
    ...expected,
  });

  expect(patched).toMatchObject({
    ok: false,
    error: { message: `Session ${sessionKey} changed before patch. Retry.` },
  });
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    sessionId: "sess-after-reset",
    lifecycleRevision: "revision-after-reset",
  });
  expect(loadSessionEntry({ sessionKey, storePath })).not.toHaveProperty("label");
});

test("sessions.patch rejects conditional unread acknowledgements with another mutation", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:conditional-unread-label";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry("conditional-unread-label", { markedUnreadAt: 10 }),
    },
  });

  const result = await directSessionReq("sessions.patch", {
    key: sessionKey,
    unread: false,
    label: "Must not be discarded",
    expectedMarkedUnreadAt: 9,
  });

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: "expectedMarkedUnreadAt requires unread=false as the only mutation.",
    },
  });
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    markedUnreadAt: 10,
    sessionId: "conditional-unread-label",
  });
});

test("sessions.patch keeps explicit unread markers strictly advancing", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:conditional-unread-revision";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry("conditional-unread-revision"),
    },
  });
  const now = vi.spyOn(Date, "now").mockReturnValue(100);

  try {
    await directSessionReq("sessions.patch", { key: sessionKey, unread: true });
    const firstMarker = loadSessionEntry({ sessionKey, storePath })?.markedUnreadAt;
    await directSessionReq("sessions.patch", { key: sessionKey, unread: true });
    const secondMarker = loadSessionEntry({ sessionKey, storePath })?.markedUnreadAt;

    expect(firstMarker).toBe(100);
    expect(secondMarker).toBe(101);
    const staleRead = await directSessionReq("sessions.patch", {
      key: sessionKey,
      unread: false,
      expectedMarkedUnreadAt: firstMarker,
    });
    expect(staleRead).toMatchObject({ ok: true });
    expect(loadSessionEntry({ sessionKey, storePath })?.markedUnreadAt).toBe(secondMarker);
  } finally {
    now.mockRestore();
  }
});

test("sessions.patch archives the expected session under its lifecycle lock", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:archive-identity";
  const sessionId = "sess-expected-archive";
  const lifecycleRevision = "revision-expected-archive";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId, { lifecycleRevision }),
    },
  });

  const archived = await directSessionReq("sessions.patch", {
    key: sessionKey,
    archived: true,
    expectedSessionId: sessionId,
    expectedLifecycleRevision: lifecycleRevision,
  });

  expect(archived.ok).toBe(true);
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    sessionId,
    lifecycleRevision,
    archivedAt: expect.any(Number),
  });
});
