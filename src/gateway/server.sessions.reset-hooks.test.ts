import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { embeddedRunMock, testState, writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  bootstrapCacheMocks,
  sessionHookMocks,
  beforeResetHookMocks,
  sessionLifecycleHookMocks,
  beforeResetHookState,
  browserSessionTabMocks,
  writeSingleLineSession,
  sessionStoreEntry,
  expectActiveRunCleanup,
  directSessionReq,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, seedActiveMainSession } = setupGatewaySessionsTestHarness();

type HookEventRecord = Record<string, unknown> & {
  context?: Record<string, unknown> & {
    previousSessionEntry?: { sessionId?: string };
  };
  messages?: Array<{ role?: string; content?: unknown }>;
};

type CommandNewHookEvent = {
  type: string;
  action: string;
  sessionKey?: string;
  context?: {
    commandSource?: string;
    previousSessionEntry?: { sessionId?: string };
  };
};

type SessionEntryWithCliBindings = {
  sessionId?: string;
  claudeCliSessionId?: string;
  cliSessionBindings?: unknown;
  cliSessionIds?: unknown;
};

function firstHookCall(mock: { mock: { calls: unknown[][] } }): [HookEventRecord, HookEventRecord] {
  const call = mock.mock.calls.at(0);
  if (!call) {
    throw new Error("Expected hook call");
  }
  return [call[0] as HookEventRecord, call[1] as HookEventRecord];
}

function expectTranscriptResetEvent(params: {
  event: HookEventRecord;
  sessionFile: string;
  content: string;
}) {
  expect(params.event.sessionFile).toBe(params.sessionFile);
  expect(params.event.reason).toBe("new");
  expect(params.event.messages).toHaveLength(1);
  expect(params.event.messages?.[0]?.role).toBe("user");
  expect(params.event.messages?.[0]?.content).toBe(params.content);
}

function expectMainHookContext(context: HookEventRecord, sessionId: string) {
  expect(context.agentId).toBe("main");
  expect(context.sessionKey).toBe("agent:main:main");
  expect(context.sessionId).toBe(sessionId);
}

function expectStringValue(value: unknown, label: string): string {
  expect(typeof value, label).toBe("string");
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function expectStringWithPrefix(value: unknown, prefix: string, label: string): string {
  const text = expectStringValue(value, label);
  expect(text.startsWith(prefix), label).toBe(true);
  expect(text.length, label).toBeGreaterThan(prefix.length);
  return text;
}

async function configureGlobalAgentSessionStore(dir: string) {
  const storeTemplate = path.join(dir, "{agentId}", "sessions.json");
  const configPath = expectStringValue(process.env.OPENCLAW_CONFIG_PATH, "OPENCLAW_CONFIG_PATH");
  const { clearConfigCache, clearRuntimeConfigSnapshot } = await import("../config/config.js");
  testState.sessionStorePath = storeTemplate;
  testState.sessionConfig = { scope: "global" };
  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        session: { scope: "global", store: storeTemplate },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  return {
    storeTemplate,
    configPath,
    mainStorePath: storeTemplate.replace("{agentId}", "main"),
    workStorePath: storeTemplate.replace("{agentId}", "work"),
    cleanup: async () => {
      testState.sessionStorePath = undefined;
      testState.sessionConfig = undefined;
      await fs.writeFile(configPath, "{}\n", "utf-8");
      clearRuntimeConfigSnapshot();
      clearConfigCache();
    },
  };
}

async function withGlobalAgentSessionStore<T>(
  dir: string,
  run: (globalConfig: Awaited<ReturnType<typeof configureGlobalAgentSessionStore>>) => Promise<T>,
) {
  const globalConfig = await configureGlobalAgentSessionStore(dir);
  try {
    return await run(globalConfig);
  } finally {
    await globalConfig.cleanup();
  }
}

async function writeGlobalSessionFile(storePath: string, sessionId: string) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(
    storePath,
    JSON.stringify({ global: sessionStoreEntry(sessionId) }, null, 2),
    "utf-8",
  );
}

async function writeMessageTranscript(params: {
  dir: string;
  sessionId: string;
  content: string;
  messageId?: string;
}) {
  const transcriptPath = path.join(params.dir, `${params.sessionId}.jsonl`);
  await fs.writeFile(
    transcriptPath,
    `${JSON.stringify({
      type: "message",
      id: params.messageId ?? "m1",
      message: { role: "user", content: params.content },
    })}\n`,
    "utf-8",
  );
  return transcriptPath;
}

