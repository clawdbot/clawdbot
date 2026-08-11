// sessions.create parent-disposition coverage. Kept separate because the main
// reset-hook suite is already at its max-lines budget.
import { expect, test, vi } from "vitest";
import { createDeferred } from "../shared/deferred.js";
import { embeddedRunMock } from "./test-helpers.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  beforeResetHookMocks,
  beforeResetHookState,
  bundleMcpRuntimeMocks,
  directSessionReq,
  seedSessionTranscript,
  sessionLifecycleHookMocks,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const providerRuntimeMocks = vi.hoisted(() => ({ cleanupSessionResources: vi.fn() }));

vi.mock("@openclaw/ai/internal/runtime", async () => {
  const actual = await vi.importActual<typeof import("@openclaw/ai/internal/runtime")>(
    "@openclaw/ai/internal/runtime",
  );
  return { ...actual, cleanupSessionResources: providerRuntimeMocks.cleanupSessionResources };
});

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

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

async function startDeferredSessionCleanup(sessionId: string) {
  await seedParent(sessionId);
  providerRuntimeMocks.cleanupSessionResources.mockClear();
  embeddedRunMock.activeIds.add(sessionId);
  embeddedRunMock.waitResults.set(sessionId, false);

  const retirement = createDeferred();
  const retirementStarted = createDeferred();
  let retirements = 0;
  bundleMcpRuntimeMocks.retireSessionMcpRuntime.mockImplementation(
    async ({ retainAcrossReuse }) => {
      if (!retainAcrossReuse && ++retirements === 1) {
        retirementStarted.resolve();
        await retirement.promise;
      }
      return true;
    },
  );

  expect((await directSessionReq("sessions.reset", { key: "main", reason: "new" })).ok).toBe(false);
  embeddedRunMock.activeIds.delete(sessionId);
  embeddedRunMock.endWaiters.get(sessionId)?.(true);
  await retirementStarted.promise;
  return { release: retirement.resolve, retirements: () => retirements };
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

test("sessions.reset joins cleanup deferred by a prior timeout before same-id reuse", async () => {
  const cleanup = await startDeferredSessionCleanup("sess-provider-cleanup");

  embeddedRunMock.activeIds.add("sess-provider-cleanup");
  embeddedRunMock.waitResults.set("sess-provider-cleanup", true);
  let resetSettled = false;
  const resetPromise = directSessionReq("sessions.reset", { key: "main", reason: "new" }).finally(
    () => {
      resetSettled = true;
    },
  );
  await vi.waitFor(() => expect(cleanup.retirements()).toBe(2));
  await Promise.resolve();

  expect(resetSettled).toBe(false);
  expect(providerRuntimeMocks.cleanupSessionResources).not.toHaveBeenCalled();

  cleanup.release();
  const reset = await resetPromise;
  expect(reset.ok).toBe(true);
  expect(providerRuntimeMocks.cleanupSessionResources).toHaveBeenCalledWith(
    "sess-provider-cleanup",
  );
  const cleanupCount = providerRuntimeMocks.cleanupSessionResources.mock.calls.length;
  await Promise.resolve();
  expect(providerRuntimeMocks.cleanupSessionResources).toHaveBeenCalledTimes(cleanupCount);
});

test("completed wait keeps cleanup armed when a same-id replacement starts during retirement", async () => {
  const sessionId = "sess-provider-ended-replacement";
  await seedParent(sessionId);
  providerRuntimeMocks.cleanupSessionResources.mockClear();
  embeddedRunMock.activeIds.add(sessionId);
  embeddedRunMock.waitResults.set(sessionId, true);
  const retirement = createDeferred();
  let terminalRetirements = 0;
  bundleMcpRuntimeMocks.retireSessionMcpRuntime.mockImplementation(
    async ({ retainAcrossReuse }) => {
      if (!retainAcrossReuse && ++terminalRetirements <= 2) {
        await retirement.promise;
      }
      return true;
    },
  );

  const reset = directSessionReq("sessions.reset", { key: "main", reason: "new" });
  await vi.waitFor(() => expect(terminalRetirements).toBe(2));
  embeddedRunMock.activeIds.add(sessionId);
  retirement.resolve();

  expect((await reset).error).toMatchObject({ code: "UNAVAILABLE" });
  expect(providerRuntimeMocks.cleanupSessionResources).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(embeddedRunMock.endWaitCalls).toEqual([sessionId, sessionId]));

  embeddedRunMock.activeIds.delete(sessionId);
  embeddedRunMock.endWaiters.get(sessionId)?.(true);
  await vi.waitFor(() => {
    expect(providerRuntimeMocks.cleanupSessionResources).toHaveBeenCalledTimes(1);
  });
});
