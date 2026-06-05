// Session reset cleanup tests protect ACP metadata resets, active run shutdown,
// hook emission, thread bindings, and browser/MCP cleanup side effects.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  readAcpSessionMeta,
  writeAcpSessionMetaForMigration,
} from "../acp/runtime/session-meta.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import { enqueueSystemEvent, peekSystemEvents } from "../infra/system-events.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { embeddedRunMock, testState, writeSessionStore } from "./test-helpers.js";
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

type ResetAcpState = {
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
type ConfigFilePatch = Parameters<(typeof import("../config/config.js"))["writeConfigFile"]>[0];

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

function expectResetAcpState(acp: ResetAcpState | undefined) {
  expect(acp?.backend).toBe("acpx");
  expect(acp?.agent).toBe("codex");
  expect(acp?.runtimeSessionName).toBe("runtime:reset");
  expect(acp?.identity?.state).toBe("pending");
  expect(acp?.identity?.acpxRecordId).toBe("agent:main:main");
  expect(acp?.identity?.acpxSessionId).toBeUndefined();
  expect(acp?.mode).toBe("persistent");
  expect(acp?.runtimeOptions?.runtimeMode).toBe("auto");
  expect(acp?.runtimeOptions?.timeoutSeconds).toBe(30);
  expect(acp?.cwd).toBe("/tmp/acp-session");
  expect(acp?.state).toBe("idle");
}

async function seedWaitingActiveMainSession() {
  await seedActiveMainSession();
  embeddedRunMock.activeIds.add("sess-main");
  embeddedRunMock.waitResults.set("sess-main", true);
}

async function resetMainSession() {
  return await directSessionReq<{ ok: true; key: string; entry: { sessionId: string } }>(
    "sessions.reset",
    {
      key: "main",
    },
  );
}

function installAcpRuntimeBackendWithFreshSession() {
  const prepareFreshSession = vi.fn(async () => {});
  acpRuntimeMocks.getAcpRuntimeBackend.mockReturnValue({
    id: "acpx",
    runtime: {
      prepareFreshSession,
    },
  });
  return prepareFreshSession;
}

function resolvedAcpMeta(params: {
  recordId: string;
  backendSessionId: string;
  runtimeSessionName?: string;
  mode?: SessionAcpMeta["mode"];
  runtimeOptions?: SessionAcpMeta["runtimeOptions"];
}): SessionAcpMeta {
  const meta: SessionAcpMeta = {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: params.runtimeSessionName ?? "runtime:reset",
    identity: {
      state: "resolved",
      acpxRecordId: params.recordId,
      acpxSessionId: params.backendSessionId,
      source: "status",
      lastUpdatedAt: Date.now(),
    },
    mode: params.mode ?? "persistent",
    cwd: "/tmp/acp-session",
    state: "idle",
    lastActivityAt: Date.now(),
  };
  if (params.runtimeOptions) {
    meta.runtimeOptions = params.runtimeOptions;
  }
  return meta;
}

async function expectResetWithConfigSkipsBrowserCleanup(config: ConfigFilePatch) {
  const { writeConfigFile } = await import("../config/config.js");
  await writeConfigFile(config);
  try {
    await seedWaitingActiveMainSession();
    const reset = await resetMainSession();

    expect(reset.ok).toBe(true);
    expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).not.toHaveBeenCalled();
  } finally {
    await writeConfigFile({});
  }
}