async function writeMainTranscriptSession(params: {
  dir: string;
  sessionId: string;
  content: string;
  messageId?: string;
}) {
  const transcriptPath = await writeMessageTranscript(params);
  await writeSessionStore({
    entries: {
      main: {
        sessionId: params.sessionId,
        sessionFile: transcriptPath,
        updatedAt: Date.now(),
      },
    },
  });
  return transcriptPath;
}

async function writeMainSessionEntry(
  sessionId: string,
  overrides: Parameters<typeof sessionStoreEntry>[1] = {},
) {
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(sessionId, overrides),
    },
  });
}

async function resetMainSession() {
  return resetSession("main");
}

async function resetSession(key: string) {
  const reset = await directSessionReq<{ ok: true; key: string }>("sessions.reset", {
    key,
    reason: "new",
  });
  expect(reset.ok).toBe(true);
  return reset;
}

async function createFromMainSession(params: { emitCommandHooks?: boolean } = {}) {
  const result = await directSessionReq<{ ok: boolean; key: string }>("sessions.create", {
    parentSessionKey: "main",
    ...params,
  });
  expect(result.ok).toBe(true);
  return result;
}

async function performSessionReset(params: {
  key: string;
  agentId?: string;
  reason: "new" | "reset";
  commandSource: string;
}) {
  const { performGatewaySessionReset } = await import("./session-reset-service.js");
  return performGatewaySessionReset(params);
}

function expectResetErrorMessage(
  reset: Awaited<ReturnType<typeof performSessionReset>>,
  message: string,
) {
  expect(reset.ok).toBe(false);
  if (reset.ok) {
    throw new Error("expected reset to fail");
  }
  expect(reset.error.message).toBe(message);
}

function isCommandNewHookEvent(event: unknown): event is CommandNewHookEvent {
  return (
    Boolean(event) &&
    typeof event === "object" &&
    (event as { type?: unknown }).type === "command" &&
    (event as { action?: unknown }).action === "new"
  );
}

function commandNewHookEvents() {
  return (sessionHookMocks.triggerInternalHook.mock.calls as unknown as Array<[unknown]>)
    .map((call) => call[0])
    .filter(isCommandNewHookEvent);
}

function expectSingleCommandNewHookEvent() {
  const events = commandNewHookEvents();
  expect(events).toHaveLength(1);
  const event = events[0];
  if (!event) {
    throw new Error("expected session hook event");
  }
  expect(event.type).toBe("command");
  expect(event.action).toBe("new");
  return event;
}

function claudeCliBindings(sessionId: string) {
  return {
    claudeCliSessionId: sessionId,
    cliSessionBindings: {
      "claude-cli": { sessionId },
    },
    cliSessionIds: { "claude-cli": sessionId },
  };
}

function cliBoundSessionEntry(
  sessionId: string,
  sessionFile: string,
  cliSessionId: string,
  overrides: Parameters<typeof sessionStoreEntry>[1] = {},
) {
  return sessionStoreEntry(sessionId, {
    sessionFile,
    ...overrides,
    ...claudeCliBindings(cliSessionId),
  });
}

async function resolveGatewaySessionStorePathForKey(key: string) {
  const [{ getRuntimeConfig }, { resolveGatewaySessionStoreTarget }] = await Promise.all([
    import("../config/config.js"),
    import("./session-utils.js"),
  ]);
  return resolveGatewaySessionStoreTarget({
    cfg: getRuntimeConfig(),
    key,
  }).storePath;
}

async function loadGatewaySessionStoreForKey(key: string) {
  const [{ loadSessionStore }, gatewayStorePath] = await Promise.all([
    import("../config/sessions.js"),
    resolveGatewaySessionStorePathForKey(key),
  ]);
  return loadSessionStore(gatewayStorePath, { skipCache: true });
}

async function updateGatewaySessionStoreForKey(
  key: string,
  update: Parameters<(typeof import("../config/sessions.js"))["updateSessionStore"]>[1],
) {
  const [{ updateSessionStore }, gatewayStorePath] = await Promise.all([
    import("../config/sessions.js"),
    resolveGatewaySessionStorePathForKey(key),
  ]);
  await updateSessionStore(gatewayStorePath, update);
}

