import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
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

test("sessions.reset emits internal command hook with reason", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
    },
  });

  const reset = await directSessionReq<{ ok: true; key: string }>("sessions.reset", {
    key: "main",
    reason: "new",
  });
  expect(reset.ok).toBe(true);
  const resetHookEvents = (
    sessionHookMocks.triggerInternalHook.mock.calls as unknown as Array<[unknown]>
  )
    .map((call) => call[0])
    .filter(
      (
        event,
      ): event is {
        type: string;
        action: string;
        sessionKey?: string;
        context?: {
          commandSource?: string;
          previousSessionEntry?: { sessionId?: string };
        };
      } =>
        Boolean(event) &&
        typeof event === "object" &&
        (event as { type?: unknown }).type === "command" &&
        (event as { action?: unknown }).action === "new",
    );
  expect(resetHookEvents).toHaveLength(1);
  const event = resetHookEvents[0];
  if (!event) {
    throw new Error("expected session hook event");
  }
  expect(event.type).toBe("command");
  expect(event.action).toBe("new");
  expect(event.sessionKey).toBe("agent:main:main");
  expect(event.context?.commandSource).toBe("gateway:sessions.reset");
  expect(event.context?.previousSessionEntry?.sessionId).toBe("sess-main");
});

test("sessions.reset emits before_reset hook with transcript context", async () => {
  const { dir } = await createSessionStoreDir();
  const transcriptPath = path.join(dir, "sess-main.jsonl");
  await fs.writeFile(
    transcriptPath,
    `${JSON.stringify({
      type: "message",
      id: "m1",
      message: { role: "user", content: "hello from transcript" },
    })}\n`,
    "utf-8",
  );

  await writeSessionStore({
    entries: {
      main: {
        sessionId: "sess-main",
        sessionFile: transcriptPath,
        updatedAt: Date.now(),
      },
    },
  });

  beforeResetHookState.hasBeforeResetHook = true;

  const reset = await directSessionReq<{ ok: true; key: string }>("sessions.reset", {
    key: "main",
    reason: "new",
  });
  expect(reset.ok).toBe(true);
  expect(beforeResetHookMocks.runBeforeReset).toHaveBeenCalledTimes(1);
  const [event, context] = firstHookCall(beforeResetHookMocks.runBeforeReset);
  expectTranscriptResetEvent({
    event,
    sessionFile: transcriptPath,
    content: "hello from transcript",
  });
  expectMainHookContext(context, "sess-main");
});

test("sessions.reset emits enriched session_end and session_start hooks", async () => {
  const { dir } = await createSessionStoreDir();
  const transcriptPath = path.join(dir, "sess-main.jsonl");
  await fs.writeFile(
    transcriptPath,
    `${JSON.stringify({
      type: "message",
      id: "m1",
      message: { role: "user", content: "hello from transcript" },
    })}\n`,
    "utf-8",
  );

  await writeSessionStore({
    entries: {
      main: {
        sessionId: "sess-main",
        sessionFile: transcriptPath,
        updatedAt: Date.now(),
      },
    },
  });

  const reset = await directSessionReq<{ ok: true; key: string }>("sessions.reset", {
    key: "main",
    reason: "new",
  });
  expect(reset.ok).toBe(true);
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
  const oldTranscriptPath = path.join(dir, "sess-old.jsonl");
  const newTranscriptPath = path.join(dir, "sess-new.jsonl");
  await fs.writeFile(
    oldTranscriptPath,
    `${JSON.stringify({
      type: "message",
      id: "m-old",
      message: { role: "user", content: "old transcript" },
    })}\n`,
    "utf-8",
  );
  await fs.writeFile(
    newTranscriptPath,
    `${JSON.stringify({
      type: "message",
      id: "m-new",
      message: { role: "user", content: "new transcript" },
    })}\n`,
    "utf-8",
  );

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
  const [{ getRuntimeConfig }, { resolveGatewaySessionStoreTarget }, { updateSessionStore }] =
    await Promise.all([
      import("../config/config.js"),
      import("./session-utils.js"),
      import("../config/sessions.js"),
    ]);
  const gatewayStorePath = resolveGatewaySessionStoreTarget({
    cfg: getRuntimeConfig(),
    key: "main",
  }).storePath;

  const { performGatewaySessionReset } = await import("./session-reset-service.js");
  await updateSessionStore(gatewayStorePath, (store) => {
    store["agent:main:main"] = sessionStoreEntry("sess-new", {
      sessionFile: newTranscriptPath,
    });
  });

  const reset = await performGatewaySessionReset({
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

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-parent"),
    },
  });

  const result = await directSessionReq<{ ok: boolean; key: string }>("sessions.create", {
    parentSessionKey: "main",
    emitCommandHooks: true,
  });
  expect(result.ok).toBe(true);

  const commandNewEvents = (
    sessionHookMocks.triggerInternalHook.mock.calls as unknown as Array<[unknown]>
  )
    .map((call) => call[0])
    .filter(
      (event): event is { type: string; action: string; context?: { commandSource?: string } } =>
        Boolean(event) &&
        typeof event === "object" &&
        (event as { type?: unknown }).type === "command" &&
        (event as { action?: unknown }).action === "new",
    );
  expect(commandNewEvents).toHaveLength(1);
  expect(commandNewEvents[0]?.type).toBe("command");
  expect(commandNewEvents[0]?.action).toBe("new");
  expect(commandNewEvents[0]?.context?.commandSource).toBe("webchat");
});

test("sessions.create with emitCommandHooks=true emits reset lifecycle hooks against parent (#76957)", async () => {
  const { dir } = await createSessionStoreDir();
  const transcriptPath = path.join(dir, "sess-parent-hooks.jsonl");
  await fs.writeFile(
    transcriptPath,
    `${JSON.stringify({
      type: "message",
      id: "m1",
      message: { role: "user", content: "remember this before new" },
    })}\n`,
    "utf-8",
  );

  await writeSessionStore({
    entries: {
      main: {
        sessionId: "sess-parent-hooks",
        sessionFile: transcriptPath,
        updatedAt: Date.now(),
      },
    },
  });

  beforeResetHookState.hasBeforeResetHook = true;

  const result = await directSessionReq<{ ok: boolean; key: string }>("sessions.create", {
    parentSessionKey: "main",
    emitCommandHooks: true,
  });
  expect(result.ok).toBe(true);

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
  const transcriptPath = path.join(dir, "sess-parent-dms.jsonl");
  await fs.writeFile(
    transcriptPath,
    `${JSON.stringify({
      type: "message",
      id: "m1",
      message: { role: "user", content: "hello before /new" },
    })}\n`,
    "utf-8",
  );

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

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-parent2"),
    },
  });

  const result = await directSessionReq<{ ok: boolean; key: string }>("sessions.create", {
    parentSessionKey: "main",
  });
  expect(result.ok).toBe(true);

  const commandNewEvents = (
    sessionHookMocks.triggerInternalHook.mock.calls as unknown as Array<[unknown]>
  )
    .map((call) => call[0])
    .filter(
      (event): event is { type: string; action: string } =>
        Boolean(event) &&
        typeof event === "object" &&
        (event as { type?: unknown }).type === "command" &&
        (event as { action?: unknown }).action === "new",
    );
  expect(commandNewEvents).toHaveLength(0);
  expect(beforeResetHookMocks.runBeforeReset).not.toHaveBeenCalled();
  expect(sessionLifecycleHookMocks.runSessionEnd).not.toHaveBeenCalled();
  expect(sessionLifecycleHookMocks.runSessionStart).not.toHaveBeenCalled();
});
