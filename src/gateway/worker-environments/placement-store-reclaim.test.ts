import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { WorkerSessionPlacementIdentity } from "./placement-record.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";

const SESSION: WorkerSessionPlacementIdentity = {
  sessionId: "session-placement",
  agentId: "main",
  sessionKey: "agent:main:placement",
};

describe("worker session placement failed recovery", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerSessionPlacementStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-placement-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerSessionPlacementStore({ database });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reclaims a failed placement back to local, clearing worker metadata", () => {
    const requested = store.startDispatch(SESSION);
    const failed = store.fail({
      sessionId: SESSION.sessionId,
      expectedGeneration: requested.generation,
      recoveryError: "dispatch stopped before provisioning",
    });
    expect(failed).toMatchObject({
      state: "failed",
      recoveryError: "dispatch stopped before provisioning",
    });

    const reclaimed = store.reclaimFailedToLocal({
      sessionId: SESSION.sessionId,
      expectedGeneration: failed.generation,
    });
    expect(reclaimed).toMatchObject({
      state: "local",
      generation: failed.generation + 1,
      environmentId: null,
      workerBundleHash: null,
      remoteWorkspaceDir: null,
      workspaceBaseManifestRef: null,
      activeOwnerEpoch: null,
      recoveryError: null,
      turnClaim: null,
    });

    // Only a failed placement can be reclaimed this way; a stale generation is
    // also rejected so a concurrent transition cannot clobber a newer state.
    expect(() =>
      store.reclaimFailedToLocal({
        sessionId: SESSION.sessionId,
        expectedGeneration: reclaimed.generation,
      }),
    ).toThrow("Cannot reclaim failed worker placement");
  });
});
