import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { type PlacementStore, REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";

describe("worker placement dispatch loop guard", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let placementStore: PlacementStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "openclaw-dispatch-loop-guard-"),
    );
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    placementStore = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("dispatches a configless turn on a freshly provisioned bundle without loop guard", async () => {
    const harness = createHarness(placementStore);
    harness.markEnvironmentProtocolFeatures([WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE]);

    // A configless (no tools.loopDetection block) turn must dispatch on a
    // legacy bundle that has the execution-context carrier but lacks the
    // loop-guard capability. The per-turn launcher fence decides capability
    // compatibility; the provisioning gate only requires execution-context.
    await expect(harness.service.dispatch(REQUEST)).resolves.toBeDefined();

    expect(harness.placements.current()).toMatchObject({ state: "active" });
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });

  it("adopts an active legacy worker missing loop guard for guard-off compatibility", async () => {
    const harness = createHarness(placementStore);
    await harness.environments.attachSession({
      environmentId: harness.ready.environmentId,
      ownerEpoch: harness.ready.ownerEpoch,
      sessionId: REQUEST.sessionId,
    });
    harness.placements.seedActive(harness.attached.ownerEpoch);
    harness.markEnvironmentNodeDeviceId("device-1");
    harness.markEnvironmentProtocolFeatures([WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE]);

    await harness.service.reconcile();

    // Recovery must not reclaim a legacy bundle solely for lacking the
    // loop-guard capability: the launcher permits configless and enabled:false
    // turns on such a bundle (pre-guard execution). The launch-time fence
    // decides per turn; recovery cannot resolve per-turn guard config.
    expect(harness.placements.current()).toMatchObject({ state: "active" });
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });

  it("tears down a starting worker with generic interrupted-dispatch error", async () => {
    const harness = createHarness(placementStore);
    harness.placements.seedStarting();
    harness.markEnvironmentProtocolFeatures([]);

    await harness.service.reconcile();

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: "Worker dispatch interrupted in starting",
    });
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it("reconcileActive preserves a guard-off legacy worker missing loop guard", async () => {
    const harness = createHarness(placementStore);
    await harness.environments.attachSession({
      environmentId: harness.ready.environmentId,
      ownerEpoch: harness.ready.ownerEpoch,
      sessionId: REQUEST.sessionId,
    });
    harness.placements.seedActive(harness.attached.ownerEpoch);
    harness.markEnvironmentNodeDeviceId("device-1");
    harness.markEnvironmentProtocolFeatures([WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE]);

    await harness.service.reconcileActive();

    // Runtime sweep (reconcileActive) must not reclaim a legacy bundle solely
    // for lacking the loop-guard capability either: the same guard-off
    // compatibility contract applies as full reconciliation.
    expect(harness.placements.current()).toMatchObject({ state: "active" });
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });
});