function expectCliBindingsCleared(
  nextEntry: SessionEntryWithCliBindings | undefined,
  previousSessionId: string,
) {
  expect(nextEntry).toBeDefined();
  expect(nextEntry?.sessionId).not.toBe(previousSessionId);
  expect(nextEntry?.claudeCliSessionId).toBeUndefined();
  expect(nextEntry?.cliSessionBindings).toBeUndefined();
  expect(nextEntry?.cliSessionIds).toBeUndefined();
}

function expectClaudeCliBinding(
  nextEntry: SessionEntryWithCliBindings | undefined,
  cliSessionId: string,
) {
  expect(nextEntry?.claudeCliSessionId).toBe(cliSessionId);
  expect(nextEntry?.cliSessionBindings).toEqual({
    "claude-cli": { sessionId: cliSessionId },
  });
  expect(nextEntry?.cliSessionIds).toEqual({ "claude-cli": cliSessionId });
}

test("sessions.reset emits internal command hook with reason", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");

  await writeMainSessionEntry("sess-main");

  await resetMainSession();
  const event = expectSingleCommandNewHookEvent();
  expect(event.sessionKey).toBe("agent:main:main");
  expect(event.context?.commandSource).toBe("gateway:sessions.reset");
  expect(event.context?.previousSessionEntry?.sessionId).toBe("sess-main");
});

test("sessions.reset emits before_reset hook with transcript context", async () => {
  const { dir } = await createSessionStoreDir();
  const transcriptPath = await writeMainTranscriptSession({
    dir,
    sessionId: "sess-main",
    content: "hello from transcript",
  });

  beforeResetHookState.hasBeforeResetHook = true;

  await resetMainSession();
  expect(beforeResetHookMocks.runBeforeReset).toHaveBeenCalledTimes(1);
  const [event, context] = firstHookCall(beforeResetHookMocks.runBeforeReset);
  expectTranscriptResetEvent({
    event,
    sessionFile: transcriptPath,
    content: "hello from transcript",
  });
  expectMainHookContext(context, "sess-main");
});

test("sessions.reset infers selected global agent from agent-prefixed aliases", async () => {
  const { dir } = await createSessionStoreDir();
  await withGlobalAgentSessionStore(dir, async (globalConfig) => {
    await writeSessionStore({
      entries: {},
      storePath: path.join(dir, "prime-sessions.json"),
    });
    await writeGlobalSessionFile(globalConfig.mainStorePath, "sess-main-global");
    await writeGlobalSessionFile(globalConfig.workStorePath, "sess-work-global");
    const { getRuntimeConfig } = await import("../config/config.js");
    const { resolveGatewaySessionStoreTarget } = await import("./session-utils.js");
    const { performGatewaySessionReset } = await import("./session-reset-service.js");
    const reset = await performGatewaySessionReset({
      key: "agent:work:main",
      reason: "reset",
      commandSource: "gateway:sessions.reset",
    });

    expect(reset.ok).toBe(true);
    if (!reset.ok) {
      throw new Error("expected reset to succeed");
    }
    expect(reset.key).toBe("global");
    const resetTarget = resolveGatewaySessionStoreTarget({
      cfg: getRuntimeConfig(),
      key: "agent:work:main",
      agentId: "work",
    });
    expect(resetTarget.storePath).toBe(globalConfig.workStorePath);
    const mainStore = JSON.parse(await fs.readFile(globalConfig.mainStorePath, "utf-8")) as {
      global?: { sessionId?: string };
    };
    const workStore = JSON.parse(await fs.readFile(resetTarget.storePath, "utf-8")) as {
      global?: { sessionId?: string };
    };
    expect(mainStore.global?.sessionId).toBe("sess-main-global");
    expect(workStore.global?.sessionId).toBe(reset.entry.sessionId);
    expect(workStore.global?.sessionId).not.toBe("sess-work-global");
  });
});

test("sessions.reset rejects selected global agentId conflicts", async () => {
  const { dir } = await createSessionStoreDir();
  await withGlobalAgentSessionStore(dir, async () => {
    const reset = await performSessionReset({
      key: "agent:main:main",
      agentId: "work",
      reason: "reset",
      commandSource: "gateway:sessions.reset",
    });

    expectResetErrorMessage(reset, "session key agent does not match agentId");
  });
});

test("sessions.reset rejects unknown selected global agents", async () => {
  const { dir } = await createSessionStoreDir();
  await withGlobalAgentSessionStore(dir, async () => {
    const reset = await performSessionReset({
      key: "agent:typo:main",
      reason: "reset",
      commandSource: "gateway:sessions.reset",
    });

    expectResetErrorMessage(reset, "Unknown agent id: typo");
  });
});

