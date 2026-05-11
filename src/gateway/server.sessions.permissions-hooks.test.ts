import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { isSessionPatchEvent } from "../hooks/internal-hooks.js";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "./protocol/client-info.js";
import {
  connectOk,
  rpcReq,
  testState,
  trackConnectChallengeNonce,
  writeSessionStore,
} from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionHookMocks,
  sessionStoreEntry,
  createCheckpointFixture,
  isInternalHookEvent,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient, getHarness } = setupGatewaySessionsTestHarness();

function requireRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeTruthy();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

function requireFirstCallArg(mock: { mock: { calls: readonly (readonly unknown[])[] } }) {
  const call = mock.mock.calls[0];
  expect(call).toBeTruthy();
  return call?.[0];
}

test("webchat clients cannot patch, delete, compact, or restore sessions", async () => {
  const { dir } = await createSessionStoreDir();
  const fixture = await createCheckpointFixture(dir);

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(fixture.sessionId, {
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
      "discord:group:dev": sessionStoreEntry("sess-group"),
    },
  });

  const ws = new WebSocket(`ws://127.0.0.1:${getHarness().port}`, {
    headers: { origin: `http://127.0.0.1:${getHarness().port}` },
  });
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  await connectOk(ws, {
    client: {
      id: GATEWAY_CLIENT_IDS.WEBCHAT_UI,
      version: "1.0.0",
      platform: "test",
      mode: GATEWAY_CLIENT_MODES.UI,
    },
    scopes: ["operator.admin"],
  });

  const patched = await rpcReq(ws, "sessions.patch", {
    key: "agent:main:discord:group:dev",
    label: "should-fail",
  });
  expect(patched.ok).toBe(false);
  expect(patched.error?.message ?? "").toMatch(/webchat clients cannot patch sessions/i);

  const deleted = await rpcReq(ws, "sessions.delete", {
    key: "agent:main:discord:group:dev",
  });
  expect(deleted.ok).toBe(false);
  expect(deleted.error?.message ?? "").toMatch(/webchat clients cannot delete sessions/i);

  const compacted = await rpcReq(ws, "sessions.compact", {
    key: "main",
    maxLines: 3,
  });
  expect(compacted.ok).toBe(false);
  expect(compacted.error?.message ?? "").toMatch(/webchat clients cannot compact sessions/i);

  const restored = await rpcReq(ws, "sessions.compaction.restore", {
    key: "main",
    checkpointId: "checkpoint-1",
  });
  expect(restored.ok).toBe(false);
  expect(restored.error?.message ?? "").toMatch(/webchat clients cannot restore sessions/i);

  ws.close();
});

test("session:patch hook fires with correct context", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-patch-hook-"));
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
  const event = requireRecord(requireFirstCallArg(sessionHookMocks.triggerInternalHook));
  expect(event.type).toBe("session");
  expect(event.action).toBe("patch");
  expect(event.sessionKey).toBe("agent:main:main");
  const context = requireRecord(event.context);
  const sessionEntry = requireRecord(context.sessionEntry);
  expect(sessionEntry.sessionId).toBe("sess-hook-test");
  expect(sessionEntry.label).toBe("updated-label");
  expect(requireRecord(context.patch).label).toBe("updated-label");
  requireRecord(context.cfg);

  ws.close();
});

test("session:patch hook does not fire for webchat clients", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-webchat-hook-"));
  const storePath = path.join(dir, "sessions.json");
  testState.sessionStorePath = storePath;

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-webchat-test"),
    },
  });

  sessionHookMocks.triggerInternalHook.mockClear();

  const ws = new WebSocket(`ws://127.0.0.1:${getHarness().port}`, {
    headers: { origin: `http://127.0.0.1:${getHarness().port}` },
  });
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  await connectOk(ws, {
    client: {
      id: GATEWAY_CLIENT_IDS.WEBCHAT_UI,
      version: "1.0.0",
      platform: "test",
      mode: GATEWAY_CLIENT_MODES.UI,
    },
    scopes: ["operator.admin"],
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-success-hook-"));
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
  const event = requireRecord(requireFirstCallArg(sessionHookMocks.triggerInternalHook));
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

test("control-ui client can delete sessions even in webchat mode", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-control-ui-delete-"));
  const storePath = path.join(dir, "sessions.json");
  testState.sessionStorePath = storePath;

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
      "discord:group:dev": sessionStoreEntry("sess-group"),
    },
  });

  const ws = new WebSocket(`ws://127.0.0.1:${getHarness().port}`, {
    headers: { origin: `http://127.0.0.1:${getHarness().port}` },
  });
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  await connectOk(ws, {
    client: {
      id: GATEWAY_CLIENT_IDS.CONTROL_UI,
      version: "1.0.0",
      platform: "test",
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
    },
    scopes: ["operator.admin"],
  });

  const deleted = await rpcReq<{ ok: true; deleted: boolean }>(ws, "sessions.delete", {
    key: "agent:main:discord:group:dev",
  });
  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(true);

  const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
    string,
    { sessionId?: string }
  >;
  expect(store["agent:main:discord:group:dev"]).toBeUndefined();

  ws.close();
});
