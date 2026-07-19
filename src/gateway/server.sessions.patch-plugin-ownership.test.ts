// Plugin-runtime sessions.patch ownership tests protect the fail-closed rule
// that plugin callers may only mutate session rows they created.
import { afterEach, expect, test, vi } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import * as sessionUtils from "../gateway/session-utils.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  directSessionReq,
  sessionStoreEntry,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsTestHarness();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

test("sessions.patch limits plugin-runtime mutations to sessions owned by that plugin", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      "agent:main:dreaming-narrative-owned": sessionStoreEntry("sess-owned", {
        pluginOwnerId: "memory-core",
      }),
      "agent:main:dreaming-narrative-foreign": sessionStoreEntry("sess-foreign", {
        pluginOwnerId: "other-plugin",
      }),
      "agent:main:dreaming-narrative-foreign-archived": sessionStoreEntry("sess-foreign-archived", {
        pluginOwnerId: "other-plugin",
        archivedAt: Date.now(),
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

  const archiveForeign = await directSessionReq(
    "sessions.patch",
    {
      key: "agent:main:dreaming-narrative-foreign",
      archived: true,
    },
    {
      client: pluginClient,
    },
  );
  expect(archiveForeign.ok).toBe(false);
  expect(archiveForeign.error?.message).toContain("did not create it");

  const unarchiveForeign = await directSessionReq(
    "sessions.patch",
    {
      key: "agent:main:dreaming-narrative-foreign-archived",
      archived: false,
    },
    {
      client: pluginClient,
    },
  );
  expect(unarchiveForeign.ok).toBe(false);
  expect(unarchiveForeign.error?.message).toContain("did not create it");

  const patchOwned = await directSessionReq(
    "sessions.patch",
    {
      key: "agent:main:dreaming-narrative-owned",
      label: "patched by owner",
    },
    {
      client: pluginClient,
    },
  );
  expect(patchOwned.ok).toBe(true);
  expect(
    loadSessionEntry({
      agentId: "main",
      sessionKey: "agent:main:dreaming-narrative-owned",
      storePath,
    })?.label,
  ).toBe("patched by owner");
});

test("sessions.patch rejects plugin-runtime patches on legacy ownerless sessions", async () => {
  const { storePath } = await createSessionStoreDir();
  const originalEntry = sessionStoreEntry("sess-ownerless");
  await writeSessionStore({
    entries: {
      "agent:main:dreaming-narrative-ownerless": originalEntry,
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

  const patchOwnerless = await directSessionReq(
    "sessions.patch",
    {
      key: "agent:main:dreaming-narrative-ownerless",
      label: "patched by plugin",
    },
    {
      client: pluginClient,
    },
  );
  expect(patchOwnerless.ok).toBe(false);
  expect(patchOwnerless.error?.message).toContain("did not create it");
  expect(
    loadSessionEntry({
      agentId: "main",
      sessionKey: "agent:main:dreaming-narrative-ownerless",
      storePath,
    }),
  ).toMatchObject(originalEntry);
});

test("sessions.patch rejects a foreign-owned row missed by the initial handler lookup", async () => {
  const { storePath } = await createSessionStoreDir();
  const originalEntry = sessionStoreEntry("sess-concurrent", {
    pluginOwnerId: "other-plugin",
  });
  await writeSessionStore({
    entries: {
      "agent:main:dreaming-narrative-concurrent": originalEntry,
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

  // Simulate the foreign-owned row being absent from the handler's preliminary
  // lookup but present in the accessor snapshot used for authorization.
  const loadSessionEntrySpy = vi
    .spyOn(sessionUtils, "loadSessionEntry")
    .mockImplementationOnce(() => ({
      cfg: {} as never,
      storePath: "",
      store: {},
      entry: undefined,
      canonicalKey: "agent:main:dreaming-narrative-concurrent",
      storeKeys: ["agent:main:dreaming-narrative-concurrent"],
      legacyKey: undefined,
    }));

  const patchConcurrent = await directSessionReq(
    "sessions.patch",
    {
      key: "agent:main:dreaming-narrative-concurrent",
      label: "patched by plugin",
    },
    {
      client: pluginClient,
    },
  );

  loadSessionEntrySpy.mockRestore();

  expect(patchConcurrent.ok).toBe(false);
  expect(patchConcurrent.error?.message).toContain("did not create it");
  expect(
    loadSessionEntry({
      agentId: "main",
      sessionKey: "agent:main:dreaming-narrative-concurrent",
      storePath,
    }),
  ).toMatchObject(originalEntry);
});

test("sessions.patch stamps pluginOwnerId when patch creates a new session", async () => {
  const { storePath } = await createSessionStoreDir();
  const pluginClient = {
    connect: {
      scopes: ["operator.admin"],
    },
    internal: {
      pluginRuntimeOwnerId: "memory-core",
    },
  } as never;

  const patchCreate = await directSessionReq(
    "sessions.patch",
    {
      key: "agent:main:dreaming-narrative-new",
      label: "created by patch",
    },
    {
      client: pluginClient,
    },
  );
  expect(patchCreate.ok).toBe(true);
  const created = loadSessionEntry({
    agentId: "main",
    sessionKey: "agent:main:dreaming-narrative-new",
    storePath,
  });
  expect(created?.pluginOwnerId).toBe("memory-core");
  expect(created?.label).toBe("created by patch");
});
