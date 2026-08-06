import { createHash } from "node:crypto";
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
        workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
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

  it("advances the workspace manifest only under the exact worker turn claim", () => {
    const active = advanceToActive();
    const claim = store.claimTurn({
      ...SESSION,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "worker-workspace-claim",
      runId: "worker-workspace-run",
    });
    const manifestRef = `sha256:${"d".repeat(64)}`;

    expect(store.updateWorkspaceBaseManifest({ claim, manifestRef })).toMatchObject({
      state: "active",
      workspaceBaseManifestRef: manifestRef,
    });
    store.releaseTurn(claim);
    expect(() => store.updateWorkspaceBaseManifest({ claim, manifestRef })).toThrow(
      "Cannot advance stale worker workspace",
    );
  });

  it("fences a completed worker result until manifest acceptance clears it", () => {
    const active = advanceToActive();
    const claim = store.claimTurn({
      ...SESSION,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "pending-workspace-claim",
      runId: "pending-workspace-run",
    });
    store.markWorkspaceResultPending(claim);

    expect(store.listPendingWorkspaceResults()).toEqual([
      {
        sessionId: active.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        placementGeneration: active.generation,
        claimId: claim.claimId,
        runId: claim.runId,
        gatewayInstanceId: store.workspaceResultInstanceId(),
        recoveryRequestedAtMs: null,
        workspaceAcceptedAtMs: null,
        stagedResultRef: null,
      },
    ]);
    expect(() => store.releaseTurn(claim)).toThrow("pending cloud workspace result");

    const manifestRef = `sha256:${"f".repeat(64)}`;
    const stagedResultRef = `refs/openclaw/worker-results/${claim.claimId}`;
    expect(() =>
      store.recordStagedWorkspaceResult(claim, "refs/openclaw/worker-results/unsafe.claim"),
    ).toThrow("Worker workspace staged result reference is invalid");
    store.recordStagedWorkspaceResult(claim, stagedResultRef);
    store.recordWorkspaceResultConflict(claim, {
      paths: [" z.txt ", "a.txt", "a.txt"],
      stagedResultRef,
    });
    expect(store.get(SESSION.sessionId)?.workspaceResultConflict).toEqual({
      paths: [" z.txt ", "a.txt"],
      stagedResultRef,
      totalCount: 2,
    });
    expect(store.listPendingWorkspaceResults()).toMatchObject([
      { sessionId: active.sessionId, stagedResultRef },
    ]);
    store.updateWorkspaceBaseManifest({ claim, manifestRef });
    expect(store.listPendingWorkspaceResults()).toMatchObject([
      { sessionId: active.sessionId, workspaceAcceptedAtMs: null },
    ]);
    store.acceptWorkspaceResult(claim);
    expect(store.listPendingWorkspaceResults()).toMatchObject([
      { sessionId: active.sessionId, workspaceAcceptedAtMs: nowMs },
    ]);
    expect(store.completeWorkspaceResultAndReleaseTurn(claim)).toMatchObject({ turnClaim: null });
    expect(store.get(SESSION.sessionId)?.workspaceResultConflict).toEqual({
      paths: [" z.txt ", "a.txt"],
      stagedResultRef,
      totalCount: 2,
    });
    const laterClaim = store.claimTurn({
      ...SESSION,
      owner: claim.owner,
      claimId: "later-clean-claim",
      runId: "later-clean-run",
    });
    store.recordWorkspaceResultConflict(laterClaim, {
      paths: Array.from(
        { length: 300 },
        (_, index) => `conflict-${index.toString().padStart(3, "0")}`,
      ),
      stagedResultRef: `refs/openclaw/worker-results/${laterClaim.claimId}`,
    });
    expect(store.get(SESSION.sessionId)?.workspaceResultConflict).toMatchObject({
      totalCount: 300,
      paths: expect.arrayContaining(["conflict-000", "conflict-255"]),
    });
    expect(store.get(SESSION.sessionId)?.workspaceResultConflict?.paths).toHaveLength(256);
    store.recordWorkspaceResultConflict(laterClaim, undefined);
    expect(store.get(SESSION.sessionId)).not.toHaveProperty("workspaceResultConflict");
    store.releaseTurn(laterClaim);
    expect(
      createWorkerSessionPlacementStore({ database, now: () => nowMs }).get(SESSION.sessionId),
    ).not.toHaveProperty("workspaceResultConflict");
    expect(store.listPendingWorkspaceResults()).toEqual([]);
  });

  it("atomically reclaims an accepted result after its stale environment is destroyed", () => {
    const active = advanceToActive();
    const claim = store.claimTurn({
      ...SESSION,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "recovered-workspace-claim",
      runId: "recovered-workspace-run",
    });
    store.markWorkspaceResultPending(claim);
    expect(() => store.completeWorkspaceResultAndReleaseTurn(claim, { reclaim: true })).toThrow(
      "workspace result was not accepted",
    );
    store.updateWorkspaceBaseManifest({ claim, manifestRef: `sha256:${"e".repeat(64)}` });
    store.acceptWorkspaceResult(claim);

    expect(store.completeWorkspaceResultAndReleaseTurn(claim, { reclaim: true })).toMatchObject({
      state: "reclaimed",
      turnClaim: null,
    });
    expect(store.listPendingWorkspaceResults()).toEqual([]);
  });

  it("finishes an idle destroyed-worker reclaim in one placement transition", () => {
    const active = advanceToActive();

    expect(
      store.finishReclaim({
        sessionId: active.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        expectedGeneration: active.generation,
      }),
    ).toMatchObject({
      state: "reclaimed",
      generation: active.generation + 1,
      turnClaim: null,
    });
  });

  it("preserves an admitted worker result while its placement is draining", () => {
    const active = advanceToActive();
    const claim = store.claimTurn({
      ...SESSION,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "draining-workspace-claim",
      runId: "draining-workspace-run",
    });
    const draining = store.startDrain({
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    if (draining.state !== "draining") {
      throw new Error("expected draining workspace placement");
    }

    store.markWorkspaceResultPending(claim);
    expect(() =>
      store.startReconcile({
        sessionId: draining.sessionId,
        environmentId: draining.environmentId,
        ownerEpoch: draining.activeOwnerEpoch,
        expectedGeneration: draining.generation,
      }),
    ).toThrow("pending cloud workspace result");

    const manifestRef = `sha256:${"d".repeat(64)}`;
    const basePack = Buffer.from("draining workspace base pack");
    const owner = {
      sessionId: draining.sessionId,
      environmentId: draining.environmentId,
      ownerEpoch: draining.activeOwnerEpoch,
      placementGeneration: draining.generation,
    };
    store.beginWorkspaceReconciliation(owner, {
      version: 1,
      temporaryNonce: "a".repeat(32),
      baseManifestRef: draining.workspaceBaseManifestRef,
      currentManifestRef: manifestRef,
      baseEntries: [],
      appliedEntries: [],
      baseTree: "f".repeat(40),
      basePackSha256: createHash("sha256").update(basePack).digest("hex"),
      basePack,
    });
    expect(store.loadWorkspaceReconciliation(owner)).toMatchObject({
      currentManifestRef: manifestRef,
    });
    expect(store.updateWorkspaceBaseManifest({ claim, manifestRef })).toMatchObject({
      state: "draining",
      workspaceBaseManifestRef: manifestRef,
    });
    store.acceptWorkspaceResult(claim);
    expect(store.completeWorkspaceResultAndReleaseTurn(claim)).toMatchObject({
      state: "draining",
      turnClaim: null,
    });
    expect(store.listPendingWorkspaceResults()).toEqual([]);
  });

  it("does not begin draining after a completed result owns recovery", () => {
    const active = advanceToActive();
    const claim = store.claimTurn({
      ...SESSION,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "pre-drain-workspace-claim",
      runId: "pre-drain-workspace-run",
    });
    store.markWorkspaceResultPending(claim);

    expect(() =>
      store.startDrain({
        sessionId: active.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        expectedGeneration: active.generation,
      }),
    ).toThrow("pending cloud workspace result");
  });

  it("accepts a reconciled workspace for the exact idle active owner", () => {
    const active = advanceToActive();
    const manifestRef = `sha256:${"e".repeat(64)}`;

    expect(
      store.acceptIdleWorkspaceReconciliation({
        sessionId: active.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        expectedGeneration: active.generation,
        manifestRef,
      }),
    ).toMatchObject({ state: "active", workspaceBaseManifestRef: manifestRef, turnClaim: null });

    const claim = store.claimTurn({
      ...SESSION,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "worker-busy-claim",
      runId: "worker-busy-run",
    });
    expect(() =>
      store.acceptIdleWorkspaceReconciliation({
        sessionId: active.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        expectedGeneration: active.generation,
        manifestRef,
      }),
    ).toThrow("Cannot accept stale idle worker workspace");
    store.releaseTurn(claim);
  });

  it("persists a workspace rollback journal and clears it with manifest acceptance", () => {
    const active = advanceToActive();
    const owner = {
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      placementGeneration: active.generation,
    };
    const currentManifestRef = `sha256:${"c".repeat(64)}`;
    const content = Buffer.from("base");
    const basePack = Buffer.from("workspace base pack");
    // JavaScript UTF-16 and SQLite UTF-8 order these paths differently.
    const unicodePaths = ["\u{10000}.txt", "\uE000.txt"];
    store.beginWorkspaceReconciliation(owner, {
      version: 1,
      temporaryNonce: "b".repeat(32),
      baseManifestRef: active.workspaceBaseManifestRef,
      currentManifestRef,
      baseEntries: unicodePaths.map((entryPath) => ({
        path: entryPath,
        type: "file",
        mode: 0o644,
        size: content.length,
        sha256: "d".repeat(64),
      })),
      appliedEntries: unicodePaths.map((entryPath) => ({
        path: entryPath,
        type: "file",
        mode: 0o644,
        size: 6,
        sha256: "e".repeat(64),
      })),
      baseTree: "f".repeat(40),
      basePackSha256: createHash("sha256").update(basePack).digest("hex"),
      basePack,
    });

    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerSessionPlacementStore({ database, now: () => nowMs });
    expect(store.listWorkspaceReconciliationOwners()).toEqual([owner]);
    const loaded = store.loadWorkspaceReconciliation(owner);
    expect(loaded).toMatchObject({
      baseManifestRef: active.workspaceBaseManifestRef,
      currentManifestRef,
    });
    expect(Buffer.from(loaded?.basePack ?? [])).toEqual(basePack);

    const claim = store.claimTurn({
      ...SESSION,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "journal-claim",
      runId: "journal-run",
    });
    store.markWorkspaceResultPending(claim);
    const appliedManifestRef = active.workspaceBaseManifestRef;
    store.updateWorkspaceBaseManifest({ claim, manifestRef: appliedManifestRef });
    expect(store.loadWorkspaceReconciliation(owner)).toMatchObject({
      appliedManifestRef,
    });
    store.updateWorkspaceBaseManifest({ claim, manifestRef: currentManifestRef });
    expect(store.loadWorkspaceReconciliation(owner)).toMatchObject({
      appliedManifestRef: currentManifestRef,
    });
    store.acceptWorkspaceResult(claim);
    expect(store.loadWorkspaceReconciliation(owner)).toBeUndefined();
  });
});
