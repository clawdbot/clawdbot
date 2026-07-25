// Session permissions and hooks tests protect gateway access control around
// patch/delete/compact/restore APIs plus emitted internal hook payloads.
import path from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";

const permHookTempDirs: string[] = [];

afterAll(() => {
  cleanupTempDirs(permHookTempDirs);
});
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import {
  listSessionEntries,
  loadSessionEntry,
  upsertSessionEntry,
} from "../config/sessions/session-accessor.js";
import { isSessionPatchEvent } from "../hooks/internal-hooks.js";
import { requireRecord } from "./test-helpers.assertions.js";
import { connectWebchatClient, rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionHookMocks,
  sessionStoreEntry,
  createCheckpointFixture,
  isInternalHookEvent,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient, getHarness } = setupGatewaySessionsTestHarness();
type PermissionClient = NonNullable<Parameters<typeof connectWebchatClient>[0]["client"]>;

async function openPermissionClient(
  client: Pick<PermissionClient, "id" | "mode"> & { scopes?: string[] },
) {
  return await connectWebchatClient({
    port: getHarness().port,
    scopes: client.scopes,
    client: {
      id: client.id,
      version: "1.0.0",
      platform: "test",
      mode: client.mode,
    },
  });
}

function requireFirstCallArg(mock: { mock: { calls: readonly (readonly unknown[])[] } }) {
  const call = mock.mock.calls.at(0);
  if (!call) {
    throw new Error("Expected first mock call");
  }
  return call[0];
}

async function createPermissionCheckpointStore() {
  const { dir, storePath } = await createSessionStoreDir();
  const fixture = await createCheckpointFixture(dir);
  if (!fixture.preCompactionSession || !fixture.preCompactionSessionFile) {
    throw new Error("expected legacy checkpoint fixture");
  }

  await upsertSessionEntry(
    { sessionKey: "agent:main:main", storePath },
    sessionStoreEntry(fixture.sessionId, {
      sessionFile: fixture.sessionFile,
      compactionCheckpoints: [
        {
          checkpointId: "checkpoint-1",
          sessionKey: "agent:main:main",
          sessionId: fixture.sessionId,
          createdAt: Date.now(),
          reason: "manual",
          tokensBefore: 123,
          tokensAfter: 45,
          summary: "checkpoint summary",
          firstKeptEntryId: fixture.preCompactionLeafId,
          preCompaction: {
            sessionId: fixture.preCompactionSession.getSessionId(),
            sessionFile: fixture.preCompactionSessionFile,
            leafId: fixture.preCompactionLeafId,
          },
          postCompaction: {
            sessionId: fixture.sessionId,
            sessionFile: fixture.sessionFile,
            leafId: fixture.postCompactionLeafId,
            entryId: fixture.postCompactionLeafId,
          },
        },
      ],
    }),
  );
  await upsertSessionEntry(
    { sessionKey: "agent:main:discord:group:dev", storePath },
    sessionStoreEntry("sess-group"),
  );
  return { storePath };
}