test("sessions.reset aborts active runs and clears queues", async () => {
  await seedWaitingActiveMainSession();
  enqueueSystemEvent("stale event via alias", { sessionKey: "main" });
  enqueueSystemEvent("stale event via canonical key", { sessionKey: "agent:main:main" });
  enqueueSystemEvent("stale event via session id", { sessionKey: "sess-main" });
  const waitCallCountAtSnapshotClear: number[] = [];
  bootstrapCacheMocks.clearBootstrapSnapshot.mockImplementation(() => {
    waitCallCountAtSnapshotClear.push(embeddedRunMock.waitCalls.length);
  });

  const reset = await resetMainSession();
  expect(reset.ok).toBe(true);
  expect(reset.payload?.key).toBe("agent:main:main");
  expect(reset.payload?.entry.sessionId).not.toBe("sess-main");
  expectActiveRunCleanup("agent:main:main", ["main", "agent:main:main", "sess-main"], "sess-main");
  expect(peekSystemEvents("main")).toStrictEqual([]);
  expect(peekSystemEvents("agent:main:main")).toStrictEqual([]);
  expect(peekSystemEvents("sess-main")).toStrictEqual([]);
  expect(bundleMcpRuntimeMocks.disposeSessionMcpRuntime).toHaveBeenCalledWith("sess-main");
  expect(waitCallCountAtSnapshotClear).toEqual([1]);
  expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).toHaveBeenCalledTimes(1);
  const closeTabsCall = browserSessionTabMocks.closeTrackedBrowserTabsForSessions.mock
    .calls[0] as unknown as [{ sessionKeys?: string[]; onWarn?: unknown }] | undefined;
  const closeTabsParams = closeTabsCall?.[0];
  expect(closeTabsParams?.sessionKeys).toEqual(["main", "agent:main:main", "sess-main"]);
  expect(typeof closeTabsParams?.onWarn).toBe("function");
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

test("sessions.reset skips browser cleanup when root browser support is disabled", async () => {
  await expectResetWithConfigSkipsBrowserCleanup({ browser: { enabled: false } });
});

test("sessions.reset skips browser cleanup when the browser plugin entry is disabled", async () => {
  await expectResetWithConfigSkipsBrowserCleanup({
    plugins: { entries: { browser: { enabled: false } } },
  });
});

test("sessions.reset closes ACP runtime handles for ACP sessions", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  const prepareFreshSession = installAcpRuntimeBackendWithFreshSession();

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
    },
  });
  writeAcpSessionMetaForMigration({
    sessionKey: "agent:main:main",
    meta: resolvedAcpMeta({
      recordId: "agent:main:main",
      backendSessionId: "backend-session-1",
      runtimeOptions: {
        runtimeMode: "auto",
        timeoutSeconds: 30,
      },
    }),
  });
  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: Record<string, unknown>;
  }>("sessions.reset", {
    key: "main",
  });
  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry).not.toHaveProperty("acp");
  expectResetAcpState(readAcpSessionMeta({ sessionKey: "agent:main:main" }));
  expect(acpManagerMocks.closeSession).toHaveBeenCalledTimes(1);
  const closeSessionCall = acpManagerMocks.closeSession.mock.calls.at(0) as unknown as
    | [
        {
          allowBackendUnavailable?: boolean;
          cfg?: unknown;
          discardPersistentState?: boolean;
          requireAcpSession?: boolean;
          reason?: string;
          sessionKey?: string;
        },
      ]
    | undefined;
  const closeSessionParams = closeSessionCall?.[0] as
    | {
        allowBackendUnavailable?: boolean;
        cfg?: unknown;
        discardPersistentState?: boolean;
        requireAcpSession?: boolean;
        reason?: string;
        sessionKey?: string;
      }
    | undefined;
  expect(closeSessionParams?.allowBackendUnavailable).toBe(true);
  if (!closeSessionParams?.cfg) {
    throw new Error("expected closeSession config");
  }
  expect(closeSessionParams?.discardPersistentState).toBe(true);
  expect(closeSessionParams?.requireAcpSession).toBe(false);
  expect(closeSessionParams?.reason).toBe("session-reset");
  expect(closeSessionParams?.sessionKey).toBe("agent:main:main");
  expect(prepareFreshSession).toHaveBeenCalledWith({
    sessionKey: "agent:main:main",
  });
  const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
    string,
    { acp?: ResetAcpState }
  >;
  expect(store["agent:main:main"]).not.toHaveProperty("acp");
  expectResetAcpState(readAcpSessionMeta({ sessionKey: "agent:main:main" }));
});

test("sessions.reset closes child ACP runtime handles spawned from the parent", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  installAcpRuntimeBackendWithFreshSession();

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
      "acp-child-1": sessionStoreEntry("sess-child-1", {
        spawnedBy: "agent:main:main",
      }),
      "not-acp-child": sessionStoreEntry("sess-not-acp-child", {
        spawnedBy: "agent:main:main",
      }),
      "unrelated-acp-child": sessionStoreEntry("sess-unrelated-acp-child", {
        spawnedBy: "agent:main:other",
      }),
    },
  });
  writeAcpSessionMetaForMigration({
    sessionKey: "agent:main:main",
    meta: resolvedAcpMeta({
      recordId: "agent:main:main",
      backendSessionId: "backend-session-main",
    }),
  });
  writeAcpSessionMetaForMigration({
    sessionKey: "agent:main:acp-child-1",
    meta: resolvedAcpMeta({
      recordId: "agent:main:acp-child-1",
      backendSessionId: "backend-session-child-1",
      runtimeSessionName: "runtime:child-1",
      mode: "oneshot",
    }),
  });
  writeAcpSessionMetaForMigration({
    sessionKey: "agent:main:unrelated-acp-child",
    meta: {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "runtime:unrelated",
      mode: "oneshot",
      cwd: "/tmp/acp-session",
      state: "idle",
      lastActivityAt: Date.now(),
    },
  });

  const reset = await directSessionReq<{ ok: true }>("sessions.reset", {
    key: "main",
  });
  expect(reset.ok).toBe(true);

  // The parent and its spawned ACP child are both closed; without child cleanup
  // the child's claude-agent-acp process is orphaned on parent reset (#68916).
  const closedKeys = (
    acpManagerMocks.closeSession.mock.calls as unknown as Array<[{ sessionKey?: string }]>
  ).map((call) => call[0]?.sessionKey);
  expect(closedKeys).toContain("agent:main:main");
  expect(closedKeys).toContain("agent:main:acp-child-1");
  expect(closedKeys).not.toContain("agent:main:not-acp-child");
  expect(closedKeys).not.toContain("agent:main:unrelated-acp-child");
});

