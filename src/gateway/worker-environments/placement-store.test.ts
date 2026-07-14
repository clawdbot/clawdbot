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

describe("worker session placement store", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerSessionPlacementStore;
  let nowMs: number;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-placement-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    nowMs = 1_000;
    store = createWorkerSessionPlacementStore({ database, now: () => nowMs });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  function advanceToActive(identity: WorkerSessionPlacementIdentity = SESSION) {
    let placement = store.startDispatch(identity);
    placement = store.transition({
      sessionId: identity.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: placement.generation,
      patch: { environmentId: `environment-${identity.sessionId}` },
    });
    placement = store.transition({
      sessionId: identity.sessionId,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: placement.generation,
      patch: { workerBundleHash: "a".repeat(64) },
    });
    placement = store.transition({
      sessionId: identity.sessionId,
      from: "syncing",
      to: "starting",
      expectedGeneration: placement.generation,
      patch: {
        workspaceBaseManifestRef: `manifest-${identity.sessionId}`,
        remoteWorkspaceDir: `/workspace/${identity.sessionId}`,
      },
    });
    const active = store.transition({
      sessionId: identity.sessionId,
      from: "starting",
      to: "active",
      expectedGeneration: placement.generation,
      patch: { activeOwnerEpoch: 7 },
    });
    if (active.state !== "active") {
      throw new Error("expected active worker placement");
    }
    return active;
  }

  it("persists the placement lifecycle and rejects stale transition generations", () => {
    const requested = store.startDispatch(SESSION);
    expect(requested).toMatchObject({
      state: "requested",
      generation: 1,
      environmentId: null,
      activeOwnerEpoch: null,
    });

    const provisioning = store.transition({
      sessionId: SESSION.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: requested.generation,
      patch: { environmentId: "environment-placement" },
    });
    expect(provisioning).toMatchObject({
      state: "provisioning",
      generation: 2,
      environmentId: "environment-placement",
    });
    expect(() =>
      store.transition({
        sessionId: SESSION.sessionId,
        from: "provisioning",
        to: "syncing",
        expectedGeneration: 1,
      }),
    ).toThrow("expected provisioning@1, found provisioning@2");
    expect(() =>
      store.transition({
        sessionId: SESSION.sessionId,
        from: "provisioning",
        to: "active",
        expectedGeneration: provisioning.generation,
      }),
    ).toThrow("Illegal worker session placement transition");

    const failed = store.fail({
      sessionId: SESSION.sessionId,
      expectedGeneration: provisioning.generation,
      recoveryError: "workspace synchronization failed",
    });
    expect(failed).toMatchObject({
      state: "failed",
      generation: 3,
      recoveryError: "workspace synchronization failed",
    });
    expect(() =>
      store.fail({
        sessionId: SESSION.sessionId,
        expectedGeneration: failed.generation - 1,
        recoveryError: "stale teardown failure",
      }),
    ).toThrow("changed before failure");
    expect(store.get(SESSION.sessionId)?.recoveryError).toBe("workspace synchronization failed");
    expect(
      store.fail({ sessionId: SESSION.sessionId, recoveryError: "teardown retry failed" }),
    ).toMatchObject({
      state: "failed",
      generation: failed.generation,
      recoveryError: "teardown retry failed",
    });
  });

  it("requires each placement phase to persist its complete metadata", () => {
    const requested = store.startDispatch(SESSION);
    const provisioning = store.transition({
      sessionId: SESSION.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: requested.generation,
      patch: { environmentId: "environment-placement" },
    });
    expect(provisioning).toMatchObject({
      workspaceBaseManifestRef: null,
      remoteWorkspaceDir: null,
      workerBundleHash: null,
      lastTranscriptAckCursor: null,
      lastLiveEventAckCursor: null,
    });

    expect(() =>
      store.transition({
        sessionId: SESSION.sessionId,
        from: "provisioning",
        to: "syncing",
        expectedGeneration: provisioning.generation,
      }),
    ).toThrow("requires an environment and bundle");
    const syncing = store.transition({
      sessionId: SESSION.sessionId,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: provisioning.generation,
      patch: { workerBundleHash: "a".repeat(64) },
    });

    expect(() =>
      store.transition({
        sessionId: SESSION.sessionId,
        from: "syncing",
        to: "starting",
        expectedGeneration: syncing.generation,
        patch: { workspaceBaseManifestRef: "manifest-placement" },
      }),
    ).toThrow("requires complete workspace metadata");
    expect(
      store.transition({
        sessionId: SESSION.sessionId,
        from: "syncing",
        to: "starting",
        expectedGeneration: syncing.generation,
        patch: {
          workspaceBaseManifestRef: "manifest-placement",
          remoteWorkspaceDir: "/workspace/placement",
        },
      }),
    ).toMatchObject({
      state: "starting",
      environmentId: "environment-placement",
      workerBundleHash: "a".repeat(64),
      workspaceBaseManifestRef: "manifest-placement",
      remoteWorkspaceDir: "/workspace/placement",
    });
  });

  it("drains and reconciles worker ownership before returning local", () => {
    const active = advanceToActive();
    const draining = store.transition({
      sessionId: SESSION.sessionId,
      from: "active",
      to: "draining",
      expectedGeneration: active.generation,
    });
    const reconciling = store.startReconcile({
      sessionId: SESSION.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: draining.generation,
    });
    const local = store.transition({
      sessionId: SESSION.sessionId,
      from: "reconciling",
      to: "local",
      expectedGeneration: reconciling.generation,
    });
    expect(local).toMatchObject({
      state: "local",
      environmentId: null,
      activeOwnerEpoch: null,
    });
  });

  it("rejects reclaim before worker ownership reaches reconciliation", () => {
    const requested = store.startDispatch(SESSION);
    expect(() =>
      store.transition({
        sessionId: SESSION.sessionId,
        from: "requested",
        to: "reclaimed",
        expectedGeneration: requested.generation,
      }),
    ).toThrow("Illegal worker session placement transition");
    expect(
      store.fail({
        sessionId: SESSION.sessionId,
        expectedGeneration: requested.generation,
        recoveryError: "dispatch stopped before provisioning",
      }),
    ).toMatchObject({ state: "failed" });
  });

  it("closes local admission before draining the existing local turn", async () => {
    const localClaim = store.claimTurn({
      ...SESSION,
      owner: { kind: "local" },
      claimId: "local-claim",
      runId: "run-local",
    });
    const requested = store.startDispatch(SESSION);
    expect(requested).toMatchObject({ state: "requested", generation: 1 });
    expect(requested.turnClaim).toMatchObject({ owner: "local", generation: 0 });

    expect(() =>
      store.claimTurn({
        ...SESSION,
        owner: { kind: "local" },
        claimId: "new-local-claim",
        runId: "new-local-run",
      }),
    ).toThrow("already has an active turn claim");
    expect(() =>
      store.claimTurn({
        ...SESSION,
        owner: localClaim.owner,
        claimId: localClaim.claimId,
        runId: localClaim.runId,
      }),
    ).toThrow("already has an active turn claim");
    expect(() =>
      store.transition({
        sessionId: SESSION.sessionId,
        from: "requested",
        to: "provisioning",
        expectedGeneration: requested.generation,
        patch: { environmentId: "environment-placement" },
      }),
    ).toThrow("during an active turn");

    const released = store.waitForTurnClaimRelease(SESSION.sessionId, { timeoutMs: 1_000 });
    store.releaseTurn(localClaim);
    await released;
    expect(
      store.transition({
        sessionId: SESSION.sessionId,
        from: "requested",
        to: "provisioning",
        expectedGeneration: requested.generation,
        patch: { environmentId: "environment-placement" },
      }),
    ).toMatchObject({ state: "provisioning", turnClaim: null });
  });

  it("keeps the draining local claim releasable when the dispatch barrier fails", () => {
    const localClaim = store.claimTurn({
      ...SESSION,
      owner: { kind: "local" },
      claimId: "local-barrier-claim",
      runId: "local-barrier-run",
    });
    const requested = store.startDispatch(SESSION);
    const failed = store.fail({
      sessionId: SESSION.sessionId,
      expectedGeneration: requested.generation,
      recoveryError: "local drain timed out",
    });

    expect(failed).toMatchObject({
      state: "failed",
      recoveryError: "local drain timed out",
      turnClaim: { owner: "local", claimId: localClaim.claimId },
    });
    expect(() =>
      store.claimTurn({
        ...SESSION,
        owner: { kind: "local" },
        claimId: "new-local-claim",
        runId: "new-local-run",
      }),
    ).toThrow("already has an active turn claim");
    expect(store.releaseTurn(localClaim)).toMatchObject({ state: "failed", turnClaim: null });
  });

  it("does not let a stale claim release a later turn that reuses the run id", () => {
    const firstClaim = store.claimTurn({
      ...SESSION,
      owner: { kind: "local" },
      claimId: "first-claim-token",
      runId: "reused-run",
    });
    store.releaseTurn(firstClaim);
    const secondClaim = store.claimTurn({
      ...SESSION,
      owner: { kind: "local" },
      claimId: "second-claim-token",
      runId: firstClaim.runId,
    });

    expect(() => store.releaseTurn(firstClaim)).toThrow("turn claim changed before release");
    expect(store.validateTurnClaim(secondClaim)).toBe(true);
    expect(store.get(SESSION.sessionId)?.turnClaim).toMatchObject({
      claimId: secondClaim.claimId,
      runId: secondClaim.runId,
    });
  });

  it("allows a reset session id to reuse its canonical session key", () => {
    const firstClaim = store.claimTurn({
      ...SESSION,
      owner: { kind: "local" },
      claimId: "first-session-claim",
      runId: "first-session-run",
    });
    store.releaseTurn(firstClaim);

    const rotated = store.claimTurn({
      ...SESSION,
      sessionId: "session-placement-rotated",
      owner: { kind: "local" },
      claimId: "rotated-session-claim",
      runId: "rotated-session-run",
    });
    expect(rotated.sessionId).toBe("session-placement-rotated");
    expect(store.list().map((record) => record.sessionId)).toEqual([
      SESSION.sessionId,
      "session-placement-rotated",
    ]);
  });

  it("admits exactly the active placement owner and fences stale worker epochs", () => {
    const active = advanceToActive();
    expect(() =>
      store.claimTurn({
        ...SESSION,
        owner: { kind: "local" },
        claimId: "local-after-dispatch",
        runId: "local-after-dispatch-run",
      }),
    ).toThrow("Local turn rejected");
    expect(() =>
      store.claimTurn({
        ...SESSION,
        owner: {
          kind: "worker",
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch + 1,
        },
        claimId: "stale-worker",
        runId: "stale-worker-run",
      }),
    ).toThrow("stale owner");

    const workerClaim = store.claimTurn({
      ...SESSION,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "worker-claim",
      runId: "worker-run",
    });
    expect(store.validateTurnClaim(workerClaim)).toBe(true);
    expect(
      store.validateTurnClaim({
        ...workerClaim,
        owner: {
          kind: "worker",
          environmentId: "environment-stale",
          ownerEpoch: active.activeOwnerEpoch,
        },
      }),
    ).toBe(false);
    expect(
      store.validateWorkerOwner({
        sessionId: SESSION.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      }),
    ).toBe(true);
    expect(() =>
      store.claimTurn({
        ...SESSION,
        owner: {
          kind: "worker",
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
        claimId: "competing-worker",
        runId: "competing-worker-run",
      }),
    ).toThrow("already has an active turn claim");
    expect(() =>
      store.claimTurn({
        ...SESSION,
        owner: workerClaim.owner,
        claimId: workerClaim.claimId,
        runId: workerClaim.runId,
      }),
    ).toThrow("already has an active turn claim");
    expect(() =>
      store.fail({
        sessionId: SESSION.sessionId,
        expectedGeneration: active.generation,
        recoveryError: "active worker disappeared",
      }),
    ).toThrow("Cannot fail worker session placement from active");
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
    expect(
      store.transition({
        sessionId: SESSION.sessionId,
        from: "reconciling",
        to: "failed",
        expectedGeneration: reconciling.generation,
        patch: { recoveryError: "active worker disappeared" },
      }),
    ).toMatchObject({ state: "failed", turnClaim: null });
    expect(store.validateTurnClaim(workerClaim)).toBe(false);
  });

  it("clears dead local claims on restart while adopting active worker ownership", () => {
    const localIdentity = {
      ...SESSION,
      sessionId: "session-local-restart",
      sessionKey: "agent:main:local-restart",
    };
    store.claimTurn({
      ...localIdentity,
      owner: { kind: "local" },
      claimId: "local-before-restart",
      runId: "local-restart-run",
    });
    const active = advanceToActive();
    const workerClaim = store.claimTurn({
      ...SESSION,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "worker-before-restart",
      runId: "worker-restart-run",
    });

    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerSessionPlacementStore({ database, now: () => nowMs });

    expect(store.clearLocalTurnClaimsAfterRestart()).toBe(1);
    expect(store.get(localIdentity.sessionId)?.turnClaim).toBeNull();
    expect(store.validateTurnClaim(workerClaim)).toBe(true);
    expect(
      store.adoptActive({
        sessionId: SESSION.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        expectedGeneration: active.generation,
      }),
    ).toMatchObject({ state: "active", turnClaim: { owner: "worker" } });
    expect(store.listForReconcile().map((record) => record.sessionId)).toEqual([SESSION.sessionId]);
    expect(store.list().map((record) => record.sessionId)).toEqual([
      localIdentity.sessionId,
      SESSION.sessionId,
    ]);
  });

  it("closes worker admission before draining the active turn", async () => {
    const active = advanceToActive();
    const workerClaim = store.claimTurn({
      ...SESSION,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "worker-drain-claim",
      runId: "worker-drain-run",
    });

    const draining = store.startDrain({
      sessionId: SESSION.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    expect(draining).toMatchObject({
      state: "draining",
      generation: active.generation + 1,
      turnClaim: { owner: "worker", claimId: workerClaim.claimId },
    });
    expect(store.validateTurnClaim(workerClaim)).toBe(true);

    const released = store.waitForTurnClaimRelease(SESSION.sessionId, { timeoutMs: 1_000 });
    expect(store.releaseTurn(workerClaim)).toMatchObject({ state: "draining", turnClaim: null });
    await released;
    expect(() =>
      store.claimTurn({
        ...SESSION,
        owner: workerClaim.owner,
        claimId: "worker-after-drain",
        runId: "worker-after-drain-run",
      }),
    ).toThrow("stale owner");
    expect(
      store.startReconcile({
        sessionId: SESSION.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        expectedGeneration: draining.generation,
      }),
    ).toMatchObject({ state: "reconciling", turnClaim: null });
  });

  it("atomically fences a drained claim before its worker is reclaimed", async () => {
    const active = advanceToActive();
    const workerClaim = store.claimTurn({
      ...SESSION,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "worker-reclaim-claim",
      runId: "worker-reclaim-run",
    });
    const released = store.waitForTurnClaimRelease(SESSION.sessionId, { timeoutMs: 1_000 });

    const draining = store.startDrain({
      sessionId: SESSION.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    expect(() =>
      store.fail({
        sessionId: SESSION.sessionId,
        expectedGeneration: draining.generation,
        recoveryError: "worker teardown not yet fenced",
      }),
    ).toThrow("Cannot fail worker session placement from draining");
    expect(() =>
      store.transition({
        sessionId: SESSION.sessionId,
        from: "draining",
        to: "reclaimed",
        expectedGeneration: draining.generation,
      }),
    ).toThrow("Illegal worker session placement transition");
    expect(() =>
      store.transition({
        sessionId: SESSION.sessionId,
        from: "draining",
        to: "reconciling",
        expectedGeneration: draining.generation,
      }),
    ).toThrow("Use startReconcile after fencing the drained worker environment");
    expect(() =>
      store.startReconcile({
        sessionId: SESSION.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        expectedGeneration: draining.generation - 1,
      }),
    ).toThrow("Cannot reconcile stale worker placement");
    const reconciling = store.startReconcile({
      sessionId: SESSION.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: draining.generation,
    });
    const reclaimed = store.transition({
      sessionId: SESSION.sessionId,
      from: "reconciling",
      to: "reclaimed",
      expectedGeneration: reconciling.generation,
    });
    expect(reclaimed).toMatchObject({ state: "reclaimed", turnClaim: null });
    await released;
    expect(store.validateTurnClaim(workerClaim)).toBe(false);
    expect(store.startDispatch(SESSION)).toMatchObject({
      state: "requested",
      generation: reclaimed.generation + 1,
      environmentId: null,
      activeOwnerEpoch: null,
      workspaceBaseManifestRef: null,
      remoteWorkspaceDir: null,
      workerBundleHash: null,
    });
  });

  it("binds acknowledged cursors to the exact normalized worker claim", () => {
    const active = advanceToActive();
    const firstClaim = store.claimTurn({
      ...SESSION,
      owner: {
        kind: "worker",
        environmentId: ` ${active.environmentId} `,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "worker-ack-first",
      runId: "worker-ack-first-run",
    });
    expect(firstClaim.owner).toEqual({
      kind: "worker",
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
    });
    store.releaseTurn(firstClaim);
    const currentClaim = store.claimTurn({
      ...SESSION,
      owner: firstClaim.owner,
      claimId: "worker-ack-current",
      runId: "worker-ack-current-run",
    });

    expect(() => store.updateAckCursors({ claim: firstClaim, transcript: 4 })).toThrow(
      "Cannot ACK stale worker turn",
    );
    expect(store.get(SESSION.sessionId)?.lastTranscriptAckCursor).toBeNull();
    expect(
      store.updateAckCursors({
        claim: currentClaim,
        transcript: 4,
        liveEvent: 9,
      }),
    ).toMatchObject({ lastTranscriptAckCursor: 4, lastLiveEventAckCursor: 9 });
    expect(
      store.updateAckCursors({
        claim: currentClaim,
        transcript: 3,
        liveEvent: 8,
      }),
    ).toMatchObject({ lastTranscriptAckCursor: 4, lastLiveEventAckCursor: 9 });
  });
});