test("webchat session mutations follow operator scope policy", async () => {
  const { storePath } = await createPermissionCheckpointStore();

  const ws = await openPermissionClient({
    id: GATEWAY_CLIENT_IDS.WEBCHAT_UI,
    mode: GATEWAY_CLIENT_MODES.UI,
    scopes: ["operator.read"],
  });

  const deniedMutations = [
    {
      method: "sessions.patch",
      params: { key: "agent:main:discord:group:dev", label: "should-fail" },
      missingScope: "operator.write",
    },
    {
      method: "sessions.delete",
      params: { key: "agent:main:discord:group:dev" },
      missingScope: "operator.admin",
    },
    {
      method: "sessions.compact",
      params: { key: "main", maxLines: 3 },
      missingScope: "operator.admin",
    },
    {
      method: "sessions.compaction.branch",
      params: { key: "main", checkpointId: "checkpoint-1" },
      missingScope: "operator.write",
    },
    {
      method: "sessions.compaction.restore",
      params: { key: "main", checkpointId: "checkpoint-1" },
      missingScope: "operator.admin",
    },
    {
      method: "sessions.branches.switch",
      params: { sessionKey: "agent:main:main", leafEntryId: "entry-1" },
      missingScope: "operator.admin",
    },
    {
      method: "sessions.rewind",
      params: { sessionKey: "agent:main:main", entryId: "entry-1" },
      missingScope: "operator.admin",
    },
    {
      method: "sessions.fork",
      params: { sessionKey: "agent:main:main", entryId: "entry-1" },
      missingScope: "operator.write",
    },
    {
      method: "sessions.dispatch",
      params: { key: "agent:main:main", profileId: "test" },
      missingScope: "operator.admin",
    },
    {
      method: "sessions.reclaim",
      params: { key: "agent:main:main" },
      missingScope: "operator.admin",
    },
    {
      method: "sessions.pluginPatch",
      params: {
        key: "agent:main:main",
        pluginId: "test-plugin",
        namespace: "test",
        value: true,
      },
      missingScope: "operator.admin",
    },
  ];

  for (const mutation of deniedMutations) {
    const result = await rpcReq(ws, mutation.method, mutation.params);
    expect(result.ok, mutation.method).toBe(false);
    expect(result.error, mutation.method).toEqual({
      code: "FORBIDDEN",
      message: `missing scope: ${mutation.missingScope}`,
      details: {
        code: "MISSING_SCOPE",
        missingScope: mutation.missingScope,
        requiredScopes: [mutation.missingScope],
      },
    });
  }

  expect(
    listSessionEntries({ storePath })
      .map(({ sessionKey }) => sessionKey)
      .toSorted(),
  ).toEqual(["agent:main:discord:group:dev", "agent:main:main"]);

  ws.close();
});

test("session:patch hook fires with correct context", async () => {
  const dir = makeTempDir(permHookTempDirs, "openclaw-sessions-patch-hook-");
  const storePath = path.join(dir, "sessions.json");
  testState.sessionStorePath = storePath;

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-hook-test", {
        label: "original-label",
      }),
    },
  });

  sessionHookMocks.triggerInternalHook.mockClear();

  const { ws } = await openClient();

  const patched = await rpcReq(ws, "sessions.patch", {
    key: "agent:main:main",
    label: "updated-label",
  });

  expect(patched.ok).toBe(true);
  const event = requireRecord(
    requireFirstCallArg(sessionHookMocks.triggerInternalHook),
    "internal hook event",
  );
  expect(event.type).toBe("session");
  expect(event.action).toBe("patch");
  expect(event.sessionKey).toBe("agent:main:main");
  const context = requireRecord(event.context, "internal hook context");
  const sessionEntry = requireRecord(context.sessionEntry, "session entry");
  expect(sessionEntry.sessionId).toBe("sess-hook-test");
  expect(sessionEntry.label).toBe("updated-label");
  expect(requireRecord(context.patch, "session patch").label).toBe("updated-label");
  requireRecord(context.cfg, "config");

  ws.close();
});

test("session:patch hook does not fire after scope rejection", async () => {
  const dir = makeTempDir(permHookTempDirs, "openclaw-sessions-webchat-hook-");
  const storePath = path.join(dir, "sessions.json");
  testState.sessionStorePath = storePath;

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-webchat-test"),
    },
  });

  sessionHookMocks.triggerInternalHook.mockClear();

  const ws = await openPermissionClient({
    id: GATEWAY_CLIENT_IDS.WEBCHAT_UI,
    mode: GATEWAY_CLIENT_MODES.UI,
    scopes: ["operator.read"],
  });

  const patched = await rpcReq(ws, "sessions.patch", {
    key: "agent:main:main",
    label: "should-not-trigger-hook",
  });

  expect(patched.ok).toBe(false);
  expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();

  ws.close();
});

