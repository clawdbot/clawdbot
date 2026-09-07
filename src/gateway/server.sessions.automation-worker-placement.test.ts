import { afterEach, expect, test } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { loadGatewayWorkerEnvironmentStartupState } from "./server-worker-environment-startup.js";
import { loadSessionEntry } from "./session-utils.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import { createWorkerInferenceDrainService } from "./worker-environments/inference-control.test-helpers.js";
import { REQUEST } from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createHarness } from "./worker-environments/placement-dispatch-test-harness.js";

// Isolated automation runs claim their placement under the hidden exact-run alias
// `<base>:run:<sessionId>` while the stable base row keeps the same sessionId.
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

const AUTOMATION_BASE_KEY = "agent:main:cron:one-shot-job";
const automationRunAlias = (sessionId: string) => `${AUTOMATION_BASE_KEY}:run:${sessionId}`;

async function seedIdleAutomationRunPlacement(sessionId: string, placementSessionKey: string) {
  await createSessionStoreDir();
  await writeSessionStore({ entries: { [AUTOMATION_BASE_KEY]: sessionStoreEntry(sessionId) } });
  const { placementStore } = await loadGatewayWorkerEnvironmentStartupState();
  placementStore.releaseTurn(
    placementStore.claimTurn({
      sessionId,
      agentId: "main",
      sessionKey: placementSessionKey,
      owner: { kind: "local" },
      claimId: `${sessionId}-claim`,
      runId: `${sessionId}-run`,
    }),
  );
  expect(placementStore.get(sessionId)).toMatchObject({
    state: "local",
    sessionKey: placementSessionKey,
    turnClaim: null,
  });
  return placementStore;
}

function requireOk(label: string, result: Awaited<ReturnType<typeof directSessionReq>>) {
  if (!result.ok) {
    throw new Error(`${label} failed: ${JSON.stringify(result.error)}`);
  }
}

test("sessions.delete retires an automation's idle run-alias placement through its base key", async () => {
  const sessionId = "sess-automation-idle-delete";
  const placementStore = await seedIdleAutomationRunPlacement(
    sessionId,
    automationRunAlias(sessionId),
  );

  const deleted = await directSessionReq(
    "sessions.delete",
    { key: AUTOMATION_BASE_KEY },
    { context: { workerSessionPlacementService: placementStore } },
  );

  requireOk("sessions.delete", deleted);
  expect(deleted.payload).toMatchObject({ deleted: true });
  expect(placementStore.get(sessionId)).toBeUndefined();
  expect(loadSessionEntry(AUTOMATION_BASE_KEY).entry).toBeUndefined();
});

test("sessions.delete still accepts an automation's exact run-alias key", async () => {
  const sessionId = "sess-automation-exact-alias-delete";
  const alias = automationRunAlias(sessionId);
  await createSessionStoreDir();
  // A retained run row aliases the base transcript; both share the sessionId.
  await writeSessionStore({
    entries: {
      [AUTOMATION_BASE_KEY]: sessionStoreEntry(sessionId),
      [alias]: sessionStoreEntry(sessionId),
    },
  });
  const { placementStore } = await loadGatewayWorkerEnvironmentStartupState();
  placementStore.releaseTurn(
    placementStore.claimTurn({
      sessionId,
      agentId: "main",
      sessionKey: alias,
      owner: { kind: "local" },
      claimId: `${sessionId}-claim`,
      runId: `${sessionId}-run`,
    }),
  );

  const deleted = await directSessionReq(
    "sessions.delete",
    { key: alias },
    { context: { workerSessionPlacementService: placementStore } },
  );

  requireOk("sessions.delete", deleted);
  expect(deleted.payload).toMatchObject({ deleted: true });
  expect(placementStore.get(sessionId)).toBeUndefined();
  expect(loadSessionEntry(alias).entry).toBeUndefined();
});

test("sessions.patch archives an automation base session over its idle run-alias placement", async () => {
  const sessionId = "sess-automation-idle-archive";
  const placementStore = await seedIdleAutomationRunPlacement(
    sessionId,
    automationRunAlias(sessionId),
  );

  const archived = await directSessionReq(
    "sessions.patch",
    { key: AUTOMATION_BASE_KEY, archived: true, expectedSessionId: sessionId },
    { context: { workerSessionPlacementService: placementStore } },
  );

  requireOk("sessions.patch", archived);
  expect(loadSessionEntry(AUTOMATION_BASE_KEY).entry?.archivedAt).toEqual(expect.any(Number));
  // Archive keeps cloud affinity; only deletion retires the placement.
  expect(placementStore.get(sessionId)).toMatchObject({
    state: "local",
    sessionKey: automationRunAlias(sessionId),
  });
});

test("sessions.delete still rejects a placement keyed to another automation's run alias", async () => {
  const sessionId = "sess-automation-foreign-alias";
  const foreignAlias = `agent:main:cron:other-job:run:${sessionId}`;
  const placementStore = await seedIdleAutomationRunPlacement(sessionId, foreignAlias);

  const deleted = await directSessionReq(
    "sessions.delete",
    { key: AUTOMATION_BASE_KEY },
    { context: { workerSessionPlacementService: placementStore } },
  );

  expect(deleted).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
  expect(deleted.error?.message).toContain("cloud worker placement identity changed");
  expect(placementStore.get(sessionId)).toMatchObject({ sessionKey: foreignAlias });
  expect(loadSessionEntry(AUTOMATION_BASE_KEY).entry?.sessionId).toBe(sessionId);
});

test("sessions.delete reclaims an automation's active run-alias placement before deleting", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: { [AUTOMATION_BASE_KEY]: sessionStoreEntry(REQUEST.sessionId) },
  });
  const { placementStore } = await loadGatewayWorkerEnvironmentStartupState();
  const harness = createHarness(placementStore, {
    reconcileChanged: false,
    reconcileCommitsManifest: false,
  });
  // The dispatch fixture derives its environment from REQUEST.sessionId; only the key differs.
  await harness.service.dispatch({ ...REQUEST, sessionKey: automationRunAlias(REQUEST.sessionId) });

  const deleted = await directSessionReq(
    "sessions.delete",
    { key: AUTOMATION_BASE_KEY },
    {
      context: {
        workerEnvironmentService: createWorkerInferenceDrainService(
          () => ({ drained: Promise.resolve(), hasWork: () => false, release: () => {} }),
          harness.environments,
        ),
        workerPlacementDispatchService: harness.service,
        workerSessionPlacementService: placementStore,
      },
    },
  );

  requireOk("sessions.delete", deleted);
  expect(deleted.payload).toMatchObject({ deleted: true });
  expect(harness.environments.destroy).toHaveBeenCalledOnce();
  expect(placementStore.get(REQUEST.sessionId)).toBeUndefined();
  expect(loadSessionEntry(AUTOMATION_BASE_KEY).entry).toBeUndefined();
});