test("sessions.reset closes a spawned ACP child that lives in a different agent store", async () => {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required for gateway session tests");
  }
  // Per-agent store layout: ACP children live under the target agent's own
  // store file, which is different from the parent's store.
  testState.sessionConfig = {
    store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
  };
  const mainStorePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  const codexStorePath = path.join(stateDir, "agents", "codex", "sessions", "sessions.json");
  await fs.mkdir(path.dirname(mainStorePath), { recursive: true });
  await fs.mkdir(path.dirname(codexStorePath), { recursive: true });
  await fs.writeFile(
    mainStorePath,
    JSON.stringify({
      main: {
        sessionId: "sess-main",
        updatedAt: Date.now(),
      },
    }),
    "utf-8",
  );
  await fs.writeFile(
    codexStorePath,
    JSON.stringify({
      "agent:codex:acp:cross-store-child": {
        sessionId: "sess-codex-child",
        updatedAt: Date.now(),
        spawnedBy: "agent:main:main",
      },
    }),
    "utf-8",
  );
  writeAcpSessionMetaForMigration({
    sessionKey: "agent:main:main",
    meta: {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "runtime:main",
      mode: "persistent",
      state: "idle",
      lastActivityAt: Date.now(),
    },
  });
  writeAcpSessionMetaForMigration({
    sessionKey: "agent:codex:acp:cross-store-child",
    meta: {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "runtime:codex-child",
      mode: "oneshot",
      state: "idle",
      lastActivityAt: Date.now(),
    },
  });

  const reset = await directSessionReq<{ ok: true }>("sessions.reset", { key: "main" });
  expect(reset.ok).toBe(true);

  // The child in the codex store is closed even though it is not in the main
  // (parent) store — cleanup enumerates the combined cross-agent store.
  const closedKeys = (
    acpManagerMocks.closeSession.mock.calls as unknown as Array<[{ sessionKey?: string }]>
  ).map((call) => call[0]?.sessionKey);
  expect(closedKeys).toContain("agent:codex:acp:cross-store-child");
});

test("sessions.reset closes child ACP runtimes concurrently so stuck children do not serialize cleanup", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  acpRuntimeMocks.getAcpRuntimeBackend.mockReturnValue({
    id: "acpx",
    runtime: { prepareFreshSession: vi.fn(async () => {}) },
  });

  const childAcp = (recordId: string): SessionAcpMeta => ({
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: `runtime:${recordId}`,
    identity: {
      state: "resolved",
      acpxRecordId: recordId,
      acpxSessionId: `backend-${recordId}`,
      source: "status",
      lastUpdatedAt: Date.now(),
    },
    mode: "oneshot",
    cwd: "/tmp/acp-session",
    state: "idle",
    lastActivityAt: Date.now(),
  });

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
      // Mix the two real lineage fields: ACP spawns record `spawnedBy`,
      // subagent spawns record `parentSessionKey`; both must be cleaned up.
      "acp-child-1": sessionStoreEntry("sess-c1", {
        spawnedBy: "agent:main:main",
      }),
      "acp-child-2": sessionStoreEntry("sess-c2", {
        spawnedBy: "agent:main:main",
      }),
      "acp-child-3": sessionStoreEntry("sess-c3", {
        parentSessionKey: "agent:main:main",
      }),
    },
  });
  for (const sessionKey of [
    "agent:main:main",
    "agent:main:acp-child-1",
    "agent:main:acp-child-2",
    "agent:main:acp-child-3",
  ]) {
    writeAcpSessionMetaForMigration({
      sessionKey,
      meta: childAcp(sessionKey),
    });
  }

  // Parent cancel resolves immediately; child cancels hang until released. With
  // sequential cleanup only the first child would dispatch; concurrent cleanup
  // dispatches all three before any resolves.
  const releaseChildren: Array<() => void> = [];
  acpManagerMocks.cancelSession.mockImplementation(async (...args: unknown[]) => {
    const req = args[0] as { sessionKey?: string } | undefined;
    if (req?.sessionKey === "agent:main:main") {
      return;
    }
    await new Promise<void>((resolve) => {
      releaseChildren.push(resolve);
    });
  });

  try {
    const resetPromise = directSessionReq<{ ok: true }>("sessions.reset", {
      key: "main",
    });

    await vi.waitFor(() => {
      const childCancels = (
        acpManagerMocks.cancelSession.mock.calls as unknown as Array<[{ sessionKey?: string }]>
      ).filter((call) => call[0]?.sessionKey?.startsWith("agent:main:acp-child"));
      expect(childCancels.length).toBe(3);
    });

    for (const release of releaseChildren) {
      release();
    }
    const reset = await resetPromise;
    expect(reset.ok).toBe(true);
  } finally {
    acpManagerMocks.cancelSession.mockImplementation(async () => {});
  }
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
  expect(event?.targetSessionKey).toBe("agent:main:subagent:worker");
  expect(event?.targetKind).toBe("subagent");
  expect(event?.reason).toBe("session-reset");
  expect(event?.outcome).toBe("reset");
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