test("sessions.reset emits inferred selected global agent scope", async () => {
  const { dir } = await createSessionStoreDir();
  await withGlobalAgentSessionStore(dir, async (globalConfig) => {
    await writeGlobalSessionFile(globalConfig.workStorePath, "sess-work-global");
    const broadcast = vi.fn();
    const reset = await directSessionReq<{ ok: true; key: string }>(
      "sessions.reset",
      { key: "agent:work:main", reason: "reset" },
      {
        context: {
          broadcastToConnIds: broadcast,
          getSessionEventSubscriberConnIds: () => new Set(["conn-work"]),
        },
      },
    );

    expect(reset.ok).toBe(true);
    expect(broadcast.mock.calls[0]?.[0]).toBe("sessions.changed");
    expect(broadcast.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        sessionKey: "global",
        agentId: "work",
        reason: "reset",
      }),
    );
    expect(broadcast.mock.calls[0]?.[2]).toEqual(new Set(["conn-work"]));
  });
});

test("sessions.reset emits enriched session_end and session_start hooks", async () => {
  const { dir } = await createSessionStoreDir();
  await writeMainTranscriptSession({
    dir,
    sessionId: "sess-main",
    content: "hello from transcript",
  });

  await resetMainSession();
  expect(sessionLifecycleHookMocks.runSessionEnd).toHaveBeenCalledTimes(1);
  expect(sessionLifecycleHookMocks.runSessionStart).toHaveBeenCalledTimes(1);

  const [endEvent, endContext] = firstHookCall(sessionLifecycleHookMocks.runSessionEnd);
  const [startEvent, startContext] = firstHookCall(sessionLifecycleHookMocks.runSessionStart);

  expect(endEvent.sessionId).toBe("sess-main");
  expect(endEvent.sessionKey).toBe("agent:main:main");
  expect(endEvent.reason).toBe("new");
  expect(endEvent.transcriptArchived).toBe(true);
  const realDir = await fs.realpath(dir);
  const archivedSessionFile = expectStringWithPrefix(
    endEvent.sessionFile,
    path.join(realDir, "sess-main.jsonl.reset."),
    "archived session file",
  );
  expect(path.dirname(archivedSessionFile)).toBe(realDir);
  expect(endEvent.nextSessionId).toBe(startEvent.sessionId);
  expectMainHookContext(endContext, "sess-main");
  expect(startEvent.sessionKey).toBe("agent:main:main");
  expect(startEvent.resumedFrom).toBe("sess-main");
  expect(startContext.sessionId).toBe(startEvent.sessionId);
  expect(startContext.sessionKey).toBe("agent:main:main");
  expect(startContext.agentId).toBe("main");
});

test("sessions.reset returns unavailable when active run does not stop", async () => {
  const { dir, storePath } = await seedActiveMainSession();
  const waitCallCountAtSnapshotClear: number[] = [];
  bootstrapCacheMocks.clearBootstrapSnapshot.mockImplementation(() => {
    waitCallCountAtSnapshotClear.push(embeddedRunMock.waitCalls.length);
  });

  beforeResetHookState.hasBeforeResetHook = true;
  embeddedRunMock.activeIds.add("sess-main");
  embeddedRunMock.waitResults.set("sess-main", false);

  const reset = await directSessionReq("sessions.reset", {
    key: "main",
  });
  expect(reset.ok).toBe(false);
  expect(reset.error?.code).toBe("UNAVAILABLE");
  expect(reset.error?.message ?? "").toMatch(/still active/i);
  expectActiveRunCleanup("agent:main:main", ["main", "agent:main:main", "sess-main"], "sess-main");
  expect(beforeResetHookMocks.runBeforeReset).not.toHaveBeenCalled();
  expect(waitCallCountAtSnapshotClear).toEqual([1]);
  expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).not.toHaveBeenCalled();

  const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
    string,
    { sessionId?: string }
  >;
  expect(store["agent:main:main"]?.sessionId).toBe("sess-main");
  const filesAfterResetAttempt = await fs.readdir(dir);
  expect(
    filesAfterResetAttempt.filter((file) => file.startsWith("sess-main.jsonl.reset.")),
  ).toEqual([]);
});

