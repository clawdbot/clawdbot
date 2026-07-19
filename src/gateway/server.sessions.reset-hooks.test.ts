// Session reset hook tests cover before/after reset payloads, transcript reset
// events, CLI bindings, browser cleanup, and active-run shutdown.
import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { listSessionEntries, loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
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
  seedSessionTranscript,
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
  const storeTemplate = path.join(dir, "agents", "{agentId}", "sessions", "sessions.json");
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
  const agentId = path.basename(path.dirname(path.dirname(storePath)));
  await writeSessionStore({
    agentId,
    entries: {
      global: sessionStoreEntry(sessionId),
    },
    storePath,
  });
}

async function writeMessageTranscript(params: {
  sessionId: string;
  sessionKey: string;
  storePath: string;
  agentId?: string;
  content: string;
  messageId?: string;
}) {
  await seedSessionTranscript({
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    messages: [{ role: "user", content: params.content, id: params.messageId ?? "m1" }],
  });
}

async function writeMainTranscriptSession(params: {
  sessionId: string;
  content: string;
  messageId?: string;
}) {
  const storePath = expectStringValue(testState.sessionStorePath, "testState.sessionStorePath");
  await writeSessionStore({
    entries: {
      main: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
      },
    },
  });
  await writeMessageTranscript({
    ...params,
    agentId: "main",
    sessionKey: "agent:main:main",
    storePath,
  });
  return expectStringValue(
    loadSessionEntry({
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath,
    })?.sessionFile,
    "sessionFile",
  );
}

