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
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";

const SESSION: WorkerSessionPlacementIdentity = {
  sessionId: "session-worker-gate",
  agentId: "main",
  sessionKey: "agent:main:worker-gate",
};
const ENVIRONMENT_ID = "environment-worker-gate";
const OWNER_EPOCH = 7;

describe("worker session placement gate", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerSessionPlacementStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-gate-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerSessionPlacementStore({ database });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  function activate() {
    let placement = store.startDispatch(SESSION);
    placement = store.transition({
      sessionId: SESSION.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: placement.generation,
      patch: { environmentId: ENVIRONMENT_ID },
    });
    placement = store.transition({
      sessionId: SESSION.sessionId,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: placement.generation,
      patch: { workerBundleHash: "a".repeat(64) },
    });
    placement = store.transition({
      sessionId: SESSION.sessionId,
      from: "syncing",
      to: "starting",
      expectedGeneration: placement.generation,
      patch: {
        workspaceBaseManifestRef: "manifest-worker-gate",
        remoteWorkspaceDir: "/workspace/worker-gate",
      },
    });
    return store.transition({
      sessionId: SESSION.sessionId,
      from: "starting",
      to: "active",
      expectedGeneration: placement.generation,
      patch: { activeOwnerEpoch: OWNER_EPOCH },
    });
  }

  function preclaim(runId: string) {
    const placement = activate();
    return store.claimTurn({
      sessionId: placement.sessionId,
      agentId: placement.agentId,
      sessionKey: placement.sessionKey,
      claimId: `claim:${runId}`,
      runId,
      owner: { kind: "worker", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
    });
  }

  it("accepts only the exact gateway-preclaimed worker run", () => {
    const runId = "run-worker-gate";
    preclaim(runId);
    const gate = createWorkerSessionPlacementGate(store);
    const binding = {
      sessionId: SESSION.sessionId,
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      runId,
    };

    expect(gate.validateWorkerTurn(binding)).toBe(true);
    expect(gate.validateWorkerTurn({ ...binding, runId: "run-competing" })).toBe(false);
    expect(gate.validateWorkerTurn({ ...binding, ownerEpoch: OWNER_EPOCH + 1 })).toBe(false);
  });

  it("updates exact-owner cursors and rejects stale descriptor replay", () => {
    const runId = "run-worker-ack";
    const claim = preclaim(runId);
    const gate = createWorkerSessionPlacementGate(store);
    const binding = {
      sessionId: SESSION.sessionId,
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      runId,
    };

    gate.updateAckCursors({ ...binding, transcriptSeq: 4, liveSeq: 9 });
    expect(store.get(SESSION.sessionId)).toMatchObject({
      generation: claim.placementGeneration,
      lastTranscriptAckCursor: 4,
      lastLiveEventAckCursor: 9,
    });
    store.releaseTurn(claim);
    expect(store.get(SESSION.sessionId)?.turnClaim).toBeNull();
    expect(gate.validateWorkerTurn(binding)).toBe(false);
  });

  it("lets the admitted worker finish acknowledgements after draining closes admission", () => {
    const runId = "run-worker-draining-ack";
    const claim = preclaim(runId);
    const active = store.get(SESSION.sessionId);
    if (active?.state !== "active") {
      throw new Error("expected active placement");
    }
    store.startDrain({
      sessionId: SESSION.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    const gate = createWorkerSessionPlacementGate(store);
    const binding = {
      sessionId: SESSION.sessionId,
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      runId,
    };

    expect(gate.validateWorkerTurn(binding)).toBe(true);
    gate.updateAckCursors({ ...binding, transcriptSeq: 5 });
    expect(store.get(SESSION.sessionId)?.lastTranscriptAckCursor).toBe(5);
    store.releaseTurn(claim);
    expect(gate.validateWorkerTurn(binding)).toBe(false);
  });
});
