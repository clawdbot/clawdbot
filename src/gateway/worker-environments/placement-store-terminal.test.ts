import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { WorkerSessionPlacementIdentity, WorkerSessionTurnClaim } from "./placement-record.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";

const SESSION: WorkerSessionPlacementIdentity = {
  sessionId: "session-placement-terminal",
  agentId: "main",
  sessionKey: "agent:main:placement-terminal",
};

describe("worker placement terminal persistence", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerSessionPlacementStore;
  let nowMs: number;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-terminal-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    nowMs = 1_000;
    store = createWorkerSessionPlacementStore({ database, now: () => nowMs });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  function advanceToActive(
    identity: WorkerSessionPlacementIdentity = SESSION,
    environmentId = `environment-${identity.sessionId}`,
  ) {
    let placement = store.startDispatch(identity);
    placement = store.transition({
      sessionId: identity.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: placement.generation,
      patch: { environmentId },
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

  function pendingResult(identity = SESSION) {
    const active = store.get(identity.sessionId);
    if (active?.state !== "active") {
      throw new Error("expected active placement");
    }
    const claim = store.claimTurn({
      ...identity,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: `claim-${identity.sessionId}`,
      runId: `run-${identity.sessionId}`,
    });
    store.markWorkspaceResultPending(claim);
    const pending = store
      .listPendingWorkspaceResults()
      .find((result) => result.sessionId === identity.sessionId);
    if (!pending) {
      throw new Error("expected pending workspace result");
    }
    return { active, claim, pending };
  }

  it("records a clean terminal timestamp when reclaiming an accepted result", () => {
    advanceToActive();
    const { claim } = pendingResult();
    expect(() => store.completeWorkspaceResultAndReleaseTurn(claim, { reclaim: true })).toThrow(
      "workspace result was not accepted",
    );
    store.updateWorkspaceBaseManifest({ claim, manifestRef: `sha256:${"e".repeat(64)}` });
    store.acceptWorkspaceResult(claim);

    expect(store.completeWorkspaceResultAndReleaseTurn(claim, { reclaim: true })).toMatchObject({
      state: "reclaimed",
      turnClaim: null,
      terminalReason: null,
      terminalAtMs: 1_000,
    });
    expect(store.listPendingWorkspaceResults()).toEqual([]);
  });

  it("records a clean terminal timestamp for an idle destroyed-worker reclaim", () => {
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
      terminalReason: null,
      terminalAtMs: 1_000,
    });
  });

  it("atomically fails a pending result and preserves its bounded reason across restart", () => {
    advanceToActive();
    const { active, claim, pending } = pendingResult();
    const closedClaims: WorkerSessionTurnClaim[] = [];
    const unregister = store.registerTurnClaimClosedHandler((closedClaim) => {
      closedClaims.push(closedClaim);
    });
    nowMs = 2_000;
    const disappearance = `cloud worker disappeared: ${"provider-detail ".repeat(100)}`;

    const failed = store.failWorkspaceResultAndReleaseTurn(pending, new Error(disappearance));
    expect(failed).toMatchObject({
      state: "failed",
      generation: active.generation + 3,
      turnClaim: null,
      terminalAtMs: 2_000,
    });
    expect(failed.terminalReason).toHaveLength(1_024);
    expect(failed.terminalReason).toMatch(/^cloud worker disappeared: provider-detail/u);
    expect(failed.recoveryError).toBe(failed.terminalReason);
    expect(store.listPendingWorkspaceResults()).toEqual([]);
    expect(closedClaims).toEqual([claim]);
    unregister();

    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerSessionPlacementStore({ database, now: () => nowMs });
    const reopened = store.get(SESSION.sessionId);
    expect(reopened).toMatchObject({ state: "failed", terminalAtMs: 2_000 });
    expect(reopened?.terminalReason).toBe(failed.terminalReason);
  });

  it("does not leak terminal diagnostics between sessions sharing an environment", () => {
    const sharedEnvironmentId = "environment-shared";
    advanceToActive(SESSION, sharedEnvironmentId);
    const otherIdentity = {
      sessionId: "session-placement-terminal-other",
      agentId: "main",
      sessionKey: "agent:main:placement-terminal-other",
    };
    const second = advanceToActive(otherIdentity, sharedEnvironmentId);
    const { pending } = pendingResult();

    const failed = store.failWorkspaceResultAndReleaseTurn(
      pending,
      new Error("cloud worker disappeared: shared lease destroyed"),
    );

    expect(failed).toMatchObject({
      terminalReason: "cloud worker disappeared: shared lease destroyed",
      terminalAtMs: 1_000,
    });
    expect(store.get(second.sessionId)).toMatchObject({
      state: "active",
      environmentId: sharedEnvironmentId,
      terminalReason: null,
      terminalAtMs: null,
    });
  });

  it("rolls back placement failure when pending-result removal aborts", () => {
    advanceToActive();
    const { active, claim, pending } = pendingResult();
    database.db.exec(`
      CREATE TRIGGER reject_pending_result_delete
      BEFORE DELETE ON worker_workspace_pending_results
      BEGIN
        SELECT RAISE(ABORT, 'injected pending delete failure');
      END;
    `);

    expect(() =>
      store.failWorkspaceResultAndReleaseTurn(pending, new Error("worker disappeared")),
    ).toThrow("injected pending delete failure");
    expect(store.get(active.sessionId)).toMatchObject({
      state: "active",
      generation: active.generation,
      turnClaim: { claimId: claim.claimId },
      terminalReason: null,
      terminalAtMs: null,
    });
    expect(store.listPendingWorkspaceResults()).toMatchObject([
      { sessionId: active.sessionId, claimId: claim.claimId },
    ]);
  });
});