function loadEntry(params: { agentId?: string; sessionKey: string; storePath: string }) {
  return loadSessionEntry({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
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
  assertCurrent?: () => void;
  onCommitted?: (commit: { key: string; sessionId: string }) => void;
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
  cliSessionId: string,
  overrides: Parameters<typeof sessionStoreEntry>[1] = {},
) {
  return sessionStoreEntry(sessionId, {
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
  const gatewayStorePath = await resolveGatewaySessionStorePathForKey(key);
  return Object.fromEntries(
    listSessionEntries({ storePath: gatewayStorePath }).map(({ sessionKey, entry }) => [
      sessionKey,
      entry,
    ]),
  );
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

test("sessions.reset removes automatic recovery state from the replacement session", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-recovery", "hello");
  await writeMainSessionEntry("sess-recovery", {
    abortedLastRun: true,
    restartRecoveryRuns: [{ runId: "recovery-run", lifecycleGeneration: "generation-1" }],
    mainRestartRecovery: {
      cycleId: "cycle-1",
      revision: 5,
      chargedAttempts: 3,
      foregroundClaims: {
        lifecycleGeneration: "generation-1",
        tokens: ["foreground-owner"],
      },
      tombstone: {
        reason: "exhausted",
      },
    },
    subagentRecovery: {
      automaticAttempts: 2,
      lastAttemptAt: 10,
      lastRunId: "child-recovery-run",
      wedgedAt: 20,
      wedgedReason: "child exhausted",
    },
  });

  await resetMainSession();

  const store = await loadGatewaySessionStoreForKey("main");
  const replacement = store["agent:main:main"];
  expect(replacement?.sessionId).not.toBe("sess-recovery");
  expect(replacement?.abortedLastRun).toBe(false);
  expect(replacement?.restartRecoveryRuns).toBeUndefined();
  expect((replacement as InternalSessionEntry | undefined)?.mainRestartRecovery).toBeUndefined();
  expect(replacement?.subagentRecovery).toBeUndefined();
});

test("sessions.reset does not begin cleanup after losing lifecycle ownership", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeMainSessionEntry("sess-main");
  let ownershipChecks = 0;

  await expect(
    performSessionReset({
      key: "main",
      reason: "new",
      commandSource: "gateway:agent",
      assertCurrent: () => {
        ownershipChecks += 1;
        if (ownershipChecks >= 2) {
          const error = new Error("stale lifecycle");
          error.name = "AbortError";
          throw error;
        }
      },
    }),
  ).rejects.toThrow("stale lifecycle");

  expect(ownershipChecks).toBe(2);
  const store = await loadGatewaySessionStoreForKey("main");
  expect(store["agent:main:main"]?.sessionId).toBe("sess-main");
});

test("sessions.reset emits before_reset hook with transcript context", async () => {
  await createSessionStoreDir();
  const transcriptPath = await writeMainTranscriptSession({
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
    const mainEntry = loadEntry({
      agentId: "main",
      sessionKey: "global",
      storePath: globalConfig.mainStorePath,
    });
    const workEntry = loadEntry({
      agentId: "work",
      sessionKey: "global",
      storePath: resetTarget.storePath,
    });
    expect(mainEntry?.sessionId).toBe("sess-main-global");
    expect(workEntry?.sessionId).toBe(reset.entry.sessionId);
    expect(workEntry?.sessionId).not.toBe("sess-work-global");
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
  await createSessionStoreDir();
  await writeMainTranscriptSession({
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
  // Retained history: reset keeps the SQLite transcript searchable under the
  // same key, so nothing is archived and no reset artifact file exists.
  expect(endEvent.transcriptArchived).toBeUndefined();
  expect(endEvent.sessionFile).toBeUndefined();
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

  expect(
    loadEntry({
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath,
    })?.sessionId,
  ).toBe("sess-main");
  const filesAfterResetAttempt = await fs.readdir(dir);
  expect(
    filesAfterResetAttempt.filter((file) => file.startsWith("sess-main.jsonl.reset.")),
  ).toEqual([]);
});

test("sessions.reset emits before_reset for the entry actually reset in the writer slot", async () => {
  const { storePath } = await createSessionStoreDir();

  await writeSessionStore({
    entries: {
      main: {
        sessionId: "sess-old",
        updatedAt: Date.now(),
      },
    },
  });
  await writeMessageTranscript({
    agentId: "main",
    sessionId: "sess-old",
    sessionKey: "agent:main:main",
    storePath,
    content: "old transcript",
    messageId: "m-old",
  });

  beforeResetHookState.hasBeforeResetHook = true;
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-new"),
    },
  });
  await writeMessageTranscript({
    agentId: "main",
    sessionId: "sess-new",
    sessionKey: "agent:main:main",
    storePath,
    content: "new transcript",
    messageId: "m-new",
  });
  const newSessionFile = expectStringValue(
    loadEntry({
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath,
    })?.sessionFile,
    "new sessionFile",
  );

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
  expectTranscriptResetEvent({ event, sessionFile: newSessionFile, content: "new transcript" });
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
  await createSessionStoreDir();
  const transcriptPath = await writeMainTranscriptSession({
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

test("sessions.create waits for the parent run lifecycle before firing hooks", async () => {
  await createSessionStoreDir();
  await writeMainSessionEntry("sess-active-parent");
  embeddedRunMock.activeIds.add("sess-active-parent");

  const result = await directSessionReq("sessions.create", {
    key: "tui-next",
    parentSessionKey: "main",
    emitCommandHooks: true,
  });

  expect(result.ok).toBe(false);
  expect(result.error).toMatchObject({ code: "UNAVAILABLE" });
  expect(result.error?.message).toMatch(/parent session.*still active/i);
  expect(commandNewHookEvents()).toHaveLength(0);
  expect(beforeResetHookMocks.runBeforeReset).not.toHaveBeenCalled();
  expect(sessionLifecycleHookMocks.runSessionEnd).not.toHaveBeenCalled();
  expect(sessionLifecycleHookMocks.runSessionStart).not.toHaveBeenCalled();
});

test("sessions.create waits for the parent work admission to release", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeMainSessionEntry("sess-finishing-parent");
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: ["agent:main:main", "sess-finishing-parent"],
    assertAllowed: () => {},
  });
  try {
    const result = await directSessionReq("sessions.create", {
      key: "tui-next",
      parentSessionKey: "main",
      emitCommandHooks: true,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: "UNAVAILABLE" });
    expect(commandNewHookEvents()).toHaveLength(0);
    expect(sessionLifecycleHookMocks.runSessionEnd).not.toHaveBeenCalled();
  } finally {
    admission.release();
  }
});

test("sessions.create fences new parent work while rollover hooks run", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeMainSessionEntry("sess-parent-fenced");
  let releaseHook: (() => void) | undefined;
  sessionHookMocks.triggerInternalHook.mockImplementationOnce(
    async () =>
      await new Promise<void>((resolve) => {
        releaseHook = resolve;
      }),
  );

  const creating = directSessionReq("sessions.create", {
    key: "tui-next",
    parentSessionKey: "main",
    emitCommandHooks: true,
  });
  await vi.waitFor(() => expect(sessionHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1));

  let admissionStarted = false;
  const admission = beginSessionWorkAdmission({
    scope: storePath,
    identities: ["agent:main:main", "sess-parent-fenced"],
    assertAllowed: () => {
      admissionStarted = true;
    },
  });
  await Promise.resolve();
  expect(admissionStarted).toBe(false);

  if (!releaseHook) {
    throw new Error("expected pending command:new hook");
  }
  releaseHook();
  expect((await creating).ok).toBe(true);
  const lease = await admission;
  expect(admissionStarted).toBe(true);
  lease.release();
});

test("sessions.create with emitCommandHooks=true resets parent in place when session.dmScope is 'main' (#77434)", async () => {
  const { storePath } = await createSessionStoreDir();

  testState.sessionConfig = { dmScope: "main" };
  try {
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-parent-dms",
          updatedAt: Date.now(),
        },
      },
    });
    await writeMessageTranscript({
      agentId: "main",
      sessionId: "sess-parent-dms",
      sessionKey: "agent:main:main",
      storePath,
      content: "hello before /new",
    });
    embeddedRunMock.activeIds.add("sess-parent-dms");

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

test("sessions.create keeps an explicit TUI child key when session.dmScope is 'main'", async () => {
  const { storePath } = await createSessionStoreDir();

  testState.sessionConfig = { dmScope: "main" };
  try {
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-parent-tui",
          updatedAt: Date.now(),
        },
      },
    });
    await writeMessageTranscript({
      agentId: "main",
      sessionId: "sess-parent-tui",
      sessionKey: "agent:main:main",
      storePath,
      content: "hello before TUI /new",
    });

    const result = await directSessionReq<{ key: string; sessionId: string }>("sessions.create", {
      key: "tui-explicit",
      agentId: "main",
      parentSessionKey: "main",
      emitCommandHooks: true,
    });

    expect(result.ok).toBe(true);
    expect(result.payload?.key).toBe("agent:main:tui-explicit");
    expect(result.payload?.sessionId).not.toBe("sess-parent-tui");
    expect(expectSingleCommandNewHookEvent().context?.commandSource).toBe("webchat");
    const [endEvent] = firstHookCall(sessionLifecycleHookMocks.runSessionEnd);
    const [startEvent] = firstHookCall(sessionLifecycleHookMocks.runSessionStart);
    expect(endEvent.sessionKey).toBe("agent:main:main");
    expect(endEvent.nextSessionKey).toBe("agent:main:tui-explicit");
    expect(startEvent.sessionKey).toBe("agent:main:tui-explicit");
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
  const { storePath } = await createSessionStoreDir();

  await writeSessionStore({
    entries: {
      "dashboard:child:42": cliBoundSessionEntry(
        "sess-dashboard-child",
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
  await writeMessageTranscript({
    agentId: "main",
    sessionId: "sess-dashboard-child",
    sessionKey: "agent:main:dashboard:child:42",
    storePath,
    content: "hello from dashboard child",
    messageId: "m-dashboard",
  });

  await resetSession("dashboard:child:42");

  const store = await loadGatewaySessionStoreForKey("dashboard:child:42");
  expectCliBindingsCleared(store["agent:main:dashboard:child:42"], "sess-dashboard-child");
});

test("sessions.reset preserves cli session bindings for spawned subagents (Tak Hoffman's fa56682b3ced contract)", async () => {
  const { storePath } = await createSessionStoreDir();
  const reseedPromptHash = "a".repeat(64);
  const childEntry = cliBoundSessionEntry("sess-spawned-child", "claude-cli-child-session", {
    parentSessionKey: "agent:main:main",
    spawnedBy: "agent:main:main",
    subagentRole: "orchestrator",
  });
  childEntry.cliSessionBindings = {
    "claude-cli": {
      sessionId: "claude-cli-child-session",
      reseedReceipt: {
        version: 1,
        promptHash: reseedPromptHash,
        localSessionId: "sess-spawned-child",
        userTurnDisposition: "omitted",
      },
    },
  };

  await writeSessionStore({
    entries: {
      "subagent:child": childEntry,
    },
  });
  await writeMessageTranscript({
    agentId: "main",
    sessionId: "sess-spawned-child",
    sessionKey: "agent:main:subagent:child",
    storePath,
    content: "hello from spawned child",
    messageId: "m-child",
  });

  await resetSession("subagent:child");

  const store = await loadGatewaySessionStoreForKey("subagent:child");
  const nextEntry = store["agent:main:subagent:child"];
  expect(nextEntry).toBeDefined();
  expect(nextEntry?.sessionId).not.toBe("sess-spawned-child");
  expect(nextEntry?.claudeCliSessionId).toBe("claude-cli-child-session");
  expect(nextEntry?.cliSessionIds).toEqual({
    "claude-cli": "claude-cli-child-session",
  });
  expect(nextEntry?.cliSessionBindings).toEqual({
    "claude-cli": {
      sessionId: "claude-cli-child-session",
      reseedReceipt: {
        version: 1,
        promptHash: reseedPromptHash,
        localSessionId: nextEntry?.sessionId,
        userTurnDisposition: "omitted",
      },
    },
  });
});
