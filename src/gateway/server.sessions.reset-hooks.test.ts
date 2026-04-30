import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { embeddedRunMock, writeSessionStore } from "./test-helpers.js";
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
        context?: { previousSessionEntry?: unknown };
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
  expect(event).toMatchObject({
    type: "command",
    action: "new",
    sessionKey: "agent:main:main",
    context: {
      commandSource: "gateway:sessions.reset",
    },
  });
  expect(event.context?.previousSessionEntry).toMatchObject({ sessionId: "sess-main" });
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
  const [event, context] = (
    beforeResetHookMocks.runBeforeReset.mock.calls as unknown as Array<[unknown, unknown]>
  )[0] ?? [undefined, undefined];
  expect(event).toMatchObject({
    sessionFile: transcriptPath,
    reason: "new",
    messages: [
      {
        role: "user",
        content: "hello from transcript",
      },
    ],
  });
  expect(context).toMatchObject({
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "sess-main",
  });
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

  const [endEvent, endContext] = (
    sessionLifecycleHookMocks.runSessionEnd.mock.calls as unknown as Array<[unknown, unknown]>
  )[0] ?? [undefined, undefined];
  const [startEvent, startContext] = (
    sessionLifecycleHookMocks.runSessionStart.mock.calls as unknown as Array<[unknown, unknown]>
  )[0] ?? [undefined, undefined];

  expect(endEvent).toMatchObject({
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    reason: "new",
    transcriptArchived: true,
  });
  expect((endEvent as { sessionFile?: string } | undefined)?.sessionFile).toContain(
    ".jsonl.reset.",
  );
  expect((endEvent as { nextSessionId?: string } | undefined)?.nextSessionId).toBe(
    (startEvent as { sessionId?: string } | undefined)?.sessionId,
  );
  expect(endContext).toMatchObject({
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    agentId: "main",
  });
  expect(startEvent).toMatchObject({
    sessionKey: "agent:main:main",
    resumedFrom: "sess-main",
  });
  expect(startContext).toMatchObject({
    sessionId: (startEvent as { sessionId?: string } | undefined)?.sessionId,
    sessionKey: "agent:main:main",
    agentId: "main",
  });
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
  expect(filesAfterResetAttempt.some((f) => f.startsWith("sess-main.jsonl.reset."))).toBe(false);
});

test("sessions.reset emits before_reset for the entry actually reset under the store lock", async () => {
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
  const [
    { getRuntimeConfig },
    { resolveGatewaySessionStoreTarget },
    { withSessionStoreLockForTest },
  ] = await Promise.all([
    import("../config/config.js"),
    import("./session-utils.js"),
    import("../config/sessions/store.js"),
  ]);
  const gatewayStorePath = resolveGatewaySessionStoreTarget({
    cfg: getRuntimeConfig(),
    key: "main",
  }).storePath;

  let pendingReset:
    | ReturnType<(typeof import("./session-reset-service.js"))["performGatewaySessionReset"]>
    | undefined;
  const { performGatewaySessionReset } = await import("./session-reset-service.js");
  await withSessionStoreLockForTest(gatewayStorePath, async () => {
    pendingReset = performGatewaySessionReset({
      key: "main",
      reason: "new",
      commandSource: "gateway:sessions.reset",
    });
    await vi.waitFor(() => {
      expect(sessionHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
    });
    await fs.writeFile(
      gatewayStorePath,
      JSON.stringify(
        {
          "agent:main:main": sessionStoreEntry("sess-new", {
            sessionFile: newTranscriptPath,
          }),
        },
        null,
        2,
      ),
      "utf-8",
    );
  });

  const reset = await pendingReset!;
  expect(reset.ok).toBe(true);
  const internalEvent = (
    sessionHookMocks.triggerInternalHook.mock.calls as unknown as Array<[unknown]>
  )[0]?.[0] as { context?: { previousSessionEntry?: { sessionId?: string } } } | undefined;
  expect(internalEvent?.context?.previousSessionEntry?.sessionId).toBe("sess-old");
  expect(beforeResetHookMocks.runBeforeReset).toHaveBeenCalledTimes(1);
  const [event, context] = (
    beforeResetHookMocks.runBeforeReset.mock.calls as unknown as Array<[unknown, unknown]>
  )[0] ?? [undefined, undefined];
  expect(event).toMatchObject({
    sessionFile: newTranscriptPath,
    reason: "new",
    messages: [
      {
        role: "user",
        content: "new transcript",
      },
    ],
  });
  expect(context).toMatchObject({
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "sess-new",
  });
});