test("sessions.reset emits before_reset for the entry actually reset in the writer slot", async () => {
  const { dir } = await createSessionStoreDir();
  const oldTranscriptPath = await writeMessageTranscript({
    dir,
    sessionId: "sess-old",
    content: "old transcript",
    messageId: "m-old",
  });
  const newTranscriptPath = await writeMessageTranscript({
    dir,
    sessionId: "sess-new",
    content: "new transcript",
    messageId: "m-new",
  });

  await writeSessionStore({
    entries: {
      main: {
        sessionId: "sess-old",
        sessionFile: oldTranscriptPath,
        updatedAt: Date.now(),
      },
    },
  });

  beforeResetHookState.hasBeforeResetHook = true;
  await updateGatewaySessionStoreForKey("main", (store) => {
    store["agent:main:main"] = sessionStoreEntry("sess-new", {
      sessionFile: newTranscriptPath,
    });
  });

  const reset = await performSessionReset({
    key: "main",
    reason: "new",
    commandSource: "gateway:sessions.reset",
  });
  expect(reset.ok).toBe(true);
  const internalEvent = (
    sessionHookMocks.triggerInternalHook.mock.calls as unknown as Array<[unknown]>
  )[0]?.[0] as { context?: { previousSessionEntry?: { sessionId?: string } } } | undefined;
  expect(internalEvent?.context?.previousSessionEntry?.sessionId).toBe("sess-new");
  expect(beforeResetHookMocks.runBeforeReset).toHaveBeenCalledTimes(1);
  const [event, context] = firstHookCall(beforeResetHookMocks.runBeforeReset);
  expectTranscriptResetEvent({ event, sessionFile: newTranscriptPath, content: "new transcript" });
  expectMainHookContext(context, "sess-new");
});

test("sessions.create with emitCommandHooks=true fires command:new hook against parent (#76957)", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-parent", "hello from parent");

  await writeMainSessionEntry("sess-parent");

  await createFromMainSession({ emitCommandHooks: true });

  expect(expectSingleCommandNewHookEvent().context?.commandSource).toBe("webchat");
});

test("sessions.create with emitCommandHooks=true emits reset lifecycle hooks against parent (#76957)", async () => {
  const { dir } = await createSessionStoreDir();
  const transcriptPath = await writeMainTranscriptSession({
    dir,
    sessionId: "sess-parent-hooks",
    content: "remember this before new",
  });

  beforeResetHookState.hasBeforeResetHook = true;

  await createFromMainSession({ emitCommandHooks: true });

  expect(beforeResetHookMocks.runBeforeReset).toHaveBeenCalledTimes(1);
  const [beforeResetEvent, beforeResetContext] = firstHookCall(beforeResetHookMocks.runBeforeReset);
  expectTranscriptResetEvent({
    event: beforeResetEvent,
    sessionFile: transcriptPath,
    content: "remember this before new",
  });
  expectMainHookContext(beforeResetContext, "sess-parent-hooks");

  expect(sessionLifecycleHookMocks.runSessionEnd).toHaveBeenCalledTimes(1);
  expect(sessionLifecycleHookMocks.runSessionStart).toHaveBeenCalledTimes(1);
  const [endEvent] = firstHookCall(sessionLifecycleHookMocks.runSessionEnd);
  const [startEvent] = firstHookCall(sessionLifecycleHookMocks.runSessionStart);
  expect(endEvent.sessionId).toBe("sess-parent-hooks");
  expect(endEvent.sessionKey).toBe("agent:main:main");
  expect(endEvent.reason).toBe("new");
  expect(endEvent.nextSessionId).toBe(startEvent.sessionId);
  expect(endEvent.nextSessionKey).toBe(startEvent.sessionKey);
  expect(startEvent.resumedFrom).toBe("sess-parent-hooks");
  expect(startEvent.sessionId).toBeTypeOf("string");
  expect(startEvent.sessionId).not.toBe("");
  expectStringWithPrefix(startEvent.sessionKey, "agent:main:dashboard:", "created session key");
});

