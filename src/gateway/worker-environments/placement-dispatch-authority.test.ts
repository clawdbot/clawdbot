import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { type PlacementStore, REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("worker placement reclaim authority", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let placementStore: PlacementStore;

  const createTestHarness = (options: Parameters<typeof createHarness>[1] = {}) =>
    createHarness(placementStore, { workspacePath: path.join(root, "workspace"), ...options });

  beforeEach(async () => {
    root = tempDirs.make("openclaw-reclaim-auth-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    placementStore = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("stops final effects when authority closes during workspace reconciliation", async () => {
    let authorized = true;
    const harness = createTestHarness({
      afterReconcile: () => {
        authorized = false;
      },
    });
    await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.reclaim(REQUEST, () => {
        if (!authorized) {
          throw new Error("session recovery authority closed");
        }
      }),
    ).rejects.toThrow("session recovery authority closed");

    expect(harness.log).toContain("workspace:reconcile");
    expect(harness.log).toContain("workspace:resume");
    expect(harness.log).not.toContain("teardown:destroy");
    expect(harness.log).not.toContain("placement:reclaimed");
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(harness.placements.current()).toMatchObject({ state: "draining" });
  });

  it("finishes durable placement completion when authority closes during destroy", async () => {
    let authorized = true;
    const harness = createTestHarness({
      afterDestroy: () => {
        authorized = false;
      },
    });
    await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.reclaim(REQUEST, () => {
        if (!authorized) {
          throw new Error("session recovery authority closed");
        }
      }),
    ).resolves.toMatchObject({ state: "reclaimed" });

    expect(harness.environments.destroy).toHaveBeenCalledOnce();
    expect(harness.placements.current()).toMatchObject({ state: "reclaimed" });
  });

  it("stops failed-placement teardown when authority closes after tunnel cleanup", async () => {
    let authorized = true;
    let revokeAfterStop = false;
    const harness = createTestHarness({
      failAt: "activation",
      destroyFailureCount: 1,
      afterStopTunnel: () => {
        if (revokeAfterStop) {
          authorized = false;
        }
      },
    });
    await expect(harness.service.dispatch(REQUEST)).rejects.toThrow("activation failed");
    expect(harness.placements.current()).toMatchObject({ state: "failed" });

    revokeAfterStop = true;
    await expect(
      harness.service.reclaim(REQUEST, () => {
        if (!authorized) {
          throw new Error("session recovery authority closed");
        }
      }),
    ).rejects.toThrow("session recovery authority closed");

    expect(harness.environments.destroy).toHaveBeenCalledTimes(1);
    expect(harness.placements.current()).toMatchObject({ state: "failed" });
  });

  it("finishes failed-placement bookkeeping when authority closes during destroy", async () => {
    let authorized = true;
    const harness = createTestHarness({
      failAt: "activation",
      destroyFailureCount: 1,
      afterDestroy: () => {
        authorized = false;
      },
    });
    await expect(harness.service.dispatch(REQUEST)).rejects.toThrow("activation failed");
    expect(harness.placements.current()).toMatchObject({ state: "failed" });

    await expect(
      harness.service.reclaim(REQUEST, () => {
        if (!authorized) {
          throw new Error("session recovery authority closed");
        }
      }),
    ).resolves.toMatchObject({ state: "local" });

    expect(harness.environments.destroy).toHaveBeenCalledTimes(2);
    expect(harness.placements.current()).toMatchObject({ state: "local" });
  });
});