test("session:patch hook only fires after successful patch", async () => {
  const dir = makeTempDir(permHookTempDirs, "openclaw-sessions-success-hook-");
  const storePath = path.join(dir, "sessions.json");
  testState.sessionStorePath = storePath;

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-success-test"),
    },
  });

  const { ws } = await openClient();

  sessionHookMocks.triggerInternalHook.mockClear();

  // Test 1: Invalid patch (missing key) - hook should not fire
  const invalidPatch = await rpcReq(ws, "sessions.patch", {
    // Missing required 'key' parameter
    label: "should-fail",
  });

  expect(invalidPatch.ok).toBe(false);
  expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();

  // Test 2: Valid patch - hook should fire
  const validPatch = await rpcReq(ws, "sessions.patch", {
    key: "agent:main:main",
    label: "should-succeed",
  });

  expect(validPatch.ok).toBe(true);
  const event = requireRecord(
    requireFirstCallArg(sessionHookMocks.triggerInternalHook),
    "internal hook event",
  );
  expect(event.type).toBe("session");
  expect(event.action).toBe("patch");

  ws.close();
});

test("session:patch skips clone and dispatch when no hooks listen", async () => {
  const structuredCloneSpy = vi.spyOn(globalThis, "structuredClone");
  sessionHookMocks.hasInternalHookListeners.mockReturnValue(false);

  const { ws } = await openClient();
  const patched = await rpcReq(ws, "sessions.patch", {
    key: "agent:main:main",
    label: "no-hook-listener",
  });

  expect(patched.ok).toBe(true);
  const clonedHookContexts = structuredCloneSpy.mock.calls.filter(([value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const record = value as Record<string, unknown>;
    return Boolean(record.cfg && record.patch && record.sessionEntry);
  });
  expect(clonedHookContexts).toHaveLength(0);
  expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();

  structuredCloneSpy.mockRestore();
  ws.close();
});

test("session:patch hook mutations cannot change the response path", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-cfg-isolation-test"),
    },
  });

  sessionHookMocks.triggerInternalHook.mockImplementationOnce(async (event) => {
    if (!isInternalHookEvent(event) || !isSessionPatchEvent(event)) {
      return;
    }
    event.context.cfg.agents = {
      ...event.context.cfg.agents,
      defaults: {
        ...event.context.cfg.agents?.defaults,
        model: "zai/glm-4.6",
      },
    };
  });

  const { ws } = await openClient();
  const patched = await rpcReq<{
    entry: { label?: string };
    key: string;
    resolved: {
      modelProvider: string;
      model: string;
      agentRuntime: { id: string; source: string };
    };
  }>(ws, "sessions.patch", {
    key: "agent:main:main",
    label: "cfg-isolation",
  });

  expect(patched.ok).toBe(true);
  expect(patched.payload?.resolved).toEqual({
    modelProvider: "anthropic",
    model: "claude-opus-4-6",
    agentRuntime: { id: "auto", source: "implicit" },
  });
  expect(patched.payload?.entry.label).toBe("cfg-isolation");

  ws.close();
});

test("admin-scoped webchat client can mutate sessions", async () => {
  const { storePath } = await createPermissionCheckpointStore();
  const ws = await openPermissionClient({
    id: GATEWAY_CLIENT_IDS.WEBCHAT_UI,
    mode: GATEWAY_CLIENT_MODES.WEBCHAT,
    scopes: ["operator.admin"],
  });

  const branched = await rpcReq<{
    sourceKey: string;
    entry: { parentSessionKey?: string };
  }>(ws, "sessions.compaction.branch", {
    key: "main",
    checkpointId: "checkpoint-1",
  });
  expect(branched.ok).toBe(true);
  expect(branched.payload?.sourceKey).toBe("agent:main:main");
  expect(branched.payload?.entry.parentSessionKey).toBe("agent:main:main");

  const deleted = await rpcReq<{ ok: true; deleted: boolean }>(ws, "sessions.delete", {
    key: "agent:main:discord:group:dev",
  });
  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(true);

  expect(
    loadSessionEntry({ sessionKey: "agent:main:discord:group:dev", storePath }),
  ).toBeUndefined();

  ws.close();
});
