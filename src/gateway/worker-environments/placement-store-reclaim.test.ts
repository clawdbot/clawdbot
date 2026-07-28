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

const ENVIRONMENT_ID = "environment-placement";
const BUNDLE_HASH = "a".repeat(64);
const MANIFEST_REF = `sha256:${"b".repeat(64)}`;
const OWNER_EPOCH = 7;

// Reaches `active` worker ownership so a later failure carries worker state
// (activeOwnerEpoch set), the case that must NOT bypass reconciliation.
function advanceToActive(s: WorkerSessionPlacementStore, identity = SESSION) {
  let placement = s.startDispatch(identity);
  placement = s.transition({
    sessionId: identity.sessionId,
    from: "requested",
    to: "provisioning",
    expectedGeneration: placement.generation,
    patch: { environmentId: ENVIRONMENT_ID },
  });
  placement = s.transition({
    sessionId: identity.sessionId,
    from: "provisioning",
    to: "syncing",
    expectedGeneration: placement.generation,
    patch: { workerBundleHash: BUNDLE_HASH },
  });
  placement = s.transition({
    sessionId: identity.sessionId,
    from: "syncing",
    to: "starting",
    expectedGeneration: placement.generation,
    patch: { remoteWorkspaceDir: "/worker/workspace", workspaceBaseManifestRef: MANIFEST_REF },
  });
  return s.transition({
    sessionId: identity.sessionId,
    from: "starting",
    to: "active",
    expectedGeneration: placement.generation,
    patch: { activeOwnerEpoch: OWNER_EPOCH },
  });
}

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

  it("refuses to reclaim a failed placement that reached worker ownership", () => {
    const active = advanceToActive(store);
    const draining = store.startDrain({
      sessionId: SESSION.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    const reconciling = store.startReconcile({
      sessionId: SESSION.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: draining.generation,
    });
    const failed = store.transition({
      sessionId: SESSION.sessionId,
      from: "reconciling",
      to: "failed",
      expectedGeneration: reconciling.generation,
      patch: { recoveryError: "reconcile failed with remote work in flight" },
    });
    expect(failed).toMatchObject({ state: "failed", activeOwnerEpoch: active.activeOwnerEpoch });

    // A post-worker failure may carry unreconciled remote workspace changes, so
    // it must not be reset to local; recovery has to go through drain/reconcile.
    expect(() =>
      store.reclaimFailedToLocal({
        sessionId: SESSION.sessionId,
        expectedGeneration: failed.generation,
      }),
    ).toThrow("worker ownership was reached");
  });
});