test("sessions.create with emitCommandHooks=true resets parent in place when session.dmScope is 'main' (#77434)", async () => {
  const { dir } = await createSessionStoreDir();
  const transcriptPath = await writeMessageTranscript({
    dir,
    sessionId: "sess-parent-dms",
    content: "hello before /new",
  });

  testState.sessionConfig = { dmScope: "main" };
  try {
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-parent-dms",
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
        },
      },
    });

    const result = await directSessionReq<{
      ok: boolean;
      key: string;
      sessionId: string;
      runStarted: boolean;
    }>("sessions.create", {
      parentSessionKey: "main",
      emitCommandHooks: true,
    });
    expect(result.ok).toBe(true);
    // Reset-in-place: response key matches the parent main key, NOT a dashboard child.
    expect(result.payload?.key).toBe("agent:main:main");
    expect(result.payload?.runStarted).toBe(false);
    expect(result.payload?.sessionId).not.toBe("sess-parent-dms");

    expect(sessionLifecycleHookMocks.runSessionEnd).toHaveBeenCalledTimes(1);
    expect(sessionLifecycleHookMocks.runSessionStart).toHaveBeenCalledTimes(1);
    const [endEvent] = firstHookCall(sessionLifecycleHookMocks.runSessionEnd);
    const [startEvent] = firstHookCall(sessionLifecycleHookMocks.runSessionStart);
    expect(endEvent.sessionId).toBe("sess-parent-dms");
    expect(endEvent.sessionKey).toBe("agent:main:main");
    expect(endEvent.reason).toBe("new");
    expect(startEvent.sessionKey).toBe("agent:main:main");
    expect(startEvent.resumedFrom).toBe("sess-parent-dms");
  } finally {
    testState.sessionConfig = undefined;
  }
});

test("sessions.create without emitCommandHooks does not fire command:new hook (#76957)", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-parent2", "hello from parent 2");

  await writeMainSessionEntry("sess-parent2");

  await createFromMainSession();

  expect(commandNewHookEvents()).toHaveLength(0);
  expect(beforeResetHookMocks.runBeforeReset).not.toHaveBeenCalled();
  expect(sessionLifecycleHookMocks.runSessionEnd).not.toHaveBeenCalled();
  expect(sessionLifecycleHookMocks.runSessionStart).not.toHaveBeenCalled();
});

test("sessions.reset drops cli session bindings so the next turn does not --resume the old claude-cli session", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-with-binding", "hello");

  await writeMainSessionEntry("sess-with-binding", claudeCliBindings("claude-cli-old-session"));

  await resetMainSession();

  const store = await loadGatewaySessionStoreForKey("main");
  expectCliBindingsCleared(store["agent:main:main"], "sess-with-binding");
});

test("sessions.reset clears cli session bindings for parent-linked non-subagent sessions (e.g. dashboard children)", async () => {
  const { dir } = await createSessionStoreDir();
  const dashboardTranscript = await writeMessageTranscript({
    dir,
    sessionId: "sess-dashboard-child",
    content: "hello from dashboard child",
    messageId: "m-dashboard",
  });

  await writeSessionStore({
    entries: {
      "dashboard:child:42": cliBoundSessionEntry(
        "sess-dashboard-child",
        dashboardTranscript,
        "claude-cli-dashboard-session",
        {
          // parentSessionKey is set but the session key carries no `:subagent:`
          // marker, so this is a user-facing parent-linked session, not a
          // spawned subagent. The tighter predicate should still clear the
          // CLI binding here so /reset matches user intuition.
          parentSessionKey: "agent:main:main",
        },
      ),
    },
  });

  await resetSession("dashboard:child:42");

  const store = await loadGatewaySessionStoreForKey("dashboard:child:42");
  expectCliBindingsCleared(store["agent:main:dashboard:child:42"], "sess-dashboard-child");
});

test("sessions.reset preserves cli session bindings for spawned subagents (Tak Hoffman's fa56682b3ced contract)", async () => {
  const { dir } = await createSessionStoreDir();
  const childTranscript = await writeMessageTranscript({
    dir,
    sessionId: "sess-spawned-child",
    content: "hello from spawned child",
    messageId: "m-child",
  });

  await writeSessionStore({
    entries: {
      "subagent:child": cliBoundSessionEntry(
        "sess-spawned-child",
        childTranscript,
        "claude-cli-child-session",
        {
          parentSessionKey: "agent:main:main",
          spawnedBy: "agent:main:main",
          subagentRole: "orchestrator",
        },
      ),
    },
  });

  await resetSession("subagent:child");

  const store = await loadGatewaySessionStoreForKey("subagent:child");
  const nextEntry = store["agent:main:subagent:child"];
  expect(nextEntry).toBeDefined();
  expect(nextEntry?.sessionId).not.toBe("sess-spawned-child");
  expectClaudeCliBinding(nextEntry, "claude-cli-child-session");
});
