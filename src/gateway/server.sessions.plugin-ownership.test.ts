import { expect, test } from "vitest";
import {
  loadSessionEntry,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { runExclusiveSessionLifecycleMutation } from "../sessions/session-lifecycle-admission.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

test.each([
  {
    name: "another plugin's session",
    key: "agent:main:dreaming-narrative-foreign",
    entry: sessionStoreEntry("foreign-plugin-session", { pluginOwnerId: "other-plugin" }),
  },
  {
    name: "an operator-owned session",
    key: "agent:main:dashboard:operator-owned",
    entry: sessionStoreEntry("operator-owned-session"),
  },
])("sessions.reset prevents a plugin from resetting $name", async ({ key, entry }) => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({ entries: { [key]: entry } });
  const pluginClient = {
    connect: { scopes: ["operator.write"] },
    internal: { pluginRuntimeOwnerId: "memory-core" },
  } as never;

  const reset = await directSessionReq("sessions.reset", { key }, { client: pluginClient });

  expect(reset.ok).toBe(false);
  expect(reset.error).toMatchObject({
    code: "INVALID_REQUEST",
    message: `Plugin "memory-core" cannot reset session "${key}" because it did not create it.`,
  });
  expect(loadSessionEntry({ sessionKey: key, storePath })).toMatchObject({
    sessionId: entry.sessionId,
    ...(entry.pluginOwnerId ? { pluginOwnerId: entry.pluginOwnerId } : {}),
  });
});

test("sessions.reset preserves ownership when a plugin resets its own session", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dreaming-narrative-owned";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry("owned-plugin-session", { pluginOwnerId: "memory-core" }),
    },
  });
  const pluginClient = {
    connect: { scopes: ["operator.write"] },
    internal: { pluginRuntimeOwnerId: "memory-core" },
  } as never;

  const reset = await directSessionReq(
    "sessions.reset",
    { key: sessionKey },
    { client: pluginClient },
  );

  expect(reset.ok, JSON.stringify(reset.error)).toBe(true);
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    pluginOwnerId: "memory-core",
  });
});

test("sessions.reset stamps plugin ownership when it materializes a missing session", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dreaming-narrative-new";
  const pluginClient = {
    connect: { scopes: ["operator.write"] },
    internal: { pluginRuntimeOwnerId: "memory-core" },
  } as never;

  const reset = await directSessionReq(
    "sessions.reset",
    { key: sessionKey },
    { client: pluginClient },
  );

  expect(reset.ok, JSON.stringify(reset.error)).toBe(true);
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    pluginOwnerId: "memory-core",
  });

  const patched = await directSessionReq(
    "sessions.patch",
    { key: sessionKey, label: "Reset-created plugin session" },
    { client: pluginClient },
  );

  expect(patched.ok, JSON.stringify(patched.error)).toBe(true);
});

test("sessions.reset rechecks plugin ownership inside lifecycle admission", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dreaming-narrative-owned";
  const sessionId = "owned-plugin-session";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId, { pluginOwnerId: "memory-core" }),
    },
  });
  const { performGatewaySessionReset } = await import("./session-reset-service.js");
  let replaced = false;

  const reset = await performGatewaySessionReset({
    key: sessionKey,
    reason: "reset",
    commandSource: "gateway:sessions.reset",
    workerPlacementContext: {},
    authorizedPluginId: "memory-core",
    assertCurrent: () => {
      if (replaced) {
        return;
      }
      replaced = true;
      replaceSessionEntrySync(
        { sessionKey, storePath },
        sessionStoreEntry(sessionId, { pluginOwnerId: "other-plugin" }),
      );
    },
  });

  expect(reset.ok).toBe(false);
  if (!reset.ok) {
    expect(reset.error.message).toBe(
      `Plugin "memory-core" cannot reset session "${sessionKey}" because it did not create it.`,
    );
  }
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    pluginOwnerId: "other-plugin",
    sessionId,
  });
});

