import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  createDispatchEnvironmentFixtures,
  REQUEST,
  seedActivePlacement,
} from "./placement-dispatch-test-fixtures.js";
import { forceAbandonWorkerEnvironment } from "./placement-force-abandon.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";

describe("forced worker environment abandonment", () => {
  let root: string;
  let database: OpenClawStateDatabase;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-force-worker-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("records result loss and releases a pending worker claim before teardown", async () => {
    const store = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
    const { environmentId } = createDispatchEnvironmentFixtures();
    const active = seedActivePlacement(store, { environmentId, ownerEpoch: 2 });
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = store.claimTurn({
      ...REQUEST,
      claimId: "forced-claim",
      runId: "forced-run",
      owner: { kind: "worker", environmentId, ownerEpoch: 2 },
    });
    store.markWorkspaceResultPending(claim);

    await forceAbandonWorkerEnvironment({
      placements: store,
      environmentId,
      resolveWorkspacePath: async () => root,
    });

    expect(store.get(REQUEST.sessionId)).toMatchObject({
      state: "failed",
      turnClaim: null,
      recoveryError: "Cloud worker result abandoned by forced operator teardown",
    });
    expect(store.listPendingWorkspaceResults()).toEqual([]);
  });
});
