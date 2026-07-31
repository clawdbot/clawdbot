// sessions.create parent-disposition coverage. Kept separate because the main
// reset-hook suite is already at its max-lines budget.
import { expect, test } from "vitest";
import { writeSessionStore } from "./test-helpers.js";
import {
  beforeResetHookMocks,
  beforeResetHookState,
  directSessionReq,
  seedSessionTranscript,
  sessionLifecycleHookMocks,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsTestHarness();

type HookEvent = {
  sessionKey?: string;
  nextSessionKey?: string;
};

function firstHookEvent(mock: { mock: { calls: unknown[][] } }): HookEvent {
  const call = mock.mock.calls.at(0);
  if (!call) {
    throw new Error("Expected hook call");
  }
  return call[0] as HookEvent;
}

async function seedParent(sessionId: string) {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: { main: { sessionId, updatedAt: Date.now() } },
  });
  await seedSessionTranscript({
    agentId: "main",
    sessionId,
    sessionKey: "agent:main:main",
    storePath,
    messages: [{ role: "user", content: "before child creation", id: "m1" }],
  });
}

test("sessions.create keeps the parent active for an explicit parallel child", async () => {
  await seedParent("sess-parallel");
  beforeResetHookState.hasBeforeResetHook = true;

  const result = await directSessionReq<{ key: string }>("sessions.create", {
    parentSessionKey: "main",
    emitCommandHooks: true,
    succeedsParent: false,
  });

  expect(result.ok).toBe(true);
  expect(result.payload?.key).toMatch(/^agent:main:dashboard:/);
  expect(beforeResetHookMocks.runBeforeReset).toHaveBeenCalledTimes(1);
  expect(sessionLifecycleHookMocks.runSessionEnd).not.toHaveBeenCalled();
  expect(firstHookEvent(sessionLifecycleHookMocks.runSessionStart).sessionKey).toBe(
    result.payload?.key,
  );
});

test("sessions.create accepts an explicit successor with a minted dashboard key", async () => {
  await seedParent("sess-successor");

  const result = await directSessionReq<{ key: string }>("sessions.create", {
    parentSessionKey: "main",
    emitCommandHooks: true,
    succeedsParent: true,
  });

  expect(result.ok).toBe(true);
  expect(result.payload?.key).toMatch(/^agent:main:dashboard:/);
  const endEvent = firstHookEvent(sessionLifecycleHookMocks.runSessionEnd);
  expect(endEvent.sessionKey).toBe("agent:main:main");
  expect(endEvent.nextSessionKey).toBe(result.payload?.key);
  expect(firstHookEvent(sessionLifecycleHookMocks.runSessionStart).sessionKey).toBe(
    result.payload?.key,
  );
});

test("sessions.create rejects an explicit successor fork", async () => {
  await seedParent("sess-fork");

  const result = await directSessionReq("sessions.create", {
    key: "forked-child",
    parentSessionKey: "main",
    emitCommandHooks: true,
    fork: true,
    succeedsParent: true,
  });

  expect(result.ok).toBe(false);
  expect(result.error).toMatchObject({ code: "INVALID_REQUEST" });
  expect(result.error?.message).toMatch(/fork/i);
  expect(sessionLifecycleHookMocks.runSessionEnd).not.toHaveBeenCalled();
});

test("sessions.create requires a parent for either explicit disposition", async () => {
  await createSessionStoreDir();

  const result = await directSessionReq("sessions.create", {
    key: "parallel-child",
    emitCommandHooks: true,
    succeedsParent: false,
  });

  expect(result.ok).toBe(false);
  expect(result.error).toMatchObject({ code: "INVALID_REQUEST" });
  expect(result.error?.message).toMatch(/parentSessionKey/i);
});

test("sessions.create requires command hooks for either explicit disposition", async () => {
  await seedParent("sess-no-hooks");

  const result = await directSessionReq("sessions.create", {
    key: "parallel-child",
    parentSessionKey: "main",
    succeedsParent: false,
  });

  expect(result.ok).toBe(false);
  expect(result.error).toMatchObject({ code: "INVALID_REQUEST" });
  expect(result.error?.message).toMatch(/emitCommandHooks/i);
});
