import { afterEach, expect, test } from "vitest";
import {
  registerContinuationDispatchClaim,
  resetContinuationDispatchClaimsForTests,
} from "../auto-reply/continuation/continuation-dispatch-claims.js";
import { enqueuePendingDelegate } from "../auto-reply/continuation/delegate-store.js";
import { enqueuePendingWork } from "../auto-reply/continuation/work-store.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { listTaskFlowRecords } from "../tasks/task-flow-registry.js";
import { configureTaskFlowRegistryRuntime } from "../tasks/task-flow-registry.store.test-support.js";
import { resetTaskFlowRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { embeddedRunMock } from "./test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { seedActiveMainSession } = setupGatewaySessionsHandlerTestHarness();

afterEach(() => {
  resetContinuationDispatchClaimsForTests();
  resetTaskFlowRegistryForTests();
  closeOpenClawStateDatabaseForTest();
});

async function seedWaitingActiveMainSession() {
  const seeded = await seedActiveMainSession();
  embeddedRunMock.activeIds.add("sess-main");
  embeddedRunMock.waitResults.set("sess-main", true);
  return seeded;
}

async function resetMainSession() {
  return await directSessionReq<{
    ok: true;
    key: string;
    entry: { lifecycleRevision?: string; sessionId: string };
  }>("sessions.reset", { key: "main" });
}

test("sessions.reset cancels durable continuation work and delegates", async () => {
  await seedWaitingActiveMainSession();
  resetTaskFlowRegistryForTests();
  const work = enqueuePendingWork({
    sessionKey: "agent:main:main",
    hop: 1,
    delayMs: 60_000,
    electedAt: Date.now(),
    dueAt: Date.now() + 60_000,
    maxChainLength: 8,
  });
  const delegate = enqueuePendingDelegate("agent:main:main", {
    task: "delegate after gateway reset",
    delayMs: 60_000,
  });
  if (!work || !delegate) {
    throw new Error("expected durable continuation rows");
  }

  const reset = await resetMainSession();

  expect(reset.ok).toBe(true);
  const flows = new Map(listTaskFlowRecords().map((flow) => [flow.flowId, flow]));
  expect(flows.get(work.flowId!)?.status).toBe("cancelled");
  expect(flows.get(delegate.flowId!)?.status).toBe("cancelled");
});

test("sessions.reset reports durable continuation cancellation failures", async () => {
  const { storePath } = await seedWaitingActiveMainSession();
  resetTaskFlowRegistryForTests();
  const work = enqueuePendingWork({
    sessionKey: "agent:main:main",
    hop: 1,
    delayMs: 60_000,
    electedAt: Date.now(),
    dueAt: Date.now() + 60_000,
    maxChainLength: 8,
  });
  if (!work) {
    throw new Error("expected durable continuation work");
  }
  const delegate = enqueuePendingDelegate("agent:main:main", {
    task: "remain claimable after failed reset",
    delayMs: 60_000,
  });
  if (!delegate) {
    throw new Error("expected durable continuation delegate");
  }
  const activeDelegate = registerContinuationDispatchClaim({
    sessionKey: "agent:main:main",
    flowId: delegate.flowId,
  });
  configureTaskFlowRegistryRuntime({
    store: {
      loadSnapshot: () => ({ flows: new Map() }),
      saveSnapshot: () => {},
      upsertFlow: () => {
        throw new Error("SQLITE_FULL: database or disk is full");
      },
    },
  });

  const reset = await resetMainSession();

  expect(reset.ok).toBe(false);
  expect(reset.error).toMatchObject({
    code: "UNAVAILABLE",
    message: expect.stringContaining("could not cancel continuation flow"),
  });
  expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.sessionId).toBe(
    "sess-main",
  );
  expect(listTaskFlowRecords().find((flow) => flow.flowId === work.flowId)?.status).toBe("queued");
  expect(listTaskFlowRecords().find((flow) => flow.flowId === delegate.flowId)?.status).toBe(
    "queued",
  );
  expect(activeDelegate.controller.signal.aborted).toBe(false);
});