test("sessions.patch limits plugin-runtime mutations to sessions owned by that plugin", async () => {
  const { storePath } = await createSessionStoreDir();
  const ownedKey = "agent:main:dreaming-narrative-owned";
  const foreignKey = "agent:main:dreaming-narrative-foreign";
  const operatorKey = "agent:main:dashboard:operator-owned";
  await writeSessionStore({
    entries: {
      [ownedKey]: sessionStoreEntry("sess-owned", { pluginOwnerId: "memory-core" }),
      [foreignKey]: sessionStoreEntry("sess-foreign", { pluginOwnerId: "other-plugin" }),
      [operatorKey]: sessionStoreEntry("sess-operator"),
    },
  });
  const pluginClient = {
    connect: { scopes: ["operator.admin"] },
    internal: { pluginRuntimeOwnerId: "memory-core" },
  } as never;

  for (const key of [foreignKey, operatorKey]) {
    const denied = await directSessionReq(
      "sessions.patch",
      { key, label: "unauthorized mutation" },
      { client: pluginClient },
    );

    expect(denied.ok).toBe(false);
    expect(denied.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: `Plugin "memory-core" cannot patch session "${key}" because it did not create it.`,
    });
    expect(loadSessionEntry({ sessionKey: key, storePath })?.label).toBeUndefined();
  }

  const patched = await directSessionReq(
    "sessions.patch",
    { key: ownedKey, label: "authorized mutation" },
    { client: pluginClient },
  );

  expect(patched.ok, JSON.stringify(patched.error)).toBe(true);
  expect(loadSessionEntry({ sessionKey: ownedKey, storePath })?.label).toBe("authorized mutation");
});

test("sessions.patch rechecks plugin ownership after waiting for lifecycle admission", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dreaming-narrative-owned";
  const sessionId = "sess-owned";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId, { pluginOwnerId: "memory-core" }),
    },
  });
  const pluginClient = {
    connect: { scopes: ["operator.admin"] },
    internal: { pluginRuntimeOwnerId: "memory-core" },
  } as never;
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
  const patch = directSessionReq(
    "sessions.patch",
    { key: sessionKey, label: "unauthorized raced mutation" },
    { client: pluginClient },
  );
  await Promise.resolve();
  await replaceSessionEntry(
    { sessionKey, storePath },
    sessionStoreEntry(sessionId, { pluginOwnerId: "other-plugin" }),
  );
  releaseMutation();

  const [patched] = await Promise.all([patch, mutation]);

  expect(patched.ok).toBe(false);
  expect(patched.error?.message).toContain("did not create it");
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    pluginOwnerId: "other-plugin",
  });
  expect(loadSessionEntry({ sessionKey, storePath })?.label).toBeUndefined();
});

test("sessions.delete protects the archived session generation from a replacement", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dreaming-narrative-owned";
  const originalSessionId = "original-plugin-session";
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(originalSessionId, { pluginOwnerId: "memory-core" }),
    },
  });
  const pluginClient = {
    connect: { scopes: ["operator.write"] },
    internal: { pluginRuntimeOwnerId: "memory-core" },
  } as never;

  const archived = await directSessionReq<{
    entry: { sessionId: string; lifecycleRevision?: string };
  }>(
    "sessions.patch",
    { key: sessionKey, archived: true, expectedSessionId: originalSessionId },
    { client: pluginClient },
  );

  expect(archived.ok, JSON.stringify(archived.error)).toBe(true);
  expect(archived.payload?.entry.sessionId).toBe(originalSessionId);

  await replaceSessionEntry(
    { sessionKey, storePath },
    sessionStoreEntry("replacement-plugin-session", {
      archivedAt: Date.now(),
      lifecycleRevision: "replacement-plugin-revision",
      pluginOwnerId: "memory-core",
    }),
  );

  const deleted = await directSessionReq(
    "sessions.delete",
    {
      key: sessionKey,
      archivedOnly: true,
      expectedSessionId: originalSessionId,
      ...(archived.payload?.entry.lifecycleRevision
        ? { expectedLifecycleRevision: archived.payload.entry.lifecycleRevision }
        : {}),
    },
    { client: pluginClient },
  );

  expect(deleted.ok).toBe(false);
  expect(deleted.error?.message).toBe(`Session ${sessionKey} changed before deletion. Retry.`);
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    lifecycleRevision: "replacement-plugin-revision",
    pluginOwnerId: "memory-core",
    sessionId: "replacement-plugin-session",
  });
});
