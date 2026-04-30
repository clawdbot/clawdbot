import fs from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { enqueueSystemEvent, peekSystemEvents } from "../infra/system-events.js";
import { embeddedRunMock, writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  bootstrapCacheMocks,
  subagentLifecycleHookMocks,
  subagentLifecycleHookState,
  threadBindingMocks,
  acpRuntimeMocks,
  acpManagerMocks,
  browserSessionTabMocks,
  bundleMcpRuntimeMocks,
  writeSingleLineSession,
  sessionStoreEntry,
  expectActiveRunCleanup,
  directSessionReq,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, seedActiveMainSession } = setupGatewaySessionsTestHarness();

test("sessions.reset aborts active runs and clears queues", async () => {
  await seedActiveMainSession();
  enqueueSystemEvent("stale event via alias", { sessionKey: "main" });
  enqueueSystemEvent("stale event via canonical key", { sessionKey: "agent:main:main" });
  enqueueSystemEvent("stale event via session id", { sessionKey: "sess-main" });
  const waitCallCountAtSnapshotClear: number[] = [];
  bootstrapCacheMocks.clearBootstrapSnapshot.mockImplementation(() => {
    waitCallCountAtSnapshotClear.push(embeddedRunMock.waitCalls.length);
  });

  embeddedRunMock.activeIds.add("sess-main");
  embeddedRunMock.waitResults.set("sess-main", true);

  const reset = await directSessionReq<{ ok: true; key: string; entry: { sessionId: string } }>(
    "sessions.reset",
    {
      key: "main",
    },
  );
  expect(reset.ok).toBe(true);
  expect(reset.payload?.key).toBe("agent:main:main");
  expect(reset.payload?.entry.sessionId).not.toBe("sess-main");
  expectActiveRunCleanup("agent:main:main", ["main", "agent:main:main", "sess-main"], "sess-main");
  expect(peekSystemEvents("main")).toEqual([]);
  expect(peekSystemEvents("agent:main:main")).toEqual([]);
  expect(peekSystemEvents("sess-main")).toEqual([]);
  expect(bundleMcpRuntimeMocks.disposeSessionMcpRuntime).toHaveBeenCalledWith("sess-main");
  expect(waitCallCountAtSnapshotClear).toEqual([1]);
  expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).toHaveBeenCalledTimes(1);
  expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).toHaveBeenCalledWith({
    sessionKeys: expect.arrayContaining(["main", "agent:main:main", "sess-main"]),
    onWarn: expect.any(Function),
  });
  expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
  expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledWith(
    {
      targetSessionKey: "agent:main:main",
      targetKind: "acp",
      reason: "session-reset",
      sendFarewell: true,
      outcome: "reset",
    },
    {
      childSessionKey: "agent:main:main",
    },
  );
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
    targetSessionKey: "agent:main:main",
    reason: "session-reset",
  });
});

test("sessions.reset closes ACP runtime handles for ACP sessions", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  const prepareFreshSession = vi.fn(async () => {});
  acpRuntimeMocks.getAcpRuntimeBackend.mockReturnValue({
    id: "acpx",
    runtime: {
      prepareFreshSession,
    },
  });

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main", {
        acp: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "runtime:reset",
          identity: {
            state: "resolved",
            acpxRecordId: "agent:main:main",
            acpxSessionId: "backend-session-1",
            source: "status",
            lastUpdatedAt: Date.now(),
          },
          mode: "persistent",
          runtimeOptions: {
            runtimeMode: "auto",
            timeoutSeconds: 30,
          },
          cwd: "/tmp/acp-session",
          state: "idle",
          lastActivityAt: Date.now(),
        },
      }),
    },
  });
  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: {
      acp?: {
        backend?: string;
        agent?: string;
        runtimeSessionName?: string;
        identity?: {
          state?: string;
          acpxRecordId?: string;
          acpxSessionId?: string;
        };
        mode?: string;
        runtimeOptions?: {
          runtimeMode?: string;
          timeoutSeconds?: number;
        };
        cwd?: string;
        state?: string;
      };
    };
  }>("sessions.reset", {
    key: "main",
  });
  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry.acp).toMatchObject({
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "runtime:reset",
    identity: {
      state: "pending",
      acpxRecordId: "agent:main:main",
    },
    mode: "persistent",
    runtimeOptions: {
      runtimeMode: "auto",
      timeoutSeconds: 30,
    },
    cwd: "/tmp/acp-session",
    state: "idle",
  });
  expect(reset.payload?.entry.acp?.identity?.acpxSessionId).toBeUndefined();
  expect(acpManagerMocks.closeSession).toHaveBeenCalledWith({
    allowBackendUnavailable: true,
    cfg: expect.any(Object),
    discardPersistentState: true,
    requireAcpSession: false,
    reason: "session-reset",
    sessionKey: "agent:main:main",
  });
  expect(prepareFreshSession).toHaveBeenCalledWith({
    sessionKey: "agent:main:main",
  });
  const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
    string,
    {
      acp?: {
        backend?: string;
        agent?: string;
        runtimeSessionName?: string;
        identity?: {
          state?: string;
          acpxRecordId?: string;
          acpxSessionId?: string;
        };
        mode?: string;
        runtimeOptions?: {
          runtimeMode?: string;
          timeoutSeconds?: number;
        };
        cwd?: string;
        state?: string;
      };
    }
  >;
  expect(store["agent:main:main"]?.acp).toMatchObject({
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "runtime:reset",
    identity: {
      state: "pending",
      acpxRecordId: "agent:main:main",
    },
    mode: "persistent",
    runtimeOptions: {
      runtimeMode: "auto",
      timeoutSeconds: 30,
    },
    cwd: "/tmp/acp-session",
    state: "idle",
  });
  expect(store["agent:main:main"]?.acp?.identity?.acpxSessionId).toBeUndefined();
});

test("sessions.reset does not emit lifecycle events when key does not exist", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
    },
  });

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: { sessionId: string };
  }>("sessions.reset", {
    key: "agent:main:subagent:missing",
  });

  expect(reset.ok).toBe(true);
  expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).not.toHaveBeenCalled();
});

test("sessions.reset emits subagent targetKind for subagent sessions", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-subagent", "hello");
  await writeSessionStore({
    entries: {
      "agent:main:subagent:worker": sessionStoreEntry("sess-subagent"),
    },
  });

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: { sessionId: string };
  }>("sessions.reset", {
    key: "agent:main:subagent:worker",
  });
  expect(reset.ok).toBe(true);
  expect(reset.payload?.key).toBe("agent:main:subagent:worker");
  expect(reset.payload?.entry.sessionId).not.toBe("sess-subagent");
  expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
  const event = (subagentLifecycleHookMocks.runSubagentEnded.mock.calls as unknown[][])[0]?.[0] as
    | { targetKind?: string; targetSessionKey?: string; reason?: string; outcome?: string }
    | undefined;
  expect(event).toMatchObject({
    targetSessionKey: "agent:main:subagent:worker",
    targetKind: "subagent",
    reason: "session-reset",
    outcome: "reset",
  });
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
    targetSessionKey: "agent:main:subagent:worker",
    reason: "session-reset",
  });
});

test("sessions.reset directly unbinds thread bindings when hooks are unavailable", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
    },
  });
  subagentLifecycleHookState.hasSubagentEndedHook = false;

  const reset = await directSessionReq<{ ok: true; key: string }>("sessions.reset", {
    key: "main",
  });
  expect(reset.ok).toBe(true);
  expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
    targetSessionKey: "agent:main:main",
    reason: "session-reset",
  });
});
